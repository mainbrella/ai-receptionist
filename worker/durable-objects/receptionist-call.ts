import { Agent, type Connection, type ConnectionContext } from "agents";
import { withVoice, WorkersAIFluxSTT, WorkersAINova3STT, type Transcriber, type TTSProvider, type TextSource, type VoiceTurnContext } from "@cloudflare/voice";
import { hangupTwilioCall } from "../lib/voice-telephony";
import { hangupTelnyxCall } from "../lib/voice-telnyx";
import { isVoiceBackchannel, voiceAcknowledgment, withVoiceBackchannel } from "../lib/voice-backchannel";
import { MAX_CALL_MS, MAX_TURNS, readCall, receptionistMessages, type VoiceAgentConfig, type VoiceCallRow } from "../lib/voice";

import { resolveVoiceModels } from "../lib/voice-options";
import { synthesizeVoiceSpeech } from "../lib/voice-speech";

const VoiceAgent = withVoice(Agent, { audioFormat: "pcm16", sampleRate: 16000, historyLimit: 20, maxMessageCount: MAX_TURNS * 2 + 1 });
const IMMEDIATE_REPLIES = {
  en: ['One second please.', 'Got it, just a sec.', 'I see, let me think.'],
  es: ['Un momento, por favor.', 'Entendido, un segundo.', 'Déjeme pensar.'],
  fr: ['Un instant, s’il vous plaît.', 'D’accord, un instant.', 'Laissez-moi réfléchir.'],
  de: ['Einen Moment bitte.', 'Verstanden, einen Augenblick.', 'Lassen Sie mich überlegen.'],
  hi: ['एक क्षण, कृपया।', 'समझ गया, एक क्षण।', 'मुझे सोचने दीजिए।'],
  ru: ['Одну секунду, пожалуйста.', 'Понятно, одну минуту.', 'Дайте подумать.'],
  pt: ['Um momento, por favor.', 'Entendido, só um instante.', 'Deixe-me pensar.'],
  ja: ['少々お待ちください。', '承知しました。', '少し考えさせてください。'],
  it: ['Un momento, per favore.', 'Capito, un secondo.', 'Mi lasci pensare.'],
  nl: ['Een ogenblik alstublieft.', 'Begrepen, een moment.', 'Laat me even nadenken.'],
};
interface CallState {
  callId: string;
  channel: VoiceCallRow["channel"];
  startedAt: string;
  config: VoiceAgentConfig;
  closed: boolean;
  failed: boolean;
  turns: number;
  phoneProvider: VoiceCallRow["phone_provider"];
  providerCallId: string | null;
  phoneEnded?: boolean;
  finalized?: boolean;
  endedAt?: string;
}
interface SocketState { accepted: boolean; started: boolean; ready?: boolean }

/** Each call has its own temporary Agent; D1 owns retained call history. */
export class ReceptionistCall extends VoiceAgent<Cloudflare.Env & Env, CallState | null> {
  static options = { sendIdentityOnConnect: false };
  initialState: CallState | null = null;
  createTranscriber(): Transcriber {
    const language = this.state?.config.language ?? 'en';
    if (language === 'en') return new WorkersAIFluxSTT(this.env.AI);
    return { createSession: options => new WorkersAINova3STT({
      run: async (model,input,runOptions) => {
        const response = await this.env.AI.run(model as Parameters<Ai['run']>[0],input,runOptions) as unknown as Response;
        // The installed Nova adapter forwards transcripts but omits SpeechStarted.
        // Forward upstream VAD so phone callers can interrupt without client VAD.
        response.webSocket?.addEventListener('message',event=>{
          if (typeof event.data !== 'string') return;
          try { if (JSON.parse(event.data).type==='SpeechStarted') options?.onSpeechStart?.(); } catch { /* Ignore non-JSON provider events. */ }
        });
        return response;
      },
    }, { language, endpointingMs: 500 }).createSession(options) };
  }
  private models() { return resolveVoiceModels(this.state?.config ?? {}); }
  protected fetchSpeech: typeof fetch = fetch;
  private writes: Promise<unknown> = Promise.resolve();
  private finalization: Promise<void> | null = null;
  private windowStart = 0;
  private windowBytes = 0;
  private windowFrames = 0;
  private lastTurn = 0;
  private activeInference = 0;
  private audioWrites: Promise<void> = Promise.resolve();
  private ttsWrites: Promise<void> = Promise.resolve();
  private immediateReplyAudio: ArrayBuffer[] = [];
  private backchannelAudio = new Map<string, Promise<ArrayBuffer | null>>();

  private async inferenceFailure(): Promise<void> {
    for (const connection of this.getConnections()) {
      try { connection.send(JSON.stringify({ type: "error", message: "The receptionist is unavailable. Please try again." })); }
      catch { /* A disconnected socket still needs finalization. */ }
    }
    await this.finish(true);
  }

  tts: TTSProvider = { synthesize: (text, signal) => {
    if (!this.usesLegacyBackchannel() || !isVoiceBackchannel(text)) return this.queueSpeech(text, signal);
    const phrase = text.trim();
    let audio = this.backchannelAudio.get(phrase);
    if (!audio) {
      // This call's voice is fixed, so reuse warmed PCM for every matching filler.
      audio = this.queueSpeech(phrase, undefined, true);
      this.backchannelAudio.set(phrase, audio);
    }
    return audio.then((result) => signal?.aborted || this.state?.closed ? null : result);
  } };

  private queueSpeech(text: string, signal?: AbortSignal, optional = false): Promise<ArrayBuffer | null> {
    this.activeInference++;
    // The SDK may request several sentence clips at once. Keep inference and
    // response-body consumption in one queue so provider calls stay serial.
    const task = this.ttsWrites.then(() => this.synthesizeSpeech(text, signal, optional));
    this.ttsWrites = task.then(() => {}, () => {});
    return task.finally(() => { this.activeInference--; });
  }

  private async synthesizeSpeech(text: string, signal?: AbortSignal, optional = false): Promise<ArrayBuffer | null> {
    if (!this.state || this.state.closed || signal?.aborted) return null;
    try {
      const timeout = AbortSignal.timeout(30_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      return await synthesizeVoiceSpeech(this.env, this.state.config, text, requestSignal, this.fetchSpeech);
    } catch (error) {
      if (optional) {
        console.error("voice_tts_filler_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        return null;
      }
      if (!signal?.aborted) await this.inferenceFailure();
      throw error;
    }
  }

  private usesLegacyBackchannel(): boolean {
    // Preserve existing in-flight snapshots while newly saved agents use the
    // explicit modes. The older filler vocabulary only supports English.
    return Boolean(this.state && this.state.channel !== "text" && !this.state.config.voiceLogic
      && (!this.state.config.language || this.state.config.language === "en"));
  }

  private async prepareImmediateReply(): Promise<void> {
    if (!this.state || this.state.closed || this.state.channel === "text" || this.state.config.voiceLogic !== "reply_right_away") return;
    // Prepare serially before the greeting. A failed optional clip must never
    // close the call or hold up a later answer with repeated synthesis attempts.
    for (const text of IMMEDIATE_REPLIES[this.state.config.language ?? "en"]) {
      const audio = await this.queueSpeech(text, undefined, true);
      if (!audio || this.state.closed) return;
      this.immediateReplyAudio.push(audio);
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env as Cloudflare.Env & Env);
    // Filter before the SDK sees messages: it must never accept state mutation
    // or arbitrary Agent RPC from a browser or a carrier media socket.
    const voiceMessage = this.onMessage.bind(this);
    this.onMessage = async (connection, message) => {
      if (!(connection.state as SocketState | null)?.accepted || !this.state || this.state.closed) {
        connection.close(1008, "Call unavailable"); return;
      }
      if (Date.now() - Date.parse(this.state.startedAt) >= MAX_CALL_MS) { await this.finish(); return; }
      const bytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
      if (Date.now() - this.windowStart >= 1000) { this.windowStart = Date.now(); this.windowBytes = 0; this.windowFrames = 0; }
      this.windowBytes += bytes;
      if (++this.windowFrames > 120 || this.windowBytes > 128_000 || bytes > 32_768) { await this.finish(true); return; }
      if (typeof message !== "string") {
        if (this.state.channel === "text" || !(connection.state as SocketState).started || message.byteLength % 2) {
          await this.finish(true); return;
        }
        const task = this.audioWrites.then(async () => {
          if (this.state && !this.state.closed) await voiceMessage(connection, message);
        });
        this.audioWrites = task.catch(() => this.inferenceFailure());
        return this.audioWrites;
      }
      let input: { type?: unknown; text?: unknown };
      try { input = JSON.parse(message); } catch { await this.finish(true); return; }
      if (!input || typeof input !== "object") { await this.finish(true); return; }
      if (input.type === "end_call") { await this.finish(); return; }
      if (input.type === "start_call") {
        if (this.state.channel === "text" || (connection.state as SocketState).started) { await this.finish(true); return; }
        connection.setState({ accepted: true, started: true });
      } else if (input.type === "text_message") {
        if (this.state.turns >= MAX_TURNS || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000) {
          await this.finish(true); return;
        }
      } else if (!["hello", "interrupt", "start_of_speech", "end_of_speech"].includes(String(input.type))) {
        await this.finish(true); return;
      }
      return voiceMessage(connection, message);
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/initialize" && request.method === "POST") {
      const { callId } = await request.json() as { callId: string };
      const call = await readCall(this.env, callId);
      if (!call || call.status !== "active" || (this.state && this.state.callId !== call.id)) return new Response(null, { status: 409 });
      if (!this.state) {
        this.setState({ callId: call.id, channel: call.channel, startedAt: call.started_at,
          config: JSON.parse(call.config_json), providerCallId: call.provider_call_id,
          phoneProvider: call.phone_provider, closed: false, failed: false, turns: 0 });
        await this.schedule(new Date(Date.parse(call.started_at) + MAX_CALL_MS), "expireCall");
      }
      return new Response(null, { status: 204 });
    }
    if (path === "/end" && request.method === "POST") {
      await this.finish(request.headers.get("x-call-failed") === "true");
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  async onConnect(connection: Connection, _context: ConnectionContext) {
    if (!this.state || this.state.closed) { connection.close(1008, "Call ended"); return; }
    const claimed = await this.env.DB.prepare("UPDATE voice_calls SET connected_at=? WHERE id=? AND status='active' AND connected_at IS NULL")
      .bind(new Date().toISOString(), this.state.callId).run();
    if (!claimed.meta.changes) { connection.close(1008, "Call already connected"); return; }
    connection.setState({ accepted: true, started: false });
    if (this.state.channel === "text") {
      this.saveMessage("assistant", this.state.config.greeting);
      await this.flush();
      connection.send(JSON.stringify({ type: "transcript", role: "assistant", text: this.state.config.greeting }));
    }
  }

  async beforeCallStart(_connection: Connection): Promise<boolean> {
    if (!this.state || this.state.closed || this.state.channel === "text") return false;
    await this.prepareImmediateReply();
    return !this.state.closed;
  }
  async onCallStart(connection: Connection) {
    if (!this.state || this.state.closed) return;
    connection.setState({ ...connection.state as SocketState, ready: true });
    await this.speak(connection, this.state.config.greeting);
  }
  async onCallEnd(connection: Connection) {
    if ((connection.state as SocketState | null)?.accepted) await this.finish(this.state?.channel !== "text" && !(connection.state as SocketState).ready);
  }
  async onClose(connection: Connection) {
    if ((connection.state as SocketState | null)?.accepted) await this.finish();
  }
  async afterTranscribe(transcript: string, _connection: Connection): Promise<string | null> {
    if (!this.state || this.state.closed || this.state.turns >= MAX_TURNS || transcript.length > 4000) {
      await this.finish(); return null;
    }
    return transcript;
  }
  async onTurn(transcript: string, context: VoiceTurnContext): Promise<TextSource> {
    const reply = this.generateReply(transcript, context);
    if (!this.usesLegacyBackchannel()) return reply;
    return withVoiceBackchannel(reply, context.signal, this.state?.turns || 1);
  }

  private async generateReply(transcript: string, context: VoiceTurnContext): Promise<string> {
    const replyRightAway = this.state?.config.voiceLogic === "reply_right_away" && this.state.channel !== "text";
    const rapidOriginalTurn = !replyRightAway && Date.now() - this.lastTurn < 750;
    if (!this.state || this.state.closed || this.state.turns >= MAX_TURNS || transcript.length > 4000 || rapidOriginalTurn) {
      await this.finish(); throw new Error("Call limit reached");
    }
    this.lastTurn = Date.now();
    this.setState({ ...this.state, turns: this.state.turns + 1 });
    if (replyRightAway && (context.connection.state as SocketState | null)?.started && this.immediateReplyAudio.length && !context.signal.aborted) {
      // Cue audio belongs to this turn but is excluded from conversation history.
      // speak() would abort the active turn, so send the cached PCM directly.
      try {
        context.connection.send(JSON.stringify({ type: "status", status: "speaking" }));
        context.connection.send(this.immediateReplyAudio[(this.state.turns - 1) % this.immediateReplyAudio.length]);
      } catch { /* The caller may have disconnected. */ }
    }
    await this.flush();
    this.activeInference++;
    try {
      const response = await this.env.AI.run(this.models().llm as Parameters<Ai['run']>[0], {
        messages: receptionistMessages(this.state.config, context.messages, transcript), max_tokens: 256, temperature: 0.4,
        ...(this.state.config.language && this.state.config.language !== "en" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) }) as { response?: string; choices?: Array<{ message?: { content?: string | null } }> };
      if (this.state.closed || context.signal.aborted) throw new Error("call_ended");
      const text = (response.response ?? response.choices?.[0]?.message?.content)?.trim().slice(0, 4000);
      if (!text) throw new Error("empty_response");
      return text;
    } catch {
      if (!context.signal.aborted) await this.inferenceFailure();
      throw new Error("The receptionist is unavailable. Please try again.");
    } finally { this.activeInference--; }
  }

  saveMessage(role: "user" | "assistant", text: string): void {
    super.saveMessage(role, text);
    if (role === "assistant" && this.state && !this.state.closed && this.usesLegacyBackchannel()) {
      // Warm the next turn's acknowledgment while this assistant reply plays.
      const warm = this.tts.synthesize(voiceAcknowledgment(this.state.turns + 1));
      this.ctx.waitUntil(warm.then(() => {}, () => {}));
    }
    const callId = this.state?.callId;
    if (!callId) return;
    const transcript = JSON.stringify(this.getConversationHistory(MAX_TURNS * 2 + 1).map((message) => ({ role: message.role, text: message.content })));
    this.writes = this.writes.catch(() => {}).then(() => this.env.DB.prepare("UPDATE voice_calls SET transcript_json=? WHERE id=? AND deleted_at IS NULL")
      .bind(transcript, callId).run());
    this.ctx.waitUntil(this.writes.catch(() => { console.error("voice_transcript_persistence_failed"); }));
  }
  private async flush(retry = false): Promise<void> {
    try { await this.writes; }
    catch (error) {
      if (!retry || !this.state) throw error;
      const transcript = JSON.stringify(this.getConversationHistory(MAX_TURNS * 2 + 1).map((message) => ({ role: message.role, text: message.content })));
      this.writes = this.env.DB.prepare("UPDATE voice_calls SET transcript_json=? WHERE id=? AND deleted_at IS NULL")
        .bind(transcript, this.state.callId).run();
      await this.writes;
    }
  }
  protected async hangupPhone(callId: string) {
    return this.state?.phoneProvider === "telnyx" ? hangupTelnyxCall(this.env, callId) : hangupTwilioCall(this.env, callId);
  }
  async retryFinish() { await this.finish(); }
  async expireCall() { await this.finish(); }
  async purgeCall(): Promise<void> {
    if (!this.state?.closed) return;
    if (!this.state.finalized || this.finalization) await this.finish();
    if (this.activeInference) { await this.schedule(15, "purgeCall"); return; }
    await this.flush();
    await this.destroy();
  }
  private async finish(failed = false): Promise<void> {
    if (!this.state) return;
    // A socket close may arrive before its bridge reports a media error.
    // Failure is monotonic, including a report that arrives after finalization.
    if (failed && !this.state.failed) this.setState({ ...this.state, failed: true });
    if (this.finalization) {
      await this.finalization;
      if (failed) await this.finish();
      return;
    }
    const finalization = Promise.resolve().then(async () => {
      if (!this.state!.closed) {
        this.setState({ ...this.state!, closed: true, failed: this.state!.failed || failed, endedAt: new Date().toISOString() });
        for (const connection of this.getConnections()) {
          try { this.forceEndCall(connection); } catch { /* Already disconnected. */ }
          try { connection.close(1000, "Call ended"); } catch { /* Already closed. */ }
        }
      }
      if (this.state!.providerCallId && !this.state!.phoneEnded) {
        await this.hangupPhone(this.state!.providerCallId);
        this.setState({ ...this.state!, phoneEnded: true });
      }
      await this.flush(true);
      await this.env.DB.prepare("UPDATE voice_calls SET status=CASE WHEN status='failed' THEN status ELSE ? END,ended_at=COALESCE(ended_at,?) WHERE id=? AND deleted_at IS NULL")
        .bind(this.state!.failed ? "failed" : "completed", this.state!.endedAt!, this.state!.callId).run();
      this.setState({ ...this.state!, finalized: true });
      await this.schedule(60, "purgeCall", undefined, { idempotent: true });
    });
    this.finalization = finalization;
    try { await finalization; }
    catch (error) { await this.schedule(5, "retryFinish"); throw error; }
    finally { if (this.finalization === finalization) this.finalization = null; }
  }
}

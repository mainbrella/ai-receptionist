import { Agent, type Connection, type ConnectionContext } from "agents";
import { withVoice, WorkersAIFluxSTT, type TTSProvider, type VoiceTurnContext } from "@cloudflare/voice";
import { hangupTwilioCall } from "../lib/voice-telephony";
import { hangupTelnyxCall } from "../lib/voice-telnyx";
import { MAX_CALL_MS, MAX_TURNS, readCall, receptionistMessages, VOICE_MODELS, type VoiceAgentConfig, type VoiceCallRow } from "../lib/voice";

const VoiceAgent = withVoice(Agent, { audioFormat: "pcm16", sampleRate: 16000, historyLimit: 20, maxMessageCount: MAX_TURNS * 2 + 1 });
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
  endedAt?: string;
}
interface SocketState { accepted: boolean; started: boolean; ready?: boolean }

/** Each call has its own temporary Agent; D1 owns retained call history. */
export class ReceptionistCall extends VoiceAgent<Cloudflare.Env & Env, CallState | null> {
  static options = { sendIdentityOnConnect: false };
  initialState: CallState | null = null;
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  private writes: Promise<unknown> = Promise.resolve();
  private finalization: Promise<void> | null = null;
  private windowStart = 0;
  private windowBytes = 0;
  private windowFrames = 0;
  private lastTurn = 0;
  private activeInference = 0;
  private audioWrites: Promise<void> = Promise.resolve();

  private async inferenceFailure(): Promise<void> {
    for (const connection of this.getConnections()) {
      try { connection.send(JSON.stringify({ type: "error", message: "The receptionist is unavailable. Please try again." })); }
      catch { /* A disconnected socket still needs finalization. */ }
    }
    await this.finish(true);
  }

  tts: TTSProvider = { synthesize: async (text, signal) => {
    if (!this.state || this.state.closed) throw new Error("call_ended");
    this.activeInference++;
    try {
      const timeout = AbortSignal.timeout(30_000);
      const response = await this.env.AI.run(VOICE_MODELS.tts, {
        text, speaker: this.state.config.voice, encoding: "linear16", container: "none", sample_rate: 16000,
      }, { returnRawResponse: true, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }) as Response;
      if (!response.ok) throw new Error("tts_failed");
      return await response.arrayBuffer();
    } catch (error) {
      if (!signal?.aborted) await this.inferenceFailure();
      throw error;
    } finally { this.activeInference--; }
  } };

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
    if (path === "/end" && request.method === "POST") { await this.finish(); return new Response(null, { status: 204 }); }
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
    return Boolean(this.state && !this.state.closed && this.state.channel !== "text");
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
  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    if (!this.state || this.state.closed || this.state.turns >= MAX_TURNS || transcript.length > 4000 || Date.now() - this.lastTurn < 750) {
      await this.finish(); throw new Error("Call limit reached");
    }
    this.lastTurn = Date.now();
    this.setState({ ...this.state, turns: this.state.turns + 1 });
    await this.flush();
    this.activeInference++;
    try {
      const response = await this.env.AI.run(VOICE_MODELS.llm, {
        messages: receptionistMessages(this.state.config, context.messages, transcript), max_tokens: 256, temperature: 0.4,
      }, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) }) as { response?: string };
      if (this.state.closed || context.signal.aborted) throw new Error("call_ended");
      const text = response.response?.trim().slice(0, 4000);
      if (!text) throw new Error("empty_response");
      return text;
    } catch {
      if (!context.signal.aborted) await this.inferenceFailure();
      throw new Error("The receptionist is unavailable. Please try again.");
    } finally { this.activeInference--; }
  }

  saveMessage(role: "user" | "assistant", text: string): void {
    super.saveMessage(role, text);
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
    if (this.activeInference) { await this.schedule(15, "purgeCall"); return; }
    await this.flush();
    await this.destroy();
  }
  private async finish(failed = false): Promise<void> {
    if (!this.state) return;
    if (this.finalization) return this.finalization;
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
      await this.env.DB.prepare("UPDATE voice_calls SET status=?,ended_at=COALESCE(ended_at,?) WHERE id=? AND status='active'")
        .bind(this.state!.failed ? "failed" : "completed", this.state!.endedAt!, this.state!.callId).run();
      await this.schedule(60, "purgeCall", undefined, { idempotent: true });
    });
    this.finalization = finalization;
    try { await finalization; }
    catch (error) { await this.schedule(5, "retryFinish"); throw error; }
    finally { if (this.finalization === finalization) this.finalization = null; }
  }
}

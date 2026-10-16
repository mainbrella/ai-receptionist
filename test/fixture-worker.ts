import { ReceptionistCall as BaseCall } from "../worker/durable-objects/receptionist-call";
import { handleRequest, cleanup } from "../worker/index";

// Only the test entrypoint supplies fake inference. Production always uses AI.
let ttsStats = { active: 0, maxActive: 0, requests: 0 };
let failNextHold = false;
let inferenceRequests: Array<{ model: string; input: Record<string, unknown> }> = [];
const cues = ["One second please.", "Got it, just a sec.", "I see, let me think."];
async function speech(input: Record<string, unknown>, options: Record<string, string> = {}) {
  ttsStats.active++;
  ttsStats.requests++;
  ttsStats.maxActive = Math.max(ttsStats.maxActive, ttsStats.active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (input.text === "One moment." && failNextHold) {
      failNextHold = false;
      throw new Error("Fixture filler synthesis failure");
    }
    const cue = cues.indexOf(String(input.text));
    if (cue >= 0 && options.TEST_CUE_FAILURE && (!options.TEST_CUE_FAILURE_TEXT || input.text === options.TEST_CUE_FAILURE_TEXT)) {
      if (options.TEST_CUE_FAILURE === "odd_pcm") return new Response(new Uint8Array(3));
      if (options.TEST_CUE_FAILURE === "empty_pcm") return new Response(new Uint8Array());
      throw new Error("Fixture optional cue failure");
    }
    const sample = cue >= 0 ? 1000 + cue * 2000 : input.text === "Hello, how can I help?" ? 0 : 2000;
    return new Response(new Int16Array(320).fill(sample).buffer, { headers: { "content-type": "audio/pcm" } });
  } finally { ttsStats.active--; }
}
function fixtureAI(env: Env) {
  const options = env as unknown as Record<string, string>;
  return {
  async run(model: string, input: Record<string, unknown>) {
    inferenceRequests.push({ model, input });
    if (model.includes("/flux") || model.includes("/nova-3")) {
      const pair = new WebSocketPair();
      pair[1].accept();
      let turns = 0;
      pair[1].addEventListener("message", (event) => {
        if (typeof event.data === "string" || (turns && options.TEST_MULTI_TURN !== "true")) return;
        const transcript = ["Could I leave a message?", "Could I change that message?", "Please take a final message."][turns++] || "Another message.";
        if (model.includes("/nova-3")) {
          if (!input.language || input.language === "en") throw new Error("Missing Nova language");
          pair[1].send(JSON.stringify({ type: "SpeechStarted" }));
          if (turns > 1 && options.TEST_NOVA_SPEECH_START_ONLY === "true") return;
          pair[1].send(JSON.stringify({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript }] } }));
        } else {
          if (options.TEST_MULTI_TURN === "true") pair[1].send(JSON.stringify({ event: "StartOfTurn" }));
          pair[1].send(JSON.stringify({ event: "EndOfTurn", transcript }));
        }
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (model.includes("/aura-")) {
      if (input.encoding !== "linear16" || input.container !== "none" || input.sample_rate !== 16000) throw new Error("Raw PCM required");
      return speech(input, options);
    }
    const messages = input.messages as Array<{ role: string; content: string }>;
    const text = messages.at(-1)!.content;
    if (text === "cause model failure") throw new Error("Private fixture error must not reach caller");
    if (text === "filler outage") failNextHold = true;
    if (text === "waiting model" || text === "filler outage") await new Promise((resolve) => setTimeout(resolve, 6500));
    if (options.TEST_REPLY_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(options.TEST_REPLY_DELAY_MS)));
    if (text === "multi sentence") return { response: "First sentence. Second sentence. Third sentence." };
    const response = `I can take a message: ${text}`;
    return model.includes("/gemma-4") ? { choices: [{ message: { content: response } }] } : { response };
  },
  };
}

export class ReceptionistCall extends BaseCall {
  protected fetchSpeech: typeof fetch = (async (url: RequestInfo | URL, request?: RequestInit) => {
    const body = JSON.parse(String(request?.body));
    const parsed = new URL(String(url));
    const model = parsed.pathname.includes("/cartesia/") ? "cartesia/sonic-3.6" : "deepgram/aura-2";
    inferenceRequests.push({ model, input: body });
    if (body.output_format && (body.output_format.container !== "raw" || body.output_format.sample_rate !== 16000)) throw new Error("Raw PCM required");
    return speech({ text: body.text ?? body.transcript }, this.env as unknown as Record<string, string>);
  }) as typeof fetch;
  async useLegacyBackchannel() {
    if (!this.state) return;
    const { voiceLogic: _voiceLogic, ...config } = this.state.config;
    this.setState({ ...this.state, config: config as typeof this.state.config });
  }
  private hangupFailures: number;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, AI: fixtureAI(env) } as unknown as Env);
    this.hangupFailures = Number((env as Env & { TEST_HANGUP_FAILURES?: string }).TEST_HANGUP_FAILURES ?? "0");
  }
  protected async hangupPhone(_callId: string) {
    if (this.hangupFailures > 0) { this.hangupFailures--; throw new Error("Fixture carrier outage"); }
    return { durationSeconds: 1, billableMinutes: 1 };
  }
  async allowHangup() { this.hangupFailures = 0; }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/__test_tts_stats" && request.method === "POST") {
      ttsStats = { active: 0, maxActive: 0, requests: 0 };
      return new Response(null, { status: 204 });
    }
    if (path === "/__test_tts_stats") return Response.json(ttsStats);
    if (path === "/__test_inference" && request.method === "POST") {
      inferenceRequests = [];
      return new Response(null, { status: 204 });
    }
    if (path === "/__test_inference") return Response.json(inferenceRequests);
    const legacy = path.match(/^\/__test_legacy_backchannel\/([^/]+)$/);
    if (legacy) {
      await (env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(legacy[1])) as unknown as ReceptionistCall).useLegacyBackchannel();
      return new Response(null, { status: 204 });
    }
    const inspect = path.match(/^\/__test_state\/([^/]+)$/);
    if (inspect) return Response.json(await env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(inspect[1])).state);
    const release = path.match(/^\/__test_allow_hangup\/([^/]+)$/);
    if (release) {
      const stub = env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(release[1])) as unknown as ReceptionistCall;
      await stub.allowHangup();
      return new Response(null, { status: 204 });
    }
    const fail = path.match(/^\/__test_fail\/([^/]+)$/);
    if (fail) return env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(fail[1])).fetch(new Request("https://voice.internal/end", {
      method: "POST", headers: { "x-call-failed": "true" },
    }));
    if (path === "/__test_cleanup") { await cleanup(env); return new Response(null, { status: 204 }); }
    const purge = path.match(/^\/__test_purge\/([^/]+)$/);
    if (purge) {
      await env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(purge[1])).purgeCall();
      return new Response(null, { status: 204 });
    }
    return handleRequest(request, { ...env, AI: fixtureAI(env) } as unknown as Env, ctx);
  },
};

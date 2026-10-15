import { ReceptionistCall as BaseCall } from "../worker/durable-objects/receptionist-call";
import { handleRequest, cleanup } from "../worker/index";

// Only the test entrypoint supplies fake inference. Production always uses AI.
const ai = {
  async run(model: string, input: Record<string, unknown>) {
    if (model.includes("/flux")) {
      const pair = new WebSocketPair();
      pair[1].accept();
      let sent = false;
      pair[1].addEventListener("message", (event) => {
        if (!sent && typeof event.data !== "string") {
          sent = true;
          pair[1].send(JSON.stringify({ event: "EndOfTurn", transcript: "Could I leave a message?" }));
        }
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (model.includes("/aura-1")) {
      if (input.encoding !== "linear16" || input.container !== "none" || input.sample_rate !== 16000) throw new Error("Raw PCM required");
      return new Response(new Uint8Array(640), { headers: { "content-type": "audio/pcm" } });
    }
    const messages = input.messages as Array<{ role: string; content: string }>;
    const text = messages.at(-1)!.content;
    if (text === "cause model failure") throw new Error("Private fixture error must not reach caller");
    return { response: `I can take a message: ${text}` };
  },
};

export class ReceptionistCall extends BaseCall {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, AI: ai } as unknown as Env);
  }
  protected async hangupPhone(_callId: string) { return { durationSeconds: 1, billableMinutes: 1 }; }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/__test_cleanup") { await cleanup(env); return new Response(null, { status: 204 }); }
    const purge = path.match(/^\/__test_purge\/([^/]+)$/);
    if (purge) {
      await env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(purge[1])).purgeCall();
      return new Response(null, { status: 204 });
    }
    return handleRequest(request, { ...env, AI: ai } as unknown as Env, ctx);
  },
};

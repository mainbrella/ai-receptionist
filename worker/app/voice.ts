import { authCorsHeaders, authJson, currentUser, readJSON } from "./auth-core";
import {
  AGENT_ID, callStub, createCall, expireCalls, initializeCall, publicAgent, publicCall,
  publicVoiceOrigin, readAgent, readCall, telephonyConfigured, twilioSipUri, VOICE_MODELS,
  voiceAgentInput, voiceEnabled, type VoiceCallRow,
} from "../lib/voice";
import { handleTwilioRequest } from "./voice-twilio";
import { handleTelnyxRequest } from "./voice-telnyx";
import { telnyxConfigured, telnyxSipUri } from "../lib/voice-telnyx";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleVoiceRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  // Carriers authenticate their own signed requests; they cannot use admin routes.
  if (url.pathname.startsWith("/voice/twilio/")) return handleTwilioRequest(request, env, ctx);
  if (url.pathname.startsWith("/voice/telnyx/")) return handleTelnyxRequest(request, env, ctx);
  if (authCorsHeaders(request) === null) return authJson({ error: "origin_not_allowed" }, 403);
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) return authJson({ error: "method_not_allowed" }, 405);
  if ((request.method !== "GET" || url.pathname.endsWith("/connect")) && request.headers.get("Origin") !== url.origin) {
    return authJson({ error: "origin_required" }, 403);
  }
  if (url.search) return authJson({ error: "invalid_request" }, 400);
  const user = await currentUser(env, request);
  if (!user) return authJson({ error: "not_authenticated" }, 401);
  if (url.pathname === "/voice/config" && request.method === "GET") {
    const agent = await readAgent(env, user.id);
    const id = agent?.id ?? null;
    const origin = publicVoiceOrigin(env);
    return authJson({ enabled: voiceEnabled(env), browserCalling: voiceEnabled(env), models: VOICE_MODELS,
      telephony: {
        configured: telephonyConfigured(env, id) || telnyxConfigured(env, id),
        twilioConfigured: telephonyConfigured(env, id),
        webhookUrl: agent && origin ? `${origin}/voice/twilio/incoming/${id}` : null,
        phoneNumber: telephonyConfigured(env, id, "pstn") ? env.TWILIO_PHONE_NUMBER : null,
        sipUri: telephonyConfigured(env, id, "sip") ? twilioSipUri(env.TWILIO_SIP_URI) : null,
        telnyx: {
          configured: telnyxConfigured(env, id),
          webhookUrl: agent && origin ? `${origin}/voice/telnyx/incoming/${id}` : null,
          phoneNumber: telnyxConfigured(env, id, "pstn") ? env.TELNYX_PHONE_NUMBER : null,
          sipUri: telnyxConfigured(env, id, "sip") ? telnyxSipUri(env.TELNYX_SIP_URI) : null,
        },
      },
    });
  }
  if (url.pathname === "/voice/agent") {
    if (request.method === "GET") {
      const agent = await readAgent(env, user.id);
      return authJson({ agent: agent ? publicAgent(agent) : null });
    }
    if (request.method !== "PUT") return authJson({ error: "method_not_allowed" }, 405);
    const parsed = voiceAgentInput.safeParse(await readJSON(request, 40_000));
    if (!parsed.success) return authJson({ error: "invalid_request" }, 400);
    const input = parsed.data;
    await env.DB.prepare(`INSERT INTO voice_agents(id,user_id,name,business_name,greeting,instructions,voice,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,business_name=excluded.business_name,
      greeting=excluded.greeting,instructions=excluded.instructions,voice=excluded.voice,updated_at=excluded.updated_at`)
      .bind(AGENT_ID, user.id, input.name, input.businessName, input.greeting, input.instructions, input.voice, new Date().toISOString()).run();
    return authJson({ agent: publicAgent((await readAgent(env, user.id))!) });
  }
  if (url.pathname === "/voice/calls") {
    await expireCalls(env, user.id);
    if (request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM voice_calls WHERE user_id=? AND deleted_at IS NULL ORDER BY started_at DESC,id DESC LIMIT 50")
        .bind(user.id).all<VoiceCallRow>();
      return authJson({ calls: results.map(publicCall) });
    }
    if (request.method !== "POST") return authJson({ error: "method_not_allowed" }, 405);
    if (!voiceEnabled(env)) return authJson({ error: "voice_unavailable" }, 503);
    const input = await readJSON(request) as { channel?: unknown } | null;
    if (!input || Object.keys(input).length !== 1 || !["browser", "text"].includes(String(input.channel))) return authJson({ error: "invalid_request" }, 400);
    const agent = await readAgent(env, user.id);
    if (!agent) return authJson({ error: "agent_required" }, 409);
    const call = await createCall(env, user.id, publicAgent(agent), input.channel as "browser" | "text");
    if (!call) return authJson({ error: "voice_call_limit" }, 429);
    try { await initializeCall(env, call); }
    catch {
      await env.DB.prepare("UPDATE voice_calls SET status='failed',ended_at=? WHERE id=?")
        .bind(new Date().toISOString(), call.id).run();
      return authJson({ error: "voice_unavailable" }, 503);
    }
    const websocketUrl = new URL(`/voice/calls/${call.id}/connect`, url.origin);
    websocketUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return authJson({ call: publicCall(call), websocketUrl: websocketUrl.toString() }, 201);
  }
  const match = url.pathname.match(/^\/voice\/calls\/([^/]+)(?:\/(connect|end))?$/);
  if (!match || !uuid.test(match[1])) return authJson({ error: "not_found" }, 404);
  await expireCalls(env, user.id);
  const call = await readCall(env, match[1]);
  if (!call || call.user_id !== user.id || call.deleted_at) return authJson({ error: "not_found" }, 404);
  if (!match[2] && request.method === "GET") return authJson({ call: publicCall(call) });
  if (!match[2] && request.method === "DELETE") {
    if (call.status === "active") return authJson({ error: "call_active" }, 409);
    // Purge the temporary Agent before redaction, so it cannot re-persist a transcript.
    const stub = callStub(env, call.id);
    const ended = await stub.fetch(new Request("https://voice.internal/end", { method: "POST" }));
    if (!ended.ok) return authJson({ error: "voice_unavailable" }, 503);
    await stub.purgeCall();
    await env.DB.prepare("UPDATE voice_calls SET transcript_json='[]',config_json='{}',deleted_at=? WHERE id=? AND status!='active'")
      .bind(new Date().toISOString(), call.id).run();
    return new Response(null, { status: 204 });
  }
  if (match[2] === "end" && request.method === "POST") {
    if (call.status === "active") {
      const response = await callStub(env, call.id).fetch(new Request("https://voice.internal/end", { method: "POST" }));
      if (!response.ok) return authJson({ error: "voice_unavailable" }, 503);
    }
    return authJson({ call: publicCall((await readCall(env, call.id))!) });
  }
  if (match[2] === "connect" && request.method === "GET") {
    if (call.channel === "phone") return authJson({ error: "not_found" }, 404);
    if (!voiceEnabled(env)) return authJson({ error: "voice_unavailable" }, 503);
    if (call.status !== "active") return authJson({ error: "call_ended" }, 409);
    if (call.connected_at) return authJson({ error: "call_already_connected" }, 409);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return authJson({ error: "websocket_required" }, 426);
    return callStub(env, call.id).fetch(new Request("https://voice.internal/connect", { headers: { Upgrade: "websocket" } }));
  }
  return authJson({ error: "method_not_allowed" }, 405);
}

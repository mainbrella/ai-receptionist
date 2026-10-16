import { handleAuth, authJson } from "./app/auth-core";
import { handleVoiceRequest } from "./app/voice";
export { ReceptionistCall } from "./durable-objects/receptionist-call";

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/health" && request.method === "GET") return authJson({ ok: true });
    if (path.startsWith("/auth/")) return await handleAuth(request, env);
    if (path.startsWith("/voice/")) return await handleVoiceRequest(request, env, ctx);
    // Never expose the SDK's unauthenticated /agents RPC/state endpoints.
    if (path.startsWith("/agents/") || path.startsWith("/__")) return authJson({ error: "not_found" }, 404);
    return await env.ASSETS.fetch(request);
  } catch {
    console.error("receptionist_request_failed");
    return authJson({ error: "voice_unavailable" }, 503);
  }
}

export async function cleanup(env: Env): Promise<void> {
  const configured = Number(env.TRANSCRIPT_RETENTION_DAYS ?? "30");
  const days = Number.isInteger(configured) && configured >= 1 && configured <= 365 ? configured : 30;
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  // Retain provider IDs as replay tombstones; redact sensitive conversation data.
  await env.DB.batch([
    env.DB.prepare(`UPDATE voice_calls SET transcript_json='[]',config_json='{}',deleted_at=?
      WHERE status!='active' AND deleted_at IS NULL AND ended_at<?`).bind(new Date().toISOString(), before),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(Date.now()),
    env.DB.prepare("DELETE FROM login_attempts WHERE expires_at<=?").bind(Date.now()),
    env.DB.prepare("DELETE FROM number_search_attempts WHERE expires_at<=?").bind(Date.now()),
  ]);
}

export default {
  fetch: handleRequest,
  scheduled(_event, env, ctx) { ctx.waitUntil(cleanup(env)); },
} satisfies ExportedHandler<Env>;

const COOKIE = "receptionist_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
export const OWNER_ID = "owner";

export async function hashToken(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Fixed-size digests avoid an early return on individual password characters.
async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([hashToken(input), hashToken(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export function authCorsHeaders(request: Request): Record<string, string> | null {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin ? {} : null;
}

export function authJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

function tokenFrom(request: Request): string | null {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? `__Host-${COOKIE}` : COOKIE;
  const value = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function cookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:";
  return `${secure ? "__Host-" : ""}${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export async function currentUser(env: Env, request: Request): Promise<{ id: string } | null> {
  const token = tokenFrom(request);
  if (!token || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) return null;
  const session = await env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash=? AND password_hash=? AND expires_at>?",
  ).bind(await hashToken(token), await hashToken(env.ADMIN_PASSWORD), Date.now()).first();
  return session ? { id: OWNER_ID } : null;
}

/** Bound streamed input too: Content-Length alone is not a body size limit. */
export async function readJSON(request: Request, limit = 16_384): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (authCorsHeaders(request) === null ||
    (request.method !== "GET" && request.headers.get("Origin") !== url.origin)) {
    return authJson({ error: "origin_not_allowed" }, 403);
  }
  if (url.search) return authJson({ error: "invalid_request" }, 400);
  if (url.pathname === "/auth/session" && request.method === "GET") {
    return authJson({ user: await currentUser(env, request) });
  }
  if (request.method !== "POST") return authJson({ error: "method_not_allowed" }, 405);
  if (url.pathname === "/auth/logout") {
    const token = tokenFrom(request);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await hashToken(token)).run();
    return new Response(null, { status: 204, headers: { "set-cookie": cookie(request, "", 0), "cache-control": "no-store" } });
  }
  if (url.pathname !== "/auth/login") return authJson({ error: "not_found" }, 404);
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) return authJson({ error: "login_unavailable" }, 503);
  const now = Date.now();
  const ip = await hashToken(request.headers.get("CF-Connecting-IP") || "local");
  const attempt = await env.DB.prepare(`INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`)
    .bind(`${ip}:${Math.floor(now / 60_000)}`, now + 120_000).first<{ attempts: number }>();
  if (!attempt || attempt.attempts > 10) return authJson({ error: "rate_limited" }, 429, { "retry-after": "60" });
  const input = await readJSON(request, 4096) as { password?: unknown } | null;
  if (!input || typeof input.password !== "string" || input.password.length > 1024 ||
    !await passwordMatches(input.password, env.ADMIN_PASSWORD)) return authJson({ error: "invalid_password" }, 401);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const previous = tokenFrom(request);
  const statements = [env.DB.prepare("INSERT INTO sessions(token_hash,password_hash,expires_at) VALUES(?,?,?)")
    .bind(await hashToken(token), await hashToken(env.ADMIN_PASSWORD), now + SESSION_MS)];
  if (previous) statements.push(env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await hashToken(previous)));
  await env.DB.batch(statements);
  return new Response(null, { status: 204, headers: { "set-cookie": cookie(request, token, SESSION_MS / 1000), "cache-control": "no-store" } });
}

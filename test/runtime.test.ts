import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { VoiceClient, type VoiceTransport } from "@cloudflare/voice/client";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { handleTelnyxRequest } from "../worker/app/voice-telnyx";

const ORIGIN = "https://receptionist.example";
const PASSWORD = "a-long-test-admin-password";
const ACCOUNT = `AC${"a".repeat(32)}`;
const SID = `CA${"b".repeat(32)}`;
const AGENT = "00000000-0000-4000-8000-000000000001";
const TWILIO_TOKEN = "test-twilio-auth-token";
const agent = { name: "Maya", businessName: "Test workshop", greeting: "Hello, how can I help?",
  instructions: "Open weekdays. Take messages. Do not invent details.", voice: "asteria", transferNumber: null };
const bundle = build({ entryPoints: [new URL("fixture-worker.ts", import.meta.url).pathname], bundle: true, write: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/voice-test.js');" },
  format: "esm", target: "es2022", platform: "browser", external: ["cloudflare:*", "node:*"],
  alias: { crypto: "node:crypto", url: "node:url", querystring: "node:querystring", path: "node:path" },
});

async function runtime(t: TestContext, overrides: Record<string, string> = {}) {
  const result = await bundle;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "voice-test", modules: true,
    script: result.outputFiles[0].text, compatibilityDate: "2026-09-18", compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"], durableObjects: { RECEPTIONIST_CALL: { className: "ReceptionistCall", useSQLite: true } },
    bindings: { ADMIN_PASSWORD: PASSWORD, VOICE_ENABLED: "true", VOICE_PUBLIC_ORIGIN: ORIGIN,
      TRANSCRIPT_RETENTION_DAYS: "30", TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TWILIO_ACCOUNT_SID: ACCOUNT,
      TWILIO_PHONE_NUMBER: "+15551234567", ...overrides },
  }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = readFileSync(new URL(filename, migrationDirectory), "utf8");
    const statements = migration.replace(/^--.*$/gm, "").split(";").map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  let cookie = "";
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => mf.dispatchFetch(`${ORIGIN}${path}`, {
    method, headers: { Origin: ORIGIN, Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async () => {
    const response = await request("/auth/login", "POST", { password: PASSWORD });
    assert.equal(response.status, 204, await response.clone().text());
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    return cookie;
  };
  const save = async (config: Record<string, unknown> = {}) => {
    const response = await request("/voice/agent", "PUT", { ...agent, ...config });
    assert.equal(response.status, 200, await response.clone().text());
  };
  const create = async (channel = "text", legacyBackchannel = false) => {
    const response = await request("/voice/calls", "POST", { channel });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as { call: { id: string }; websocketUrl: string };
    if (legacyBackchannel) assert.equal((await request(`/__test_legacy_backchannel/${created.call.id}`, "POST")).status, 204);
    return created;
  };
  return { mf, db, request, login, save, create, get cookie() { return cookie; } };
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

function clientTransport(f: Awaited<ReturnType<typeof runtime>>, url: string) {
  let socket: any;
  const frames: string[] = [];
  const transport: VoiceTransport = {
    get connected() { return socket?.readyState === 1; },
    onopen: null, onclose: null, onerror: null, onmessage: null,
    connect() {
      void f.request(new URL(url).pathname, "GET", undefined, { Upgrade: "websocket" }).then((response) => {
        assert.equal(response.status, 101);
        socket = response.webSocket!;
        socket.addEventListener("message", (event: any) => transport.onmessage?.(event.data));
        socket.addEventListener("close", () => transport.onclose?.());
        socket.accept(); transport.onopen?.();
      }).catch((error) => transport.onerror?.(error));
    },
    disconnect() { socket?.close(); },
    sendJSON(value) { frames.push(String(value.type)); socket.send(JSON.stringify(value)); },
    sendBinary(data) { socket.send(data); },
  };
  return { transport, frames };
}

test("admin auth rejects foreign/missing origins, revokes logout, and stores only token hashes", async (t) => {
  const f = await runtime(t);
  assert.equal((await f.request("/health")).status, 200);
  assert.equal((await f.request("/voice/agent")).status, 401);
  assert.equal((await f.request("/auth/login", "POST", { password: PASSWORD }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.mf.dispatchFetch(`${ORIGIN}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).status, 403);
  assert.equal((await f.request("/auth/login", "POST", { password: "wrong" })).status, 401);
  const cookie = await f.login();
  assert.match(cookie, /^__Host-receptionist_session=[a-f0-9]{64}$/);
  const stored = await f.db.prepare("SELECT * FROM sessions").first();
  assert.notEqual(stored!.token_hash, cookie.split("=")[1]);
  assert.equal((await f.request("/voice/agent")).status, 200);
  assert.equal((await f.request("/voice/agent", "PUT", agent, { Origin: "https://evil.example" })).status, 403);
  for (const path of ["/agents/ReceptionistCall/private", "/__inspect"]) assert.equal((await f.request(path)).status, 404);
  assert.equal((await f.request("/auth/logout", "POST")).status, 204);
  assert.equal((await f.request("/voice/agent", "GET", undefined, { Cookie: cookie })).status, 401);
});

test("login attempts are bounded and oversized input is rejected", async (t) => {
  const f = await runtime(t);
  assert.equal((await f.request("/auth/login", "POST", { password: "x".repeat(5000) })).status, 401);
  for (let index = 1; index < 10; index++) assert.equal((await f.request("/auth/login", "POST", { password: "wrong" })).status, 401);
  assert.equal((await f.request("/auth/login", "POST", { password: PASSWORD })).status, 429);
});

test("installed VoiceClient completes a real Agent text turn and persists isolated history", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create();
  const { transport, frames } = clientTransport(f, created.websocketUrl);
  const client = new VoiceClient({ agent: "ReceptionistCall", transport });
  t.after(() => client.disconnect()); client.connect();
  await until(() => client.transcript.length === 1, "Greeting missing");
  assert.deepEqual(frames, ["hello"]);
  client.sendText("Please ask Alex to call me.");
  await until(() => client.transcript.at(-1)?.text === "I can take a message: Please ask Alex to call me.", "Agent reply missing");
  assert.equal(client.error, null);
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>())?.transcript_json.includes("Please ask Alex"), "D1 transcript missing");
  assert.equal((await f.request(`/voice/calls/${created.call.id}`, "DELETE")).status, 409);
  assert.equal((await f.request(`/voice/calls/${created.call.id}/end`, "POST", {})).status, 200);
  assert.equal((await f.request(`/voice/calls/${created.call.id}`, "DELETE")).status, 204);
  assert.equal((await f.request(`/voice/calls/${created.call.id}`)).status, 404);
  const row = await f.db.prepare("SELECT transcript_json,config_json FROM voice_calls WHERE id=?").bind(created.call.id).first();
  assert.deepEqual(row, { transcript_json: "[]", config_json: "{}" });
  const next = await f.create();
  assert.notEqual(next.call.id, created.call.id);
});

test("browser call streams PCM through the real voice pipeline and bounds arbitrary SDK traffic", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create("browser");
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const frames: (string | ArrayBuffer)[] = [];
  socket.addEventListener("message", (event) => frames.push(event.data));
  socket.accept();
  socket.send(JSON.stringify({ type: "start_call" }));
  await until(() => frames.some((frame) => typeof frame !== "string"), "Greeting PCM missing");
  socket.send(new ArrayBuffer(640));
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>())?.transcript_json.includes("Could I leave a message?") ?? false, "STT turn missing");
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>())?.transcript_json.includes("I can take a message: Could I leave a message?") ?? false, "Fast spoken reply missing");
  const transcript = await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>();
  assert.doesNotMatch(transcript!.transcript_json, /Mm-hmm\.|One moment\./);
  socket.send(JSON.stringify({ type: "cf_agent_state", state: { closed: false } }));
  await until(async () => (await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(created.call.id).first())?.status === "failed", "Unauthorized SDK traffic accepted");
});

test("legacy call snapshots retain two short fillers before a slow final answer", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create("browser", true);
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const times: number[] = [];
  socket.addEventListener("message", (event) => { if (typeof event.data !== "string") times.push(Date.now()); });
  socket.accept();
  socket.send(JSON.stringify({ type: "start_call" }));
  await until(() => times.length > 0, "Greeting PCM missing");
  const initialAudio = times.length;
  const started = Date.now();
  socket.send(JSON.stringify({ type: "text_message", text: "waiting model" }));
  await until(() => times.length >= initialAudio + 3, "Filler and final reply PCM missing", 10_000);
  assert.ok(times[initialAudio] - started < 1000, "acknowledgment was not immediate");
  assert.ok(times[initialAudio + 1] - started >= 4500, "holding phrase arrived too early");
  assert.ok(times[initialAudio + 2] - started >= 6000, "final answer arrived too early");
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>())?.transcript_json.includes("I can take a message: waiting model") ?? false, "Final voice transcript missing");
  const stored = await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>();
  assert.match(stored!.transcript_json, /Mm-hmm\./);
  assert.match(stored!.transcript_json, /One moment\./);
  assert.match(stored!.transcript_json, /I can take a message: waiting model/);
});

test("voice TTS requests stay serial across a multi-sentence reply", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create("browser", true);
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const frames: (string | ArrayBuffer)[] = [];
  socket.addEventListener("message", (event) => frames.push(event.data));
  socket.accept();
  socket.send(JSON.stringify({ type: "start_call" }));
  await until(() => frames.some((frame) => typeof frame !== "string"), "Greeting PCM missing");
  await until(async () => ((await (await f.request("/__test_tts_stats")).json()) as { active: number }).active === 0, "Greeting TTS still active");
  await f.request("/__test_tts_stats", "POST");
  socket.send(JSON.stringify({ type: "text_message", text: "multi sentence" }));
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>())?.transcript_json.includes("Third sentence.") ?? false, "Multi-sentence answer missing");
  await until(async () => {
    const stats = await (await f.request("/__test_tts_stats")).json() as { active: number; requests: number };
    return stats.active === 0 && stats.requests >= 3;
  }, "Sentence audio did not finish", 5000);
  const stats = await (await f.request("/__test_tts_stats")).json() as { maxActive: number; requests: number };
  assert.ok(stats.requests >= 3, "reply did not synthesize each sentence");
  assert.equal(stats.maxActive, 1, "TTS provider requests overlapped");
});

test("text calls return slow model replies without voice fillers", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create("text");
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const frames: string[] = [];
  socket.addEventListener("message", (event) => { if (typeof event.data === "string") frames.push(event.data); });
  socket.accept();
  await until(() => frames.some((frame) => frame.includes("Hello, how can I help?")), "Text greeting missing");
  socket.send(JSON.stringify({ type: "text_message", text: "waiting model" }));
  await until(() => frames.some((frame) => frame.includes("I can take a message: waiting model")), "Text reply missing", 8000);
  assert.equal(frames.some((frame) => /Mm-hmm\.|One moment\./.test(frame)), false);
  const stored = await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>();
  assert.doesNotMatch(stored!.transcript_json, /Mm-hmm\.|One moment\./);
});

test("a failed optional holding phrase does not end the call", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create("browser", true);
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const frames: (string | ArrayBuffer)[] = [];
  socket.addEventListener("message", (event) => frames.push(event.data));
  socket.accept();
  socket.send(JSON.stringify({ type: "start_call" }));
  await until(() => frames.some((frame) => typeof frame !== "string"), "Greeting PCM missing");
  socket.send(JSON.stringify({ type: "text_message", text: "filler outage" }));
  await until(() => frames.filter((frame) => typeof frame !== "string").length >= 2, "Acknowledgment PCM missing");
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>())?.transcript_json.includes("I can take a message: filler outage") ?? false, "Final response missing", 10_000);
  assert.equal(frames.some((frame) => typeof frame === "string" && frame.includes('"error"')), false);
  assert.equal((await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(created.call.id).first<{ status: string }>())?.status, "active");
});

test("interrupting a delayed voice turn prevents its fillers and late answer", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create("browser", true);
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const frames: (string | ArrayBuffer)[] = [];
  socket.addEventListener("message", (event) => frames.push(event.data));
  socket.accept();
  socket.send(JSON.stringify({ type: "start_call" }));
  await until(() => frames.some((frame) => typeof frame !== "string"), "Greeting PCM missing");
  socket.send(JSON.stringify({ type: "text_message", text: "waiting model" }));
  await until(() => frames.filter((frame) => typeof frame !== "string").length >= 2, "Acknowledgment PCM missing");
  const interruptedAt = Date.now();
  socket.send(JSON.stringify({ type: "interrupt" }));
  await until(() => frames.some((frame) => typeof frame === "string" && frame.includes('"listening"')), "Interrupt did not return to listening");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, interruptedAt + 800 - Date.now())));
  socket.send(JSON.stringify({ type: "text_message", text: "quick question" }));
  await until(() => frames.some((frame) => typeof frame === "string" && frame.includes("I can take a message: quick question")), "Follow-up reply missing");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, interruptedAt + 7000 - Date.now())));
  const stored = await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ transcript_json: string }>();
  assert.match(stored!.transcript_json, /I can take a message: quick question/);
  assert.doesNotMatch(stored!.transcript_json, /One moment\.|I can take a message: waiting model/);
});

test("call limits are atomic across concurrent starts and deleted calls still count toward the daily limit", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const starts = await Promise.all(Array.from({ length: 4 }, () => f.request("/voice/calls", "POST", { channel: "text" })));
  assert.deepEqual(starts.map((r) => r.status).sort(), [201, 201, 201, 429]);
  const { call } = await starts.find((r) => r.status === 201)!.json() as { call: { id: string } };
  await f.request(`/voice/calls/${call.id}/end`, "POST", {});
  assert.equal((await f.request("/voice/calls", "POST", { channel: "text" })).status, 201);
  await f.db.batch(Array.from({ length: 96 }, (_, index) => f.db.prepare(`INSERT INTO voice_calls(id,user_id,agent_id,channel,status,started_at,ended_at,config_json,deleted_at)
    VALUES(?,'owner',?,'text','completed',?,?, '{}',?)`).bind(`old-${index}`, AGENT, new Date().toISOString(), new Date().toISOString(), new Date().toISOString())));
  const { results } = await f.db.prepare("SELECT id FROM voice_calls WHERE status='active'").all<{ id: string }>();
  for (const row of results) await f.request(`/voice/calls/${row.id}/end`, "POST", {});
  assert.equal((await f.request("/voice/calls", "POST", { channel: "text" })).status, 429);
});

test("provider webhook authentication, destination matching and replay protection survive extraction", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const path = `/voice/twilio/incoming/${AGENT}`;
  const fields = { AccountSid: ACCOUNT, CallSid: SID, To: "+15551234567", From: "+15557654321" };
  const send = (data = fields, signatureOrigin = ORIGIN) => f.mf.dispatchFetch(`${ORIGIN}${path}`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": getExpectedTwilioSignature(TWILIO_TOKEN, `${signatureOrigin}${path}`, data) },
    body: new URLSearchParams(data).toString(),
  });
  assert.equal((await send(fields, "https://evil.example")).status, 403);
  assert.equal((await send({ ...fields, To: "+15559999999" })).status, 403);
  const accepted = await send(); assert.equal(accepted.status, 200);
  const twiml = await accepted.text();
  assert.match(twiml, /<Connect><Stream url="wss:\/\/receptionist.example\/voice\/twilio\/media\//);
  assert.match(await (await send()).text(), /<Hangup \/>/);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM voice_calls WHERE provider_call_id=?").bind(SID).first())?.n, 1);
  const row = await f.db.prepare("SELECT id FROM voice_calls WHERE provider_call_id=?").bind(SID).first<{ id: string }>();
  const mediaPath = `/voice/twilio/media/${row!.id}`;
  const signature = getExpectedTwilioSignature(TWILIO_TOKEN, `${ORIGIN}${mediaPath}`, {});
  const stream = await f.mf.dispatchFetch(`${ORIGIN}${mediaPath}`, { headers: { Upgrade: "websocket", "X-Twilio-Signature": signature } });
  assert.equal(stream.status, 101);
  const socket = stream.webSocket!;
  const frames: string[] = [];
  socket.addEventListener("message", (event) => { if (typeof event.data === "string") frames.push(event.data); });
  socket.accept();
  const streamSid = `MZ${"c".repeat(32)}`;
  socket.send(JSON.stringify({ event: "start", start: { callSid: SID, accountSid: ACCOUNT, streamSid,
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    customParameters: { token: twiml.match(/name="token" value="([a-f0-9]+)"/)![1] },
  } }));
  await until(() => frames.some((frame) => JSON.parse(frame).event === "media"), "Carrier greeting audio missing");
  socket.send(JSON.stringify({ event: "media", streamSid, media: { track: "inbound", payload: btoa("\xff".repeat(160)) } }));
  await until(async () => (await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(row!.id).first<{ transcript_json: string }>())?.transcript_json.includes("Could I leave a message?") ?? false, "Carrier audio transcript missing");
  await f.request(`/voice/calls/${row!.id}/end`, "POST", {});
  await f.request(`/voice/calls/${row!.id}`, "DELETE");
  assert.match(await (await send()).text(), /<Hangup \/>/);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM voice_calls WHERE provider_call_id=?").bind(SID).first())?.n, 1);
});

test("Telnyx verifies the raw signed webhook, timestamp, account and application", async (t) => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  const account = "11111111-1111-4111-8111-111111111111";
  const connection = "123456789";
  const f = await runtime(t, { TELNYX_API_KEY: "fixture-api-key", TELNYX_PUBLIC_KEY: publicKey,
    TELNYX_ACCOUNT_SID: account, TELNYX_CONNECTION_ID: connection, TELNYX_PHONE_NUMBER: "+15557654321" });
  await f.login(); await f.save();
  const path = `/voice/telnyx/incoming/${AGENT}`;
  const fields = { AccountSid: account, ConnectionId: connection, CallSid: "v3:fixture-call", To: "+15557654321" };
  const send = async (values = fields, timestamp = Math.floor(Date.now() / 1000), tamper = false) => {
    const body = new URLSearchParams(values).toString();
    const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey,
      new TextEncoder().encode(`${timestamp}|${body}`))).toString("base64");
    return f.mf.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", headers: {
      "Content-Type": "application/x-www-form-urlencoded", "telnyx-timestamp": String(timestamp), "telnyx-signature-ed25519": signature,
    }, body: tamper ? `${body}&From=changed` : body });
  };
  assert.equal((await send(fields, Math.floor(Date.now() / 1000) - 600)).status, 403);
  assert.equal((await send(fields, Math.floor(Date.now() / 1000), true)).status, 403);
  assert.equal((await send({ ...fields, ConnectionId: "999" })).status, 403);
  assert.equal((await send({ ...fields, AccountSid: "22222222-2222-4222-8222-222222222222" })).status, 403);
  const response = await send(); assert.equal(response.status, 200);
  assert.match(await response.text(), /codec="PCMU"/);
  assert.match(await (await send()).text(), /<Hangup \/>/);
});

test("Telnyx SID discovery logs only verified mapped identities and never creates a call", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  const account = "11111111-1111-4111-8111-111111111111";
  const connection = "123456789";
  let databaseCalls = 0;
  const env = { VOICE_ENABLED: "true", VOICE_PUBLIC_ORIGIN: ORIGIN, AI: {}, RECEPTIONIST_CALL: {},
    TELNYX_API_KEY: "fixture-api-key", TELNYX_PUBLIC_KEY: publicKey, TELNYX_ACCOUNT_SID: "",
    TELNYX_CONNECTION_ID: connection, TELNYX_PHONE_NUMBER: "+15557654321",
    DB: { prepare() { databaseCalls++; throw new Error("SID discovery must not access call storage"); } },
  } as unknown as Env;
  const path = `/voice/telnyx/incoming/${AGENT}`;
  const fields = { AccountSid: account, ConnectionId: connection, CallSid: "v3:fixture-call", To: "+15557654321" };
  async function send(values = fields, options: { path?: string; timestamp?: number; signed?: boolean } = {}) {
    const body = new URLSearchParams(values).toString();
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey,
      new TextEncoder().encode(`${timestamp}|${body}`))).toString("base64");
    return handleTelnyxRequest(new Request(`${ORIGIN}${options.path ?? path}`, { method: "POST", headers: {
      "Content-Type": "application/x-www-form-urlencoded", "telnyx-timestamp": String(timestamp),
      ...(options.signed === false ? {} : { "telnyx-signature-ed25519": signature }),
    }, body }), env);
  }
  assert.equal((await send(fields, { signed: false })).status, 403);
  assert.equal((await send(fields, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 403);
  assert.equal((await send({ ...fields, ConnectionId: "999" })).status, 403);
  assert.equal((await send({ ...fields, To: "+15550000000" })).status, 403);
  assert.equal((await send({ ...fields, CallSid: "invalid" })).status, 403);
  assert.equal((await send(fields, { path: `/voice/telnyx/incoming/${crypto.randomUUID()}` })).status, 403);
  assert.equal((await send({ ...fields, AccountSid: "untrusted\nlog-injection" })).status, 503);
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === "voice_telnyx_account_sid_missing_or_invalid"));
  assert.ok(warnings.mock.calls.every((call) => !JSON.stringify(call.arguments).includes(account) && !JSON.stringify(call.arguments).includes("log-injection")));
  const response = await send();
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
  const discovery = warnings.mock.calls.filter((call) => call.arguments[0] === "voice_telnyx_account_sid_required");
  assert.equal(discovery.length, 1);
  assert.deepEqual(JSON.parse(discovery[0].arguments[1]), {
    AccountSid: account, ConnectionId: connection,
  });
  assert.equal(databaseCalls, 0);
  assert.equal(env.TELNYX_ACCOUNT_SID, "");
  assert.equal((await handleTelnyxRequest(new Request(`${ORIGIN}/voice/telnyx/media/${crypto.randomUUID()}`, {
    headers: { Upgrade: "websocket" },
  }), env)).status, 503);
});

test("failed phone cleanup stays active and non-deletable until the provider hangup retry succeeds", async (t) => {
  const f = await runtime(t, { TEST_HANGUP_FAILURES: "100" }); await f.login(); await f.save();
  const path = `/voice/twilio/incoming/${AGENT}`;
  const fields = { AccountSid: ACCOUNT, CallSid: SID, To: "+15551234567" };
  const incoming = await f.mf.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", headers: {
    "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": getExpectedTwilioSignature(TWILIO_TOKEN, `${ORIGIN}${path}`, fields),
  }, body: new URLSearchParams(fields).toString() });
  assert.equal(incoming.status, 200);
  const twiml = await incoming.text();
  const row = await f.db.prepare("SELECT id FROM voice_calls WHERE provider_call_id=?").bind(SID).first<{ id: string }>();
  const mediaPath = `/voice/twilio/media/${row!.id}`;
  const response = await f.mf.dispatchFetch(`${ORIGIN}${mediaPath}`, { headers: { Upgrade: "websocket",
    "X-Twilio-Signature": getExpectedTwilioSignature(TWILIO_TOKEN, `${ORIGIN}${mediaPath}`, {}),
  } });
  assert.equal(response.status, 101);
  const frames: string[] = [];
  response.webSocket!.addEventListener("message", (event) => { if (typeof event.data === "string") frames.push(event.data); });
  response.webSocket!.accept();
  const streamSid = `MZ${"d".repeat(32)}`;
  response.webSocket!.send(JSON.stringify({ event: "start", start: { callSid: SID, accountSid: ACCOUNT, streamSid,
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    customParameters: { token: twiml.match(/name="token" value="([a-f0-9]+)"/)![1] },
  } }));
  await until(() => frames.some((frame) => JSON.parse(frame).event === "media"), "Carrier stream was not established");
  response.webSocket!.send(JSON.stringify({ event: "invalid_event", streamSid }));
  await until(async () => {
    const state = await (await f.request(`/__test_state/${row!.id}`)).json() as { closed?: boolean; phoneEnded?: boolean };
    return Boolean(state.closed && !state.phoneEnded);
  }, "Carrier hangup failure did not leave retry state");
  assert.equal((await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(row!.id).first())?.status, "active");
  assert.equal((await f.request(`/voice/calls/${row!.id}`, "DELETE")).status, 409);
  assert.equal((await f.request(`/__test_allow_hangup/${row!.id}`)).status, 204);
  assert.equal((await f.request(`/voice/calls/${row!.id}/end`, "POST", {})).status, 200);
  assert.equal((await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(row!.id).first())?.status, "failed");
  assert.equal((await f.request(`/voice/calls/${row!.id}`, "DELETE")).status, 204);
});

test("a late bridge failure upgrades a completed call and cannot later be overwritten by a normal close", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create();
  await f.request(`/voice/calls/${created.call.id}/end`, "POST", {});
  assert.equal((await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(created.call.id).first())?.status, "completed");
  assert.equal((await f.request(`/__test_fail/${created.call.id}`)).status, 204);
  await f.request(`/voice/calls/${created.call.id}/end`, "POST", {});
  assert.equal((await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(created.call.id).first())?.status, "failed");
});

test("model failures end a call without disclosing provider errors", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create();
  const { transport } = clientTransport(f, created.websocketUrl);
  const client = new VoiceClient({ agent: "ReceptionistCall", transport });
  const messages: string[] = [];
  client.addEventListener("error", (error) => { if (error) messages.push(error); });
  t.after(() => client.disconnect()); client.connect();
  await until(() => client.transcript.length === 1, "Greeting missing");
  client.sendText("cause model failure");
  await until(async () => (await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(created.call.id).first())?.status === "failed", "Failed inference did not close call");
  assert.ok(messages.every((message) => !message.includes("Private fixture")));
});

test("retention redacts old transcripts and instructions while preserving webhook tombstones", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const created = await f.create(); await f.request(`/voice/calls/${created.call.id}/end`, "POST", {});
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  await f.db.prepare("UPDATE voice_calls SET ended_at=?,transcript_json=?,provider_call_id=? WHERE id=?")
    .bind(old, '[{"role":"user","text":"private message"}]', SID, created.call.id).run();
  assert.equal((await f.request("/__test_cleanup")).status, 204);
  assert.equal((await f.request(`/voice/calls/${created.call.id}`)).status, 404);
  const row = await f.db.prepare("SELECT transcript_json,config_json,provider_call_id FROM voice_calls WHERE id=?").bind(created.call.id).first();
  assert.deepEqual(row, { transcript_json: "[]", config_json: "{}", provider_call_id: SID });
});

async function spokenCall(t: TestContext, f: Awaited<ReturnType<typeof runtime>>) {
  const created = await f.create("browser");
  const response = await f.request(new URL(created.websocketUrl).pathname, "GET", undefined, { Upgrade: "websocket" });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const audio: number[] = [];
  const messages: Array<{ type: string; text?: string; status?: string }> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(JSON.parse(event.data));
    else audio.push(new Int16Array(event.data)[0]);
  });
  socket.accept();
  t.after(() => { try { socket.close(); } catch { /* Already closed. */ } });
  socket.send(JSON.stringify({ type: "start_call" }));
  await until(() => audio.length === 1, "Greeting missing");
  return { socket, audio, messages, id: created.call.id };
}

test("voice settings validate selections, persist, and freeze each call's speech configuration", async (t) => {
  const f = await runtime(t); await f.login(); await f.save();
  const initial = await (await f.request("/voice/agent")).json() as { agent: Record<string, unknown> };
  assert.equal(initial.agent.voiceLogic, "original_no_reply");
  assert.equal(initial.agent.model, "aura-1");
  assert.equal(initial.agent.language, "en");
  for (const selection of [
    { voiceLogic: "unknown" }, { model: "unknown" }, { language: "unknown" },
    { model: "aura-1", language: "es", voice: "celeste" },
    { model: "aura-2", language: "es", voice: "asteria" },
  ]) assert.equal((await f.request("/voice/agent", "PUT", { ...agent, ...selection })).status, 400);
  assert.equal((await f.request("/voice/agent", "PUT", { ...agent, model: "sonic-3.6", voice: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" })).status, 503);
  await f.save({ model: "aura-2", language: "es", voice: "celeste", voiceLogic: "reply_right_away" });
  const created = await f.create();
  await f.save();
  const frozen = await f.db.prepare("SELECT config_json FROM voice_calls WHERE id=?").bind(created.call.id).first<{ config_json: string }>();
  const config = JSON.parse(frozen!.config_json);
  assert.equal(config.model, "aura-2");
  assert.equal(config.language, "es");
  assert.equal(config.voice, "celeste");
  assert.equal(config.voiceLogic, "reply_right_away");
  const advertised = await (await f.request("/voice/config")).json() as { speech: { models: Array<{ id: string; available: boolean }> } };
  assert.deepEqual(advertised.speech.models.map(({ id, available }) => [id, available]), [
    ["aura-1", true], ["aura-2", true], ["aura-2-gateway", false], ["sonic-3.6", false],
  ]);
});

test("original_no_reply waits for the full answer without optional speech", async (t) => {
  const f = await runtime(t, { TEST_REPLY_DELAY_MS: "350" }); await f.login(); await f.save();
  const call = await spokenCall(t, f);
  call.socket.send(new ArrayBuffer(640));
  await until(async () => (await (await f.request("/__test_inference")).json() as Array<{ model: string }>).some(({ model }) => model.includes("/llama-")), "Reply inference missing");
  assert.deepEqual(call.audio, [0]);
  await until(() => call.audio.length === 2, "Full answer missing");
  const stats = await (await f.request("/__test_tts_stats")).json() as { requests: number };
  assert.equal(stats.requests, 2, "Original mode should only synthesize its greeting and answer");
});

test("reply_right_away rotates cached cues before whole replies without adding them to history", async (t) => {
  const f = await runtime(t, { TEST_REPLY_DELAY_MS: "150" }); await f.login(); await f.save({ voiceLogic: "reply_right_away" });
  const call = await spokenCall(t, f);
  assert.deepEqual(call.audio, [0], "Cue preparation must be silent");
  for (let turn = 0; turn < 4; turn++) {
    call.socket.send(JSON.stringify({ type: "text_message", text: "multi sentence" }));
    await until(() => call.audio.length >= 2 + turn * 2, "Immediate cue missing", 500);
    assert.equal(call.audio[1 + turn * 2], 1000 + turn % 3 * 2000);
    await until(() => call.audio.length === 3 + turn * 2, "Whole answer missing");
    await until(async () => {
      const stored = await f.db.prepare("SELECT transcript_json FROM voice_calls WHERE id=?").bind(call.id).first<{ transcript_json: string }>();
      return JSON.parse(stored!.transcript_json).length === 3 + turn * 2;
    }, "Saved answer missing");
  }
  assert.deepEqual(call.audio, [0, 1000, 2000, 3000, 2000, 5000, 2000, 1000, 2000]);
  const stored = await f.db.prepare("SELECT transcript_json,status FROM voice_calls WHERE id=?").bind(call.id).first<{ transcript_json: string; status: string }>();
  assert.equal(stored!.status, "active");
  assert.doesNotMatch(stored!.transcript_json, /One second please|Got it, just a sec|I see, let me think/);
  const stats = await (await f.request("/__test_tts_stats")).json() as { requests: number; maxActive: number };
  assert.equal(stats.requests, 8, "Prepare three clips once, one greeting, and one complete TTS request per reply");
  assert.equal(stats.maxActive, 1);
  assert.equal(call.messages.some(({ type }) => type === "error"), false);
});

for (const failure of ["provider", "odd_pcm", "empty_pcm"]) {
  test(`reply_right_away tolerates ${failure} optional clip failures without retrying or ending the call`, async (t) => {
    const f = await runtime(t, { TEST_CUE_FAILURE: failure }); await f.login(); await f.save({ voiceLogic: "reply_right_away" });
    const call = await spokenCall(t, f);
    for (let turn = 0; turn < 2; turn++) {
      call.socket.send(JSON.stringify({ type: "text_message", text: `Question ${turn}` }));
      await until(() => call.audio.length === turn + 2, "Answer missing after optional clip failure");
    }
    assert.deepEqual(call.audio, [0, 2000, 2000]);
    const stats = await (await f.request("/__test_tts_stats")).json() as { requests: number };
    assert.equal(stats.requests, 4, "Failed preparation must never retry during turns");
    assert.equal(call.messages.some(({ type }) => type === "error"), false);
    const state = await (await f.request(`/__test_state/${call.id}`)).json() as { closed: boolean };
    assert.equal(state.closed, false);
  });
}

test("reply_right_away keeps cached clips prepared before an optional failure", async (t) => {
  const f = await runtime(t, { TEST_CUE_FAILURE: "provider", TEST_CUE_FAILURE_TEXT: "Got it, just a sec." });
  await f.login(); await f.save({ voiceLogic: "reply_right_away" });
  const call = await spokenCall(t, f);
  for (let turn = 0; turn < 2; turn++) {
    call.socket.send(JSON.stringify({ type: "text_message", text: `Question ${turn}` }));
    await until(() => call.audio.length === 3 + turn * 2, "Answer missing after partial preparation");
  }
  assert.deepEqual(call.audio, [0, 1000, 2000, 1000, 2000]);
  const stats = await (await f.request("/__test_tts_stats")).json() as { requests: number };
  assert.equal(stats.requests, 5);
});

test("reply_right_away interruption accepts a rapid correction and suppresses stale and post-hangup audio", async (t) => {
  const f = await runtime(t, { TEST_MULTI_TURN: "true", TEST_REPLY_DELAY_MS: "350" });
  await f.login(); await f.save({ voiceLogic: "reply_right_away" });
  const call = await spokenCall(t, f);
  call.socket.send(new ArrayBuffer(640));
  await until(() => call.audio.length === 2, "First cue missing");
  call.socket.send(new ArrayBuffer(640));
  await until(() => call.audio.length === 3, "Rapid correction cue missing");
  assert.ok(call.messages.some(({ type }) => type === "playback_interrupt"));
  await until(() => call.audio.length === 4, "Replacement answer missing");
  assert.deepEqual(call.audio, [0, 1000, 3000, 2000]);
  const replies = call.messages.filter(({ type }) => type === "transcript_end").map(({ text }) => text);
  assert.ok(!replies.includes("I can take a message: Could I leave a message?"));
  assert.ok(replies.includes("I can take a message: Could I change that message?"));
  call.socket.send(new ArrayBuffer(640));
  await until(() => call.audio.length === 5, "Third cue missing");
  assert.equal((await f.request(`/voice/calls/${call.id}/end`, "POST", {})).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(call.audio, [0, 1000, 3000, 2000, 5000]);
  assert.equal(call.messages.some(({ type }) => type === "error"), false);
});

test("reply_right_away text calls do not prepare or play speech", async (t) => {
  const f = await runtime(t); await f.login(); await f.save({ voiceLogic: "reply_right_away" });
  const created = await f.create("text");
  const { transport } = clientTransport(f, created.websocketUrl);
  const client = new VoiceClient({ agent: "ReceptionistCall", transport });
  t.after(() => client.disconnect()); client.connect();
  await until(() => client.transcript.length === 1, "Text greeting missing");
  client.sendText("Please take a message.");
  await until(() => client.transcript.length === 3, "Text reply missing");
  const stats = await (await f.request("/__test_tts_stats")).json() as { requests: number };
  assert.equal(stats.requests, 0);
  assert.equal(client.error, null);
});

test("all ten languages complete spoken turns through their selected speech and reply models", async (t) => {
  const f = await runtime(t, { VOICE_AI_GATEWAY_ACCOUNT_ID: "a".repeat(32), VOICE_AI_GATEWAY_ID: "voice", CARTESIA_API_KEY: "test" });
  await f.login();
  for (const language of ["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"]) {
    await f.save({ model: "sonic-3.6", language, voice: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" });
    await f.request("/__test_inference", "POST");
    const call = await spokenCall(t, f);
    call.socket.send(new ArrayBuffer(640));
    await until(() => call.audio.length === 2, `${language} speech reply missing`);
    const requests = await (await f.request("/__test_inference")).json() as Array<{ model: string; input: Record<string, unknown> }>;
    assert.deepEqual(new Set(requests.map(({ model }) => model)), new Set([
      "cartesia/sonic-3.6", language === "en" ? "@cf/deepgram/flux" : "@cf/deepgram/nova-3",
      language === "en" ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast" : "@cf/google/gemma-4-26b-a4b-it",
    ]), language);
    assert.equal(requests.filter(({ model }) => model === "cartesia/sonic-3.6").every(({ input }) => input.language === language), true);
    if (language !== "en") {
      assert.equal(requests.find(({ model }) => model.includes("/nova-3"))!.input.language, language);
      assert.deepEqual(requests.find(({ model }) => model.includes("/gemma-4"))!.input.chat_template_kwargs, { enable_thinking: false });
    }
    assert.equal((await f.request(`/voice/calls/${call.id}/end`, "POST", {})).status, 200);
  }
});

test("native Spanish and gateway French use localized prepared cues and keep speech selections", async (t) => {
  const f = await runtime(t, { VOICE_AI_GATEWAY_ACCOUNT_ID: "a".repeat(32), VOICE_AI_GATEWAY_ID: "voice", DEEPGRAM_API_KEY: "test" });
  await f.login();
  for (const selection of [
    { model: "aura-2", language: "es", voice: "celeste", cue: "Un momento, por favor." },
    { model: "aura-2-gateway", language: "fr", voice: "agathe", cue: "Un instant, s’il vous plaît." },
  ]) {
    const { cue, ...config } = selection;
    await f.save({ ...config, voiceLogic: "reply_right_away" });
    await f.request("/__test_inference", "POST");
    const call = await spokenCall(t, f);
    call.socket.send(new ArrayBuffer(640));
    await until(() => call.audio.length === 3, `${selection.language} cue or reply missing`);
    const requests = await (await f.request("/__test_inference")).json() as Array<{ model: string; input: Record<string, unknown> }>;
    const speech = requests.filter(({ model }) => model.includes("aura-2"));
    assert.equal(speech.length, 5);
    assert.equal(speech[0].input.text, cue);
    assert.equal((await f.request(`/voice/calls/${call.id}/end`, "POST", {})).status, 200);
  }
});

test("Nova speech-start interrupts pending non-English replies without client VAD", async (t) => {
  const f = await runtime(t, { TEST_MULTI_TURN: "true", TEST_NOVA_SPEECH_START_ONLY: "true", TEST_REPLY_DELAY_MS: "350" });
  await f.login(); await f.save({ model: "aura-2", language: "es", voice: "celeste" });
  const call = await spokenCall(t, f);
  call.socket.send(new ArrayBuffer(640));
  await until(async () => (await (await f.request("/__test_inference")).json() as Array<{ model: string }>).some(({ model }) => model.includes("/gemma-4")), "Spanish inference missing");
  const interruptions = call.messages.filter(({ type }) => type === "playback_interrupt").length;
  call.socket.send(new ArrayBuffer(640));
  await until(() => call.messages.filter(({ type }) => type === "playback_interrupt").length > interruptions, "Provider VAD did not interrupt reply");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(call.audio, [0], "Interrupted reply must not produce speech");
});

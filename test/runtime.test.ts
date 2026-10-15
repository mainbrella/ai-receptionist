import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { VoiceClient, type VoiceTransport } from "@cloudflare/voice/client";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";

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
  const migration = readFileSync(new URL("../migrations/0001_receptionist.sql", import.meta.url), "utf8");
  for (const statement of migration.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
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
  const save = async () => {
    const response = await request("/voice/agent", "PUT", agent);
    assert.equal(response.status, 200, await response.clone().text());
  };
  const create = async (channel = "text") => {
    const response = await request("/voice/calls", "POST", { channel });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json() as Promise<{ call: { id: string }; websocketUrl: string }>;
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
  socket.send(JSON.stringify({ type: "cf_agent_state", state: { closed: false } }));
  await until(async () => (await f.db.prepare("SELECT status FROM voice_calls WHERE id=?").bind(created.call.id).first())?.status === "failed", "Unauthorized SDK traffic accepted");
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
  const response = await send(); assert.equal(response.status, 200);
  assert.match(await response.text(), /codec="PCMU"/);
  assert.match(await (await send()).text(), /<Hangup \/>/);
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

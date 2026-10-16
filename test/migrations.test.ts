import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const migrations = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UPDATED_AT = "2026-10-01T12:00:00.000Z";
const legacyConfig = JSON.stringify({
  id: AGENT_ID, name: "Maya", businessName: "Workshop", greeting: "Hello!",
  instructions: "Take a message.", voice: "asteria", transferNumber: null, updatedAt: UPDATED_AT,
});

type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

async function database(t: TestContext) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "migration-test", modules: true,
    script: "export default { fetch() { return new Response('OK'); } };",
    compatibilityDate: "2026-09-18", d1Databases: ["DB"],
  }] }));
  t.after(() => mf.dispose());
  return mf.getD1Database("DB");
}

async function migrate(db: Database, file: string) {
  const statements = readFileSync(new URL(file, migrations), "utf8")
    .replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter(Boolean);
  // Wrangler runs each migration transactionally. In particular, the parent
  // table rebuild needs deferred foreign keys for the whole migration batch.
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

async function insertLegacyAgent(db: Database) {
  await db.prepare(`INSERT INTO voice_agents
    (id,user_id,name,business_name,greeting,instructions,voice,updated_at)
    VALUES(?,'owner','Maya','Workshop','Hello!','Take a message.','asteria',?)`)
    .bind(AGENT_ID, UPDATED_AT).run();
}

test("upgrading a populated installation preserves agents, calls, and frozen legacy settings", async (t) => {
  const db = await database(t);
  await migrate(db, "0001_receptionist.sql");
  await insertLegacyAgent(db);
  await db.batch([
    db.prepare(`INSERT INTO voice_calls
      (id,user_id,agent_id,channel,status,started_at,ended_at,transcript_json,config_json,provider_call_id,phone_transport,phone_provider)
      VALUES('finished-call','owner',?,'phone','completed',?,?,?,?,'provider-call','pstn','telnyx')`)
      .bind(AGENT_ID, UPDATED_AT, "2026-10-01T12:01:00.000Z", '[{"role":"user","text":"Please call back."}]', legacyConfig),
    db.prepare(`INSERT INTO voice_calls(id,user_id,agent_id,channel,status,started_at,config_json)
      VALUES('active-call','owner',?,'browser','active',?,?)`).bind(AGENT_ID, UPDATED_AT, legacyConfig),
  ]);
  const oldAgent = await db.prepare("SELECT * FROM voice_agents").first();
  const oldCalls = (await db.prepare("SELECT * FROM voice_calls ORDER BY id").all()).results;

  for (const file of migrationFiles.filter((name) => name !== "0001_receptionist.sql")) await migrate(db, file);

  assert.deepEqual(await db.prepare("SELECT * FROM voice_agents").first(), {
    ...oldAgent, voice_logic: "original_no_reply", model: "aura-1", language: "en",
  });
  assert.deepEqual((await db.prepare("SELECT * FROM voice_calls ORDER BY id").all()).results, oldCalls);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);

  const cartesiaVoice = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
  await db.prepare("UPDATE voice_agents SET model='sonic-3.6',language='ja',voice=?,voice_logic='reply_right_away' WHERE id=?")
    .bind(cartesiaVoice, AGENT_ID).run();
  assert.deepEqual(await db.prepare("SELECT model,language,voice,voice_logic FROM voice_agents").first(), {
    model: "sonic-3.6", language: "ja", voice: cartesiaVoice, voice_logic: "reply_right_away",
  });
  assert.deepEqual((await db.prepare("SELECT * FROM voice_calls ORDER BY id").all()).results, oldCalls);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal((await db.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>())?.foreign_keys, 1);
});

test("fresh installation supports new speech settings and retains owner and call integrity", async (t) => {
  const db = await database(t);
  for (const file of migrationFiles) await migrate(db, file);
  await insertLegacyAgent(db);
  assert.deepEqual(await db.prepare("SELECT model,language,voice_logic FROM voice_agents").first(), {
    model: "aura-1", language: "en", voice_logic: "original_no_reply",
  });
  await db.prepare("UPDATE voice_agents SET model='aura-2',language='es',voice='celeste' WHERE id=?").bind(AGENT_ID).run();
  await db.prepare(`INSERT INTO voice_calls(id,user_id,agent_id,channel,started_at,config_json)
    VALUES('new-call','owner',?,'text',?,?)`).bind(AGENT_ID, UPDATED_AT, legacyConfig).run();
  await db.prepare("INSERT INTO number_search_attempts(bucket,attempts,expires_at) VALUES('owner:1',1,1000)").run();
  assert.deepEqual(await db.prepare("SELECT model,language,voice FROM voice_agents").first(), {
    model: "aura-2", language: "es", voice: "celeste",
  });
  await assert.rejects(db.prepare("UPDATE voice_agents SET user_id='another-user'").run(), /CHECK constraint failed/);
  await assert.rejects(db.prepare("UPDATE voice_calls SET agent_id='missing-agent'").run(), /FOREIGN KEY constraint failed/);
  await assert.rejects(db.prepare("DELETE FROM voice_agents WHERE id=?").bind(AGENT_ID).run(), /FOREIGN KEY constraint failed/);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM voice_calls").first<{ count: number }>())?.count, 1);
});

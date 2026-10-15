-- A single installation owns one receptionist; no Mainbrella users or wallet.
CREATE TABLE voice_agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE CHECK (user_id = 'owner'),
  name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  greeting TEXT NOT NULL,
  instructions TEXT NOT NULL,
  voice TEXT NOT NULL CHECK (voice IN ('asteria', 'luna', 'athena')),
  updated_at TEXT NOT NULL
);

CREATE TABLE voice_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CHECK (user_id = 'owner'),
  agent_id TEXT NOT NULL REFERENCES voice_agents(id),
  channel TEXT NOT NULL CHECK (channel IN ('browser', 'text', 'phone')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL,
  provider_call_id TEXT UNIQUE,
  media_token_hash TEXT,
  media_token_expires_at TEXT,
  connected_at TEXT,
  phone_transport TEXT CHECK (phone_transport IN ('pstn', 'sip')),
  phone_provider TEXT CHECK (phone_provider IN ('twilio', 'telnyx')),
  deleted_at TEXT
);

CREATE INDEX voice_calls_started ON voice_calls(user_id, started_at DESC);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

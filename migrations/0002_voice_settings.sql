-- Rebuild to remove the original three-voice restriction while retaining calls.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE voice_agents_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE CHECK (user_id = 'owner'),
  name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  greeting TEXT NOT NULL,
  instructions TEXT NOT NULL,
  voice TEXT NOT NULL,
  voice_logic TEXT NOT NULL DEFAULT 'original_no_reply'
    CHECK (voice_logic IN ('original_no_reply', 'reply_right_away')),
  model TEXT NOT NULL DEFAULT 'aura-1'
    CHECK (model IN ('aura-1', 'aura-2', 'aura-2-gateway', 'sonic-3.6')),
  language TEXT NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl')),
  updated_at TEXT NOT NULL
);

INSERT INTO voice_agents_next (id,user_id,name,business_name,greeting,instructions,voice,updated_at)
  SELECT id,user_id,name,business_name,greeting,instructions,voice,updated_at FROM voice_agents;
DROP TABLE voice_agents;
ALTER TABLE voice_agents_next RENAME TO voice_agents;

PRAGMA defer_foreign_keys = OFF;

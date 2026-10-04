-- Fetch prototype schema. Apply with: npm run db:migrate -w server  (needs DATABASE_URL)
CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  twenty_contact_id TEXT,
  twenty_object_type TEXT,
  contact_name      TEXT NOT NULL,
  phone_number      TEXT NOT NULL,
  caller_id         TEXT,
  telnyx_call_id    TEXT,
  status            TEXT NOT NULL,
  disposition       TEXT,
  notes             TEXT,
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  duration_seconds  INTEGER,
  twenty_note_id    TEXT,
  logged_at         TIMESTAMPTZ,
  last_log_error    TEXT,
  session_id        TEXT,
  rep_email         TEXT,
  blocked_reasons   JSONB,
  recording_status  TEXT,
  recording_url     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added in Phase 2 (embed). Idempotent for databases created before the column existed.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS twenty_object_type TEXT;
-- Added in 0.4 (per-call caller ID).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_id TEXT;
-- Added in 0.4 (call recording).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT;

CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls (twenty_contact_id);
CREATE INDEX IF NOT EXISTS calls_unlogged_idx ON calls (created_at DESC) WHERE twenty_note_id IS NULL;

-- Fetch Guard rules and other key/value settings (DNC list, permissions, calling hours)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

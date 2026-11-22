-- The Couple server: pairs, their devices, messages and cross-reminders.
CREATE TABLE IF NOT EXISTS pairs (
  pair_id      TEXT PRIMARY KEY,
  code         TEXT,              -- one-use pairing code, cleared once used
  code_expires INTEGER,
  created      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pairs_code ON pairs (code);

CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  pair_id       TEXT NOT NULL,
  name          TEXT,
  status        TEXT,
  focus_minutes INTEGER DEFAULT 0,
  hearts        INTEGER DEFAULT 0,
  last_seen     INTEGER
);
CREATE INDEX IF NOT EXISTS devices_pair ON devices (pair_id);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id     TEXT NOT NULL,
  from_device TEXT NOT NULL,
  to_device   TEXT NOT NULL,
  kind        TEXT NOT NULL,     -- note | nudge | heart | session | tattle
  text        TEXT,
  at          INTEGER NOT NULL,
  delivered   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (to_device, delivered);

CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id     TEXT NOT NULL,
  from_device TEXT NOT NULL,
  to_device   TEXT NOT NULL,
  text        TEXT NOT NULL,
  due         INTEGER NOT NULL,  -- epoch ms
  repeat      TEXT,              -- daily | weekdays | null
  active      INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (to_device, active, due);

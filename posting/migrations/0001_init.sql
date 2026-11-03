-- Posting server state. Times are ms since 1970. Secrets are never stored in the clear (see src/crypto.ts).
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- 's_' + 32 hex
  token_hash TEXT NOT NULL UNIQUE,  -- hex SHA-256 of the session token
  sid TEXT NOT NULL,                -- the purchase (Stripe Checkout Session id)
  plan TEXT NOT NULL,               -- 'monthly' | 'once'
  device TEXT NOT NULL,             -- 'Windows' | 'Mac' | 'Linux'
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL     -- updated at most once an hour
);
CREATE INDEX sessions_sid ON sessions (sid);

CREATE TABLE oauth_attempts (
  id TEXT PRIMARY KEY,              -- 'a_' + 32 hex (the app polls with it)
  sid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 'youtube'
  begin_hash TEXT NOT NULL,         -- SHA-256 of the one-time token in openUrl
  state TEXT UNIQUE,                -- set at /begin, cleared at the outcome
  code_verifier TEXT,               -- set at /begin, cleared at the outcome
  cookie_hash TEXT,                 -- set at /begin, cleared at the outcome
  status TEXT NOT NULL,             -- waiting|opened|connected|denied|missing_permission|no_channel|failed|cancelled
  connection_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_attempts_sid ON oauth_attempts (sid);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,              -- 'c_' + 32 hex; also the AES-GCM associated data
  sid TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 'youtube'
  status TEXT NOT NULL,             -- connected|reconnect
  scopes TEXT NOT NULL,             -- granted, space-separated
  channel_id TEXT,
  channel_name TEXT,
  channel_handle TEXT,              -- '@handle' or null
  channel_checked_at INTEGER,       -- channel fields are refreshed or cleared within 30 days
  refresh_enc TEXT,                 -- null once it needs reconnecting
  access_enc TEXT,
  access_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (sid, platform)
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,              -- 'u_' + 32 hex
  sid TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,             -- uploading|done|failed|cancelled|expired
  privacy_requested TEXT NOT NULL,
  privacy TEXT,                     -- what YouTube set
  video_id TEXT,
  error TEXT,                       -- Google's reason, e.g. 'uploadLimitExceeded'
  session_uri_enc TEXT,             -- null once finished
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX uploads_sid ON uploads (sid);
CREATE INDEX uploads_connection ON uploads (connection_id);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,             -- '<bucket>:<window>:<who>'
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

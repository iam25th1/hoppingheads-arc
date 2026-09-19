-- Append to schema.sql (after existing tables)

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  event_name  VARCHAR(64) NOT NULL,
  twitter_id  VARCHAR(32),
  username    VARCHAR(32),
  session_id  VARCHAR(64),
  ip_hash     VARCHAR(64),
  country     VARCHAR(4),
  device      VARCHAR(16),
  referrer    VARCHAR(256),
  props       JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_twitter ON events(twitter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS user_first_seen (
  twitter_id   VARCHAR(32) PRIMARY KEY,
  username     VARCHAR(32),
  first_seen   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  total_games  INT DEFAULT 0,
  total_mints  INT DEFAULT 0,
  country      VARCHAR(4)
);
CREATE INDEX IF NOT EXISTS idx_user_last_seen ON user_first_seen(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_user_first_seen ON user_first_seen(first_seen DESC);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day            DATE PRIMARY KEY,
  dau            INT DEFAULT 0,
  new_users      INT DEFAULT 0,
  total_events   INT DEFAULT 0,
  games_played   INT DEFAULT 0,
  mints          INT DEFAULT 0,
  codes_redeemed INT DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

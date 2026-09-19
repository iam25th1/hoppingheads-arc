-- Mint Rush Database Schema

CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  wallet        VARCHAR(42) UNIQUE NOT NULL,
  display_name  VARCHAR(32),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  total_rounds  INTEGER DEFAULT 0,
  total_wins    INTEGER DEFAULT 0,
  total_score   BIGINT DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  best_streak   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_players_wallet ON players(wallet);

CREATE TABLE IF NOT EXISTS rounds (
  id              SERIAL PRIMARY KEY,
  onchain_id      INTEGER UNIQUE,
  seed            VARCHAR(66),
  theme           VARCHAR(64) NOT NULL,
  theme_hash      VARCHAR(66) NOT NULL,
  status          VARCHAR(16) DEFAULT 'pending',  -- pending, lobby, active, resolving, completed, cancelled
  entry_fee_wei   VARCHAR(78) NOT NULL,
  max_players     SMALLINT NOT NULL DEFAULT 6,
  duration_secs   INTEGER NOT NULL DEFAULT 300,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  winner_wallet   VARCHAR(42),
  prize_pool_wei  VARCHAR(78) DEFAULT '0',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);
CREATE INDEX IF NOT EXISTS idx_rounds_onchain ON rounds(onchain_id);

CREATE TABLE IF NOT EXISTS round_players (
  id          SERIAL PRIMARY KEY,
  round_id    INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
  player_id   INTEGER REFERENCES players(id),
  wallet      VARCHAR(42) NOT NULL,
  score       INTEGER DEFAULT 0,
  placement   SMALLINT,
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(round_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_rp_round ON round_players(round_id);
CREATE INDEX IF NOT EXISTS idx_rp_wallet ON round_players(wallet);

CREATE TABLE IF NOT EXISTS round_assets (
  id            SERIAL PRIMARY KEY,
  round_id      INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
  asset_index   INTEGER NOT NULL,       -- position index in the generated map
  rarity        SMALLINT NOT NULL,      -- 0=Common,1=Uncommon,2=Rare,3=Epic,4=Legendary
  x             FLOAT NOT NULL,
  y             FLOAT NOT NULL,
  name          VARCHAR(64),
  theme_tag     VARCHAR(32),            -- for set bonus grouping
  discovered_by VARCHAR(42),
  minted_by     VARCHAR(42),
  token_id      INTEGER,                -- onchain ERC-1155 token ID
  minted_at     TIMESTAMPTZ,
  metadata_uri  VARCHAR(256),
  UNIQUE(round_id, asset_index)
);
CREATE INDEX IF NOT EXISTS idx_ra_round ON round_assets(round_id);
CREATE INDEX IF NOT EXISTS idx_ra_minted ON round_assets(minted_by);

CREATE TABLE IF NOT EXISTS game_events (
  id          SERIAL PRIMARY KEY,
  round_id    INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
  event_type  VARCHAR(32) NOT NULL,     -- discover, mint_start, mint_complete, contest, jammer, radar, sabotage
  wallet      VARCHAR(42) NOT NULL,
  target      VARCHAR(42),
  asset_index INTEGER,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_round ON game_events(round_id);

CREATE TABLE IF NOT EXISTS seasons (
  id              SERIAL PRIMARY KEY,
  onchain_id      INTEGER UNIQUE,
  name            VARCHAR(64),
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  status          VARCHAR(16) DEFAULT 'upcoming', -- upcoming, active, ended
  reward_pool_wei VARCHAR(78) DEFAULT '0',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS season_standings (
  id          SERIAL PRIMARY KEY,
  season_id   INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  player_id   INTEGER REFERENCES players(id),
  wallet      VARCHAR(42) NOT NULL,
  points      INTEGER DEFAULT 0,
  rounds_played INTEGER DEFAULT 0,
  rounds_won  INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  UNIQUE(season_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_ss_season ON season_standings(season_id);
CREATE INDEX IF NOT EXISTS idx_ss_points ON season_standings(season_id, points DESC);

-- Leaderboard (quick-match results)
CREATE TABLE IF NOT EXISTS leaderboard (
  id            SERIAL PRIMARY KEY,
  player_name   VARCHAR(16) NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0,
  minted        INTEGER NOT NULL DEFAULT 0,
  fragments     INTEGER NOT NULL DEFAULT 0,
  placement     SMALLINT NOT NULL DEFAULT 1,
  map_index     SMALLINT,
  played_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lb_score ON leaderboard(score DESC);
CREATE INDEX IF NOT EXISTS idx_lb_name ON leaderboard(player_name);

-- Aggregated player stats
CREATE TABLE IF NOT EXISTS player_stats (
  id            SERIAL PRIMARY KEY,
  player_name   VARCHAR(16) UNIQUE NOT NULL,
  total_score   BIGINT DEFAULT 0,
  total_wins    INTEGER DEFAULT 0,
  total_rounds  INTEGER DEFAULT 0,
  total_minted  INTEGER DEFAULT 0,
  best_score    INTEGER DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_score ON player_stats(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_ps_wins ON player_stats(total_wins DESC);

-- Twitter connected profiles
CREATE TABLE IF NOT EXISTS twitter_profiles (
  id            SERIAL PRIMARY KEY,
  twitter_id    VARCHAR(32) UNIQUE NOT NULL,
  username      VARCHAR(20) NOT NULL,
  display_name  VARCHAR(50),
  avatar_url    VARCHAR(256),
  access_token  VARCHAR(256),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tp_username ON twitter_profiles(username);

-- Beta access system
CREATE TABLE IF NOT EXISTS beta_codes (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(16) UNIQUE NOT NULL,
  max_uses      INTEGER NOT NULL DEFAULT 1,
  used_count    INTEGER NOT NULL DEFAULT 0,
  created_by    VARCHAR(20) DEFAULT 'admin',
  label         VARCHAR(64),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bc_code ON beta_codes(code);

CREATE TABLE IF NOT EXISTS beta_access (
  id            SERIAL PRIMARY KEY,
  twitter_id    VARCHAR(32) NOT NULL,
  username      VARCHAR(20) NOT NULL,
  code_used     VARCHAR(16) NOT NULL,
  granted_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(twitter_id)
);
CREATE INDEX IF NOT EXISTS idx_ba_twitter ON beta_access(twitter_id);
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

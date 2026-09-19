-- Hopping Heads Arc schema
--
-- Fresh for this repo. Identity is a wallet address, lowercase 0x plus 40
-- hex, exactly as walletAuth.js recovers it. A seat can also be a bot, and a
-- bot id can never look like an address (see server/src/game/ids.js), so
-- one participant column holds both and is_bot says which.
--
-- Columns that later phases fill are here from the first write on purpose.
-- Retrofitting them once payouts reference these rows is the expensive path.

CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  address       VARCHAR(42) UNIQUE NOT NULL,
  display_name  VARCHAR(32),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_seen     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_players_address ON players(address);

-- One row per match, whatever the mode. Shape carried over from the source
-- rounds table minus onchain_id. seed and theme_hash are what phase 1 fills;
-- commit_hash, signature and tx_hash are what phases 2 and 3 fill.
CREATE TABLE IF NOT EXISTS rounds (
  id              SERIAL PRIMARY KEY,
  mode            VARCHAR(24) NOT NULL,             -- classic-solo, lbs-solo, multiplayer
  map_index       SMALLINT,
  seed            VARCHAR(66),                      -- run seed, hex
  theme           VARCHAR(64),
  theme_hash      VARCHAR(66),
  status          VARCHAR(16) DEFAULT 'pending',    -- pending, lobby, active, resolving, completed, cancelled
  entry_fee_wei   VARCHAR(78) NOT NULL DEFAULT '0',
  max_players     SMALLINT NOT NULL DEFAULT 8,
  duration_secs   INTEGER NOT NULL DEFAULT 180,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  winner          VARCHAR(64),                      -- participant id of the winner
  prize_pool_wei  VARCHAR(78) DEFAULT '0',
  commit_hash     VARCHAR(66),                      -- phase 2: commitment to the result set
  signature       VARCHAR(132),                     -- phase 2: settler signature over commit_hash
  tx_hash         VARCHAR(66),                      -- phase 3: settlement transaction
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);
CREATE INDEX IF NOT EXISTS idx_rounds_created ON rounds(created_at DESC);

-- One row per seat per match. participant is an address for a human and a
-- bot id for a bot; is_bot is set on every write, never defaulted by omission.
CREATE TABLE IF NOT EXISTS round_results (
  id            SERIAL PRIMARY KEY,
  round_id      INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  participant   VARCHAR(64) NOT NULL,
  is_bot        BOOLEAN NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0,
  minted        INTEGER NOT NULL DEFAULT 0,
  fragments     INTEGER NOT NULL DEFAULT 0,
  placement     SMALLINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(round_id, participant)
);
CREATE INDEX IF NOT EXISTS idx_rr_round ON round_results(round_id);
CREATE INDEX IF NOT EXISTS idx_rr_participant ON round_results(participant);
CREATE INDEX IF NOT EXISTS idx_rr_score ON round_results(score DESC);

-- Aggregate per human, keyed by the full address, not the display form.
CREATE TABLE IF NOT EXISTS player_stats (
  address       VARCHAR(42) PRIMARY KEY,
  total_score   BIGINT DEFAULT 0,
  total_wins    INTEGER DEFAULT 0,
  total_rounds  INTEGER DEFAULT 0,
  total_minted  INTEGER DEFAULT 0,
  best_score    INTEGER DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_score ON player_stats(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_ps_wins ON player_stats(total_wins DESC);

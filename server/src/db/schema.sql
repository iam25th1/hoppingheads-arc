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
  mode            VARCHAR(24) NOT NULL,             -- arena, sandbox-lbs-online, sandbox-classic-solo, sandbox-lbs-solo
  stakeable       BOOLEAN NOT NULL DEFAULT false,   -- true only for arena; the constraint below enforces it
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
  issued_to       VARCHAR(64),                      -- solo: the participant the seed was issued to
  prize_pool_wei  VARCHAR(78) DEFAULT '0',
  commit_hash     VARCHAR(66),                      -- phase 2: commitment to the result set
  signature       VARCHAR(132),                     -- phase 2: settler signature over commit_hash
  tx_hash         VARCHAR(66),                      -- phase 3: settlement transaction
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Existing databases: add the column, then the rule. Both idempotent.
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS stakeable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_stakeable_arena_only;
ALTER TABLE rounds ADD CONSTRAINT rounds_stakeable_arena_only CHECK (NOT stakeable OR mode = 'arena');

-- Phase 4: settlement on chain. The SERIAL id is not the on chain round id; the escrow
-- keys rounds by a bytes32 the server draws when a stakeable round is issued. The seed
-- commitment is keccak256(seed), what openRound is called with (commit_hash above is the
-- result set commitment, a different thing). chain_status is the worker's state machine:
-- none (never on chain), open_requested, open, settle_requested, settling, settled,
-- stalled (a transaction accepted but not mined past its deadline: alert), dead (given
-- up after repeated failure: alert). settlement is the replayable record: seed, commit,
-- digest, placements, signature, memo index, written by the worker when it settles.
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS onchain_round_id VARCHAR(66);
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS seed_commit VARCHAR(66);
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS settled_block BIGINT;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS chain_status VARCHAR(20) NOT NULL DEFAULT 'none';
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS open_tx_hash VARCHAR(66);
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS settlement JSONB;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS chain_error TEXT;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS chain_attempts SMALLINT NOT NULL DEFAULT 0;
-- Rows from before this phase: stakeable arena rounds that were never on chain get a
-- derived id so the rule below holds; chain_status none says they were never opened.
UPDATE rounds SET onchain_round_id = '0x' || encode(sha256(decode(substr(seed, 3), 'hex')), 'hex')
  WHERE stakeable AND onchain_round_id IS NULL AND seed IS NOT NULL;
UPDATE rounds SET onchain_round_id = '0x' || encode(sha256(convert_to(id::text || ':legacy-no-seed', 'UTF8')), 'hex')
  WHERE stakeable AND onchain_round_id IS NULL;
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_stakeable_has_onchain_id;
ALTER TABLE rounds ADD CONSTRAINT rounds_stakeable_has_onchain_id CHECK (NOT stakeable OR onchain_round_id IS NOT NULL);
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_chain_status_known;
ALTER TABLE rounds ADD CONSTRAINT rounds_chain_status_known CHECK (chain_status IN ('none','open_requested','open','settle_requested','settling','settled','stalled','dead'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_onchain ON rounds(onchain_round_id) WHERE onchain_round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rounds_chain_status ON rounds(chain_status) WHERE chain_status IN ('open_requested','settle_requested','settling','stalled');
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
-- Phase 4: what the settlement credited this seat, USDC in 6 decimal units. NULL until the
-- round settles; 0 for a seat the tiers did not reach; never set on a bot row.
ALTER TABLE round_results ADD COLUMN IF NOT EXISTS payout_units BIGINT;
ALTER TABLE round_results DROP CONSTRAINT IF EXISTS round_results_bots_unpaid;
ALTER TABLE round_results ADD CONSTRAINT round_results_bots_unpaid CHECK (NOT is_bot OR payout_units IS NULL);
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

-- Hopping Heads Store System Schema
-- Token-powered marketplace for skins, effects, and cosmetics

-- ---------------------------------------------------------------
-- Item Catalog
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_items (
  id              SERIAL PRIMARY KEY,
  slug            VARCHAR(64) UNIQUE NOT NULL,
  name            VARCHAR(64) NOT NULL,
  description     VARCHAR(256),
  category        VARCHAR(32) NOT NULL,   -- skin, eye_style, headwear, trail_effect, victory_anim, skin_color, glow_color, name_color, badge
  rarity          VARCHAR(16) NOT NULL DEFAULT 'common',  -- common, uncommon, rare, epic, legendary
  price_credits   INT NOT NULL DEFAULT 0,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,      -- visual config: hex colors, mesh params, animation keys
  traits          JSONB DEFAULT '[]'::jsonb,               -- display trait tags
  preview_url     VARCHAR(256),
  is_default      BOOLEAN DEFAULT false,                   -- free starter items everyone owns
  locked          BOOLEAN DEFAULT false,                   -- visible but not purchasable (coming soon)
  available_from  TIMESTAMPTZ,                             -- seasonal drop start (null = always)
  available_until TIMESTAMPTZ,                             -- seasonal drop end (null = never expires)
  max_supply      INT,                                     -- null = unlimited
  total_sold      INT NOT NULL DEFAULT 0,
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_si_category ON store_items(category);
CREATE INDEX IF NOT EXISTS idx_si_rarity ON store_items(rarity);
CREATE INDEX IF NOT EXISTS idx_si_active ON store_items(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_si_seasonal ON store_items(available_from, available_until)
  WHERE available_from IS NOT NULL;

-- ---------------------------------------------------------------
-- Player Credit Balances
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_credits (
  id              SERIAL PRIMARY KEY,
  twitter_id      VARCHAR(32) UNIQUE NOT NULL,
  balance         BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned    BIGINT NOT NULL DEFAULT 0,
  total_spent     BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pc_twitter ON player_credits(twitter_id);

-- ---------------------------------------------------------------
-- Player Inventory (owned items)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_inventory (
  id              SERIAL PRIMARY KEY,
  twitter_id      VARCHAR(32) NOT NULL,
  item_id         INT NOT NULL REFERENCES store_items(id),
  acquired_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(twitter_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_pi_twitter ON player_inventory(twitter_id);

-- ---------------------------------------------------------------
-- Player Loadout (equipped items per slot)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_loadout (
  id              SERIAL PRIMARY KEY,
  twitter_id      VARCHAR(32) UNIQUE NOT NULL,
  skin            INT REFERENCES store_items(id),
  skin_color      INT REFERENCES store_items(id),
  eye_style       INT REFERENCES store_items(id),
  headwear        INT REFERENCES store_items(id),
  trail_effect    INT REFERENCES store_items(id),
  glow_color      INT REFERENCES store_items(id),
  name_color      INT REFERENCES store_items(id),
  victory_anim    INT REFERENCES store_items(id),
  badge           INT REFERENCES store_items(id),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pl_twitter ON player_loadout(twitter_id);

-- Migrations for existing databases
ALTER TABLE store_items ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false;
ALTER TABLE store_items ADD COLUMN IF NOT EXISTS traits JSONB DEFAULT '[]'::jsonb;
ALTER TABLE player_loadout ADD COLUMN IF NOT EXISTS skin INT REFERENCES store_items(id);

-- ---------------------------------------------------------------
-- Credit Transaction Log (full audit trail)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_transactions (
  id              BIGSERIAL PRIMARY KEY,
  twitter_id      VARCHAR(32) NOT NULL,
  tx_type         VARCHAR(16) NOT NULL,    -- purchase, deposit, reward, refund, admin
  amount          INT NOT NULL,            -- positive = credit, negative = debit
  balance_after   BIGINT NOT NULL,
  ref_type        VARCHAR(32),             -- item_purchase, crypto_deposit, game_reward, season_bonus
  ref_id          VARCHAR(128),            -- item slug, tx hash, round id, etc.
  note            VARCHAR(256),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ct_twitter ON credit_transactions(twitter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_type ON credit_transactions(tx_type);

-- ---------------------------------------------------------------
-- Seed: Default Starter Items (free for all players)
-- ---------------------------------------------------------------
INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config, is_default) VALUES
  -- Default skin colors (the 5 originals, free)
  ('skin-coral',    'Coral',    'The OG.',                    'skin_color', 'common', 0, '{"hex": "0xff8866"}', true),
  ('skin-lime',     'Lime',     'Fresh and clean.',           'skin_color', 'common', 0, '{"hex": "0xaadd55"}', true),
  ('skin-grape',    'Grape',    'Purple reign.',              'skin_color', 'common', 0, '{"hex": "0xaa88dd"}', true),
  ('skin-steel',    'Steel',    'Cool and collected.',        'skin_color', 'common', 0, '{"hex": "0x88bbcc"}', true),
  ('skin-gold',     'Gold',     'Stay golden.',               'skin_color', 'common', 0, '{"hex": "0xddcc55"}', true),
  -- Default eye styles (free)
  ('eyes-x',        'X Eyes',   'The classic stare.',         'eye_style',  'common', 0, '{"style": "X"}',      true),
  ('eyes-dots',     'Dot Eyes', 'Simple. Effective.',         'eye_style',  'common', 0, '{"style": "Dots"}',   true),
  ('eyes-slit',     'Slit Eyes','Calculated gaze.',           'eye_style',  'common', 0, '{"style": "Slit"}',   true),
  ('eyes-open',     'Open Eyes','Wide awake.',                'eye_style',  'common', 0, '{"style": "Open"}',   true),
  -- Default headwear (free)
  ('head-horns',    'Horns',    'Classic devil energy.',      'headwear',   'common', 0, '{"style": "Horns"}',    true),
  ('head-crown',    'Crown',    'Born to rule.',              'headwear',   'common', 0, '{"style": "Crown"}',    true),
  ('head-spike',    'Spike',    'Punk never dies.',           'headwear',   'common', 0, '{"style": "Spike"}',    true),
  ('head-antenna',  'Antenna',  'Receiving signals.',         'headwear',   'common', 0, '{"style": "Antenna"}',  true),
  ('head-ears',     'Ears',     'All ears.',                  'headwear',   'common', 0, '{"style": "Ears"}',     true)
ON CONFLICT (slug) DO NOTHING;

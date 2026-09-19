-- Hopping Heads Store: Premium Catalog v2
-- 29 items, 5 categories, 3 tiers - ALL LOCKED
-- Items are visible in store but cannot be purchased until unlock
--
-- Seed INSERTs below use ON CONFLICT (slug) DO UPDATE so they self-heal on
-- every boot without touching user-forged items. Do NOT add a blanket
-- `UPDATE store_items SET active = false` here: that would deactivate
-- every workshop-forged item every time the server restarts.

-- ---------------------------------------------------------------
-- SKINS (9) - Full character skin replacement
-- ---------------------------------------------------------------
INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config, traits, locked, active) VALUES
  ('skin_arctic',  'ARCTIC',      'Frosted ice-blue shell with crystalline features. Chills the competition.',
   'skin', 'rare', 800,
   '{"skinColor":"0xa8d8ea","eyes":"Slit","head":"Crown","crownColor":"0x66ccff","emissive":"0x224466","emissiveI":0.08,"blushColor":"0x88ccee"}',
   '["Ice Shell","Crystal Crown","Frost Eyes","Cold Aura"]', true, true),
  ('skin_magma',   'MAGMA',       'Volcanic core radiates heat. Forged in the deep.',
   'skin', 'rare', 800,
   '{"skinColor":"0xcc4422","eyes":"X","head":"Horns","hornColor":"0xff6633","emissive":"0xff2200","emissiveI":0.12,"blushColor":"0xff6644"}',
   '["Molten Core","Lava Horns","Ember Eyes","Heat Haze"]', true, true),
  ('skin_phantom', 'PHANTOM',     'Semi-translucent spectral form. Now you see it, now you don''t.',
   'skin', 'rare', 900,
   '{"skinColor":"0x6b4c9a","eyes":"Dots","head":"Spike","spikeColor":"0x9966cc","emissive":"0x4400aa","emissiveI":0.1,"blushColor":"0x8866bb","transparent":true,"opacity":0.82}',
   '["Ghost Shell","Spectral Spike","Phase Shift","Ether Blush"]', true, true),
  ('skin_void',    'VOID WALKER', 'Pulled from the space between dimensions. Wireframe reality bleeds through.',
   'skin', 'epic', 2000,
   '{"skinColor":"0x111122","eyes":"Open","head":"Horns","hornColor":"0x00ffcc","emissive":"0x00ffcc","emissiveI":0.25,"blushColor":"0x00aa88","wireframe":true,"wireColor":"0x00ffcc"}',
   '["Dimensional Shell","Void Horns","Rift Eyes","Wire Reality","Cyan Bleed"]', true, true),
  ('skin_solaris', 'SOLARIS',     'Temple gold, untarnished. The chosen one walks among mortals.',
   'skin', 'epic', 2200,
   '{"skinColor":"0xdaa520","eyes":"Slit","head":"Crown","crownColor":"0xffd700","emissive":"0xffaa00","emissiveI":0.2,"blushColor":"0xffcc44","metallic":true}',
   '["Temple Gold","Pharaoh Crown","Judgement Eyes","Divine Glow","Blessed"]', true, true),
  ('skin_neon',    'NEON RUSH',   'Overclocked and overloaded. Maximum frequency, maximum style.',
   'skin', 'epic', 2000,
   '{"skinColor":"0xff0088","eyes":"X","head":"Antenna","antennaColor":"0x00ff88","emissive":"0xff00aa","emissiveI":0.2,"blushColor":"0xff44aa","neonGlow":true}',
   '["Hotline Shell","Signal Antenna","Overclock Eyes","Neon Pulse","Circuit Blush"]', true, true),
  ('skin_inferno', 'INFERNO',     'Living flame incarnate. Fire particles rise endlessly from the burning shell.',
   'skin', 'legendary', 5000,
   '{"skinColor":"0xff4400","eyes":"X","head":"Crown","crownColor":"0xff8800","emissive":"0xff2200","emissiveI":0.35,"blushColor":"0xff6600","animated":true,"animType":"fire"}',
   '["Flame Body","Ember Crown","Blaze Eyes","Fire Particles","Scorched Trail","Living Heat"]', true, true),
  ('skin_glitch',  'GLITCH',      'Corrupted data given form. RGB channels tear apart as reality struggles to render.',
   'skin', 'legendary', 5500,
   '{"skinColor":"0x222222","eyes":"Dots","head":"Spike","spikeColor":"0xff0044","emissive":"0x00ff00","emissiveI":0.15,"blushColor":"0x00ff88","animated":true,"animType":"glitch"}',
   '["Corrupted Shell","Error Spike","Scan Lines","RGB Tear","Pixel Noise","Data Bleed"]', true, true),
  ('skin_cosmic',  'COSMIC',      'A fragment of the universe itself. Stars orbit while nebula colors shift across the surface.',
   'skin', 'legendary', 6000,
   '{"skinColor":"0x1a0a3e","eyes":"Open","head":"Crown","crownColor":"0xcc88ff","emissive":"0x6622cc","emissiveI":0.2,"blushColor":"0x8844ee","animated":true,"animType":"cosmic"}',
   '["Nebula Shell","Galaxy Crown","Star Eyes","Orbiting Stars","Color Shift","Cosmic Ring"]', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
  rarity=EXCLUDED.rarity, price_credits=EXCLUDED.price_credits, config=EXCLUDED.config,
  traits=EXCLUDED.traits, locked=EXCLUDED.locked, active=EXCLUDED.active;

-- ---------------------------------------------------------------
-- EYES (5)
-- ---------------------------------------------------------------
INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config, traits, locked, active) VALUES
  ('eyes_laser',   'LASER',       'Thin red beam slits. Focused. Dangerous.',
   'eye_style', 'rare', 400,
   '{"style":"Laser","color":"0xff0033","emissive":"0xff0000","emissiveI":0.6,"glow":true}',
   '["Red Beam","Lock-on Glow"]', true, true),
  ('eyes_diamond', 'DIAMOND',     'Faceted gem-cut pupils that catch the light.',
   'eye_style', 'rare', 450,
   '{"style":"Diamond","color":"0x88eeff","emissive":"0x44ccff","emissiveI":0.3}',
   '["Gem Cut","Crystal Clear"]', true, true),
  ('eyes_void',    'VOID',        'Empty black sockets ringed with electric green. Nothing inside but power.',
   'eye_style', 'epic', 1200,
   '{"style":"Void","color":"0x000000","rimColor":"0x00ff66","emissive":"0x00ff44","emissiveI":0.7,"glow":true}',
   '["Empty Socket","Power Rim","Electric Green"]', true, true),
  ('eyes_hypno',   'HYPNO',       'Concentric ring eyes that pulse outward. Mesmerizing.',
   'eye_style', 'epic', 1400,
   '{"style":"Hypno","color":"0xff00ff","secondaryColor":"0x00ffff","emissive":"0xaa00ff","emissiveI":0.5,"animated":true}',
   '["Dual Color Rings","Constant Pulse","Mesmerize"]', true, true),
  ('eyes_hellfire','HELLFIRE',    'Flickering flame particles pour from the eye sockets. Burning from within.',
   'eye_style', 'legendary', 3500,
   '{"style":"Hellfire","color":"0xff4400","emissive":"0xff2200","emissiveI":0.9,"animated":true,"particleCount":8}',
   '["Flame Particles","Burning Sockets","Heat Distortion"]', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
  rarity=EXCLUDED.rarity, price_credits=EXCLUDED.price_credits, config=EXCLUDED.config,
  traits=EXCLUDED.traits, locked=EXCLUDED.locked, active=EXCLUDED.active;

-- ---------------------------------------------------------------
-- HEADWEAR (5)
-- ---------------------------------------------------------------
INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config, traits, locked, active) VALUES
  ('hw_mohawk',    'MOHAWK',      'Row of sharp spikes running front to back. Punk energy.',
   'headwear', 'rare', 500,
   '{"type":"Mohawk","color":"0xff2266","spikeCount":5,"spikeHeight":0.4,"emissive":"0xcc0044","emissiveI":0.1}',
   '["5 Spikes","Punk Red"]', true, true),
  ('hw_halo',      'HALO',        'Floating golden ring of light above the head. Angelic vibes.',
   'headwear', 'rare', 550,
   '{"type":"Halo","color":"0xffd700","emissive":"0xffaa00","emissiveI":0.5,"floatHeight":0.3,"animated":true}',
   '["Golden Ring","Floating","Soft Glow"]', true, true),
  ('hw_visor',     'CYBER VISOR', 'Holographic visor band across the face. Data streams across the surface.',
   'headwear', 'epic', 1500,
   '{"type":"Visor","color":"0x00ffcc","emissive":"0x00ffaa","emissiveI":0.5,"animated":true}',
   '["Holo Band","Data Stream","Scan Line"]', true, true),
  ('hw_wings',     'BAT WINGS',   'Small dark wings on either side. Flap on jump.',
   'headwear', 'epic', 1600,
   '{"type":"Wings","color":"0x442266","emissive":"0x220044","emissiveI":0.08,"animated":true}',
   '["Dark Wings","Flap Physics","Shadow Spread"]', true, true),
  ('hw_storm',     'STORM HORNS', 'Massive horns crackling with electricity. Lightning arcs jump between the tips.',
   'headwear', 'legendary', 4000,
   '{"type":"StormHorns","hornColor":"0x444466","lightningColor":"0x44ccff","emissive":"0x44ccff","emissiveI":0.4,"animated":true,"arcCount":3}',
   '["Charged Horns","Lightning Arcs","Thunder Flash","Storm Aura"]', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
  rarity=EXCLUDED.rarity, price_credits=EXCLUDED.price_credits, config=EXCLUDED.config,
  traits=EXCLUDED.traits, locked=EXCLUDED.locked, active=EXCLUDED.active;

-- ---------------------------------------------------------------
-- TRAILS (5)
-- ---------------------------------------------------------------
INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config, traits, locked, active) VALUES
  ('trail_smoke',    'SMOKE',       'Wispy gray smoke curls behind you. Mysterious presence.',
   'trail_effect', 'rare', 350,
   '{"type":"particle","color":"0x888899","opacity":0.4,"fadeTime":0.8,"size":0.3,"count":12}',
   '["Gray Wisps","Soft Fade"]', true, true),
  ('trail_sparkle',  'SPARKLE',     'Tiny glitter dots scatter in your wake. Shine bright.',
   'trail_effect', 'rare', 400,
   '{"type":"dots","colors":["0xffffff","0xffffaa","0xaaffff"],"opacity":0.8,"fadeTime":0.6,"size":0.08,"count":20}',
   '["Multi-Color","Glitter Dots"]', true, true),
  ('trail_neonline', 'NEON STREAK', 'Bright color line drawn behind every move. Tron vibes.',
   'trail_effect', 'epic', 1300,
   '{"type":"line","color":"0xff00ff","emissive":"0xff00aa","emissiveI":0.7,"width":0.08,"maxLength":30,"fadeTime":1.5}',
   '["Solid Line","Neon Glow","Long Persist"]', true, true),
  ('trail_shadow',   'SHADOW CLONE','Ghost silhouettes of your character linger at past positions.',
   'trail_effect', 'epic', 1500,
   '{"type":"clone","opacity":0.25,"fadeTime":1.0,"interval":0.15,"maxClones":5,"tint":"0x6622aa"}',
   '["Ghost Images","Afterimage","5 Clones"]', true, true),
  ('trail_rainbow',  'PRISMATIC',   'Full spectrum color-shifting trail. Every step paints the map.',
   'trail_effect', 'legendary', 3800,
   '{"type":"rainbow","colors":["0xff0000","0xff8800","0xffff00","0x00ff00","0x0088ff","0x8800ff"],"emissiveI":0.5,"width":0.15,"maxLength":40,"fadeTime":2.0,"animated":true}',
   '["6-Color Spectrum","Hue Cycle","Light Trail","Map Painter"]', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
  rarity=EXCLUDED.rarity, price_credits=EXCLUDED.price_credits, config=EXCLUDED.config,
  traits=EXCLUDED.traits, locked=EXCLUDED.locked, active=EXCLUDED.active;

-- ---------------------------------------------------------------
-- VICTORY ANIMATIONS (5)
-- ---------------------------------------------------------------
INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config, traits, locked, active) VALUES
  ('vic_spin',      'TORNADO',      'Rapid 360 spin after every elimination. Flex on em.',
   'victory_anim', 'rare', 350,
   '{"type":"spin","speed":8,"rotations":2,"duration":0.5}',
   '["Double Spin","Quick Flash"]', true, true),
  ('vic_stomp',     'GROUND POUND', 'Hop up and slam down. Shockwave ring on impact.',
   'victory_anim', 'rare', 400,
   '{"type":"stomp","jumpHeight":1.5,"duration":0.6,"ringColor":"0xffd700","ringRadius":2.0}',
   '["Jump Slam","Impact Ring"]', true, true),
  ('vic_shockwave', 'SHOCKWAVE',    'Massive expanding energy ring + cube debris blast.',
   'victory_anim', 'epic', 1400,
   '{"type":"shockwave","ringColor":"0xff00ff","emissive":"0xff00aa","emissiveI":0.6,"maxRadius":5.0,"debrisCount":20,"duration":1.0,"screenShake":true}',
   '["Energy Ring","Cube Debris","Screen Shake"]', true, true),
  ('vic_confetti',  'CONFETTI BURST','Explosion of colored particles upward. Party mode.',
   'victory_anim', 'epic', 1300,
   '{"type":"confetti","colors":["0xff0044","0x00ff88","0x4488ff","0xffcc00","0xff00ff"],"count":40,"height":4.0,"duration":1.5}',
   '["5 Colors","40 Particles","Gravity Fall"]', true, true),
  ('vic_ascend',    'ASCENSION',    'Character lifts off in a pillar of light. Divine energy.',
   'victory_anim', 'legendary', 4200,
   '{"type":"ascend","pillarColor":"0xffffff","coreColor":"0xffd700","emissive":"0xffaa00","emissiveI":0.9,"liftHeight":3.0,"duration":2.0,"orbiterCount":8,"lightBeams":4}',
   '["Light Pillar","Float Lift","8 Orbiters","4 Beams","Divine Glow"]', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
  rarity=EXCLUDED.rarity, price_credits=EXCLUDED.price_credits, config=EXCLUDED.config,
  traits=EXCLUDED.traits, locked=EXCLUDED.locked, active=EXCLUDED.active;

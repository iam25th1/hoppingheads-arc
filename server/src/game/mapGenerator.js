/**
 * Deterministic Map Generator
 *
 * Given a seed (from the onchain blockhash), generates a complete
 * map layout including terrain zones, asset positions, rarities,
 * and themed item names. Anyone can verify the map by re-running
 * the generator with the same seed.
 *
 * Uses a seeded PRNG (mulberry32) so output is 100% deterministic.
 */

// -- Seeded PRNG (Mulberry32) ----------------------------------

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromHex(hexSeed) {
  // Take first 8 hex chars after 0x as the numeric seed
  const clean = hexSeed.replace(/^0x/, "");
  return parseInt(clean.slice(0, 8), 16);
}

// -- Theme asset pools -----------------------------------------

const THEMES = {
  "internet-culture": {
    common:    ["shitpost", "ratio", "copypasta", "hot take", "subtweet", "based take", "npc moment", "touch grass", "main character", "doom scroll"],
    uncommon:  ["viral thread", "dank meme", "discord mod", "stan account", "cancel receipt", "fomo post"],
    rare:      ["wojak original", "rare pepe", "sigma grindset", "gigachad moment"],
    epic:      ["twitter beef", "leaked dm"],
    legendary: ["golden ratio"],
  },
  "enchanted-ruins": {
    common:    ["cracked stone", "moss fragment", "old coin", "clay shard", "faded glyph", "iron nail", "bone chip", "torch ash", "vine root", "dust pile"],
    uncommon:  ["ancient scroll", "rune tablet", "silver ring", "cursed idol", "crystal shard", "glowing moss"],
    rare:      ["dragon scale", "enchanted blade", "void crystal", "phoenix feather"],
    epic:      ["arcane grimoire", "titan's eye"],
    legendary: ["crown of ages"],
  },
  "city-objects": {
    common:    ["street sign", "parking meter", "fire hydrant", "manhole cover", "traffic cone", "brick wall", "bus ticket", "gum wrapper", "pigeon feather", "lost sock"],
    uncommon:  ["graffiti tag", "food cart menu", "vintage poster", "neon sign", "payphone", "skateboard wheel"],
    rare:      ["banksy stencil", "golden key", "rooftop garden", "hidden speakeasy"],
    epic:      ["time capsule", "underground map"],
    legendary: ["city charter"],
  },
  "abstract-concepts": {
    common:    ["nostalgia", "deja vu", "irony", "silence", "gravity", "echo", "shadow", "rhythm", "entropy", "symmetry"],
    uncommon:  ["3am energy", "shower thought", "liminal space", "hyperfocus", "flow state", "sonder"],
    rare:      ["collective dream", "zeitgeist", "paradigm shift", "cosmic joke"],
    epic:      ["universal truth", "singularity"],
    legendary: ["meaning of life"],
  },
  "forest-relics": {
    common:    ["acorn", "mushroom cap", "bird nest", "bark strip", "pinecone", "leaf fossil", "snail shell", "dewdrop", "cobweb", "moss clump"],
    uncommon:  ["fox den map", "owl pellet", "fairy ring", "ancient root", "bee hive core", "wolf fang"],
    rare:      ["elder tree sap", "spirit moss", "moonlit pond", "thunder oak"],
    epic:      ["forest heart", "stag crown"],
    legendary: ["world tree seed"],
  },
};

const THEME_KEYS = Object.keys(THEMES);

// -- Rarity distribution ---------------------------------------

const RARITY_TABLE = [
  { rarity: 0, name: "common",    weight: 45, points: 10 },
  { rarity: 1, name: "uncommon",  weight: 25, points: 25 },
  { rarity: 2, name: "rare",      weight: 15, points: 50 },
  { rarity: 3, name: "epic",      weight: 10, points: 100 },
  { rarity: 4, name: "legendary", weight: 5,  points: 250 },
];

function rollRarity(rng) {
  const roll = rng() * 100;
  let cumulative = 0;
  for (const tier of RARITY_TABLE) {
    cumulative += tier.weight;
    if (roll < cumulative) return tier;
  }
  return RARITY_TABLE[0];
}

// -- Map config ------------------------------------------------

const MAP_WIDTH = 960;
const MAP_HEIGHT = 600;
const TILE_SIZE = 16;
const COLS = MAP_WIDTH / TILE_SIZE;
const ROWS = MAP_HEIGHT / TILE_SIZE;

const ASSET_COUNT_MIN = 15;
const ASSET_COUNT_MAX = 25;

const ZONE_COUNT = 4;
const MIN_ZONE_SIZE = 120;
const MAX_ZONE_SIZE = 240;

// -- Theme tags for set bonus grouping -------------------------

const THEME_TAGS = {
  "internet-culture": ["viral", "toxic", "wholesome", "meta"],
  "enchanted-ruins":  ["arcane", "nature", "ancient", "cursed"],
  "city-objects":     ["street", "underground", "vintage", "modern"],
  "abstract-concepts":["mind", "time", "space", "emotion"],
  "forest-relics":    ["flora", "fauna", "mystical", "earth"],
};

// -- Generator -------------------------------------------------

export function generateMap(hexSeed, themeOverride) {
  const numSeed = seedFromHex(hexSeed);
  const rng = mulberry32(numSeed);

  // Pick theme
  const themeKey = themeOverride || THEME_KEYS[Math.floor(rng() * THEME_KEYS.length)];
  const theme = THEMES[themeKey];
  if (!theme) throw new Error(`Unknown theme: ${themeKey}`);

  const tags = THEME_TAGS[themeKey];

  // Generate terrain zones
  const zones = [];
  for (let i = 0; i < ZONE_COUNT; i++) {
    const w = MIN_ZONE_SIZE + rng() * (MAX_ZONE_SIZE - MIN_ZONE_SIZE);
    const h = MIN_ZONE_SIZE + rng() * (MAX_ZONE_SIZE - MIN_ZONE_SIZE);
    const x = rng() * (MAP_WIDTH - w);
    const y = rng() * (MAP_HEIGHT - h);
    zones.push({ x, y, width: w, height: h, tag: tags[i % tags.length] });
  }

  // Generate paths (horizontal and vertical connectors)
  const paths = [];
  const pathCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < pathCount; i++) {
    const horizontal = rng() > 0.4;
    if (horizontal) {
      const y = TILE_SIZE * 2 + rng() * (MAP_HEIGHT - TILE_SIZE * 4);
      const x = rng() * (MAP_WIDTH * 0.3);
      const w = MAP_WIDTH * 0.4 + rng() * (MAP_WIDTH * 0.5);
      paths.push({ x, y, width: w, height: TILE_SIZE, dir: "h" });
    } else {
      const x = TILE_SIZE * 2 + rng() * (MAP_WIDTH - TILE_SIZE * 4);
      const y = rng() * (MAP_HEIGHT * 0.3);
      const h = MAP_HEIGHT * 0.3 + rng() * (MAP_HEIGHT * 0.5);
      paths.push({ x, y, width: TILE_SIZE, height: h, dir: "v" });
    }
  }

  // Generate trees
  const trees = [];
  const treeCount = 12 + Math.floor(rng() * 10);
  for (let i = 0; i < treeCount; i++) {
    trees.push({
      x: rng() * (MAP_WIDTH - 20),
      y: rng() * (MAP_HEIGHT - 40),
      variant: Math.floor(rng() * 3), // 0=normal, 1=autumn, 2=big
    });
  }

  // Generate structures (houses, ruins, walls)
  const structures = [];
  const structCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < structCount; i++) {
    structures.push({
      type: rng() > 0.5 ? "house" : "ruins",
      x: 60 + rng() * (MAP_WIDTH - 120),
      y: 40 + rng() * (MAP_HEIGHT - 120),
      variant: Math.floor(rng() * 3),
    });
  }

  // Generate water bodies
  const water = [];
  const waterCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < waterCount; i++) {
    water.push({
      x: rng() * (MAP_WIDTH - 160),
      y: rng() * (MAP_HEIGHT - 100),
      width: 80 + rng() * 100,
      height: 50 + rng() * 60,
    });
  }

  // Generate assets
  const assetCount = ASSET_COUNT_MIN + Math.floor(rng() * (ASSET_COUNT_MAX - ASSET_COUNT_MIN + 1));
  const assets = [];

  for (let i = 0; i < assetCount; i++) {
    const tier = rollRarity(rng);
    const rarityName = tier.name;
    const pool = theme[rarityName];
    const name = pool[Math.floor(rng() * pool.length)];
    const tag = tags[Math.floor(rng() * tags.length)];

    // Place asset avoiding edges and water
    let x, y, attempts = 0;
    do {
      x = 40 + rng() * (MAP_WIDTH - 80);
      y = 40 + rng() * (MAP_HEIGHT - 80);
      attempts++;
    } while (attempts < 20 && isInWater(x, y, water));

    assets.push({
      index: i,
      x,
      y,
      rarity: tier.rarity,
      rarityName,
      points: tier.points,
      name,
      themeTag: tag,
      discovered: false,
      discoveredBy: null,
      minted: false,
      mintedBy: null,
      tokenId: null,
    });
  }

  return {
    seed: hexSeed,
    theme: themeKey,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    tileSize: TILE_SIZE,
    zones,
    paths,
    trees,
    structures,
    water,
    assets,
    assetCount,
  };
}

function isInWater(x, y, waterBodies) {
  for (const w of waterBodies) {
    if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) {
      return true;
    }
  }
  return false;
}

/**
 * Validate that a player is close enough to an asset to discover/mint it.
 * Returns true if within discovery radius.
 */
export function isInRange(playerX, playerY, assetX, assetY, radius = 48) {
  const dx = playerX - assetX;
  const dy = playerY - assetY;
  return (dx * dx + dy * dy) <= (radius * radius);
}

/**
 * Calculate set bonuses for a player's minted assets.
 * 3+ assets with the same themeTag = 1.5x multiplier on those assets.
 */
export function calculateSetBonuses(mintedAssets) {
  const tagCounts = {};
  for (const asset of mintedAssets) {
    tagCounts[asset.themeTag] = (tagCounts[asset.themeTag] || 0) + 1;
  }

  let bonusMultiplier = 1;
  const activeSets = [];

  for (const [tag, count] of Object.entries(tagCounts)) {
    if (count >= 3) {
      activeSets.push({ tag, count });
      bonusMultiplier = 1.5; // any set = 1.5x on total
    }
  }

  return { bonusMultiplier, activeSets };
}

export { THEMES, THEME_KEYS, RARITY_TABLE };

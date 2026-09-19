/**
 * Round Manager
 *
 * Manages active game rounds in memory. Each round tracks:
 * - Player positions and states
 * - Asset discovery and mint progress
 * - Abilities (radar, jammer, sabotage)
 * - Timer and game state transitions
 *
 * Persists to PostgreSQL and settles onchain via ContractService.
 */

import { generateMap, isInRange, calculateSetBonuses } from "./mapGenerator.js";
import { query } from "../db/pool.js";

// In-memory active rounds
const activeRounds = new Map();

// Player states within a round
const PLAYER_STATE = {
  IDLE: "idle",
  MOVING: "moving",
  MINTING: "minting",
  CONTESTING: "contesting",
};

// Mint lock durations by rarity (ms)
const MINT_DURATIONS = {
  0: 2000,  // Common
  1: 3000,  // Uncommon
  2: 4000,  // Rare
  3: 5500,  // Epic
  4: 7000,  // Legendary
};

const DISCOVERY_RADIUS = 48;
const CONTEST_RADIUS = 32;
const JAMMER_RADIUS = 80;
const SPEED_BONUS_WINDOW = 2000; // ms after discovery

export function createRound(roundDbId, config) {
  const round = {
    dbId: roundDbId,
    onchainId: null,
    theme: config.theme,
    seed: null,
    status: "lobby",
    entryFee: config.entryFee,
    maxPlayers: config.maxPlayers || 6,
    duration: config.duration || 300,
    players: new Map(),
    map: null,
    startTime: null,
    endTime: null,
    timer: null,
    events: [],
  };

  activeRounds.set(roundDbId, round);
  return round;
}

export function joinRound(roundId, wallet) {
  const round = activeRounds.get(roundId);
  if (!round) throw new Error("Round not found");
  if (round.status !== "lobby") throw new Error("Round not accepting players");
  if (round.players.size >= round.maxPlayers) throw new Error("Round full");
  if (round.players.has(wallet)) throw new Error("Already joined");

  round.players.set(wallet, {
    wallet,
    x: 100 + Math.random() * 200, // spawn zone
    y: 400 + Math.random() * 100,
    state: PLAYER_STATE.IDLE,
    score: 0,
    mintedAssets: [],
    discoveredAssets: [],
    mintProgress: null, // { assetIndex, startTime, duration }
    radarPingsUsed: 0,
    jammerUsed: false,
    sabotageUsed: false,
    speedBonuses: 0,
    lastMoveTime: 0,
  });

  return round.players.size;
}

export function startRound(roundId, seed) {
  const round = activeRounds.get(roundId);
  if (!round) throw new Error("Round not found");
  if (round.status !== "lobby") throw new Error("Round not in lobby");
  if (round.players.size < 2) throw new Error("Need at least 2 players");

  round.seed = seed;
  round.map = generateMap(seed, round.theme);
  round.status = "active";
  round.startTime = Date.now();
  round.endTime = round.startTime + round.duration * 1000;

  return round;
}

export function updatePlayerPosition(roundId, wallet, x, y) {
  const round = activeRounds.get(roundId);
  if (!round || round.status !== "active") return null;

  const player = round.players.get(wallet);
  if (!player) return null;
  if (player.state === PLAYER_STATE.MINTING) return null; // locked

  // Basic speed/teleport check
  const dx = x - player.x;
  const dy = y - player.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const timeDelta = Date.now() - player.lastMoveTime;
  const maxSpeed = 300; // pixels per second
  const maxDist = (maxSpeed * Math.max(timeDelta, 16)) / 1000;

  if (dist > maxDist + 10) {
    // Suspicious movement, clamp it
    const ratio = maxDist / dist;
    x = player.x + dx * ratio;
    y = player.y + dy * ratio;
  }

  // Clamp to map bounds
  x = Math.max(0, Math.min(round.map.mapWidth, x));
  y = Math.max(0, Math.min(round.map.mapHeight, y));

  player.x = x;
  player.y = y;
  player.lastMoveTime = Date.now();

  // Check for nearby undiscovered assets
  const discoveries = [];
  for (const asset of round.map.assets) {
    if (!asset.discovered && isInRange(x, y, asset.x, asset.y, DISCOVERY_RADIUS)) {
      asset.discovered = true;
      asset.discoveredBy = wallet;
      asset.discoveryTime = Date.now();
      player.discoveredAssets.push(asset.index);
      discoveries.push(asset);

      round.events.push({
        type: "discover",
        wallet,
        assetIndex: asset.index,
        rarity: asset.rarity,
        time: Date.now(),
      });
    }
  }

  return { x: player.x, y: player.y, discoveries };
}

export function startMint(roundId, wallet, assetIndex) {
  const round = activeRounds.get(roundId);
  if (!round || round.status !== "active") throw new Error("Round not active");
  if (Date.now() > round.endTime) throw new Error("Round ended");

  const player = round.players.get(wallet);
  if (!player) throw new Error("Not in round");
  if (player.state === PLAYER_STATE.MINTING) throw new Error("Already minting");
  if (player.mintedAssets.length >= 10) throw new Error("Mint limit reached");

  const asset = round.map.assets[assetIndex];
  if (!asset) throw new Error("Asset not found");
  if (!asset.discovered) throw new Error("Asset not discovered yet");
  if (asset.minted) throw new Error("Asset already minted");
  if (!isInRange(player.x, player.y, asset.x, asset.y, DISCOVERY_RADIUS)) {
    throw new Error("Too far from asset");
  }

  const duration = MINT_DURATIONS[asset.rarity];

  player.state = PLAYER_STATE.MINTING;
  player.mintProgress = {
    assetIndex,
    startTime: Date.now(),
    duration,
    endTime: Date.now() + duration,
  };

  // Check speed bonus eligibility
  const timeSinceDiscovery = Date.now() - (asset.discoveryTime || 0);
  const isSpeedBonus = asset.discoveredBy === wallet && timeSinceDiscovery <= SPEED_BONUS_WINDOW;

  round.events.push({
    type: "mint_start",
    wallet,
    assetIndex,
    rarity: asset.rarity,
    duration,
    time: Date.now(),
  });

  return {
    assetIndex,
    duration,
    endTime: player.mintProgress.endTime,
    isSpeedBonus,
    // Broadcast player position to others (steal window mechanic)
    playerPosition: { x: player.x, y: player.y },
  };
}

export function completeMint(roundId, wallet) {
  const round = activeRounds.get(roundId);
  if (!round) return null;

  const player = round.players.get(wallet);
  if (!player || !player.mintProgress) return null;

  const { assetIndex, endTime } = player.mintProgress;

  // Verify mint duration has elapsed
  if (Date.now() < endTime - 100) return null; // 100ms grace

  const asset = round.map.assets[assetIndex];
  if (!asset || asset.minted) {
    player.state = PLAYER_STATE.IDLE;
    player.mintProgress = null;
    return null;
  }

  // Complete the mint
  asset.minted = true;
  asset.mintedBy = wallet;

  player.mintedAssets.push(asset);
  player.state = PLAYER_STATE.IDLE;
  player.mintProgress = null;

  // Calculate immediate score
  let points = asset.points;
  const timeSinceDiscovery = Date.now() - (asset.discoveryTime || 0);
  if (asset.discoveredBy === wallet && timeSinceDiscovery <= SPEED_BONUS_WINDOW + MINT_DURATIONS[asset.rarity]) {
    points = Math.floor(points * 1.2); // 20% speed bonus
    player.speedBonuses++;
  }
  player.score += points;

  round.events.push({
    type: "mint_complete",
    wallet,
    assetIndex,
    rarity: asset.rarity,
    points,
    time: Date.now(),
  });

  return { asset, points, totalScore: player.score };
}

export function contestMint(roundId, challengerWallet, targetWallet, assetIndex) {
  const round = activeRounds.get(roundId);
  if (!round || round.status !== "active") throw new Error("Round not active");

  const challenger = round.players.get(challengerWallet);
  const target = round.players.get(targetWallet);
  if (!challenger || !target) throw new Error("Player not found");
  if (!target.mintProgress || target.mintProgress.assetIndex !== assetIndex) {
    throw new Error("Target not minting this asset");
  }

  // Check challenger is close enough
  if (!isInRange(challenger.x, challenger.y, target.x, target.y, CONTEST_RADIUS)) {
    throw new Error("Too far to contest");
  }

  round.events.push({
    type: "contest",
    wallet: challengerWallet,
    target: targetWallet,
    assetIndex,
    time: Date.now(),
  });

  // Contest resolution: the challenger interrupts the mint
  // Target loses their mint progress
  target.state = PLAYER_STATE.IDLE;
  target.mintProgress = null;

  return { contested: true, assetIndex };
}

export function useRadarPing(roundId, wallet) {
  const round = activeRounds.get(roundId);
  if (!round || round.status !== "active") throw new Error("Round not active");

  const player = round.players.get(wallet);
  if (!player) throw new Error("Not in round");
  if (player.radarPingsUsed >= 2) throw new Error("No radar pings remaining");

  player.radarPingsUsed++;

  // Reveal all undiscovered assets within radar radius
  const RADAR_RADIUS = 200;
  const revealed = [];
  for (const asset of round.map.assets) {
    if (!asset.discovered && isInRange(player.x, player.y, asset.x, asset.y, RADAR_RADIUS)) {
      revealed.push({
        index: asset.index,
        x: asset.x,
        y: asset.y,
        rarity: asset.rarity,
      });
    }
  }

  round.events.push({
    type: "radar",
    wallet,
    revealedCount: revealed.length,
    time: Date.now(),
  });

  return { revealed, pingsRemaining: 2 - player.radarPingsUsed };
}

export function useJammer(roundId, wallet, targetWallet) {
  const round = activeRounds.get(roundId);
  if (!round || round.status !== "active") throw new Error("Round not active");

  const player = round.players.get(wallet);
  const target = round.players.get(targetWallet);
  if (!player || !target) throw new Error("Player not found");
  if (player.jammerUsed) throw new Error("Jammer already used");

  if (!isInRange(player.x, player.y, target.x, target.y, JAMMER_RADIUS)) {
    throw new Error("Target out of jammer range");
  }

  player.jammerUsed = true;

  // If target is currently minting, extend their lock time
  if (target.mintProgress) {
    target.mintProgress.endTime += 2000;
    target.mintProgress.duration += 2000;
  }

  round.events.push({
    type: "jammer",
    wallet,
    target: targetWallet,
    time: Date.now(),
  });

  return { jammed: true, targetWallet };
}

export function resolveRound(roundId) {
  const round = activeRounds.get(roundId);
  if (!round) return null;

  round.status = "resolving";

  // Calculate final scores with set bonuses
  const results = [];
  for (const [wallet, player] of round.players) {
    const { bonusMultiplier, activeSets } = calculateSetBonuses(player.mintedAssets);
    const finalScore = Math.floor(player.score * bonusMultiplier);

    // Discovery credit: +5 points per asset discovered (even if not minted)
    const discoveryCredit = player.discoveredAssets.length * 5;

    results.push({
      wallet,
      baseScore: player.score,
      setBonus: bonusMultiplier,
      activeSets,
      discoveryCredit,
      speedBonuses: player.speedBonuses,
      finalScore: finalScore + discoveryCredit,
      mintedCount: player.mintedAssets.length,
      discoveredCount: player.discoveredAssets.length,
    });
  }

  // Sort by final score descending
  results.sort((a, b) => b.finalScore - a.finalScore);

  // Assign placements
  results.forEach((r, i) => { r.placement = i + 1; });

  round.status = "completed";
  round.results = results;

  return results;
}

export function getRound(roundId) {
  return activeRounds.get(roundId);
}

export function getGameState(roundId, forWallet) {
  const round = activeRounds.get(roundId);
  if (!round) return null;

  const player = round.players.get(forWallet);

  // Build visible state for this player
  const players = [];
  for (const [w, p] of round.players) {
    players.push({
      wallet: w,
      x: p.x,
      y: p.y,
      state: p.state,
      score: p.score,
      mintedCount: p.mintedAssets.length,
      // Only show mint progress if broadcasting (steal window)
      mintProgress: p.state === PLAYER_STATE.MINTING ? {
        assetIndex: p.mintProgress.assetIndex,
        endTime: p.mintProgress.endTime,
      } : null,
    });
  }

  // Only show discovered assets to this player (fog of war)
  const visibleAssets = round.map.assets
    .filter((a) => a.discovered)
    .map((a) => ({
      index: a.index,
      x: a.x,
      y: a.y,
      rarity: a.rarity,
      rarityName: a.rarityName,
      name: a.name,
      themeTag: a.themeTag,
      discoveredBy: a.discoveredBy,
      minted: a.minted,
      mintedBy: a.mintedBy,
    }));

  return {
    roundId,
    status: round.status,
    theme: round.theme,
    timeRemaining: Math.max(0, round.endTime - Date.now()),
    players,
    assets: visibleAssets,
    myState: player ? {
      score: player.score,
      mintedCount: player.mintedAssets.length,
      discoveredCount: player.discoveredAssets.length,
      radarPingsLeft: 2 - player.radarPingsUsed,
      jammerAvailable: !player.jammerUsed,
      state: player.state,
    } : null,
    map: {
      zones: round.map.zones,
      paths: round.map.paths,
      trees: round.map.trees,
      structures: round.map.structures,
      water: round.map.water,
    },
  };
}

export function cleanupRound(roundId) {
  activeRounds.delete(roundId);
}

export function getActiveRoundCount() {
  return activeRounds.size;
}

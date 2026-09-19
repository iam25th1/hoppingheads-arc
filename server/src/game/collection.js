/**
 * Collection rules
 *
 * Salvaged from roundManager.js before that file was removed with the Mint
 * Rush API. This is the only server side validation the source repo had for
 * finding and taking an asset: discovery radius, mint preconditions, mint
 * duration, the speed bonus, contest proximity, and end of round scoring
 * with set bonuses.
 *
 * Deliberate changes from the source, and nothing else:
 *   - No module level state. roundManager kept a global activeRounds Map and
 *     looked players up by wallet. Here the caller passes the map and the
 *     player record directly, so a lobby in gameSocket.js can own them.
 *   - The clock is a parameter. Every rule that read Date.now() now takes
 *     `now`, so the lobby tick drives it and a replay can drive it from a
 *     recorded timeline. Nothing in this file reads the clock itself.
 *   - Failures return { ok: false, error } instead of throwing. The rule text
 *     is unchanged; a socket handler cannot let a throw escape.
 *
 * The rule constants are the source's values. The mint limit is 10 here and
 * 5 in gameSocket.js; the source carried both, and reconciling them is a
 * phase 1 decision, not a port decision.
 *
 * Coordinate space: this operates on whatever space the map's assets are in.
 * generateMap() emits a 960 by 600 pixel space; the live client runs a 300
 * unit 3D map. See docs/phase0-strip.md before wiring it to live positions.
 */

import { isInRange, calculateSetBonuses } from "./mapGenerator.js";

// -- Rule constants (from roundManager.js) ---------------------

export const DISCOVERY_RADIUS = 48;
export const CONTEST_RADIUS = 32;
export const SPEED_BONUS_WINDOW = 2000; // ms after discovery
export const MINT_LIMIT = 10;
export const DISCOVERY_CREDIT = 5; // points per asset discovered, minted or not
export const SPEED_BONUS_MULTIPLIER = 1.2;

// Mint lock durations by rarity (ms)
export const MINT_DURATIONS = {
  0: 2000,  // Common
  1: 3000,  // Uncommon
  2: 4000,  // Rare
  3: 5500,  // Epic
  4: 7000,  // Legendary
};

export const COLLECTOR_STATE = {
  IDLE: "idle",
  MINTING: "minting",
};

// -- Per player collection state --------------------------------

/**
 * The fields a player record needs for these rules. A lobby player object can
 * spread this in, or hold it under one key; the rules only touch these.
 */
export function createCollector(x = 0, y = 0) {
  return {
    x,
    y,
    state: COLLECTOR_STATE.IDLE,
    score: 0,
    mintedAssets: [],
    discoveredAssets: [],
    mintProgress: null, // { assetIndex, startTime, duration, endTime }
    speedBonuses: 0,
  };
}

// -- Discovery ----------------------------------------------------

/**
 * Mark every undiscovered asset within DISCOVERY_RADIUS of the player as
 * discovered by actorId. Mutates the map's assets and the player's
 * discoveredAssets. Returns the assets discovered on this call.
 */
export function discover(map, player, actorId, now, radius = DISCOVERY_RADIUS) {
  const discoveries = [];
  for (const asset of map.assets) {
    if (!asset.discovered && isInRange(player.x, player.y, asset.x, asset.y, radius)) {
      asset.discovered = true;
      asset.discoveredBy = actorId;
      asset.discoveryTime = now;
      player.discoveredAssets.push(asset.index);
      discoveries.push(asset);
    }
  }
  return discoveries;
}

// -- Minting ------------------------------------------------------

/**
 * Validate and start a mint. On success the player is locked in the MINTING
 * state until finishMint() or contestMint() clears it.
 */
export function beginMint(map, player, actorId, assetIndex, now) {
  if (player.state === COLLECTOR_STATE.MINTING) return { ok: false, error: "Already minting" };
  if (player.mintedAssets.length >= MINT_LIMIT) return { ok: false, error: "Mint limit reached" };

  const asset = map.assets[assetIndex];
  if (!asset) return { ok: false, error: "Asset not found" };
  if (!asset.discovered) return { ok: false, error: "Asset not discovered yet" };
  if (asset.minted) return { ok: false, error: "Asset already minted" };
  if (!isInRange(player.x, player.y, asset.x, asset.y, DISCOVERY_RADIUS)) {
    return { ok: false, error: "Too far from asset" };
  }

  const duration = MINT_DURATIONS[asset.rarity];

  player.state = COLLECTOR_STATE.MINTING;
  player.mintProgress = {
    assetIndex,
    startTime: now,
    duration,
    endTime: now + duration,
  };

  // Speed bonus: the discoverer mints their own find quickly
  const timeSinceDiscovery = now - (asset.discoveryTime || 0);
  const isSpeedBonus = asset.discoveredBy === actorId && timeSinceDiscovery <= SPEED_BONUS_WINDOW;

  return {
    ok: true,
    assetIndex,
    duration,
    endTime: player.mintProgress.endTime,
    isSpeedBonus,
  };
}

/**
 * Complete a mint once its duration has elapsed. Returns { ok: false } while
 * the lock is still running so a caller can poll it from a tick. If the asset
 * was taken in the meantime the player's lock is cleared and nothing is
 * awarded.
 */
export function finishMint(map, player, actorId, now) {
  if (!player.mintProgress) return { ok: false, error: "Not minting" };

  const { assetIndex, endTime } = player.mintProgress;

  // 100ms grace, as in the source
  if (now < endTime - 100) return { ok: false, error: "Mint not finished" };

  const asset = map.assets[assetIndex];
  if (!asset || asset.minted) {
    player.state = COLLECTOR_STATE.IDLE;
    player.mintProgress = null;
    return { ok: false, error: "Asset already minted" };
  }

  asset.minted = true;
  asset.mintedBy = actorId;

  player.mintedAssets.push(asset);
  player.state = COLLECTOR_STATE.IDLE;
  player.mintProgress = null;

  let points = asset.points;
  const timeSinceDiscovery = now - (asset.discoveryTime || 0);
  if (asset.discoveredBy === actorId && timeSinceDiscovery <= SPEED_BONUS_WINDOW + MINT_DURATIONS[asset.rarity]) {
    points = Math.floor(points * SPEED_BONUS_MULTIPLIER);
    player.speedBonuses++;
  }
  player.score += points;

  return { ok: true, asset, points, totalScore: player.score };
}

/**
 * A challenger within CONTEST_RADIUS of a minting target interrupts the mint.
 * The target loses the lock and the asset stays on the map.
 */
export function contestMint(challenger, target, assetIndex) {
  if (!target.mintProgress || target.mintProgress.assetIndex !== assetIndex) {
    return { ok: false, error: "Target not minting this asset" };
  }
  if (!isInRange(challenger.x, challenger.y, target.x, target.y, CONTEST_RADIUS)) {
    return { ok: false, error: "Too far to contest" };
  }

  target.state = COLLECTOR_STATE.IDLE;
  target.mintProgress = null;

  return { ok: true, assetIndex };
}

// -- Scoring ------------------------------------------------------

/** End of round score for one collector: set bonus plus discovery credit. */
export function scoreCollector(player) {
  const { bonusMultiplier, activeSets } = calculateSetBonuses(player.mintedAssets);
  const finalScore = Math.floor(player.score * bonusMultiplier);
  const discoveryCredit = player.discoveredAssets.length * DISCOVERY_CREDIT;

  return {
    baseScore: player.score,
    setBonus: bonusMultiplier,
    activeSets,
    discoveryCredit,
    speedBonuses: player.speedBonuses,
    finalScore: finalScore + discoveryCredit,
    mintedCount: player.mintedAssets.length,
    discoveredCount: player.discoveredAssets.length,
  };
}

/**
 * Rank a set of { id, player } entries by final score and assign placement.
 */
export function rankCollectors(entries) {
  const results = entries.map(({ id, player }) => ({ id, ...scoreCollector(player) }));
  results.sort((a, b) => b.finalScore - a.finalScore);
  results.forEach((r, i) => { r.placement = i + 1; });
  return results;
}

// -- Projection ---------------------------------------------------

/** Fog of war: only discovered assets are visible to clients. */
export function visibleAssets(map) {
  return map.assets
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
}

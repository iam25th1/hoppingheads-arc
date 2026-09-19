/**
 * Lobby fragment state
 *
 * The server's record of every fragment in a round: where it is (from the
 * shared layout), who claimed it, and the rules for claiming one. Pure and
 * clock free; gameSocket.js owns one of these per lobby and wires the socket
 * events to it.
 *
 * Collection follows the boink pattern: the server checks proximity against
 * its own tracked player position, with a range wider than the client's so
 * latency does not reject an honest player. The client collects at
 * COLLECT_RADIUS (3) from the fragment's authoritative position; the server
 * accepts within COLLECT_RANGE (6). Between 3 and 6 is the margin for a
 * position update in flight at 15 per second, up to 18 units per second of
 * movement, plus round trip.
 *
 * Failures reject, never clamp, and are tallied per player so a client that
 * lies is visible in the logs. Phase 5 reads these tallies.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const layoutModule = require("../../../shared/layout.cjs");

export const COLLECT_RANGE = 6; // COLLECT_RADIUS 3 on the client, plus margin
export const FRAG_POINTS = 3; // every fragment is worth 3, as before

/** Build the per round fragment state from a layout. */
export function createFragState(layout) {
  const frags = new Map();
  for (const f of layout.fragments) frags.set(f.id, { id: f.id, rarity: f.rarity, x: f.x, z: f.z, claimedBy: null });
  return { layout, frags };
}

/** A fresh rejection tally for a player record. */
export function createRejections() {
  return { total: 0 };
}

function reject(rejections, reason, extra) {
  rejections.total++;
  rejections[reason] = (rejections[reason] || 0) + 1;
  return { ok: false, reason, ...extra };
}

/**
 * Try to claim fragment `id` for a player at server tracked position
 * `player` ({ x, z, shadow }). Mutates the state on success.
 */
export function tryCollect(state, playerId, player, id, rejections) {
  if (!Number.isInteger(id)) return reject(rejections, "bad_id");
  const f = state.frags.get(id);
  if (!f) return reject(rejections, "missing", { id });
  if (f.claimedBy !== null) return reject(rejections, "claimed", { id, by: f.claimedBy });
  if (player.shadow === 1) return reject(rejections, "shadow", { id });
  const dist = Math.hypot(player.x - f.x, player.z - f.z);
  if (dist > COLLECT_RANGE) return reject(rejections, "range", { id, dist });
  f.claimedBy = playerId;
  return { ok: true, fragment: f, dist };
}

/**
 * Re-place every fragment of one rarity from the round's layout stream and
 * clear their claims. Returns the moved fragments for broadcast.
 */
export function respawnRarity(state, rarity) {
  const moved = state.layout.respawn(rarity);
  for (const m of moved) {
    const f = state.frags.get(m.id);
    f.x = m.x;
    f.z = m.z;
    f.claimedBy = null;
  }
  return moved;
}

/** Counts of unclaimed fragments per rarity, for logs and tests. */
export function unclaimedByRarity(state) {
  const counts = layoutModule.FRAG_N.map(() => 0);
  for (const f of state.frags.values()) if (f.claimedBy === null) counts[f.rarity]++;
  return counts;
}

// -- Mints -------------------------------------------------------
//
// A chest appears when a player has collected three fragments of one
// rarity since that rarity's last chest, exactly as the client spawns one.
// The server records those chests itself, so a mint claim carries nothing:
// the rarity comes from the record, never from the payload.

export const MINT_LIMIT = 5; // per player per round; matches the client cap and collection.js
export const MINT_POINTS = [10, 25, 50, 100, 250];
export const MINT_DURATIONS = [2500, 3500, 4500, 6000, 8000]; // ms, the client's MINT_DUR
export const MINT_GRACE_MS = 500; // for the client's own timer running a hair fast
export const FRAGS_PER_CHEST = 3;

/** Fields the mint rules keep on a player record. */
export function createMintState() {
  return { chests: [], fragsSinceChest: [0, 0, 0, 0, 0], minted: 0 };
}

/**
 * Record a validated collection. Returns the rarity of a chest it spawned,
 * or null. Call this after tryCollect succeeds.
 */
export function noteCollect(mint, rarity, now) {
  mint.fragsSinceChest[rarity]++;
  if (mint.fragsSinceChest[rarity] < FRAGS_PER_CHEST) return null;
  mint.fragsSinceChest[rarity] = 0;
  mint.chests.push({ rarity, since: now });
  return rarity;
}

/**
 * Try to complete a mint. The chest consumed is the highest rarity pending;
 * the player's real collections bound what that can be. The chest must be
 * at least its rarity's mint duration old, less grace, or the client is
 * claiming a mint it could not have finished.
 */
export function tryMint(mint, now, rejections) {
  if (mint.minted >= MINT_LIMIT) return reject(rejections, "mint_cap");
  if (mint.chests.length === 0) return reject(rejections, "mint_no_chest");
  let idx = 0;
  for (let i = 1; i < mint.chests.length; i++) if (mint.chests[i].rarity > mint.chests[idx].rarity) idx = i;
  const chest = mint.chests[idx];
  const elapsed = now - chest.since;
  if (elapsed + MINT_GRACE_MS < MINT_DURATIONS[chest.rarity]) {
    return reject(rejections, "mint_early", { rarity: chest.rarity, elapsed });
  }
  mint.chests.splice(idx, 1);
  mint.minted++;
  return { ok: true, rarity: chest.rarity, points: MINT_POINTS[chest.rarity], minted: mint.minted };
}

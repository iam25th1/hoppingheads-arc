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

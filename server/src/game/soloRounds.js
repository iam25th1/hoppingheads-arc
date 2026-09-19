/**
 * Solo round state
 *
 * A solo round has no lobby, but the client must never place a fragment on
 * its own, so the server holds the round's layout stream here and performs
 * every respawn. The client asks with the round's key and applies what it is
 * told, exactly as a lobby client applies frag:respawn.
 *
 * The key is 128 bits of OS entropy returned once by POST /api/round/start.
 * It is what lets the client advance this round's stream and nothing else's.
 * Guests get one too: their round has no database row, but it has state.
 *
 * Entries expire after ROUND_TTL_MS of inactivity. Bounded, so an
 * unauthenticated caller cannot grow this without limit.
 */

import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const layoutModule = require("../../../shared/layout.cjs");

export const ROUND_TTL_MS = 10 * 60 * 1000; // a 3 minute round plus slack
export const MAX_ROUNDS = 5000;

const rounds = new Map(); // key -> { id, seed, mapIndex, mode, layout, respawns, touched }

function sweep(now) {
  for (const [key, r] of rounds) if (now - r.touched > ROUND_TTL_MS) rounds.delete(key);
}

/**
 * Register an issued round and build its layout. Returns the key the
 * client uses for respawns. Throws 'solo_rounds_full' at the bound.
 */
export function registerSoloRound(round, now = Date.now()) {
  sweep(now);
  if (rounds.size >= MAX_ROUNDS) throw new Error("solo_rounds_full");
  const key = crypto.randomBytes(16).toString("hex");
  rounds.set(key, {
    id: round.id,
    seed: round.seed,
    mapIndex: round.mapIndex,
    mode: round.mode,
    layout: layoutModule.createLayout(round.seed, round.mapIndex),
    respawns: [],
    touched: now,
  });
  return key;
}

/**
 * Respawn one rarity of a solo round from its stream. Returns the moved
 * fragments, or null for an unknown or expired key or a bad rarity. The
 * order of respawns is kept on the round so the trajectory can be replayed
 * from the seed later.
 */
export function respawnSoloRound(key, rarity, now = Date.now()) {
  if (typeof key !== "string") return null;
  const r = rounds.get(key);
  if (!r) return null;
  if (now - r.touched > ROUND_TTL_MS) { rounds.delete(key); return null; }
  if (!Number.isInteger(rarity) || rarity < 0 || rarity >= layoutModule.FRAG_N.length) return null;
  r.touched = now;
  const moved = r.layout.respawn(rarity);
  r.respawns.push(rarity);
  return moved;
}

/** For tests and logs. */
export function soloRoundCount() {
  return rounds.size;
}

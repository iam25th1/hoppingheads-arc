/**
 * Round issuance
 *
 * The one place a round's seed and map come from. A lobby round and a solo
 * round go through the same function, so phase 3 has one code path to commit
 * to: every seed the game ever plays was generated here, on the server, and
 * written to the rounds row before the client saw it.
 *
 * The seed is 256 bits from crypto.randomBytes. shared/layout.cjs folds all
 * of it into the layout stream (see shared/prng.cjs), so the space is not
 * brute forceable. mapIndex is a preference the caller may pass (a solo
 * player picks a map in the menu); the server validates it and otherwise
 * picks one with crypto.randomInt.
 */

import crypto from "crypto";
import { keccak256 } from "ethers";
import { createRequire } from "module";
import { query } from "../db/pool.js";

const require = createRequire(import.meta.url);
const layout = require("../../../shared/layout.cjs");

export const MAP_COUNT = layout.MAP_COUNT;

/** 0x plus 64 hex digits, 256 bits of OS entropy. */
export function newSeed() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

/** The on chain round id: 256 random bits, drawn once, single use at the escrow. */
export function newOnchainRoundId() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

/** What openRound is called with: keccak256 of the 32 byte seed, as ArenaEscrow.commitFor. */
export function seedCommitFor(seed) {
  if (!/^0x[0-9a-f]{64}$/.test(seed)) throw new TypeError("seedCommitFor: seed must be 0x plus 64 hex digits");
  return keccak256(seed);
}

/** A valid requested map index, else a uniformly random one. */
export function pickMapIndex(requested) {
  if (Number.isInteger(requested) && requested >= 0 && requested < MAP_COUNT) return requested;
  return crypto.randomInt(MAP_COUNT);
}

/**
 * Issue a round. Persists the rounds row when `persist` is true and the
 * database answers; if it does not, the round is still issued (the game must
 * stay playable in dev with no database) and `id` is null, which is logged.
 *
 * @param {object} opts
 * @param {string} opts.mode         classic-solo, lbs-solo, multiplayer
 * @param {number} [opts.mapIndex]   requested map, validated
 * @param {string} [opts.issuedTo]   participant id the round was issued to (solo)
 * @param {number} [opts.maxPlayers]
 * @param {number} [opts.durationSecs]
 * @param {boolean} [opts.persist]
 * @param {function} [q]             query function, injectable for tests
 */
export async function issueRound(opts, q = query) {
  const { mode, mapIndex, issuedTo = null, maxPlayers = 1, durationSecs = 180, persist = true, stakeable = false } = opts;
  if (typeof mode !== "string" || !/^[a-z-]{3,24}$/.test(mode)) throw new TypeError("issueRound: bad mode");
  const seed = newSeed();
  const map = pickMapIndex(mapIndex);
  // A stakeable round exists on chain before anyone can stake: it is born with the id the
  // escrow will key it by and the commitment openRound is called with, and its row starts
  // in the lobby with chain_status open_requested for the settlement worker to pick up.
  // The worker holds the operator key; this process holds none.
  const onchainRoundId = stakeable === true ? newOnchainRoundId() : null;
  const seedCommit = stakeable === true ? seedCommitFor(seed) : null;
  let id = null;
  if (persist) {
    try {
      const r = await q(
        `INSERT INTO rounds (mode, map_index, seed, status, max_players, duration_secs, issued_to, start_time, stakeable, onchain_round_id, seed_commit, chain_status)
         VALUES ($1, $2, $3, $8, $4, $5, $6, NOW(), $7, $9, $10, $11) RETURNING id`,
        [mode, map, seed, maxPlayers, durationSecs, issuedTo, stakeable === true, stakeable === true ? 'lobby' : 'active', onchainRoundId, seedCommit, stakeable === true ? 'open_requested' : 'none']
      );
      id = r.rows[0].id;
    } catch (err) {
      console.warn(`[Rounds] could not persist ${mode} round (${err.message}); issuing without a row`);
    }
  }
  return { id, seed, mapIndex: map, mode, stakeable: stakeable === true, onchainRoundId, seedCommit };
}

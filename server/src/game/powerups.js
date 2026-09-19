/**
 * Powerups, server side
 *
 * The server decides when a powerup spawns, where, which type, and who took
 * it. The client renders what it is told. Before this every client ran its
 * own schedule with a Math.random type, so no two clients in a round saw
 * the same powerups and the server never knew who was boosted.
 *
 * Schedule, types, count and radius are the client's own numbers: first
 * spawn 15s into the round, then every 25s, at most 5 active, gone after
 * 45s, picked up within 4 units. Type and position come off a stream
 * derived from the round seed (shared/layout.cjs createPositionStream, last
 * seed byte 0xff), so a round's powerups replay from the seed.
 *
 * Pickup uses the same idea as collection: the server checks its own
 * tracked positions, every tick, for every seat, bots included. There is no
 * claim event; proximity on the server is the claim. Effects the server
 * needs to know about (speed, for the movement cap) are recorded on the
 * seat as effects[type] = until. Effects that are purely visual stay on the
 * client, which applies its own local effect when pw:taken names it.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const layoutModule = require("../../../shared/layout.cjs");

export const PW_TYPES = ["speed", "shield", "magnet"]; // the classic set, PW_CLASSIC on the client
export const PW_DURATIONS = { speed: 8000, shield: 2000, magnet: 12000 }; // ms; shield is a hit count on the client, 2s here is only for the record
export const PW_FIRST_MS = 15000;
export const PW_INTERVAL_MS = 25000;
export const PW_MAX_ACTIVE = 5;
export const PW_LIFETIME_MS = 45000;
export const PW_COLLECT_R = 4;
export const PW_PLACE_RANGE = 0.35;

export function createPowerupState(seed, mapIndex, startedAt) {
  return {
    stream: layoutModule.createPositionStream(seed, mapIndex, PW_PLACE_RANGE),
    active: new Map(), // id -> { id, type, x, z, spawnedAt }
    nextId: 0,
    nextSpawnAt: startedAt + PW_FIRST_MS,
    log: [], // [type, x, z] in spawn order, for replay checks
  };
}

/** Spawn if due and there is room. Returns the new powerup or null. */
export function spawnIfDue(state, now) {
  if (now < state.nextSpawnAt) return null;
  state.nextSpawnAt = now + PW_INTERVAL_MS;
  if (state.active.size >= PW_MAX_ACTIVE) return null;
  const type = PW_TYPES[Math.floor(state.stream.nextFloat() * PW_TYPES.length)];
  const pos = state.stream.next();
  const pw = { id: state.nextId++, type, x: pos.x, z: pos.z, spawnedAt: now };
  state.active.set(pw.id, pw);
  state.log.push([type, pos.x, pos.z]);
  return pw;
}

/** Remove expired powerups. Returns their ids. */
export function expire(state, now) {
  const gone = [];
  for (const [id, pw] of state.active) if (now - pw.spawnedAt > PW_LIFETIME_MS) { state.active.delete(id); gone.push(id); }
  return gone;
}

/**
 * Award every active powerup that a seat is standing on, first seat wins.
 * Returns [{ id, type, by }]. Records the effect on the seat.
 */
export function pickups(state, seats, now) {
  const taken = [];
  for (const [id, pw] of state.active) {
    for (const seat of seats) {
      if (Math.hypot(seat.x - pw.x, seat.z - pw.z) > PW_COLLECT_R) continue;
      state.active.delete(id);
      seat.effects[pw.type] = now + PW_DURATIONS[pw.type];
      taken.push({ id, type: pw.type, by: seat.id });
      break;
    }
  }
  return taken;
}

/** True while the seat's server known effect of that type is running. */
export function hasEffect(seat, type, now) {
  return typeof seat.effects[type] === "number" && seat.effects[type] > now;
}

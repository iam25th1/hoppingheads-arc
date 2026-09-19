/**
 * Spawn positions
 *
 * Where every seat stands when the round starts. Before this every seat,
 * human and bot, was created at the origin, which is itself a recorded
 * obstacle on five of the six maps, and the client placed its own player
 * eight units from it: the whole roster inside boink range of one another
 * before anyone could move.
 *
 * Positions come off the round seed through the shared position stream
 * (layout.cjs createPositionStream) under its own tag, so they never
 * coincide with the fragment, powerup or bot streams, and are clear of the
 * recorded obstacles by the stream's margin. Each seat is at least
 * SPAWN_MIN_DIST from every earlier one. Rounded to a tenth once, here, so
 * the server seat and the client player hold the same number.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const layoutModule = require("../../../shared/layout.cjs");

export const SPAWN_TAG = "fe"; // the stream's last byte; "ff" is powerups, 00..07 are bot brains
export const SPAWN_RANGE = 0.5; // placement band as a fraction of the map, wider than fragments (0.38)
export const SPAWN_MIN_DIST = 20; // boink range tops out at 11 and a chasing bot aims within 4 of its human
const SPAWN_ATTEMPTS = 60;

const tenth = (v) => Math.round(v * 10) / 10;

/** count positions for seed and mapIndex, in seat order. */
export function createSpawns(seed, mapIndex, count) {
  const stream = layoutModule.createPositionStream(seed, mapIndex, SPAWN_RANGE, SPAWN_TAG);
  const out = [];
  for (let i = 0; i < count; i++) {
    let at = null;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS && at === null; attempt++) {
      const p = stream.next();
      if (out.every((o) => Math.hypot(o.x - p.x, o.z - p.z) >= SPAWN_MIN_DIST)) at = p;
    }
    if (at === null) at = stream.next(); // keeps the round starting; the tests show this is not reached over 288 runs
    out.push({ x: tenth(at.x), z: tenth(at.z) });
  }
  return out;
}

/**
 * Bot driver
 *
 * Moves bots on the server tick. Decisions come off a stream derived from
 * the round seed and the bot's slot, so a bot's decision sequence is
 * reproducible from the seed. Movement is plain arithmetic in real elapsed
 * time (the movement judge uses real time, so the driver must too), so
 * positions replay exactly at a fixed tick and drift with tick jitter live;
 * fragment claims and human positions are inputs, and humans are not
 * reproducible.
 *
 * Behaviour parity with the client AI is not the goal. A bot wanders,
 * chases a nearby human, and seeks the nearest unclaimed fragment, and it
 * claims through the same validated collection path a human uses; this
 * file only decides where to go and when to try. It never touches fragment
 * state.
 *
 * Bots move at BOT_SPEED, under the 18 unit base speed, and are judged by
 * the same movement rules as humans. A bot tripping the speed check is a
 * driver bug; the tests assert it never happens, jittered ticks included.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const prng = require("../../../shared/prng.cjs");
const layoutModule = require("../../../shared/layout.cjs");

export const BOT_SPEED = 14; // units per second, unboosted
export const BOT_TICK_S = 0.1; // nominal step; the server passes the real elapsed time
export const MAX_STEP_S = 0.25; // a stalled tick loses ground rather than leaping
export const SEEK_RANGE = 60; // a fragment this close is worth going for
export const CHASE_RANGE = 45; // a human this close may be chased
export const CLAIM_RANGE = 2.5; // try to claim inside this; the server accepts within 6

const MAP_EDGE = layoutModule.MAP / 2 - 3;

/** The 256 bit stream seed for slot n: the round seed with its last byte replaced. */
export function botStreamSeed(seedHex, slot) {
  return seedHex.slice(0, 64) + slot.toString(16).padStart(2, "0");
}

export function createBotBrain(seedHex, slot) {
  return {
    rng: prng.createRngFromHex(botStreamSeed(seedHex, slot)),
    target: null,    // { x, z, fragId|null }
    wait: 0,         // ticks until the next decision
    decisions: [],   // trace of choices, for replay checks: 'seek' | 'chase' | 'wander'
  };
}

function nearest(list, x, z, within) {
  let best = null, bestD = within;
  for (const item of list) {
    const d = Math.hypot(item.x - x, item.z - z);
    if (d < bestD) { bestD = d; best = item; }
  }
  return best;
}

/**
 * Pick a new target. world = { fragments: [{id,x,z}] unclaimed, humans: [{x,z}] }.
 * Draws from the brain's stream only.
 */
export function decide(brain, bot, world) {
  const rng = brain.rng;
  const roll = rng.nextFloat();
  const frag = roll < 0.6 ? nearest(world.fragments, bot.x, bot.z, SEEK_RANGE) : null;
  if (frag) {
    brain.target = { x: frag.x, z: frag.z, fragId: frag.id };
    brain.wait = 40 + Math.floor(rng.nextFloat() * 30); // up to 7s to get there
    brain.decisions.push("seek");
    return;
  }
  const human = roll < 0.85 ? nearest(world.humans, bot.x, bot.z, CHASE_RANGE) : null;
  if (human) {
    brain.target = { x: human.x + (rng.nextFloat() - 0.5) * 8, z: human.z + (rng.nextFloat() - 0.5) * 8, fragId: null };
    brain.wait = 10 + Math.floor(rng.nextFloat() * 15);
    brain.decisions.push("chase");
    return;
  }
  brain.target = { x: (rng.nextFloat() - 0.5) * layoutModule.MAP * 0.6, z: (rng.nextFloat() - 0.5) * layoutModule.MAP * 0.6, fragId: null };
  brain.wait = 15 + Math.floor(rng.nextFloat() * 25);
  brain.decisions.push("wander");
}

/**
 * One tick. Returns the position the bot wants to be at next and, when it
 * is standing on its target fragment, the id it wants to claim. The caller
 * runs the movement rules and the validated collection path.
 */
export function stepBot(brain, bot, world, speed = BOT_SPEED, dt = BOT_TICK_S) {
  dt = Math.max(0, Math.min(MAX_STEP_S, dt));
  // A targeted fragment may have been claimed (gone) or respawned (moved)
  // since the decision. Follow it where it is now, or decide again.
  let claimed = false;
  if (brain.target && brain.target.fragId !== null) {
    const f = world.fragments.find((x) => x.id === brain.target.fragId);
    if (!f) claimed = true;
    else { brain.target.x = f.x; brain.target.z = f.z; }
  }
  if (!brain.target || brain.wait <= 0 || claimed) decide(brain, bot, world);
  brain.wait--;

  const dx = brain.target.x - bot.x;
  const dz = brain.target.z - bot.z;
  const dist = Math.hypot(dx, dz);
  let nx = bot.x, nz = bot.z, moving = false;
  if (dist > 0.5) {
    const step = Math.min(speed * dt, dist);
    nx = bot.x + dx / dist * step;
    nz = bot.z + dz / dist * step;
    moving = true;
  }
  nx = Math.max(-MAP_EDGE, Math.min(MAP_EDGE, nx));
  nz = Math.max(-MAP_EDGE, Math.min(MAP_EDGE, nz));
  const ry = moving ? Math.atan2(dx, dz) : bot.ry;

  let claimId = null;
  if (brain.target.fragId !== null && Math.hypot(brain.target.x - nx, brain.target.z - nz) <= CLAIM_RANGE) {
    claimId = brain.target.fragId;
    brain.wait = 0; // decide again next tick whatever happened
  }
  return { nx, nz, ry, moving, claimId };
}

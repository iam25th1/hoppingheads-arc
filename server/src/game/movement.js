/**
 * Movement judgement
 *
 * Decides, per position update, whether a player moved faster than a player
 * can, and where the server believes they are. Pure and clock injected;
 * gameSocket.js keeps one state per player and wires pos and boink to it.
 *
 * The old rule was distance <= maxSpeed * elapsed + 2 per update. The 2 unit
 * knockback margin was granted on every update, so at 15 updates a second it
 * bought 28 units a second on top of the cap: a continuous 43 unit per second
 * hack (2.4 times real speed) ran for 60 updates unflagged.
 *
 * Three changes:
 *
 *   1. No constant margin. Speed is judged as path length over a short window
 *      of history against maxSpeed times the window's real span. The window
 *      is what makes this latency tolerant: updates that arrive bunched after
 *      a stall are judged over the span they really cover, not the few
 *      milliseconds between arrivals, and a silent gap is credited as time
 *      the player could have been walking, since honest clients never stop
 *      sending during a round.
 *
 *   2. Knockback is a budget, not a margin. The boink handler already knows
 *      when a player was hit, so it grants KNOCKBACK_UNITS to the target for
 *      KNOCKBACK_WINDOW_MS. The budget is spent on the excess of a step over
 *      the walking allowance, once, and never reapplied. No knockback, no
 *      margin. A hit moves a player at 15 units a second for up to 0.5s
 *      (client applyKnockback), so 8 units covers it with room.
 *
 *   3. The cap is per seat. BASE_SPEED (18, the client's SPD) for anyone,
 *      BOOST_SPEED (36) only while the server's own powerup record says the
 *      seat is boosted. The caller passes the cap; this file does not know
 *      about powerups. Anything above the cap is caught within one window.
 *
 * Overspeed is clamped, never ejected: the server position moves only as far
 * as the window allowance permits, and the flag is counted. A sustained hack
 * therefore flags on every update once the window fills, and the server's
 * position for that player falls behind the reported one, which is what the
 * collection range check then sees.
 */

export const BASE_SPEED = 18; // the client's SPD
export const BOOST_SPEED = 36; // SPD times the 2x speed powerup, only while the server knows the seat is boosted
export const MAX_SPEED = BOOST_SPEED; // kept for callers that only know the ceiling
export const MOVE_WINDOW_MS = 600; // speed is judged over this much history
export const KNOCKBACK_UNITS = 8; // 15 units a second for up to 0.5s, plus room
export const KNOCKBACK_WINDOW_MS = 700; // must be spent within this after the hit
export const MIN_STEP_MS = 16;
// Per window, not per update. Covers floating point at the cap and the
// client rounding positions to 0.1 before sending (up to 0.05 per update,
// about ten updates a window). It does not grow with update rate.
export const WINDOW_TOLERANCE = 0.5;

export function createMoveState(x = 0, z = 0) {
  return { x, z, lastAt: 0, samples: [], knockback: null };
}

/** The player was hit by a boink the server verified. Called from the boink handler. */
export function grantKnockback(state, now) {
  state.knockback = { budget: KNOCKBACK_UNITS, until: now + KNOCKBACK_WINDOW_MS };
}

/**
 * Judge a reported position and return where the server now places the
 * player, plus whether this update was flagged.
 *
 * @param {object} state     from createMoveState
 * @param {number} nx, nz    reported position, already clamped to the map
 * @param {number} now       arrival time, ms
 * @param {number} maxSpeed  this player's ceiling in units a second (grow applied)
 */
export function judgeMove(state, nx, nz, now, maxSpeed) {
  const dx = nx - state.x;
  const dz = nz - state.z;
  const step = Math.sqrt(dx * dx + dz * dz);

  // First sighting: there is no known start time for this step, so it is
  // accepted as is and not sampled. Sampling it against a 16ms span would
  // charge a whole step to almost no time and inflate every window after.
  if (state.lastAt === 0) {
    state.x = nx;
    state.z = nz;
    state.lastAt = now;
    return { x: nx, z: nz, flagged: false, step, path: 0, allowance: 0, spanMs: 0, credit: 0 };
  }
  const tStart = state.lastAt;
  const stepMs = Math.max(now - tStart, MIN_STEP_MS);

  // Knockback credit: spend it on this step's excess over walking, once.
  let credit = 0;
  if (state.knockback) {
    if (now > state.knockback.until || state.knockback.budget <= 0) {
      state.knockback = null;
    } else {
      const walk = maxSpeed * stepMs / 1000;
      const excess = Math.max(0, step - walk);
      credit = Math.min(state.knockback.budget, excess);
      state.knockback.budget -= credit;
    }
  }

  // Window of recent steps. Each sample is the distance not covered by
  // knockback, with the real time it took.
  const sample = { tStart, tEnd: now, d: step - credit };
  state.samples.push(sample);
  while (state.samples.length > 1 && state.samples[0].tEnd < now - MOVE_WINDOW_MS) state.samples.shift();
  const spanMs = Math.max(now - state.samples[0].tStart, MIN_STEP_MS);
  const allowance = maxSpeed * spanMs / 1000;
  let path = 0;
  for (const s of state.samples) path += s.d;

  // WINDOW_TOLERANCE is one centimetre per window, for floating point at
  // exactly the cap. It does not grow with update rate.
  let x = nx, z = nz, flagged = false;
  if (path > allowance + WINDOW_TOLERANCE) {
    flagged = true;
    // Move only as far as the window still allows, plus what knockback paid for.
    const before = path - sample.d;
    const allowedStep = Math.max(0, allowance - before) + credit;
    const ratio = step > 0 ? Math.min(1, allowedStep / step) : 0;
    x = state.x + dx * ratio;
    z = state.z + dz * ratio;
    sample.d = Math.max(0, step * ratio - credit);
  }

  state.x = x;
  state.z = z;
  state.lastAt = now;
  return { x, z, flagged, step, path, allowance, spanMs, credit };
}

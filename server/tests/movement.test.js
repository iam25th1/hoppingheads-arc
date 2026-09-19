import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoveState, grantKnockback, judgeMove, MAX_SPEED, BASE_SPEED, BOOST_SPEED, KNOCKBACK_UNITS, MOVE_WINDOW_MS } from '../src/game/movement.js';

const SPD = 18; // the client's base speed
const TICK = 70; // client sends every ~66ms; 70 leaves a little slack

/** Walk in a straight line at `unitsPerSec`, one update per `gapMs`, from t=0. */
function run(unitsPerSec, updates, { gapMs = TICK, state = createMoveState(), maxSpeed = MAX_SPEED, startT = 1000, gaps } = {}) {
  let t = startT, x = state.x;
  const flags = [];
  const results = [];
  for (let i = 0; i < updates; i++) {
    const gap = gaps ? gaps[i % gaps.length] : gapMs;
    t += gap;
    x += unitsPerSec * gap / 1000;
    const r = judgeMove(state, x, 0, t, maxSpeed);
    results.push(r);
    if (r.flagged) flags.push(i);
  }
  return { flags, results, state, t, reported: x };
}

test('honest walking at base speed never flags', () => {
  const { flags } = run(SPD, 60);
  assert.deepEqual(flags, []);
});

test('a server known boost (2x base) never flags under the boosted cap', () => {
  const { flags, state, reported } = run(SPD * 2, 60, { maxSpeed: BOOST_SPEED });
  assert.deepEqual(flags, []);
  assert.ok(Math.abs(state.x - reported) < 1e-9, 'server position tracks the client exactly');
});

test('an unboosted player at 1.5x flags under the base cap; at 1.0x with 0.1 rounding it does not', () => {
  assert.ok(run(SPD * 1.5, 60, { maxSpeed: BASE_SPEED }).flags.length >= 50);
  // Honest client: positions rounded to 0.1 before sending
  const s = createMoveState();
  let t = 1000, x = 0, flags = 0;
  for (let i = 0; i < 120; i++) { t += TICK; x += SPD * TICK / 1000; if (judgeMove(s, Math.round(x * 10) / 10, 0, t, BASE_SPEED).flagged) flags++; }
  assert.equal(flags, 0);
});

test('an unboosted player at 2x flags under the base cap', () => {
  assert.ok(run(SPD * 2, 60, { maxSpeed: BASE_SPEED }).flags.length >= 50);
});

test('a continuous 2.4x run over 60 updates flags, and the server position falls behind', () => {
  const { flags, state, reported } = run(SPD * 2.4, 60);
  assert.ok(flags.length >= 50, `flagged ${flags.length} of 60`);
  assert.ok(flags[0] <= Math.ceil(MOVE_WINDOW_MS / TICK), `first flag at update ${flags[0]}, within one window`);
  assert.ok(reported - state.x > 10, `server lags the client by ${(reported - state.x).toFixed(1)}`);
});

test('a single teleport still flags at that step, after honest walking', () => {
  const { state, t } = run(SPD, 20);
  const r = judgeMove(state, state.x + 322, 0, t + TICK, MAX_SPEED);
  assert.equal(r.flagged, true);
  assert.ok(r.step > 300 && state.x < r.step, 'clamped, not teleported');
});

test('a legitimate boink knockback on top of a boosted run does not flag; the same without the grant does', () => {
  // Boosted (36) plus knockback (15) for 0.5s: 51 units a second for 7 updates.
  const withGrant = run(SPD * 2, 10);
  grantKnockback(withGrant.state, withGrant.t);
  const burst = run(SPD * 2 + 15, 7, { state: withGrant.state, startT: withGrant.t });
  const after = run(SPD * 2, 20, { state: withGrant.state, startT: burst.t });
  assert.deepEqual(burst.flags, [], 'knocked back player is not flagged');
  assert.deepEqual(after.flags, [], 'and settles cleanly after');

  const noGrant = run(SPD * 2, 10);
  const burst2 = run(SPD * 2 + 15, 7, { state: noGrant.state, startT: noGrant.t });
  assert.ok(burst2.flags.length > 0, 'the same burst with no boink on record flags');
});

test('the knockback budget is spent once, not reapplied', () => {
  const s = createMoveState();
  const { t } = run(SPD, 5, { state: s });
  grantKnockback(s, t);
  // Spend it all in one step, then keep overspeeding: only the first step is covered.
  const r1 = judgeMove(s, s.x + (SPD * TICK / 1000) + KNOCKBACK_UNITS, 0, t + TICK, BASE_SPEED);
  assert.equal(r1.flagged, false);
  assert.ok(r1.credit > 0);
  const r2 = judgeMove(s, s.x + (SPD * TICK / 1000) + KNOCKBACK_UNITS, 0, t + 2 * TICK, BASE_SPEED);
  assert.equal(r2.flagged, true, 'the budget does not refill');
});

test('bunched arrivals after a stall do not flag: the window judges real span', () => {
  // Honest 18 u/s, but arrivals alternate 20ms and 120ms: per step that looks like 4x speed.
  const { flags } = run(SPD, 60, { gaps: [20, 120] });
  assert.deepEqual(flags, []);
  // A 3 second silence, then the buffered updates land 10ms apart covering 54 units.
  const s = createMoveState();
  const a = run(SPD, 10, { state: s });
  const b = run(SPD, 6, { state: s, startT: a.t + 3000 - 10, gaps: [10] });
  assert.deepEqual(b.flags, []);
});

test('a grown player is held to the reduced ceiling', () => {
  const reduced = MAX_SPEED * (1 - 0.45); // fully grown, mirrors the client penalty
  assert.deepEqual(run(reduced * 0.95, 60, { maxSpeed: reduced }).flags, []);
  assert.ok(run(reduced * 1.2, 60, { maxSpeed: reduced }).flags.length > 40);
});

test('threshold: unboosted flagging begins just above 1.0x, boosted just above 2.0x', () => {
  const firstFlag = (cap) => { for (let m = 1.0; m <= 3.0; m = +(m + 0.01).toFixed(2)) { if (run(SPD * m, 60, { maxSpeed: cap }).flags.length > 0) return m; } return null; };
  const base = firstFlag(BASE_SPEED), boost = firstFlag(BOOST_SPEED);
  assert.ok(base > 1.0 && base <= 1.1, `unboosted first flagging multiplier ${base}`);
  assert.ok(boost > 2.0 && boost <= 2.1, `boosted first flagging multiplier ${boost}`);
});

test('first update is accepted as is', () => {
  const s = createMoveState();
  const r = judgeMove(s, 100, -40, 5000, MAX_SPEED);
  assert.equal(r.flagged, false);
  assert.deepEqual([s.x, s.z], [100, -40]);
});

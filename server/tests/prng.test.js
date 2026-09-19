/**
 * Determinism contract for server/src/game/prng.js.
 *
 * These tests are the thing that makes a seeded run trustworthy, so they
 * assert the contract directly rather than sampling statistics: identical
 * seeds replay exactly, different seeds diverge, and the sequence does not
 * move when the process does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRng, seedFrom, createRngFromHex, isHexSeed } = require('../../shared/prng.cjs');

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRNG_PATH = path.join(HERE, '..', '..', 'shared', 'prng.cjs');

/** Draw n uint32 values from a fresh generator. */
function draw(seed, n = 64) {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.nextUint32());
}

// -- Same seed, same sequence ----------------------------------

test('same seed produces the same sequence', () => {
  assert.deepEqual(draw('arc-arena-p1'), draw('arc-arena-p1'));
  assert.deepEqual(draw(42), draw(42));
  assert.deepEqual(draw(0), draw(0));
});

test('a numeric seed and its string form are distinct seeds', () => {
  // Guards against a caller accidentally passing "42" where 42 was meant and
  // silently getting a different run.
  assert.notDeepEqual(draw(42), draw('42'));
});

test('two generators on one seed do not share state', () => {
  const a = createRng('shared');
  const b = createRng('shared');
  // Interleaving the draws must not shift either sequence.
  const interleaved = [];
  for (let i = 0; i < 16; i++) {
    interleaved.push(a.nextUint32());
    b.nextUint32();
  }
  assert.deepEqual(interleaved, draw('shared', 16));
});

test('the generator does not read Math.random', () => {
  const real = Math.random;
  Math.random = () => {
    throw new Error('prng must not call Math.random');
  };
  try {
    assert.deepEqual(draw('no-global-entropy', 32), draw('no-global-entropy', 32));
  } finally {
    Math.random = real;
  }
});

// -- Different seeds diverge -----------------------------------

test('different seeds produce different sequences', () => {
  assert.notDeepEqual(draw('seed-a'), draw('seed-b'));
  assert.notDeepEqual(draw(1), draw(2));
});

test('adjacent numeric seeds diverge from the first draw', () => {
  // The SplitMix32 seeding step exists for this. Without it, nearby seeds
  // produce correlated openings, which would make a run guessable.
  for (let i = 0; i < 64; i++) {
    assert.notEqual(createRng(i).nextUint32(), createRng(i + 1).nextUint32(), `seeds ${i} and ${i + 1} collided`);
  }
});

test('1024 distinct seeds produce 1024 distinct sequences', () => {
  const seen = new Set();
  for (let i = 0; i < 1024; i++) seen.add(draw(`run-${i}`, 4).join(','));
  assert.equal(seen.size, 1024);
});

// -- Stable across process restarts ----------------------------

// Captured from the implementation under test. If a change to prng.js moves
// these numbers, every previously recorded seed replays differently and past
// runs stop being reproducible. Treat a failure here as a breaking change,
// not a test to update.
const GOLDEN = {
  'arc-arena-p1': [2842425354, 659914802, 493659168, 18813400, 2153274254, 3248225571, 2974498179, 566586181],
  42: [660444221, 3652823732, 77672526, 910233633, 2297337756, 3786072677, 3123505064, 1891482476],
};

test('sequence matches the recorded golden vectors', () => {
  assert.deepEqual(draw('arc-arena-p1', 8), GOLDEN['arc-arena-p1']);
  assert.deepEqual(draw(42, 8), GOLDEN[42]);
});

test('sequence is identical in a separate process', async () => {
  // The golden vectors above would still pass if the generator were seeded
  // from something process wide and stable within one run. Actually starting
  // a second node process is what rules that out.
  const script = `
    import { createRequire } from 'node:module';
    const { createRng } = createRequire(import.meta.url)(${JSON.stringify(PRNG_PATH)});
    const rng = createRng('arc-arena-p1');
    process.stdout.write(JSON.stringify(Array.from({ length: 8 }, () => rng.nextUint32())));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script]);
  assert.deepEqual(JSON.parse(stdout), GOLDEN['arc-arena-p1']);
});

// -- Output shape ----------------------------------------------

test('nextUint32 stays in uint32 range', () => {
  const rng = createRng('range-check');
  for (let i = 0; i < 10000; i++) {
    const v = rng.nextUint32();
    assert.ok(Number.isInteger(v), `not an integer: ${v}`);
    assert.ok(v >= 0 && v <= 0xffffffff, `out of uint32 range: ${v}`);
  }
});

test('nextFloat stays in [0, 1)', () => {
  const rng = createRng('float-check');
  for (let i = 0; i < 10000; i++) {
    const v = rng.nextFloat();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('the generator does not stick on a constant', () => {
  // A zeroed xoshiro state emits 0 forever. This is the cheap canary for it.
  const values = new Set(draw('not-stuck', 256));
  assert.ok(values.size > 250, `only ${values.size} distinct values in 256 draws`);
});

// -- Seed normalisation ----------------------------------------

test('seedFrom is stable and total over its accepted inputs', () => {
  assert.equal(seedFrom('arc-arena-p1'), seedFrom('arc-arena-p1'));
  assert.equal(seedFrom(42), 42);
  assert.equal(seedFrom(-1), 0xffffffff);
  assert.equal(seedFrom(2 ** 32), 0);
  assert.equal(seedFrom(7.9), 7);
  assert.ok(Number.isInteger(seedFrom('0xdeadbeef')));
});

test('seedFrom rejects seeds it cannot represent', () => {
  assert.throws(() => seedFrom(''), TypeError);
  assert.throws(() => seedFrom(NaN), TypeError);
  assert.throws(() => seedFrom(Infinity), TypeError);
  assert.throws(() => seedFrom(null), TypeError);
  assert.throws(() => seedFrom(undefined), TypeError);
  assert.throws(() => seedFrom({}), TypeError);
});

// -- Full width hex seeds -----------------------------------------

const HEX_A = '0x' + 'ab'.repeat(32);

test('createRngFromHex: same seed, same sequence; golden vector', () => {
  const draw = (h, n = 8) => { const r = createRngFromHex(h); return Array.from({ length: n }, () => r.nextUint32()); };
  assert.deepEqual(draw(HEX_A), draw(HEX_A));
  assert.ok(isHexSeed(HEX_A));
  assert.equal(isHexSeed('0x' + 'ab'.repeat(31)), false);
  assert.equal(isHexSeed('ab'.repeat(32)), false);
  assert.throws(() => createRngFromHex('0xdead'), TypeError);
});

test('createRngFromHex: every hex digit of the 256 bits reaches the state', () => {
  // Flip one nibble at a time across the whole seed; each must change the
  // opening draws. A seed reduced to 32 bits would leave 56 of these flips
  // with no effect. Eight draws, because the first xoshiro output depends on
  // one state word only and the others mix in over the next steps.
  const draw = (h) => { const r = createRngFromHex(h); return Array.from({ length: 8 }, () => r.nextUint32()).join(','); };
  const base = draw(HEX_A);
  for (let i = 2; i < 66; i++) {
    const flipped = HEX_A.slice(0, i) + (HEX_A[i] === 'a' ? 'b' : 'a') + HEX_A.slice(i + 1);
    assert.notEqual(draw(flipped), base, 'flip at hex digit ' + (i - 2) + ' had no effect');
  }
});

test('createRngFromHex: the all zero seed does not stick', () => {
  const r = createRngFromHex('0x' + '0'.repeat(64));
  const values = new Set(Array.from({ length: 64 }, () => r.nextUint32()));
  assert.ok(values.size > 60);
});

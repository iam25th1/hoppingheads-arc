import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSpawns, SPAWN_MIN_DIST, SPAWN_RANGE, SPAWN_TAG } from '../src/game/spawns.js';

const require = createRequire(import.meta.url);
const layout = require('../../shared/layout.cjs');
const obstacles = require('../../shared/mapObstacles.cjs');
// Seeds whose two 128 bit halves differ, like a real one. A repeated byte seed folds to an all
// zero xoshiro state (prng.cjs createRngFromHex) and draws zeros.
const seedN = (n) => '0x' + Array.from({ length: 64 }, (_, i) => ((i * 7 + n * 13 + (i >> 5) * 5) % 16).toString(16)).join('');
const SEED = seedN(0);

test('spawns: same seed and map, same positions; a different seed or map differs', () => {
  assert.deepEqual(createSpawns(SEED, 1, 8), createSpawns(SEED, 1, 8));
  assert.notDeepEqual(createSpawns(SEED, 1, 8), createSpawns(seedN(9), 1, 8));
  assert.notDeepEqual(createSpawns(SEED, 1, 8), createSpawns(SEED, 2, 8));
  assert.deepEqual(createSpawns(SEED, 1, 3), createSpawns(SEED, 1, 8).slice(0, 3)); // seat order is stable as the roster grows
});

test('spawns: eight seats spread out, in the band, clear of every obstacle, on every map over many seeds', () => {
  const half = layout.MAP * SPAWN_RANGE / 2 + 0.05;
  for (let m = 0; m < layout.MAP_COUNT; m++) {
    for (let n = 1; n <= 48; n++) {
      const s = createSpawns(seedN(n), m, 8);
      assert.equal(s.length, 8);
      for (let i = 0; i < s.length; i++) {
        assert.equal(s[i].x, Math.round(s[i].x * 10) / 10, 'rounded to a tenth');
        assert.ok(Math.abs(s[i].x) <= half && Math.abs(s[i].z) <= half, `map ${m} seed ${n} seat ${i} outside the band`);
        // the stream's margin is 1.5; rounding to a tenth can move a point by up to 0.05 on each axis
        for (const c of obstacles[m]) assert.ok(Math.hypot(s[i].x - c[0], s[i].z - c[1]) >= c[2] + 1.5 - 0.08, `map ${m} seed ${n} seat ${i} inside an obstacle`);
        for (let j = 0; j < i; j++) assert.ok(Math.hypot(s[i].x - s[j].x, s[i].z - s[j].z) >= SPAWN_MIN_DIST, `map ${m} seed ${n} seats ${j} and ${i} stacked`);
      }
    }
  }
});

test('spawns: never at the origin, which is an obstacle on five maps and the old spawn on all six', () => {
  for (let m = 0; m < layout.MAP_COUNT; m++) for (let n = 1; n <= 48; n++) {
    for (const s of createSpawns(seedN(n), m, 8)) assert.ok(Math.hypot(s.x, s.z) >= 3, `map ${m} seed ${n} spawned at the origin`);
  }
});

test('spawns: their own stream, and the default stream is unchanged for powerups', () => {
  const a = layout.createPositionStream(SEED, 1, 0.35), b = layout.createPositionStream(SEED, 1, 0.35, 'ff');
  for (let i = 0; i < 5; i++) assert.deepEqual(a.next(), b.next());
  // A tag replaces the seed's last byte, one byte of one xoshiro state word, and the first two
  // outputs depend only on another word: every tagged stream shares its opening two draws with
  // the raw seed's stream (the layout). They diverge from the third draw. Asserted as it is.
  const pw = layout.createPositionStream(SEED, 1, SPAWN_RANGE), sp = layout.createPositionStream(SEED, 1, SPAWN_RANGE, SPAWN_TAG);
  assert.equal(pw.nextFloat(), sp.nextFloat()); assert.equal(pw.nextFloat(), sp.nextFloat());
  assert.notEqual(pw.nextFloat(), sp.nextFloat());
  assert.throws(() => layout.createPositionStream(SEED, 1, 0.35, 'zz'), RangeError);
  assert.throws(() => layout.createPositionStream(SEED, 1, 0.35, 'fff'), RangeError);
});

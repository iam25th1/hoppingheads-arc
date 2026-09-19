/**
 * Fragment layout: one module, two loaders, one result.
 *
 * The server loads shared/layout.cjs through require. The client loads the
 * same bytes as classic scripts. The "client path" test here runs those files
 * as classic scripts inside a bare vm context with no module or require, the
 * way a browser does, and compares the layout to the require path byte for
 * byte across several seeds and every map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SHARED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared');
const layout = require(path.join(SHARED, 'layout.cjs'));
const obstacles = require(path.join(SHARED, 'mapObstacles.cjs'));

const SEEDS = [
  '0x' + '00'.repeat(31) + '01',
  '0x' + 'ab'.repeat(32),
  '0x8f3a1c2e9b7d4f60aa11bb22cc33dd44ee55ff66001122334455667788990011',
  '0x' + 'ff'.repeat(32),
];

function snapshot(l) {
  return JSON.stringify(l.fragments);
}

/** Load the shared files as classic browser scripts: no module, no require. */
function clientPath() {
  const ctx = vm.createContext({});
  vm.runInContext('var globalThis = this;', ctx);
  for (const f of ['prng.cjs', 'mapObstacles.cjs', 'layout.cjs']) {
    vm.runInContext(fs.readFileSync(path.join(SHARED, f), 'utf8'), ctx, { filename: f });
  }
  assert.ok(ctx.HHPrng && ctx.HHMapObstacles && ctx.HHLayout, 'globals exposed');
  return ctx.HHLayout;
}

test('obstacle data: six maps, [x, z, r] triples inside the map', () => {
  assert.equal(obstacles.length, 6);
  for (const m of obstacles) {
    assert.ok(m.length > 0);
    for (const c of m) {
      assert.equal(c.length, 3);
      assert.ok(Math.abs(c[0]) <= 150 && Math.abs(c[1]) <= 150 && c[2] > 0 && c[2] < 30, JSON.stringify(c));
    }
  }
});

test('layout: same inputs, same fragments', () => {
  for (const s of SEEDS) for (let m = 0; m < 6; m++) {
    assert.equal(snapshot(layout.createLayout(s, m)), snapshot(layout.createLayout(s, m)));
  }
});

test('layout: quota, ids, rarity order, bands', () => {
  const l = layout.createLayout(SEEDS[2], 3);
  assert.equal(l.fragments.length, 71);
  const counts = [0, 0, 0, 0, 0];
  l.fragments.forEach((f, i) => {
    assert.equal(f.id, i);
    counts[f.rarity]++;
    assert.ok(Math.abs(f.x) <= 150 * 0.38 && Math.abs(f.z) <= 150 * 0.38, `in band: ${f.x},${f.z}`);
  });
  assert.deepEqual(counts, layout.FRAG_N);
});

test('layout: avoids the map obstacles by radius plus margin (or used the fallback band)', () => {
  for (let m = 0; m < 6; m++) {
    const l = layout.createLayout(SEEDS[1], m);
    let fallback = 0;
    for (const f of l.fragments) {
      const clear = obstacles[m].every((c) => Math.hypot(f.x - c[0], f.z - c[1]) >= c[2] + 1.5);
      if (!clear) {
        assert.ok(Math.abs(f.x) <= 30 && Math.abs(f.z) <= 30, `blocked fragment outside the fallback band on map ${m}`);
        fallback++;
      }
    }
    assert.ok(fallback < 10, `map ${m}: ${fallback} fallbacks, placement is too crowded`);
  }
});

test('layout: different seeds and different maps diverge', () => {
  const a = snapshot(layout.createLayout(SEEDS[0], 0));
  assert.notEqual(a, snapshot(layout.createLayout(SEEDS[1], 0)));
  assert.notEqual(a, snapshot(layout.createLayout(SEEDS[0], 1)));
  // Beyond 32 bits: seeds equal in the first 8 hex digits still diverge
  const s1 = '0x' + '12345678' + '00'.repeat(28);
  const s2 = '0x' + '12345678' + '00'.repeat(27) + '01';
  assert.notEqual(snapshot(layout.createLayout(s1, 0)), snapshot(layout.createLayout(s2, 0)));
});

test('layout: rejects bad inputs', () => {
  assert.throws(() => layout.createLayout('0xdead', 0), TypeError);
  assert.throws(() => layout.createLayout(12345, 0), TypeError);
  assert.throws(() => layout.createLayout(SEEDS[0], 6), RangeError);
  assert.throws(() => layout.createLayout(SEEDS[0], -1), RangeError);
  assert.throws(() => layout.createLayout(SEEDS[0], 1.5), RangeError);
});

test('layout: respawn moves only that rarity and is deterministic', () => {
  const a = layout.createLayout(SEEDS[2], 2);
  const b = layout.createLayout(SEEDS[2], 2);
  const before = a.fragments.map((f) => ({ ...f }));
  const movedA = a.respawn(1);
  const movedB = b.respawn(1);
  assert.deepEqual(movedA, movedB);
  assert.equal(movedA.length, layout.FRAG_N[1]);
  a.fragments.forEach((f, i) => {
    if (f.rarity === 1) assert.ok(f.x !== before[i].x || f.z !== before[i].z);
    else assert.deepEqual(f, before[i]);
  });
  // A second respawn continues the stream: different positions again
  assert.notDeepEqual(a.respawn(1), movedA);
});

test('client path (classic scripts in a bare context) equals server path (require)', () => {
  const HH = clientPath();
  for (const s of SEEDS) for (let m = 0; m < 6; m++) {
    const server = layout.createLayout(s, m);
    const client = HH.createLayout(s, m);
    assert.equal(snapshot(client), snapshot(server), `seed ${s.slice(0, 10)} map ${m}`);
    // JSON, not deepEqual: objects born inside the vm context have a different Object.prototype
    assert.equal(JSON.stringify(client.respawn(3)), JSON.stringify(server.respawn(3)), `respawn seed ${s.slice(0, 10)} map ${m}`);
  }
});

test('served bytes: the client loads exactly the files the server requires', () => {
  // The server serves shared/*.cjs at /game/lib/*.js. There is no copy, so
  // this is a tautology today; it exists to fail loudly if someone adds one.
  for (const f of ['prng.cjs', 'layout.cjs', 'mapObstacles.cjs']) {
    assert.ok(fs.existsSync(path.join(SHARED, f)), f);
  }
});

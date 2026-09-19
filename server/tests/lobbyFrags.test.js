import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createFragState, createRejections, tryCollect, respawnRarity, unclaimedByRarity, COLLECT_RANGE,
} from '../src/game/lobbyFrags.js';

const require = createRequire(import.meta.url);
const layout = require('../../shared/layout.cjs');
const SEED = '0x' + 'c3'.repeat(32);

function fresh() {
  const state = createFragState(layout.createLayout(SEED, 1));
  const rej = createRejections();
  return { state, rej };
}
const at = (f, dx = 0, dz = 0) => ({ x: f.x + dx, z: f.z + dz, shadow: 0 });

test('state mirrors the layout, nothing claimed', () => {
  const { state } = fresh();
  assert.equal(state.frags.size, 71);
  assert.deepEqual(unclaimedByRarity(state), layout.FRAG_N);
});

test('collect: in range and unclaimed succeeds once', () => {
  const { state, rej } = fresh();
  const f = state.frags.get(10);
  const r = tryCollect(state, 'alice', at(f, 1, 1), 10, rej);
  assert.equal(r.ok, true);
  assert.equal(r.fragment.claimedBy, 'alice');
  assert.equal(rej.total, 0);
  const again = tryCollect(state, 'bob', at(f), 10, rej);
  assert.deepEqual(again, { ok: false, reason: 'claimed', id: 10, by: 'alice' });
  assert.equal(rej.claimed, 1);
});

test('collect: range is the server range, not the client radius', () => {
  const { state, rej } = fresh();
  const f = state.frags.get(3);
  assert.equal(tryCollect(state, 'a', at(f, COLLECT_RANGE - 0.01, 0), 3, rej).ok, true);
  const g = state.frags.get(4);
  const r = tryCollect(state, 'a', at(g, COLLECT_RANGE + 0.01, 0), 4, rej);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'range');
  assert.ok(r.dist > COLLECT_RANGE);
  assert.equal(g.claimedBy, null, 'a rejected claim leaves the fragment untouched');
});

test('collect: rejects a missing or malformed id, and shadow form', () => {
  const { state, rej } = fresh();
  const f = state.frags.get(0);
  assert.equal(tryCollect(state, 'a', at(f), 999, rej).reason, 'missing');
  assert.equal(tryCollect(state, 'a', at(f), '0', rej).reason, 'bad_id');
  assert.equal(tryCollect(state, 'a', at(f), 1.5, rej).reason, 'bad_id');
  assert.equal(tryCollect(state, 'a', at(f), undefined, rej).reason, 'bad_id');
  assert.equal(tryCollect(state, 'a', { ...at(f), shadow: 1 }, 0, rej).reason, 'shadow');
  assert.deepEqual(rej, { total: 5, missing: 1, bad_id: 3, shadow: 1 });
});

test('collect: a far away claim on a real fragment is tallied as range with the distance', () => {
  const { state, rej } = fresh();
  const f = state.frags.get(20);
  const r = tryCollect(state, 'cheat', { x: f.x + 100, z: f.z, shadow: 0 }, 20, rej);
  assert.equal(r.reason, 'range');
  assert.ok(Math.abs(r.dist - 100) < 1e-9);
  assert.equal(rej.range, 1);
});

test('respawn: moves one rarity, clears its claims, positions follow the layout stream', () => {
  const { state, rej } = fresh();
  const rare = [...state.frags.values()].filter((f) => f.rarity === 2);
  for (const f of rare) assert.equal(tryCollect(state, 'a', at(f), f.id, rej).ok, true);
  assert.equal(unclaimedByRarity(state)[2], 0);
  const before = new Map([...state.frags].map(([k, v]) => [k, { ...v }]));
  const moved = respawnRarity(state, 2);
  assert.equal(moved.length, layout.FRAG_N[2]);
  assert.equal(unclaimedByRarity(state)[2], layout.FRAG_N[2]);
  for (const m of moved) {
    const f = state.frags.get(m.id);
    assert.equal(f.rarity, 2);
    assert.equal(f.claimedBy, null);
    assert.deepEqual([f.x, f.z], [m.x, m.z]);
    assert.ok(f.x !== before.get(m.id).x || f.z !== before.get(m.id).z);
  }
  for (const [id, b] of before) if (b.rarity !== 2) assert.deepEqual(state.frags.get(id), b);
  // The same seed on another instance respawns to the same places
  const twin = createFragState(layout.createLayout(SEED, 1));
  assert.deepEqual(respawnRarity(twin, 2), moved);
});

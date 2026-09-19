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

// -- Mints ---------------------------------------------------------

import { createMintState, noteCollect, tryMint, MINT_LIMIT, MINT_POINTS, MINT_DURATIONS, MINT_GRACE_MS } from '../src/game/lobbyFrags.js';

test('mint: the old exploit. Rarity 4 claimed five times with nothing collected scores nothing', () => {
  const mint = createMintState();
  const rej = createRejections();
  let score = 0;
  for (let i = 0; i < 5; i++) {
    const r = tryMint(mint, 100000, rej);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mint_no_chest');
    if (r.ok) score += r.points;
  }
  assert.equal(score, 0);
  assert.equal(mint.minted, 0);
  assert.equal(rej.mint_no_chest, 5);
});

test('mint: three collections of one rarity spawn a chest; rarity comes from the record', () => {
  const mint = createMintState();
  const rej = createRejections();
  assert.equal(noteCollect(mint, 2, 1000), null);
  assert.equal(noteCollect(mint, 2, 1001), null);
  assert.equal(noteCollect(mint, 2, 1002), 2, 'third of a rarity spawns its chest');
  assert.deepEqual(mint.fragsSinceChest, [0, 0, 0, 0, 0]);
  const early = tryMint(mint, 1002 + MINT_DURATIONS[2] - MINT_GRACE_MS - 1, rej);
  assert.equal(early.reason, 'mint_early');
  const done = tryMint(mint, 1002 + MINT_DURATIONS[2] - MINT_GRACE_MS, rej);
  assert.deepEqual(done, { ok: true, rarity: 2, points: MINT_POINTS[2], minted: 1 });
  assert.equal(tryMint(mint, 999999, rej).reason, 'mint_no_chest', 'a chest mints once');
});

test('mint: a player who collected three commons scores a common, whatever they claim', () => {
  // The claim carries no rarity at all, so "claiming legendary" is not even expressible.
  const mint = createMintState();
  const rej = createRejections();
  for (let i = 0; i < 3; i++) noteCollect(mint, 0, 0);
  const r = tryMint(mint, MINT_DURATIONS[0], rej);
  assert.equal(r.rarity, 0);
  assert.equal(r.points, 10);
});

test('mint: highest pending rarity is consumed first, and the cap holds', () => {
  const mint = createMintState();
  const rej = createRejections();
  for (let i = 0; i < 3; i++) noteCollect(mint, 0, 0);
  for (let i = 0; i < 3; i++) noteCollect(mint, 3, 0);
  assert.equal(tryMint(mint, 10000, rej).rarity, 3);
  assert.equal(tryMint(mint, 10000, rej).rarity, 0);
  for (let m = mint.minted; m < MINT_LIMIT; m++) {
    for (let i = 0; i < 3; i++) noteCollect(mint, 1, 0);
    assert.equal(tryMint(mint, 10000, rej).ok, true);
  }
  for (let i = 0; i < 3; i++) noteCollect(mint, 1, 0);
  assert.equal(tryMint(mint, 10000, rej).reason, 'mint_cap');
  assert.equal(mint.minted, MINT_LIMIT);
});

test('mint: six collections of one rarity make two chests', () => {
  const mint = createMintState();
  const spawned = [];
  for (let i = 0; i < 6; i++) { const r = noteCollect(mint, 4, i); if (r !== null) spawned.push(r); }
  assert.deepEqual(spawned, [4, 4]);
  assert.equal(mint.chests.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { newSeed, pickMapIndex, issueRound, MAP_COUNT } from '../src/game/rounds.js';

test('newSeed: 0x plus 64 hex, distinct every time', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = newSeed();
    assert.match(s, /^0x[0-9a-f]{64}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 200);
});

test('pickMapIndex: honours a valid request, otherwise random in range', () => {
  for (let m = 0; m < MAP_COUNT; m++) assert.equal(pickMapIndex(m), m);
  for (const bad of [-1, MAP_COUNT, 1.5, '2', null, undefined, NaN]) {
    const v = pickMapIndex(bad);
    assert.ok(Number.isInteger(v) && v >= 0 && v < MAP_COUNT, `bad ${bad} -> ${v}`);
  }
  const hits = new Set();
  for (let i = 0; i < 200; i++) hits.add(pickMapIndex());
  assert.equal(hits.size, MAP_COUNT, 'every map reachable');
});

test('issueRound: persists the seed and map on the round row', async () => {
  const calls = [];
  const q = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 42 }] }; };
  const r = await issueRound({ mode: 'classic-solo', mapIndex: 3, issuedTo: '0x' + 'ab'.repeat(20) }, q);
  assert.equal(r.id, 42);
  assert.equal(r.mapIndex, 3);
  assert.match(r.seed, /^0x[0-9a-f]{64}$/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO rounds/);
  assert.deepEqual(calls[0].params, ['classic-solo', 3, r.seed, 1, 180, '0x' + 'ab'.repeat(20)]);
});

test('issueRound: still issues when the database is down, with no id', async () => {
  const q = async () => { throw new Error('connect ECONNREFUSED'); };
  const warn = console.warn; const logged = [];
  console.warn = (m) => logged.push(m);
  try {
    const r = await issueRound({ mode: 'multiplayer', maxPlayers: 8 }, q);
    assert.equal(r.id, null);
    assert.match(r.seed, /^0x[0-9a-f]{64}$/);
    assert.ok(logged.some((m) => /could not persist multiplayer round/.test(m)));
  } finally { console.warn = warn; }
});

test('issueRound: persist false never touches the database', async () => {
  const q = async () => { throw new Error('should not be called'); };
  const r = await issueRound({ mode: 'classic-solo', persist: false }, q);
  assert.equal(r.id, null);
  assert.ok(r.seed);
});

test('issueRound: rejects a malformed mode', async () => {
  await assert.rejects(issueRound({ mode: 'DROP TABLE' }, async () => ({ rows: [] })), TypeError);
  await assert.rejects(issueRound({ mode: 7 }, async () => ({ rows: [] })), TypeError);
});

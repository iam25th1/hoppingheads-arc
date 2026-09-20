import test from 'node:test';
import assert from 'node:assert/strict';
import { newSeed, pickMapIndex, issueRound, MAP_COUNT, seedCommitFor, newOnchainRoundId } from '../src/game/rounds.js';

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
  const r = await issueRound({ mode: 'sandbox-classic-solo', mapIndex: 3, issuedTo: '0x' + 'ab'.repeat(20) }, q);
  assert.equal(r.id, 42);
  assert.equal(r.mapIndex, 3);
  assert.match(r.seed, /^0x[0-9a-f]{64}$/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO rounds/);
  assert.deepEqual(calls[0].params, ['sandbox-classic-solo', 3, r.seed, 1, 180, '0x' + 'ab'.repeat(20), false, 'active', null, null, 'none']);
  assert.equal(r.stakeable, false);
  assert.equal(r.onchainRoundId, null);
  assert.equal(r.seedCommit, null);
});

test('issueRound: a stakeable round is born with its on chain id, its commitment, and a lobby row the worker opens', async () => {
  const calls = [];
  const q = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 7 }] }; };
  const r = await issueRound({ mode: 'arena', maxPlayers: 8, stakeable: true }, q);
  assert.match(r.onchainRoundId, /^0x[0-9a-f]{64}$/);
  assert.notEqual(r.onchainRoundId, r.seed, 'the on chain id is not the seed');
  assert.equal(r.seedCommit, seedCommitFor(r.seed));
  const p = calls[0].params;
  assert.equal(p[6], true);
  assert.equal(p[7], 'lobby', 'status lobby until the round starts');
  assert.equal(p[8], r.onchainRoundId);
  assert.equal(p[9], r.seedCommit);
  assert.equal(p[10], 'open_requested', 'the settlement worker opens it on chain; this process holds no key');
});

test('seedCommitFor: keccak256 of the 32 byte seed, what ArenaEscrow.commitFor returns', () => {
  // cast keccak 0xabab...ab (32 bytes)
  assert.equal(seedCommitFor('0x' + 'ab'.repeat(32)), '0x7d3a608bb850f47c2d77d6be73b8f93c94a80264b7bb3cc5c7d2fb54d07ef6b9');
  assert.throws(() => seedCommitFor('0xabab'), TypeError);
});

test('newOnchainRoundId: 0x plus 64 hex, distinct every time', () => {
  const a = newOnchainRoundId(), b = newOnchainRoundId();
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('issueRound: still issues when the database is down, with no id', async () => {
  const q = async () => { throw new Error('connect ECONNREFUSED'); };
  const warn = console.warn; const logged = [];
  console.warn = (m) => logged.push(m);
  try {
    const r = await issueRound({ mode: 'arena', maxPlayers: 8, stakeable: true }, q);
    assert.equal(r.id, null);
    assert.match(r.seed, /^0x[0-9a-f]{64}$/);
    assert.ok(logged.some((m) => /could not persist arena round/.test(m)));
    assert.equal(r.stakeable, true);
  } finally { console.warn = warn; }
});

test('issueRound: persist false never touches the database', async () => {
  const q = async () => { throw new Error('should not be called'); };
  const r = await issueRound({ mode: 'sandbox-classic-solo', persist: false }, q);
  assert.equal(r.id, null);
  assert.ok(r.seed);
});

test('issueRound: rejects a malformed mode', async () => {
  await assert.rejects(issueRound({ mode: 'DROP TABLE' }, async () => ({ rows: [] })), TypeError);
  await assert.rejects(issueRound({ mode: 7 }, async () => ({ rows: [] })), TypeError);
});

test('issueRound: stakeable is written as a boolean and defaults to false', async () => {
  const calls = [];
  const q = async (sql, params) => { calls.push(params); return { rows: [{ id: 1 }] }; };
  await issueRound({ mode: 'arena', stakeable: true }, q);
  await issueRound({ mode: 'sandbox-lbs-online' }, q);
  await issueRound({ mode: 'sandbox-lbs-online', stakeable: 'yes' }, q);
  assert.deepEqual(calls.map((p) => p[6]), [true, false, false], 'only a literal true counts');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlacements, payoutsFor, processRound } from '../settle.js';
import { StallError, RevertError } from '../tx.js';
import { ESCROW_ABI } from '../chain.js';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const rows = [
  { participant: 'bot:00000001:0', is_bot: true, placement: 1 },
  { participant: A, is_bot: false, placement: 2 },
  { participant: 'guest:' + 'd'.repeat(16), is_bot: false, placement: 3 },
  { participant: B, is_bot: false, placement: 4 },
  { participant: C, is_bot: false, placement: 5 },
];

test('buildPlacements: humans that entered, in the round placement, bots and guests never', () => {
  const ps = buildPlacements(rows, new Set([A, C]));
  assert.deepEqual(ps, [{ player: A, place: 2 }, { player: C, place: 5 }]);
  assert.deepEqual(buildPlacements(rows, new Set()), []);
});

test('payoutsFor: the tier table by placement, zero beyond it', () => {
  const p = payoutsFor([{ player: A, place: 2 }, { player: C, place: 5 }], ['1200000', '700000', '400000']);
  assert.equal(p.get(A), 700000n);
  assert.equal(p.get(C), 0n);
});

test('the ABI the worker loads is the committed build ABI with the functions it calls', () => {
  const names = new Set(ESCROW_ABI.filter((x) => x.type === 'function').map((x) => x.name));
  for (const f of ['openRound', 'settleRound', 'rounds', 'entered', 'tiers', 'signer', 'settlementDigest']) assert.ok(names.has(f), f);
});

// ---- processRound with fakes ----
const ZERO = '0x' + '0'.repeat(64);
function fakes({ chainState = {}, entered = [], settled = false, signerAddr = '0x' + '5'.repeat(40) } = {}) {
  const updates = [];
  const db = async (sql, params) => {
    updates.push({ sql, params });
    if (/SELECT participant/.test(sql)) return { rows };
    return { rows: [] };
  };
  const reads = { rounds: [chainState.commit || ZERO, 0n, settled, 0], entered: (args) => entered.includes(args[1]), tiers: [1200000n, 700000n, 400000n], signer: signerAddr, settlementDigest: '0x' + 'd'.repeat(64) };
  const chain = { read: async (fn, args = []) => { const v = reads[fn]; return typeof v === 'function' ? v(args) : v; } };
  const sent = [];
  const sender = { send: async (tx) => { sent.push(tx); if (sender.fail) throw sender.fail; return { hash: '0x' + '1'.repeat(64), receipt: { blockNumber: 77n, status: 'success', logs: [] }, nonce: 3, attempts: 1 }; } };
  const log = { info() {}, warn() {}, error() {} };
  const cfg = { escrow: '0x' + 'e'.repeat(40), memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505', chainId: 5042002, maxAttempts: 3, useMemo: true, signerUrl: 'http://signer', signerToken: 't'.repeat(32) };
  return { deps: { cfg, db, chain, sender, log }, updates, sent, sender };
}
const openRow = { id: 9, status: 'lobby', chain_status: 'open_requested', onchain_round_id: '0x' + '9'.repeat(64), seed: '0x' + '8'.repeat(64), seed_commit: '0x' + '7'.repeat(64), open_tx_hash: null, chain_attempts: 0 };

test('open: sends openRound with the commit and records the hash; idempotent when the chain already has it', async () => {
  const f = fakes();
  const out = await processRound(f.deps, openRow);
  assert.equal(out.status, 'open');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, f.deps.cfg.escrow);
  assert.ok(f.updates.some((u) => /chain_status = 'open'/.test(u.sql) && u.params[1] === '0x' + '1'.repeat(64)));
  const g = fakes({ chainState: { commit: openRow.seed_commit } });
  const out2 = await processRound(g.deps, openRow);
  assert.equal(out2.status, 'open');
  assert.equal(g.sent.length, 0, 'nothing sent: the chain already had the round');
});

test('settle: nothing to do until the round completes; then already settled on chain is recorded without a send', async () => {
  const f = fakes({ settled: true });
  assert.equal((await processRound(f.deps, { ...openRow, chain_status: 'open', status: 'active' })).status, 'open');
  const out = await processRound(f.deps, { ...openRow, chain_status: 'open', status: 'completed' });
  assert.equal(out.status, 'settled');
  assert.equal(f.sent.length, 0);
});

test('settle: a signature that does not recover to the escrow signer is a dead letter, nothing sent', async () => {
  const f = fakes({ entered: [A] });
  global.fetch = async () => ({ ok: true, json: async () => ({ signature: '0x' + '11'.repeat(65), digest: '0x' + 'd'.repeat(64) }) });
  const out = await processRound(f.deps, { ...openRow, chain_status: 'open', status: 'completed' });
  assert.equal(out.status, 'dead');
  assert.equal(f.sent.length, 0);
  assert.ok(f.updates.some((u) => /chain_status = \$3/.test(u.sql) && u.params[2] === 'dead'));
});

test('a stall from the sender marks the round stalled with the error; a plain failure counts an attempt and stays', async () => {
  const f = fakes();
  f.sender.fail = new StallError('openRound nonce 3 unmined after 3 attempts');
  const out = await processRound(f.deps, openRow);
  assert.equal(out.status, 'stalled');
  const g = fakes();
  g.sender.fail = new Error('rpc down');
  const out2 = await processRound(g.deps, openRow);
  assert.equal(out2.status, 'open_requested', 'retried next tick');
  const h = fakes();
  h.sender.fail = new Error('rpc down');
  const out3 = await processRound(h.deps, { ...openRow, chain_attempts: 2 });
  assert.equal(out3.status, 'dead', 'third failure is the dead letter');
  const r = fakes();
  r.sender.fail = new RevertError('reverted');
  assert.equal((await processRound(r.deps, openRow)).status, 'dead', 'a revert is dead at once');
});

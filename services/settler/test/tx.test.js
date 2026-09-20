import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSender, defaultFeeRule, FEE_FLOOR, StallError, RevertError } from '../tx.js';
import { createStubRpc } from './stubRpc.js';

const account = privateKeyToAccount('0x' + '22'.repeat(32));
const quiet = { info() {}, warn() {}, error() {} };
const capture = () => { const lines = []; return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };
const fast = { deadlineMs: 40, pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const tx = { to: '0x' + 'ee'.repeat(20), data: '0x1234', label: 'test' };

test('the fee rule never goes under the 20 gwei floor, at any base fee, any attempt', () => {
  for (const base of [0n, parseGwei('1'), parseGwei('9'), parseGwei('20'), parseGwei('35')]) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const f = defaultFeeRule(base, attempt);
      assert.ok(f.maxFeePerGas >= FEE_FLOOR, `base ${base} attempt ${attempt}`);
      assert.ok(f.maxPriorityFeePerGas <= f.maxFeePerGas);
    }
  }
  assert.ok(defaultFeeRule(parseGwei('20'), 2).maxFeePerGas > defaultFeeRule(parseGwei('20'), 1).maxFeePerGas, 'a replacement bids higher');
});

test('happy path: nonce from the last mined transaction, explicit fee, receipt awaited', async () => {
  const rpc = createStubRpc();
  const sender = createSender({ rpc, account, chainId: 5042002, log: quiet, ...fast });
  const r = await sender.send(tx);
  assert.equal(r.nonce, 0);
  assert.equal(r.attempts, 1);
  assert.equal(r.receipt.status, 'success');
  assert.equal(rpc.state.latest, 1);
  assert.equal(rpc.state.pending, 1);
  assert.ok(rpc.state.sent[0].maxFeePerGas >= FEE_FLOOR);
});

test('the nonce trap: a transaction under the floor is accepted and never mined; the sender detects the stall and replaces it at the same nonce with a proper fee', async () => {
  const rpc = createStubRpc();
  const log = capture();
  // attempt 1 deliberately under the floor, as a broken fee rule would; the rule after that is the real one
  const feeRule = (base, attempt) => attempt === 1 ? { maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('1') } : defaultFeeRule(base, attempt);
  // the sender refuses to send under the floor itself, so drive the trap through the stub instead
  const rpcTrap = { ...rpc, sendRaw: async (raw) => rpc.sendRaw(raw) };
  const sender = createSender({ rpc: rpcTrap, account, chainId: 5042002, log, feeRule, ...fast });
  await assert.rejects(sender.send(tx), /under the floor/, 'the sender never produces a sub floor transaction itself');
  // so model the trap as the network sees it: the first proper looking send is swallowed
  const rpc2 = createStubRpc();
  let swallowOnce = true;
  const swallowing = { ...rpc2, sendRaw: async (raw) => { const hash = await rpc2.sendRaw(raw); if (swallowOnce) { swallowOnce = false; const t = rpc2.state.txs.get(hash); t.pollsLeft = Infinity; t.mined = false; rpc2.state.latest = 0; rpc2.state.pending = 1; } return hash; } };
  const log2 = capture();
  const sender2 = createSender({ rpc: swallowing, account, chainId: 5042002, log: log2, ...fast });
  const r = await sender2.send(tx);
  assert.equal(r.attempts, 2, 'replaced once');
  assert.equal(r.nonce, 0, 'same nonce');
  assert.deepEqual(rpc2.state.sent.map((s) => s.nonce), [0, 0], 'both attempts at nonce 0, never queued behind');
  assert.ok(rpc2.state.sent[1].maxFeePerGas > rpc2.state.sent[0].maxFeePerGas, 'the replacement bids higher');
  assert.equal(rpc2.state.latest, 1);
  assert.equal(rpc2.state.pending, 1, 'nothing left queued');
  assert.ok(log2.lines.some((l) => /ALERT .*not mined within/.test(l)), 'the stall is alerted');
});

test('a stall left by an earlier process is detected at start and cleared by the next send', async () => {
  const rpc = createStubRpc();
  rpc.seedStall(); // pending 1, latest 0, an unmined transaction at nonce 0
  const log = capture();
  const sender = createSender({ rpc, account, chainId: 5042002, log, ...fast });
  const r = await sender.send(tx);
  assert.equal(r.nonce, 0, 'took the last mined nonce, not the pending one');
  assert.equal(rpc.state.latest, 1);
  assert.equal(rpc.state.pending, 1);
  assert.ok(log.lines.some((l) => /ALERT stall detected/.test(l)));
});

test('never mined after every attempt: StallError, and the account state is reported honestly', async () => {
  const rpc = createStubRpc();
  const swallowing = { ...rpc, sendRaw: async (raw) => { const h = await rpc.sendRaw(raw); const t = rpc.state.txs.get(h); t.mined = false; t.pollsLeft = Infinity; rpc.state.latest = 0; rpc.state.pending = 1; return h; } };
  const sender = createSender({ rpc: swallowing, account, chainId: 5042002, log: quiet, maxAttempts: 3, ...fast });
  await assert.rejects(sender.send(tx), StallError);
  assert.equal(rpc.state.sent.length, 3);
  assert.ok(rpc.state.sent.every((s) => s.nonce === 0));
  assert.equal(rpc.state.latest, 0);
  assert.equal(rpc.state.pending, 1, 'the stall is still there for the next run to replace');
});

test('a revert is a RevertError at once, not retried', async () => {
  const rpc = createStubRpc();
  rpc.state.revertNext = true;
  const sender = createSender({ rpc, account, chainId: 5042002, log: quiet, ...fast });
  await assert.rejects(sender.send(tx), RevertError);
  assert.equal(rpc.state.sent.length, 1);
});

test('mined between the deadline and the replacement: the replacement is refused with nonce too low and the earlier receipt is returned', async () => {
  const rpc = createStubRpc({ mineAfterPolls: 12 }); // mines late, after the first deadline
  const sender = createSender({ rpc, account, chainId: 5042002, log: quiet, ...fast });
  const r = await sender.send(tx);
  assert.equal(r.receipt.status, 'success');
  assert.equal(rpc.state.latest, 1);
});

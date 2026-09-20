import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Interface, TypedDataEncoder, Wallet, verifyTypedData } from 'ethers';

const require = createRequire(import.meta.url);
const E = require('../../shared/escrowAbi.cjs');
const iface = new Interface([
  'function enterWithPermit2(bytes32 roundId, uint256 nonce, uint256 deadline, bytes signature)',
  'function enter(bytes32 roundId)',
  'function withdraw()',
  'function approve(address spender, uint256 value)',
  'function allowance(address owner, address spender)',
  'function claimable(address player) view returns (uint256)',
  'function entered(bytes32 roundId, address player) view returns (bool)',
  'function balanceOf(address a)',
  'function entryAmount()',
]);
const R = '0x' + 'ab'.repeat(32), A = '0x' + 'a'.repeat(40), B = '0x' + 'B'.repeat(40);

test('every encoder matches ethers byte for byte', () => {
  const sig65 = '0x' + '1f'.repeat(65), sig64 = '0x' + '2e'.repeat(64), sig0 = '0x';
  for (const sig of [sig65, sig64, sig0]) assert.equal(E.encodeEnterWithPermit2(R, 12345678901234567890n, 1700000000, sig), iface.encodeFunctionData('enterWithPermit2', [R, 12345678901234567890n, 1700000000, sig]), 'bytes of length ' + (sig.length - 2) / 2);
  assert.equal(E.encodeEnter(R), iface.encodeFunctionData('enter', [R]));
  assert.equal(E.encodeWithdraw(), iface.encodeFunctionData('withdraw', []));
  assert.equal(E.encodeApprove(B, E.MAX_UINT256), iface.encodeFunctionData('approve', [B, E.MAX_UINT256]));
  assert.equal(E.encodeApprove(B, 500000), iface.encodeFunctionData('approve', [B, 500000]));
  assert.equal(E.encodeAllowance(A, B), iface.encodeFunctionData('allowance', [A, B]));
  assert.equal(E.encodeClaimable(A), iface.encodeFunctionData('claimable', [A]));
  assert.equal(E.encodeEntered(R, A), iface.encodeFunctionData('entered', [R, A]));
  assert.equal(E.encodeBalanceOf(A), iface.encodeFunctionData('balanceOf', [A]));
  assert.equal(E.encodeEntryAmount(), iface.encodeFunctionData('entryAmount', []));
});

test('decoders and dollars', () => {
  assert.equal(E.decodeUint(iface.encodeFunctionResult('claimable', [1200000n])), 1200000n);
  assert.equal(E.decodeBool(iface.encodeFunctionResult('entered', [true])), true);
  assert.equal(E.decodeBool(iface.encodeFunctionResult('entered', [false])), false);
  assert.equal(E.usd(500000), '$0.50');
  assert.equal(E.usd(1200000n), '$1.20');
  assert.equal(E.FEE_FLOOR_WEI, '20000000000');
});

test('bad inputs are refused, never mis-encoded', () => {
  assert.throws(() => E.encodeEnter('0x12'), TypeError);
  assert.throws(() => E.encodeClaimable('bot:00000001:0'), TypeError);
  assert.throws(() => E.encodeApprove(A, -1), TypeError);
  assert.throws(() => E.encodeEnterWithPermit2(R, 1, 1, '0x123'), TypeError);
});

test('permit2TypedData hashes as Permit2 expects and a wallet signature over it verifies', async () => {
  const w = Wallet.createRandom();
  const td = E.permit2TypedData({ chainId: 5042002, permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', token: '0x3600000000000000000000000000000000000000', amount: 500000, spender: B, nonce: '77', deadline: 1700000000 });
  const types = { PermitTransferFrom: td.types.PermitTransferFrom, TokenPermissions: td.types.TokenPermissions };
  const digest = TypedDataEncoder.hash(td.domain, types, td.message);
  // the same struct hashed with the canonical Permit2 encoding
  const expected = TypedDataEncoder.hash({ name: 'Permit2', chainId: 5042002, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' }, types, { permitted: { token: '0x3600000000000000000000000000000000000000', amount: 500000n }, spender: B, nonce: 77n, deadline: 1700000000n });
  assert.equal(digest, expected);
  const sig = await w.signTypedData(td.domain, types, td.message);
  assert.equal(verifyTypedData(td.domain, types, td.message, sig), w.address);
  assert.equal(E.permit2Nonce(new Uint8Array(31).fill(255)), (2n ** 248n - 1n).toString());
});

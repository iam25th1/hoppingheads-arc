import test from 'node:test';
import assert from 'node:assert/strict';
import { chainConfig, chainEnabled, initChain, usd, ARC_TESTNET_CHAIN_ID } from '../src/chain/escrow.js';

test('chainConfig: offline without an escrow address or a detected Arc chain, and never a key in sight', async () => {
  const saved = { ...process.env };
  delete process.env.ESCROW_ADDRESS;
  assert.equal(await initChain(async () => ARC_TESTNET_CHAIN_ID), null);
  assert.equal(chainConfig(), null);
  assert.equal(chainEnabled(), false);
  process.env.ESCROW_ADDRESS = 'not-an-address';
  assert.equal(await initChain(async () => ARC_TESTNET_CHAIN_ID), null);
  assert.equal(chainConfig(), null);
  process.env.ESCROW_ADDRESS = '0xf50e5b345293b027046400ae0d9d02f7b67bd72b';
  process.env.ARC_RPC_URL = 'https://rpc.testnet.arc.io';
  process.env.CHAIN_ID = '1'; // a stale value that must not matter
  // the RPC answers chain 1: not Arc, offline, whatever CHAIN_ID says
  assert.equal(await initChain(async () => 1), null);
  assert.equal(chainConfig(), null);
  // mainnet without the confirmation: offline
  delete process.env.ARC_MAINNET_CONFIRM;
  assert.equal(await initChain(async () => 5042), null);
  // an RPC that cannot be reached: offline, no throw
  assert.equal(await initChain(async () => { throw new Error('ECONNREFUSED'); }), null);
  // a local node: any id
  process.env.ARC_RPC_URL = 'http://127.0.0.1:8546';
  assert.equal(await initChain(async () => 31337), 31337);
  assert.equal(chainConfig().chainId, 31337);
  // testnet
  process.env.ARC_RPC_URL = 'https://rpc.testnet.arc.io';
  assert.equal(await initChain(async () => ARC_TESTNET_CHAIN_ID), ARC_TESTNET_CHAIN_ID);
  const c = chainConfig();
  assert.equal(c.chainId, ARC_TESTNET_CHAIN_ID);
  assert.equal(c.escrow, '0xF50e5b345293B027046400Ae0d9D02F7b67bD72B', 'checksummed');
  assert.equal(c.usdc, '0x3600000000000000000000000000000000000000');
  assert.ok(!Object.keys(c).some((k) => /key|secret/i.test(k)));
  process.env = saved;
});

test('usd: six decimal units to dollars, never gwei', () => {
  assert.equal(usd(500000n), '$0.50');
  assert.equal(usd(1200000), '$1.20');
  assert.equal(usd(0), '$0.00');
});

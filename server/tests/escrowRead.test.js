import test from 'node:test';
import assert from 'node:assert/strict';
import { chainConfig, chainEnabled, usd, ARC_TESTNET_CHAIN_ID } from '../src/chain/escrow.js';

test('chainConfig: offline without an escrow address, and never a key in sight', () => {
  const saved = { ...process.env };
  delete process.env.ESCROW_ADDRESS;
  assert.equal(chainConfig(), null);
  assert.equal(chainEnabled(), false);
  process.env.ESCROW_ADDRESS = 'not-an-address';
  assert.equal(chainConfig(), null);
  process.env.ESCROW_ADDRESS = '0xf50e5b345293b027046400ae0d9d02f7b67bd72b';
  delete process.env.CHAIN_ID;
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

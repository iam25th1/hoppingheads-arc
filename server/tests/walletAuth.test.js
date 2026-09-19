/**
 * Wallet admission gate: a real key signs a real challenge.
 *
 * SESSION_SECRET is set before the module loads so token issue and verify
 * run for real. Nothing here touches a chain.
 */
process.env.SESSION_SECRET = 'test-secret-not-for-production';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const {
  normalizeAddress, shortAddress, buildMessage,
  issueChallenge, verifyChallenge, issueSession, verifySessionToken,
} = await import('../src/utils/walletAuth.js');
const jwt = (await import('jsonwebtoken')).default;

// Fixed key so the test is reproducible. Not a real account.
const wallet = new ethers.Wallet('0x' + '11'.repeat(32));
const ADDR = wallet.address; // checksummed
const REQ = { domain: 'hh-arc.test', uri: 'http://hh-arc.test:7080' };

test('normalizeAddress: canonical lowercase, rejects garbage', () => {
  assert.equal(normalizeAddress(ADDR), ADDR.toLowerCase());
  assert.equal(normalizeAddress(ADDR.toLowerCase()), ADDR.toLowerCase());
  assert.equal(normalizeAddress('0x1234'), null);
  assert.equal(normalizeAddress('not an address'), null);
  assert.equal(normalizeAddress(42), null);
  assert.equal(normalizeAddress(null), null);
});

test('shortAddress is 12 chars and keeps both ends', () => {
  const s = shortAddress(ADDR.toLowerCase());
  assert.equal(s.length, 12);
  assert.ok(s.startsWith(ADDR.slice(0, 6).toLowerCase()));
  assert.ok(s.endsWith(ADDR.slice(-4).toLowerCase()));
});

test('buildMessage is EIP-4361 shaped', () => {
  const m = buildMessage({ ...REQ, address: ADDR, nonce: 'abc', issuedAt: '2026-01-01T00:00:00.000Z' });
  const lines = m.split('\n');
  assert.equal(lines[0], 'hh-arc.test wants you to sign in with your Ethereum account:');
  assert.equal(lines[1], ADDR);
  assert.ok(lines.includes('URI: http://hh-arc.test:7080'));
  assert.ok(lines.includes('Version: 1'));
  assert.ok(lines.includes('Nonce: abc'));
  assert.ok(lines.includes('Issued At: 2026-01-01T00:00:00.000Z'));
});

test('happy path: challenge, sign, verify, session', async () => {
  const { address, message } = issueChallenge(ADDR, REQ, 1000);
  assert.equal(address, ADDR.toLowerCase());
  const signature = await wallet.signMessage(message);
  assert.equal(verifyChallenge(ADDR, signature, 2000), ADDR.toLowerCase());

  const token = issueSession(address);
  assert.ok(token);
  assert.equal(verifySessionToken(token), ADDR.toLowerCase());
});

test('a signature from a different key is rejected', async () => {
  const other = new ethers.Wallet('0x' + '22'.repeat(32));
  const { message } = issueChallenge(ADDR, REQ, 1000);
  const signature = await other.signMessage(message);
  assert.equal(verifyChallenge(ADDR, signature, 2000), null);
});

test('a signature over a different message is rejected', async () => {
  issueChallenge(ADDR, REQ, 1000);
  const signature = await wallet.signMessage('something else entirely');
  assert.equal(verifyChallenge(ADDR, signature, 2000), null);
});

test('nonce is single use, even after a failed attempt', async () => {
  const { message } = issueChallenge(ADDR, REQ, 1000);
  assert.equal(verifyChallenge(ADDR, 'not-a-signature', 2000), null);
  const signature = await wallet.signMessage(message);
  assert.equal(verifyChallenge(ADDR, signature, 2000), null, 'consumed by the failed attempt');

  const again = issueChallenge(ADDR, REQ, 3000);
  const sig2 = await wallet.signMessage(again.message);
  assert.equal(verifyChallenge(ADDR, sig2, 4000), ADDR.toLowerCase());
  assert.equal(verifyChallenge(ADDR, sig2, 4000), null, 'replay refused');
});

test('nonce expires after five minutes', async () => {
  const { message } = issueChallenge(ADDR, REQ, 0);
  const signature = await wallet.signMessage(message);
  assert.equal(verifyChallenge(ADDR, signature, 5 * 60 * 1000 + 1), null);
});

test('verify without a challenge is rejected', async () => {
  const signature = await wallet.signMessage('anything');
  assert.equal(verifyChallenge(ADDR, signature), null);
});

test('issueChallenge rejects a bad address and bounds the store', () => {
  assert.equal(issueChallenge('0xnope', REQ), null);
  // Fill the store with distinct addresses, then one more must be refused.
  for (let i = 0; i < 5000; i++) {
    const a = '0x' + i.toString(16).padStart(40, '0');
    issueChallenge(a, REQ, 10_000_000);
  }
  assert.throws(() => issueChallenge('0x' + 'ab'.repeat(20), REQ, 10_000_000), /nonce_store_full/);
  // A sweep at a later time frees it
  assert.ok(issueChallenge('0x' + 'ab'.repeat(20), REQ, 10_000_000 + 6 * 60 * 1000));
});

test('session tokens: tampered, foreign and oversized are rejected', () => {
  const token = issueSession(ADDR.toLowerCase());
  assert.equal(verifySessionToken(token + 'x'), null);
  assert.equal(verifySessionToken(token.slice(0, -2)), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken('a'.repeat(3000)), null);
  // A token signed with another secret
  const foreign = jwt.sign({ sub: ADDR.toLowerCase() }, 'other-secret');
  assert.equal(verifySessionToken(foreign), null);
  // A valid token whose subject is not an address
  const bad = jwt.sign({ sub: 'admin' }, process.env.SESSION_SECRET);
  assert.equal(verifySessionToken(bad), null);
});

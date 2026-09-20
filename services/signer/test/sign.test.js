import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, verifyTypedData, keccak256, AbiCoder, toUtf8Bytes, concat, getAddress } from 'ethers';
import { SETTLEMENT_TYPES, domainFor, validateSettlement, settlementDigest, signSettlement, walletFromEnv } from '../sign.js';

const ESCROW = '0xF50e5b345293B027046400Ae0d9D02F7b67bD72B';
const KEY = '0x' + '11'.repeat(32);
const ROUND = '0x' + 'ab'.repeat(32), SEED = '0x' + 'cd'.repeat(32);
const alice = getAddress('0x' + 'a'.repeat(40)), bob = getAddress('0x' + 'b'.repeat(40));
const good = { roundId: ROUND, seed: SEED, placements: [{ player: alice, place: 1 }, { player: bob, place: 2 }] };

test('validateSettlement: accepts the shape the contract accepts, normalised', () => {
  const v = validateSettlement({ ...good, placements: [{ player: alice.toLowerCase(), place: 1 }] });
  assert.equal(v.placements[0].player, alice, 'checksummed');
  assert.equal(v.roundId, ROUND);
});

test('validateSettlement: refuses what the contract refuses, before the key is touched', () => {
  const bad = [
    [{ ...good, roundId: '0x12' }, /roundId/],
    [{ ...good, seed: 'seed' }, /seed/],
    [{ ...good, placements: 'x' }, /array/],
    [{ ...good, placements: new Array(9).fill({ player: alice, place: 1 }) }, /at most 8/],
    [{ ...good, placements: [{ player: 'bot:00000001:0', place: 1 }] }, /address/],
    [{ ...good, placements: [{ player: 'guest:' + 'c'.repeat(16), place: 1 }] }, /address/],
    [{ ...good, placements: [{ player: '0x' + '0'.repeat(40), place: 1 }] }, /zero address/],
    [{ ...good, placements: [{ player: alice, place: 1 }, { player: alice, place: 2 }] }, /repeats/],
    [{ ...good, placements: [{ player: alice, place: 0 }] }, /1 to 255/],
    [{ ...good, placements: [{ player: alice, place: 1.5 }] }, /1 to 255/],
    [null, /object/],
  ];
  for (const [body, re] of bad) assert.throws(() => validateSettlement(body), re, JSON.stringify(body).slice(0, 60));
});

test('signSettlement: the signature recovers to the signer under the contract domain', async () => {
  const wallet = new Wallet(KEY);
  const domain = domainFor(5042002, ESCROW);
  const out = await signSettlement(wallet, domain, validateSettlement(good));
  assert.equal(out.signer, wallet.address);
  assert.equal(verifyTypedData(domain, SETTLEMENT_TYPES, validateSettlement(good), out.signature), wallet.address);
  assert.equal(out.digest, settlementDigest(domain, validateSettlement(good)));
});

test('settlementDigest: matches the contract construction, computed by hand', () => {
  // ArenaEscrow: keccak256(abi.encode(SETTLEMENT_TYPEHASH, roundId, seed, keccak256(abi.encodePacked(placementHashes))))
  // with PLACEMENT_TYPEHASH = keccak256("Placement(address player,uint8 place)") and the
  // EIP712 domain of OpenZeppelin (name, version, chainId, verifyingContract).
  const coder = AbiCoder.defaultAbiCoder();
  const PLACEMENT_TYPEHASH = keccak256(toUtf8Bytes('Placement(address player,uint8 place)'));
  const SETTLEMENT_TYPEHASH = keccak256(toUtf8Bytes('Settlement(bytes32 roundId,bytes32 seed,Placement[] placements)Placement(address player,uint8 place)'));
  const DOMAIN_TYPEHASH = keccak256(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const v = validateSettlement(good);
  const hashes = v.placements.map((p) => keccak256(coder.encode(['bytes32', 'address', 'uint8'], [PLACEMENT_TYPEHASH, p.player, p.place])));
  const structHash = keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32', 'bytes32'], [SETTLEMENT_TYPEHASH, v.roundId, v.seed, keccak256(concat(hashes))]));
  const domainSep = keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [DOMAIN_TYPEHASH, keccak256(toUtf8Bytes('ArenaEscrow')), keccak256(toUtf8Bytes('1')), 5042002, ESCROW]));
  const expected = keccak256(concat(['0x1901', domainSep, structHash]));
  assert.equal(settlementDigest(domainFor(5042002, ESCROW), v), expected);
});

test('digest changes with the chain, the contract, the round, the seed and the order', () => {
  const v = validateSettlement(good);
  const base = settlementDigest(domainFor(5042002, ESCROW), v);
  assert.notEqual(settlementDigest(domainFor(5042, ESCROW), v), base);
  assert.notEqual(settlementDigest(domainFor(5042002, '0x' + '1'.repeat(40)), v), base);
  assert.notEqual(settlementDigest(domainFor(5042002, ESCROW), { ...v, seed: ROUND }), base);
  assert.notEqual(settlementDigest(domainFor(5042002, ESCROW), { ...v, placements: [v.placements[1], v.placements[0]] }), base);
});

test('walletFromEnv: refuses a missing or malformed key', () => {
  assert.throws(() => walletFromEnv({}), /SIGNER_KEY/);
  assert.throws(() => walletFromEnv({ SIGNER_KEY: '0x1234' }), /SIGNER_KEY/);
  assert.equal(walletFromEnv({ SIGNER_KEY: KEY }).address, new Wallet(KEY).address);
});

test('the service: health is open, sign needs the token, a bad body is refused, a good one is signed', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = 7600 + Math.floor(Math.random() * 200);
  const token = 'tok'.repeat(12);
  const child = spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port), SIGNER_KEY: KEY, SIGNER_TOKEN: token, CHAIN_ID: '5042002', ESCROW_ADDRESS: ESCROW }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(url + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const health = await (await fetch(url + '/health')).json();
    assert.equal(health.signer, new Wallet(KEY).address);
    assert.equal((await fetch(url + '/sign', { method: 'POST', body: JSON.stringify(good) })).status, 401, 'no token');
    assert.equal((await fetch(url + '/sign', { method: 'POST', headers: { 'x-signer-token': 'wrong'.repeat(8) }, body: JSON.stringify(good) })).status, 401, 'wrong token');
    assert.equal((await fetch(url + '/sign', { method: 'POST', headers: { 'x-signer-token': token }, body: '{"roundId":"0x12"}' })).status, 400, 'bad body');
    assert.equal((await fetch(url + '/anything')).status, 404);
    const r = await fetch(url + '/sign', { method: 'POST', headers: { 'x-signer-token': token, 'content-type': 'application/json' }, body: JSON.stringify(good) });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(verifyTypedData(domainFor(5042002, ESCROW), SETTLEMENT_TYPES, validateSettlement(good), out.signature), new Wallet(KEY).address);
    assert.ok(!logs.includes(KEY.slice(4)), 'the key never reaches the log');
    assert.match(logs, /signed round 0xabab/);
  } finally { child.kill(); }
});

test('the service refuses to start without a token or a key', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = (env) => new Promise((resolve) => { const c = spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: '7999', ...env }, stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => resolve({ code, err })); });
  const a = await run({ SIGNER_KEY: KEY, SIGNER_TOKEN: 'short', CHAIN_ID: '5042002', ESCROW_ADDRESS: ESCROW });
  assert.equal(a.code, 1); assert.match(a.err, /SIGNER_TOKEN/);
  const b = await run({ SIGNER_TOKEN: 'tok'.repeat(12), CHAIN_ID: '5042002', ESCROW_ADDRESS: ESCROW });
  assert.equal(b.code, 1); assert.match(b.err, /SIGNER_KEY/);
});

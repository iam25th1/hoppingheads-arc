import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { registerSoloRound, respawnSoloRound, ROUND_TTL_MS } from '../src/game/soloRounds.js';

const require = createRequire(import.meta.url);
const layout = require('../../shared/layout.cjs');
const SEED = '0x' + 'd7'.repeat(32);
const round = { id: 1, seed: SEED, mapIndex: 2, mode: 'sandbox-classic-solo' };

test('register returns a 32 hex key, distinct per round', () => {
  const a = registerSoloRound(round);
  const b = registerSoloRound(round);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('respawn follows the round stream exactly as a lobby would', () => {
  const key = registerSoloRound(round, 1000);
  const twin = layout.createLayout(SEED, 2);
  assert.deepEqual(respawnSoloRound(key, 3, 1001), twin.respawn(3));
  assert.deepEqual(respawnSoloRound(key, 0, 1002), twin.respawn(0));
  assert.deepEqual(respawnSoloRound(key, 3, 1003), twin.respawn(3), 'second respawn of a rarity continues the stream');
});

test('respawn: unknown key, bad rarity, expired key', () => {
  assert.equal(respawnSoloRound('nope', 0), null);
  assert.equal(respawnSoloRound(42, 0), null);
  const key = registerSoloRound(round, 1000);
  assert.equal(respawnSoloRound(key, 5, 1001), null);
  assert.equal(respawnSoloRound(key, -1, 1001), null);
  assert.equal(respawnSoloRound(key, 1.5, 1001), null);
  assert.ok(respawnSoloRound(key, 1, 1002));
  assert.equal(respawnSoloRound(key, 1, 1002 + ROUND_TTL_MS + 1), null, 'expired');
  assert.equal(respawnSoloRound(key, 1, 1002 + ROUND_TTL_MS + 2), null, 'and gone');
});

test('a respawn on one round never moves another', () => {
  const k1 = registerSoloRound(round, 1000);
  const k2 = registerSoloRound(round, 1000);
  const m1 = respawnSoloRound(k1, 2, 1001);
  const m2 = respawnSoloRound(k2, 2, 1001);
  assert.deepEqual(m1, m2, 'same seed, same first respawn');
  const m1b = respawnSoloRound(k1, 2, 1002);
  assert.notDeepEqual(m1b, m1);
  assert.deepEqual(respawnSoloRound(k2, 2, 1002), m1b, 'k2 was not advanced by k1');
});

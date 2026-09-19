import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPowerupState, spawnIfDue, expire, pickups, hasEffect, PW_FIRST_MS, PW_INTERVAL_MS, PW_MAX_ACTIVE, PW_LIFETIME_MS, PW_COLLECT_R, PW_TYPES } from '../src/game/powerups.js';

const layout = createRequire(import.meta.url)('../../shared/layout.cjs');

const SEED = '0x' + 'a7'.repeat(32);
const seat = (id, x, z) => ({ id, x, z, effects: {} });

test('schedule: first at 15s, then every 25s, never more than 5 active', () => {
  const s = createPowerupState(SEED, 1, 0);
  assert.equal(spawnIfDue(s, PW_FIRST_MS - 1), null);
  assert.ok(spawnIfDue(s, PW_FIRST_MS));
  assert.equal(spawnIfDue(s, PW_FIRST_MS + 1), null);
  let t = PW_FIRST_MS;
  for (let i = 0; i < 8; i++) { t += PW_INTERVAL_MS; spawnIfDue(s, t); }
  assert.equal(s.active.size, PW_MAX_ACTIVE);
});

test('type and position replay from the seed', () => {
  const run = () => { const s = createPowerupState(SEED, 3, 0); let t = 0; for (let i = 0; i < 5; i++) { t += PW_INTERVAL_MS; spawnIfDue(s, t); } return s.log; };
  assert.deepEqual(run(), run());
  const other = createPowerupState('0x' + 'a8'.repeat(32), 3, 0); let t = 0; for (let i = 0; i < 5; i++) { t += PW_INTERVAL_MS; spawnIfDue(other, t); }
  assert.notDeepEqual(other.log, run());
  for (const [type, x, z] of run()) { assert.ok(PW_TYPES.includes(type)); assert.ok(Math.abs(x) <= 150 * 0.35 && Math.abs(z) <= 150 * 0.35); }
});

test('the powerup stream never touches the fragment layout stream', () => {
  const a = layout.createLayout(SEED, 2).fragments.map((f) => [f.x, f.z]);
  const s = createPowerupState(SEED, 2, 0); spawnIfDue(s, PW_FIRST_MS);
  const b = layout.createLayout(SEED, 2).fragments.map((f) => [f.x, f.z]);
  assert.deepEqual(a, b);
});

test('expire after 45s', () => {
  const s = createPowerupState(SEED, 0, 0);
  const pw = spawnIfDue(s, PW_FIRST_MS);
  assert.deepEqual(expire(s, PW_FIRST_MS + PW_LIFETIME_MS), []);
  assert.deepEqual(expire(s, PW_FIRST_MS + PW_LIFETIME_MS + 1), [pw.id]);
  assert.equal(s.active.size, 0);
});

test('pickup: first seat within 4 units takes it, once, and the effect is recorded with its end time', () => {
  const s = createPowerupState(SEED, 0, 0);
  const pw = spawnIfDue(s, PW_FIRST_MS);
  const far = seat('far', pw.x + PW_COLLECT_R + 0.5, pw.z);
  const near = seat('bot:aaaaaaaa:0', pw.x + 1, pw.z);
  const alsoNear = seat('0x' + '11'.repeat(20), pw.x, pw.z + 2);
  const t = pickups(s, [far, near, alsoNear], 20000);
  assert.deepEqual(t, [{ id: pw.id, type: pw.type, by: 'bot:aaaaaaaa:0' }]);
  assert.equal(s.active.size, 0);
  assert.equal(hasEffect(near, pw.type, 20001), true);
  assert.equal(hasEffect(near, pw.type, 20000 + 8000 + 1), pw.type === 'magnet');
  assert.equal(hasEffect(alsoNear, pw.type, 20001), false, 'second seat got nothing');
  assert.deepEqual(pickups(s, [near], 20100), [], 'gone');
});

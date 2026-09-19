import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBotBrain, stepBot, botStreamSeed, BOT_SPEED } from '../src/game/botDriver.js';
import { createMoveState, judgeMove } from '../src/game/movement.js';

const require = createRequire(import.meta.url);
const layout = require('../../shared/layout.cjs');
const SEED = '0x' + 'e1'.repeat(32);

function world(l, humans = []) {
  return { fragments: l.fragments.filter((f) => !f.claimed).map((f) => ({ id: f.id, x: f.x, z: f.z })), humans };
}

test('bot stream seeds differ per slot and stay 256 bits', () => {
  assert.match(botStreamSeed(SEED, 0), /^0x[0-9a-f]{64}$/);
  assert.notEqual(botStreamSeed(SEED, 0), botStreamSeed(SEED, 1));
  assert.equal(botStreamSeed(SEED, 3).slice(0, 64), SEED.slice(0, 64));
});

test('a bot run is reproducible from the seed: same seed, same trace and positions', () => {
  const run = () => {
    const l = layout.createLayout(SEED, 1);
    const brain = createBotBrain(SEED, 2);
    const bot = { x: 0, z: 0, ry: 0 };
    const pos = [];
    for (let i = 0; i < 400; i++) {
      const r = stepBot(brain, bot, world(l));
      bot.x = r.nx; bot.z = r.nz; bot.ry = r.ry;
      if (r.claimId !== null) { const f = l.fragments[r.claimId]; f.claimed = true; }
      pos.push([+bot.x.toFixed(4), +bot.z.toFixed(4)]);
    }
    return { pos, trace: brain.decisions.join(',') };
  };
  const a = run(), b = run();
  assert.equal(a.trace, b.trace);
  assert.deepEqual(a.pos, b.pos);
  assert.ok(a.trace.split(',').length >= 3, 'made several decisions');
  const other = createBotBrain('0x' + 'e2'.repeat(32), 2);
  const bot = { x: 0, z: 0, ry: 0 };
  const l = layout.createLayout(SEED, 1);
  const t = []; for (let i = 0; i < 400; i++) { const r = stepBot(other, bot, world(l)); bot.x = r.nx; bot.z = r.nz; }
  assert.notEqual(other.decisions.join(','), a.trace);
});

test('a bot never trips the movement check, at base speed cap, with jittered ticks', () => {
  const l = layout.createLayout(SEED, 3);
  for (let slot = 0; slot < 4; slot++) {
    const brain = createBotBrain(SEED, slot);
    const bot = { x: 0, z: 0, ry: 0 };
    const move = createMoveState(0, 0);
    let now = 10000, flags = 0;
    const jitter = createBotBrain(SEED, 9).rng;
    for (let i = 0; i < 3000; i++) {
      const gap = 70 + Math.floor(jitter.nextFloat() * 60); // 70..130ms between ticks
      const r = stepBot(brain, bot, world(l, [{ x: 20, z: -20 }]), undefined, gap / 1000);
      now += gap;
      const j = judgeMove(move, r.nx, r.nz, now, 18);
      if (j.flagged) flags++;
      bot.x = j.x; bot.z = j.z; bot.ry = r.ry;
      if (r.claimId !== null) l.fragments[r.claimId].claimed = true;
    }
    assert.equal(flags, 0, `slot ${slot} flagged ${flags} times`);
  }
});

test('a bot seeks fragments and claims only when on top of one', () => {
  const l = layout.createLayout(SEED, 0);
  const brain = createBotBrain(SEED, 0);
  const bot = { x: l.fragments[10].x + 30, z: l.fragments[10].z, ry: 0 };
  let claims = 0;
  for (let i = 0; i < 1500; i++) {
    const r = stepBot(brain, bot, world(l));
    if (r.claimId !== null) {
      const f = l.fragments[r.claimId];
      assert.ok(Math.hypot(f.x - r.nx, f.z - r.nz) <= 2.5, 'claim only inside CLAIM_RANGE');
      f.claimed = true; claims++;
    }
    bot.x = r.nx; bot.z = r.nz;
  }
  assert.ok(claims >= 3, `claimed ${claims} fragments in 150s`);
  assert.ok(brain.decisions.includes('seek'));
});

test('a stalled tick is capped: the bot loses ground, it never leaps', () => {
  const l = layout.createLayout(SEED, 2);
  const brain = createBotBrain(SEED, 0);
  const bot = { x: 0, z: 0, ry: 0 };
  const r = stepBot(brain, bot, world(l), undefined, 2.0);
  assert.ok(Math.hypot(r.nx, r.nz) <= BOT_SPEED * 0.25 + 1e-9);
});

test('a bot stays inside the map and moves at most BOT_SPEED per second', () => {
  const l = layout.createLayout(SEED, 5);
  const brain = createBotBrain(SEED, 1);
  const bot = { x: 140, z: 140, ry: 0 };
  for (let i = 0; i < 2000; i++) {
    const r = stepBot(brain, bot, world(l));
    assert.ok(Math.hypot(r.nx - bot.x, r.nz - bot.z) <= BOT_SPEED * 0.1 + 1e-9);
    assert.ok(Math.abs(r.nx) <= 147 && Math.abs(r.nz) <= 147);
    bot.x = r.nx; bot.z = r.nz;
  }
});

test('a bot follows its target fragment when a respawn moves it, and re-decides when it is gone', () => {
  const l = layout.createLayout(SEED, 4);
  const brain = createBotBrain(SEED, 0);
  const f = l.fragments[12];
  const bot = { x: f.x + 20, z: f.z, ry: 0 };
  // Force a seek on fragment 12 by making it the only one in range
  const only = { fragments: [{ id: 12, x: f.x, z: f.z }], humans: [] };
  stepBot(brain, bot, only);
  assert.equal(brain.target.fragId, 12);
  // Respawn moves it far away: the target follows, no claim is attempted at the old spot
  const movedWorld = { fragments: [{ id: 12, x: f.x + 80, z: f.z + 80 }], humans: [] };
  const r = stepBot(brain, bot, movedWorld);
  assert.deepEqual([brain.target.x, brain.target.z], [f.x + 80, f.z + 80]);
  assert.equal(r.claimId, null);
  // Gone: a new decision is made
  const before = brain.decisions.length;
  stepBot(brain, bot, { fragments: [{ id: 30, x: 0, z: 0 }], humans: [] });
  assert.equal(brain.decisions.length, before + 1);
});

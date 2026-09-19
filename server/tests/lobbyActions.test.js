import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { collectFragment, completeMint, hasMintableChest } from '../src/game/lobbyActions.js';
import { createFragState, MINT_DURATIONS, MINT_GRACE_MS, COLLECT_RANGE } from '../src/game/lobbyFrags.js';
import { createBotSeat, createSeat, DEFAULT_SKINS } from '../src/game/bots.js';
import { rulesFor } from '../src/game/modes.js';

const require = createRequire(import.meta.url);
const layout = require('../../shared/layout.cjs');
const SEED = '0x' + 'f1'.repeat(32);

function lobby(mode = 'arena') {
  const l = { mode, rules: rulesFor(mode), frags: createFragState(layout.createLayout(SEED, 2)) };
  const events = [];
  const emit = (event, payload, seat) => events.push({ event, payload, to: seat ? seat.id : 'lobby' });
  return { l, events, emit };
}
const human = () => createSeat({ id: '0x' + '33'.repeat(20), name: 'h', address: '0x' + '33'.repeat(20), socketId: 's', appearance: DEFAULT_SKINS[0], index: 0, isBot: false, maxMints: 5 });
const bot = () => createBotSeat(SEED, 0, 1, 5);
const warn = console.warn;
test.beforeEach(() => { console.warn = () => {}; });
test.afterEach(() => { console.warn = warn; });

test('a bot and a human go through the same path: in range is taken, broadcast to the lobby', () => {
  for (const mk of [human, bot]) {
    const { l, events, emit } = lobby();
    const seat = mk();
    const f = l.frags.frags.get(7);
    seat.x = f.x + 1; seat.z = f.z;
    const r = collectFragment(l, seat, 7, emit, 1000);
    assert.equal(r.ok, true);
    assert.equal(seat.score, 3);
    assert.equal(seat.fragments[f.rarity], 1);
    assert.deepEqual(events, [{ event: 'frag:taken', payload: { id: 7, by: seat.id, rarity: f.rarity, score: 3 }, to: 'lobby' }]);
    assert.equal(f.claimedBy, seat.id);
  }
});

test('a bot claiming out of range is rejected exactly as a human would be', () => {
  const results = {};
  for (const [kind, mk] of [['human', human], ['bot', bot]]) {
    const { l, events, emit } = lobby();
    const seat = mk();
    const f = l.frags.frags.get(7);
    seat.x = f.x + COLLECT_RANGE + 5; seat.z = f.z;
    const r = collectFragment(l, seat, 7, emit, 1000);
    results[kind] = { r, rej: seat.rejections, events: events.map((e) => [e.event, e.payload.reason, e.to === seat.id ? 'seat' : e.to]), claimed: f.claimedBy, score: seat.score };
  }
  assert.deepEqual(results.bot.r, results.human.r);
  assert.deepEqual(results.bot.rej, results.human.rej);
  assert.deepEqual(results.bot.rej, { total: 1, range: 1 });
  assert.deepEqual(results.bot.events, [['frag:rejected', 'range', 'seat']]);
  assert.deepEqual(results.bot.events, results.human.events);
  assert.equal(results.bot.claimed, null);
  assert.equal(results.bot.score, 0);
});

test('a bot cannot take a fragment a human already claimed, and vice versa', () => {
  const { l, emit } = lobby();
  const h = human(), b = bot();
  const f = l.frags.frags.get(3);
  h.x = f.x; h.z = f.z; b.x = f.x; b.z = f.z;
  assert.equal(collectFragment(l, h, 3, emit).ok, true);
  const r = collectFragment(l, b, 3, emit);
  assert.deepEqual(r, { ok: false, reason: 'claimed' });
  assert.equal(b.rejections.claimed, 1);
});

test('wrong mode and not started behave as before for any seat', () => {
  const { l, events, emit } = lobby('sandbox-lbs');
  const b = bot();
  assert.equal(collectFragment(l, b, 0, emit).reason, 'wrong_mode');
  assert.equal(events[0].to, b.id);
  const { l: l2, events: e2, emit: emit2 } = lobby();
  l2.frags = null;
  assert.equal(collectFragment(l2, b, 0, emit2).reason, 'not_started');
  assert.deepEqual(e2, []);
});

test('mint: three collections earn a chest; the mint waits for the chest, then respawns for the lobby', () => {
  const { l, events, emit } = lobby();
  const b = bot();
  const commons = [...l.frags.frags.values()].filter((f) => f.rarity === 0).slice(0, 3);
  for (const f of commons) { b.x = f.x; b.z = f.z; assert.equal(collectFragment(l, b, f.id, emit, 1000).ok, true); }
  assert.equal(b.mint.chests.length, 1);
  assert.equal(hasMintableChest(b, 1000 + 100, MINT_DURATIONS, MINT_GRACE_MS), false);
  assert.equal(completeMint(l, b, emit, 1000 + 100).reason, 'mint_early');
  const readyAt = 1000 + MINT_DURATIONS[0] - MINT_GRACE_MS;
  assert.equal(hasMintableChest(b, readyAt, MINT_DURATIONS, MINT_GRACE_MS), true);
  const m = completeMint(l, b, emit, readyAt);
  assert.deepEqual(m, { ok: true, rarity: 0, points: 10 });
  assert.equal(b.score, 9 + 10);
  const tail = events.slice(-2).map((e) => [e.event, e.to]);
  assert.deepEqual(tail, [['mint:broadcast', 'lobby'], ['frag:respawn', 'lobby']]);
  assert.equal(events[events.length - 1].payload.fragments.length, 30);
});

test('hasMintableChest checks the chest a mint would consume, and never at the cap', () => {
  const b = bot();
  // A ready common and a fresh legendary: tryMint would take the legendary, so not ready
  b.mint.chests.push({ rarity: 0, since: 0 });
  b.mint.chests.push({ rarity: 4, since: 100000 });
  assert.equal(hasMintableChest(b, 100000 + 100, MINT_DURATIONS, MINT_GRACE_MS), false);
  assert.equal(hasMintableChest(b, 100000 + MINT_DURATIONS[4], MINT_DURATIONS, MINT_GRACE_MS), true);
  b.minted = b.maxMints;
  assert.equal(hasMintableChest(b, 999999, MINT_DURATIONS, MINT_GRACE_MS), false, 'at the cap a bot stops trying');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { departedSnapshot, rankSeats, settlementPlacements } from '../src/game/settlementRoster.js';

const sanitize = (s) => String(s).slice(0, 12);
const human = (n, score, staked = true) => ({ id: '0x' + n.toString(16).padStart(40, '0'), name: 'H' + n, score, minted: 0, fragments: [1, 0, 0, 0, 0], staked });
const bot = (n, score) => ({ id: `bot:0000000${n}:${n}`, name: 'BOT ' + n, score, minted: 0, fragments: [0, 0, 0, 0, 0], isBot: true });
const guest = (score) => ({ id: 'guest:' + 'c'.repeat(16), name: 'GUEST', score, minted: 0, fragments: [0, 0, 0, 0, 0] });

test('rankSeats: placements by score over live and departed seats alike', () => {
  const departed = departedSnapshot({ ...human(2, 180), staked: true });
  const r = rankSeats([human(1, 100), bot(1, 250), departed], sanitize);
  assert.deepEqual(r.map((x) => [x.name, x.placement]), [['BOT 1', 1], ['H2', 2], ['H1', 3]]);
  assert.equal(r[1].departed, true);
  assert.equal(r[1].fragments, 1);
});

test('settlementPlacements: humans that staked, in the round placement, nothing else', () => {
  const r = rankSeats([human(1, 100), bot(1, 250), human(2, 180, false), guest(300), bot(2, 50)], sanitize);
  const ps = settlementPlacements(r);
  // guest first (300), bot second, unstaked human third, staked human fourth
  assert.deepEqual(ps, [{ player: human(1, 100).id, place: 4 }]);
});

test('settlementPlacements: a bot or guest id can never appear', () => {
  const r = rankSeats([bot(1, 10), guest(5)], sanitize);
  assert.deepEqual(settlementPlacements(r), []);
});

test('departedSnapshot: a copy, not a reference', () => {
  const seat = human(3, 42);
  const snap = departedSnapshot(seat);
  seat.score = 999; seat.fragments[0] = 9;
  assert.equal(snap.score, 42);
  assert.equal(snap.fragments[0], 1);
  assert.equal(snap.departed, true);
});

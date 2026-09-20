import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, expectedPayoutPerHuman } from '../src/game/scoreStats.js';

const rows = [
  { round_id: 1, participant: '0x' + 'a'.repeat(40), is_bot: false, score: 200, placement: 1, seats: 4 },
  { round_id: 1, participant: 'bot:00000001:0', is_bot: true, score: 150, placement: 2, seats: 4 },
  { round_id: 1, participant: 'bot:00000001:1', is_bot: true, score: 100, placement: 3, seats: 4 },
  { round_id: 1, participant: 'bot:00000001:2', is_bot: true, score: 50, placement: 4, seats: 4 },
  { round_id: 2, participant: 'bot:00000002:0', is_bot: true, score: 300, placement: 1, seats: 4 },
  { round_id: 2, participant: 'bot:00000002:1', is_bot: true, score: 250, placement: 2, seats: 4 },
  { round_id: 2, participant: '0x' + 'b'.repeat(40), is_bot: false, score: 120, placement: 3, seats: 4 },
  { round_id: 2, participant: 'bot:00000002:2', is_bot: true, score: 20, placement: 4, seats: 4 },
];

test('distribution: counts, placements and score summaries, human and bot apart', () => {
  const d = distribution(rows);
  assert.equal(d.rounds, 2);
  assert.equal(d.humans, 2);
  assert.equal(d.bots, 6);
  assert.deepEqual(d.humanPlacements, { 1: 1, 3: 1 });
  assert.equal(d.humanWinRate, 50);
  assert.equal(d.humanTop3Rate, 100);
  assert.equal(d.scoreHuman.median, 160);
  assert.equal(d.byPlacement.bot['2'].n, 2);
  assert.equal(d.byPlacement.bot['2'].mean, 200);
  assert.equal(d.byPlacement.human['1'].max, 200);
});

test('expectedPayoutPerHuman: the tier table averaged over human placements', () => {
  // one first (1.20) and one third (0.40) over two human seats
  assert.equal(expectedPayoutPerHuman(rows, [1200000, 700000, 400000]), 800000);
  assert.equal(expectedPayoutPerHuman(rows, [1000000]), 500000);
  assert.equal(expectedPayoutPerHuman([], [1]), null);
});

test('distribution: empty input is all zeros, no division by zero', () => {
  const d = distribution([]);
  assert.equal(d.rounds, 0);
  assert.equal(d.humanWinRate, null);
  assert.equal(d.scoreHuman.n, 0);
});

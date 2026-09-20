import test from 'node:test';
import assert from 'node:assert/strict';
import { seatOnRejoin, seatOnLeave, liveHumans, awayStaked, GRACE_MS } from '../src/game/seats.js';

test('seatOnRejoin: the newest connection wins before the round; a live round on a live socket is refused', () => {
  for (const status of ['waiting', 'countdown']) {
    assert.equal(seatOnRejoin({ status, alive: true }), 'reclaim', status + ' with a live older tab');
    assert.equal(seatOnRejoin({ status, alive: false }), 'reclaim', status + ' after a reload');
  }
  assert.equal(seatOnRejoin({ status: 'active', alive: true }), 'refuse');
  assert.equal(seatOnRejoin({ status: 'active', alive: false }), 'release');
  assert.equal(seatOnRejoin({ status: 'ended', alive: false }), 'new');
});

test('seatOnLeave: a staked seat survives its socket before the round; an unstaked one does not; a live round departs', () => {
  assert.equal(seatOnLeave({ status: 'waiting', staked: true }), 'keep');
  assert.equal(seatOnLeave({ status: 'countdown', staked: true }), 'keep');
  assert.equal(seatOnLeave({ status: 'waiting', staked: false }), 'drop');
  assert.equal(seatOnLeave({ status: 'countdown', staked: false }), 'drop');
  assert.equal(seatOnLeave({ status: 'active', staked: true }), 'depart');
  assert.equal(seatOnLeave({ status: 'active', staked: false }), 'depart');
  assert.equal(seatOnLeave({ status: 'ended', staked: true }), 'drop');
});

test('liveHumans and awayStaked count what they say', () => {
  const players = new Map([
    ['0xa', { id: '0xa', isBot: false, socketId: 's1', staked: true }],
    ['0xb', { id: '0xb', isBot: false, socketId: null, staked: true }],
    ['0xc', { id: '0xc', isBot: false, socketId: 's3', staked: false }],
    ['bot:1', { id: 'bot:1', isBot: true, socketId: null, staked: false }],
  ]);
  const alive = (id) => id === 's1';
  assert.equal(liveHumans(players, alive), 1);
  assert.deepEqual(awayStaked(players), ['0xb']);
  assert.ok(GRACE_MS >= 60_000);
});

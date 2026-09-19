import test from 'node:test';
import assert from 'node:assert/strict';
import { isHumanId, isBotId, botId, isGuestId, guestId } from '../src/game/ids.js';

const HUMAN = '0x' + 'ab'.repeat(20);

test('human ids are lowercase addresses only', () => {
  assert.equal(isHumanId(HUMAN), true);
  assert.equal(isHumanId(HUMAN.toUpperCase().replace('0X', '0x')), false, 'checksum case is not canonical');
  assert.equal(isHumanId('0x' + 'ab'.repeat(19)), false);
  assert.equal(isHumanId('bot:deadbeef:1'), false);
  assert.equal(isHumanId(42), false);
});

test('bot ids carry the seed prefix and slot', () => {
  const id = botId('0xdeadbeefcafebabe', 7);
  assert.equal(id, 'bot:deadbeef:7');
  assert.equal(isBotId(id), true);
  assert.equal(isBotId(botId('DEADBEEF00', 999)), true);
});

test('the two id spaces never overlap', () => {
  for (let n = 0; n < 1000; n++) {
    const id = botId('0x' + n.toString(16).padStart(8, '0') + 'ff', n);
    assert.equal(isHumanId(id), false, id);
    assert.equal(isBotId(id), true, id);
  }
  assert.equal(isBotId(HUMAN), false);
});

test('botId rejects bad input', () => {
  assert.throws(() => botId('0x1234', 0), TypeError);
  assert.throws(() => botId('zz'.repeat(8), 0), TypeError);
  assert.throws(() => botId('0xdeadbeef', -1), RangeError);
  assert.throws(() => botId('0xdeadbeef', 1000), RangeError);
  assert.throws(() => botId('0xdeadbeef', 1.5), RangeError);
});

test('guest ids: guest:<16 hex>, disjoint from humans and bots', () => {
  const g = guestId('0123456789abcdef');
  assert.equal(g, 'guest:0123456789abcdef');
  assert.ok(isGuestId(g));
  assert.ok(!isHumanId(g) && !isBotId(g));
  assert.ok(!isGuestId(HUMAN) && !isGuestId('bot:deadbeef:1') && !isGuestId('guest:short'));
  assert.throws(() => guestId('zz'), TypeError);
});

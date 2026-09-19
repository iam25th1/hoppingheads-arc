import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeat, createBotSeat, countSeats, fillWithBots, DEFAULT_SKINS } from '../src/game/bots.js';
import { isBotId, isHumanId } from '../src/game/ids.js';

const SEED = '0x' + 'ab'.repeat(32);

// Every field a reader in gameSocket.js touches on a seat. If a reader gains
// a field, add it here and to createSeat, and a bot keeps working.
const READ_FIELDS = [
  'id', 'socketId', 'name', 'address', 'isBot', 'x', 'y', 'z', 'ry', 'score', 'fragments', 'minted', 'moving',
  'appearance', 'cosmeticExtras', 'index', 'fragCount', 'maxFrags', 'shadow', 'maxMints', 'boinkCd',
  'mint', 'rejections', 'violations', 'move', 'effects',
];

test('a bot seat has every field a human seat has', () => {
  const human = createSeat({ id: '0x' + '11'.repeat(20), name: '0x1111..1111', address: '0x' + '11'.repeat(20), socketId: 's1', appearance: DEFAULT_SKINS[0], index: 0, isBot: false, maxMints: 5 });
  const bot = createBotSeat(SEED, 0, 1, 5);
  assert.deepEqual(Object.keys(bot).sort(), Object.keys(human).sort());
  for (const f of READ_FIELDS) assert.ok(f in bot, `bot seat has ${f}`);
  assert.equal(bot.socketId, null);
  assert.equal(bot.address, null);
  assert.equal(bot.isBot, true);
  assert.equal(human.isBot, false);
});

test('bot ids are bot ids, never addresses, and name the run', () => {
  const b = createBotSeat(SEED, 3, 0, 5);
  assert.equal(b.id, 'bot:abababab:3');
  assert.ok(isBotId(b.id));
  assert.ok(!isHumanId(b.id));
  assert.equal(b.name, 'BOT 4');
});

test('tick serialiser fields are present and typed on a bot', () => {
  const b = createBotSeat(SEED, 0, 2, 5);
  assert.equal(typeof b.appearance.skinColor, 'number');
  assert.equal(typeof b.appearance.eyeStyle, 'string');
  assert.equal(typeof b.appearance.headStyle, 'string');
  assert.deepEqual([b.x, b.z, b.ry, b.score, b.minted, b.fragCount, b.shadow], [0, 0, 0, 0, 0, 0, 0]);
});

test('fillWithBots fills to the target, never displaces humans, never exceeds the max', () => {
  const lobby = { players: new Map() };
  lobby.players.set('0x' + '22'.repeat(20), createSeat({ id: '0x' + '22'.repeat(20), name: 'h', address: 'x', socketId: 's', appearance: DEFAULT_SKINS[0], index: 0, isBot: false, maxMints: 5 }));
  const added = fillWithBots(lobby, SEED, 4, 8, 5);
  assert.equal(added.length, 3);
  assert.deepEqual(countSeats(lobby.players), { humans: 1, bots: 3 });
  assert.deepEqual(added.map((b) => b.id), ['bot:abababab:0', 'bot:abababab:1', 'bot:abababab:2']);
  assert.equal(fillWithBots(lobby, SEED, 4, 8, 5).length, 0, 'already full to target');
  // A full lobby of humans gets no bots
  const full = { players: new Map() };
  for (let i = 0; i < 8; i++) full.players.set('h' + i, { isBot: false });
  assert.equal(fillWithBots(full, SEED, 4, 8, 5).length, 0);
  // Target above max is capped at max
  const small = { players: new Map() };
  assert.equal(fillWithBots(small, SEED, 20, 8, 5).length, 8);
});

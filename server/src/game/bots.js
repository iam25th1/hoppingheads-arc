/**
 * Bot participants
 *
 * A bot is a lobby player record with no socket behind it. It is shaped
 * exactly like a human record so every reader in gameSocket.js (the tick
 * serialiser, the pos and collect paths, endRound, saveResults) treats it as
 * one more seat. Bots plug into the same validated paths humans use; there
 * is no side door.
 *
 * Bot ids come from ids.js: bot:<8 hex>:<n>, provably disjoint from
 * addresses. The 8 hex are the round seed's first 8 digits, so a bot id says
 * which run it belongs to. Bots are filled in at countdown, when the seed is
 * not yet issued, so the lobby's pre-seed key is used: the seed is only for
 * the id prefix and is replaced by the real one at round start.
 *
 * This file only makes and places records. The driver that moves them lives
 * in botDriver.js.
 */

import { botId } from "./ids.js";
import { createMintState, createRejections } from "./lobbyFrags.js";
import { createMoveState } from "./movement.js";

export const BOT_FILL_TO = Math.max(0, Math.min(8, Number(process.env.BOT_FILL_TO) || 4)); // seats a classic lobby is filled up to
export const DEFAULT_SKINS = [
  { skinColor: 0xff8866, eyeStyle: "X", headStyle: "Horns" },
  { skinColor: 0xaadd55, eyeStyle: "Dots", headStyle: "Crown" },
  { skinColor: 0xaa88dd, eyeStyle: "Slit", headStyle: "Antenna" },
  { skinColor: 0x88bbcc, eyeStyle: "Open", headStyle: "Spike" },
  { skinColor: 0xddcc55, eyeStyle: "X", headStyle: "Ears" },
];

/** The fields a seat needs. Kept in one place so a bot and a human agree. */
export function createSeat({ id, name, address, socketId, appearance, index, isBot, maxMints }) {
  return {
    id, socketId, name, address, isBot,
    x: 0, y: 0, z: 0, ry: 0, score: 0,
    fragments: [0, 0, 0, 0, 0], minted: 0, moving: false,
    appearance, cosmeticExtras: {}, index,
    fragCount: 0, maxFrags: 48, shadow: 0,
    maxMints, boinkCd: 0,
    staked: false, // phase 4: the chain said this address entered the round; never true on a bot
    mint: createMintState(),
    rejections: createRejections(),
    violations: { move: 0 },
    move: createMoveState(),
    effects: {}, // powerup effects the server knows about: name -> until (ms)
  };
}

/** A bot seat for slot n of the run keyed by seedHex. */
export function createBotSeat(seedHex, n, index, maxMints) {
  return createSeat({
    id: botId(seedHex, n),
    name: `BOT ${n + 1}`,
    address: null,
    socketId: null,
    appearance: DEFAULT_SKINS[index % DEFAULT_SKINS.length],
    index,
    isBot: true,
    maxMints,
  });
}

/** Count seats by kind. */
export function countSeats(players) {
  let humans = 0, bots = 0;
  for (const p of players.values()) (p.isBot ? bots++ : humans++);
  return { humans, bots };
}

/**
 * Add bots to a lobby until it has `fillTo` seats. Returns the bots added.
 * Never displaces a human and never exceeds maxSeats.
 */
export function fillWithBots(lobby, seedHex, fillTo, maxSeats, maxMints) {
  const added = [];
  let n = countSeats(lobby.players).bots;
  while (lobby.players.size < Math.min(fillTo, maxSeats)) {
    const bot = createBotSeat(seedHex, n, lobby.players.size, maxMints);
    lobby.players.set(bot.id, bot);
    added.push(bot);
    n++;
  }
  return added;
}

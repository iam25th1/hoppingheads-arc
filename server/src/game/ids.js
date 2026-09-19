/**
 * Participant ids
 *
 * A seat in a match is held by a human or a bot, and both end up in the same
 * participant column. The two id spaces are disjoint by construction:
 *
 *   human   0x followed by exactly 40 lowercase hex digits. This is the
 *           address walletAuth.js recovers from the signature, lowercased.
 *           It is never derived from client input.
 *
 *   bot     bot:<8 hex>:<n>. The prefix is not 0x, the string contains
 *           colons, which no address does, and the length differs. The 8 hex
 *           digits are the first 8 of the run seed so a bot id says which
 *           run it belongs to; n is its slot in that run.
 *
 * Nothing spawns a bot yet. This module exists so the schema, the socket
 * lobby and the settle path agree on the shape before any of them need it.
 */

const HUMAN_RE = /^0x[0-9a-f]{40}$/;
const BOT_RE = /^bot:[0-9a-f]{8}:\d{1,3}$/;
const GUEST_RE = /^guest:[0-9a-f]{16}$/;

export function isHumanId(id) {
  return typeof id === 'string' && HUMAN_RE.test(id);
}

export function isBotId(id) {
  return typeof id === 'string' && BOT_RE.test(id);
}

/**
 * A guest holds a sandbox seat with no wallet. guest:<16 hex>, random per
 * socket, so it is never an address and never a bot, and nothing a payout
 * could reference.
 */
export function isGuestId(id) {
  return typeof id === 'string' && GUEST_RE.test(id);
}

export function guestId(randomHex16) {
  if (!/^[0-9a-f]{16}$/.test(randomHex16)) throw new TypeError('guestId: needs 16 hex digits');
  return `guest:${randomHex16}`;
}

/**
 * Build a bot id for slot n of the run with the given hex seed.
 * @param {string} hexSeed  0x prefixed or bare hex, at least 8 digits
 * @param {number} n        slot index, 0 to 999
 */
export function botId(hexSeed, n) {
  const clean = String(hexSeed).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{8,}$/.test(clean)) throw new TypeError('botId: seed must be at least 8 hex digits');
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new RangeError('botId: slot must be an integer 0..999');
  return `bot:${clean.slice(0, 8)}:${n}`;
}

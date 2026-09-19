/**
 * Lobby actions
 *
 * The validated things a seat can do in a round, as functions of the lobby
 * and the seat rather than of a socket. The socket handlers call these for
 * humans; the bot driver calls the same functions for bots. There is one
 * collection path and one mint path, and neither knows who is asking.
 *
 * `emit(event, payload, seat)` is the only side channel: with a seat it
 * means "to that seat only" (a rejection), without one "to the lobby".
 * gameSocket.js binds it to socket.io; tests bind it to an array.
 */

import { tryCollect, FRAG_POINTS, noteCollect, tryMint, respawnRarity } from "./lobbyFrags.js";

function tallyWrongMode(seat, reason) {
  seat.rejections.total++;
  seat.rejections[reason] = (seat.rejections[reason] || 0) + 1;
}

/**
 * Claim fragment `id` for `seat`. Returns { ok, reason } and performs every
 * side effect on success (counts, score, chest, frag:taken to the lobby) or
 * on failure (tally, log, frag:rejected to the seat).
 */
export function collectFragment(lobby, seat, id, emit, now = Date.now()) {
  if (!lobby.rules.fragments) {
    tallyWrongMode(seat, "wrong_mode");
    console.warn(`[MP] REJECT frag:collected ${seat.id} wrong_mode lobby=${lobby.mode} total=${seat.rejections.total}`);
    emit("frag:rejected", { id, reason: "wrong_mode" }, seat);
    return { ok: false, reason: "wrong_mode" };
  }
  if (!lobby.frags) return { ok: false, reason: "not_started" }; // silent, as before
  if (seat.fragCount >= seat.maxFrags) return { ok: false, reason: "cap" }; // silent second layer, as before

  // The server decides: exists, unclaimed, not in shadow, within range of
  // the seat's server tracked position. Reject, never clamp, and tally.
  const r = tryCollect(lobby.frags, seat.id, seat, id, seat.rejections);
  if (!r.ok) {
    console.warn(`[MP] REJECT frag:collected ${seat.id} ${r.reason}${r.id !== undefined ? ` id=${r.id}` : ""}${r.dist !== undefined ? ` dist=${r.dist.toFixed(1)}` : ""} total=${seat.rejections.total}`);
    emit("frag:rejected", { id, reason: r.reason }, seat);
    return { ok: false, reason: r.reason };
  }
  const f = r.fragment;
  seat.fragments[f.rarity]++;
  seat.fragCount++;
  seat.score += FRAG_POINTS;
  noteCollect(seat.mint, f.rarity, now); // three of a rarity earn a chest, server side
  emit("frag:taken", { id: f.id, by: seat.id, rarity: f.rarity, score: seat.score });
  return { ok: true, fragment: f };
}

/**
 * True when a mint would succeed now: under the cap, and the chest tryMint
 * would consume (the highest rarity pending) is old enough. Bots use it so
 * they only attempt mints that count; a human's client does the same check
 * with its own timer.
 */
export function hasMintableChest(seat, now, durations, grace) {
  if (seat.minted >= seat.maxMints) return false;
  const chests = seat.mint.chests;
  if (chests.length === 0) return false;
  let top = chests[0];
  for (const c of chests) if (c.rarity > top.rarity) top = c;
  return now - top.since + grace >= durations[top.rarity];
}

/**
 * Complete a mint for `seat` from its own chest record. Broadcasts
 * mint:broadcast and the rarity respawn on success; tallies, logs and emits
 * mint:rejected to the seat on failure.
 */
export function completeMint(lobby, seat, emit, now = Date.now()) {
  if (!lobby.rules.mints) {
    tallyWrongMode(seat, "wrong_mode");
    console.warn(`[MP] REJECT mint:done ${seat.id} wrong_mode lobby=${lobby.mode} total=${seat.rejections.total}`);
    emit("mint:rejected", { reason: "wrong_mode" }, seat);
    return { ok: false, reason: "wrong_mode" };
  }
  const m = tryMint(seat.mint, now, seat.rejections);
  if (!m.ok) {
    console.warn(`[MP] REJECT mint:done ${seat.id} ${m.reason}${m.rarity !== undefined ? ` rarity=${m.rarity} elapsed=${m.elapsed}` : ""} total=${seat.rejections.total}`);
    emit("mint:rejected", { reason: m.reason }, seat);
    return { ok: false, reason: m.reason };
  }
  seat.minted = m.minted;
  seat.score += m.points;
  emit("mint:broadcast", { id: seat.id, rarity: m.rarity, minted: seat.minted, score: seat.score });
  if (lobby.frags) {
    const moved = respawnRarity(lobby.frags, m.rarity);
    emit("frag:respawn", { rarity: m.rarity, fragments: moved });
  }
  return { ok: true, rarity: m.rarity, points: m.points };
}

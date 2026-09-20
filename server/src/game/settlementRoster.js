/**
 * Who a settlement can name.
 *
 * endRound sorts every seat by score and hands out placements. The escrow can
 * credit only address shaped participants that entered the round on chain;
 * bots and guests cannot even be encoded. This module keeps the two views
 * apart: the full results (for the round record and the leaderboard) and the
 * settlement placements (humans only, in placement order), plus the seat
 * snapshot taken when a human leaves mid round so their stake still settles
 * by the score they had.
 */

import { isHumanId } from "./ids.js";

/** A frozen copy of a seat for the results, taken at the moment it leaves. */
export function departedSnapshot(seat) {
  return {
    id: seat.id,
    name: seat.name,
    score: seat.score,
    minted: seat.minted,
    fragments: [...seat.fragments],
    isBot: false,
    staked: seat.staked === true,
    departed: true,
  };
}

/** Results in placement order from the live seats and the departed snapshots. */
export function rankSeats(seats, sanitize) {
  return [...seats]
    .map((p) => ({ id: p.id, name: sanitize(p.name, 12), score: p.score, minted: p.minted, fragments: p.fragments.reduce((a, b) => a + b, 0), staked: p.staked === true, departed: p.departed === true }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, placement: i + 1 }));
}

/**
 * The placement list a settlement is signed over: human, address shaped, and
 * staked (the chain is asked again by the worker; this is the first filter).
 * Placement numbers are the round's, not renumbered, so a human who came third
 * behind two bots is third.
 */
export function settlementPlacements(results) {
  return results.filter((r) => isHumanId(r.id) && r.staked).map((r) => ({ player: r.id, place: r.placement }));
}

/**
 * Seats and the sockets that hold them.
 *
 * A seat is keyed by the wallet address and held by one socket at a time.
 * When the same address connects again the newest connection wins the
 * seat: a reload, a closed tab, a second tab, a dropped network all end
 * the same way, with the player back in. The one exception is a live
 * round already being played on another connection, which is refused
 * rather than yanked out from under it.
 *
 * Pure decisions live here so they are testable; gameSocket.js applies
 * them.
 */

/**
 * What to do when an address that already holds a seat joins again.
 *   status  the lobby's status
 *   alive   the seat's current socket is still connected
 * Returns 'reclaim' (take the seat back, kicking a live older socket),
 * 'release' (a live round whose player is gone: freeze the seat as departed
 * and let the new connection join fresh), 'refuse' (a live round on a live
 * connection), or 'new' (the old lobby is over; join fresh).
 */
export function seatOnRejoin({ status, alive }) {
  if (status === "ended") return "new";
  if (status === "active") return alive ? "refuse" : "release";
  return "reclaim";
}

/**
 * What to do with a seat whose socket went away.
 *   status  the lobby's status
 *   staked  the chain said this address entered the round
 * Returns 'depart' (a live round: freeze the seat with its score),
 * 'keep' (a staked seat before the round starts: money is committed, the
 * seat waits for its player through the grace period), or 'drop'.
 */
export function seatOnLeave({ status, staked }) {
  if (status === "active") return "depart";
  if (staked && (status === "waiting" || status === "countdown")) return "keep";
  return "drop";
}

/** Human seats with a connected socket. */
export function liveHumans(players, isAlive) {
  let n = 0;
  for (const p of players.values()) if (!p.isBot && p.socketId && isAlive(p.socketId)) n++;
  return n;
}

/** Staked human seats whose socket is gone: seats waiting for their player. */
export function awayStaked(players) {
  const out = [];
  for (const p of players.values()) if (!p.isBot && p.staked && !p.socketId) out.push(p.id);
  return out;
}

export const GRACE_MS = 120_000; // how long a lobby with only away staked seats waits before it is abandoned

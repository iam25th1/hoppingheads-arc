/**
 * Round modes
 *
 * The server selects the ruleset for a round from the mode the lobby was
 * made for. Before this, a lobby had no mode: the client decided what it was
 * playing, and a classic player and a Last Head Hopping player could share a
 * lobby and play two different games against one scoreboard.
 *
 * Only classic is stakeable. Wallets are free and LBS has no server side
 * state to settle on (eliminations are client side), so it stays playable
 * unstaked and phase 2 reads `stakeable` before letting any USDC near a
 * round.
 */

export const MODES = Object.freeze({
  classic: Object.freeze({
    fragments: true,   // frag:collected is a real event, validated
    mints: true,       // mint:done is a real event, validated
    bots: true,        // the server fills empty seats with bots at countdown
    powerups: true,    // the server spawns powerups and decides pickups
    stakeable: true,
    roundMode: "classic-online", // rounds.mode value
  }),
  lbs: Object.freeze({
    fragments: false,  // no fragments in LBS; a claim is a wrong_mode rejection
    mints: false,
    bots: false,       // LBS resolves eliminations on the client; no server bot can play it
    powerups: false,   // LBS powerups stay client side with the rest of LBS
    stakeable: false,
    roundMode: "lbs-online",
  }),
});

export const DEFAULT_MODE = "classic";

/** The lobby mode for a client request: a known mode, else the default. */
export function lobbyModeFor(requested) {
  return typeof requested === "string" && Object.hasOwn(MODES, requested) ? requested : DEFAULT_MODE;
}

/** The ruleset for a lobby mode. Throws on an unknown mode: that is a server bug. */
export function rulesFor(mode) {
  const r = MODES[mode];
  if (!r) throw new Error(`rulesFor: unknown mode ${mode}`);
  return r;
}

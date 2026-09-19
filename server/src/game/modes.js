/**
 * Round modes
 *
 * Two families. The sandbox is free: no wallet, no stake, and nothing it
 * writes can ever be settled. The arena is the one staked mode, built on the
 * server authoritative classic round (seed, layout, collection validation,
 * mint rarity, powerups, bots), wallet required, the only rounds phase 3
 * settles.
 *
 * Lobby modes select the ruleset. The classic ruleset is unchanged; it is
 * now selected by the name `arena`. Online Last Head Hopping is the sandbox
 * lobby, `sandbox-lbs`. The old names `classic` and `lbs` are accepted as
 * aliases so an older client still lands in the right lobby.
 *
 * `stakeable` is the flag downstream reads. It is also enforced in the
 * database: rounds.stakeable can only be true when mode is `arena`.
 */

export const ARENA = "arena";
export const SANDBOX_LBS = "sandbox-lbs";

const CLASSIC_RULES = Object.freeze({
  fragments: true,   // frag:collected is a real event, validated
  mints: true,       // mint:done is a real event, validated
  bots: true,        // the server fills empty seats with bots at countdown
  powerups: true,    // the server spawns powerups and decides pickups
  guests: false,     // a seat needs a verified wallet
  stakeable: true,
  waitSeconds: 10,   // bots fill the seats at countdown, so a long wait for humans is dead time
  roundMode: "arena", // rounds.mode value
});

const LBS_RULES = Object.freeze({
  fragments: false,  // no fragments in LBS; a claim is a wrong_mode rejection
  mints: false,
  bots: false,       // LBS resolves eliminations on the client; no server bot can play it
  powerups: false,   // LBS powerups stay client side with the rest of LBS
  guests: true,      // sandbox: playable with no wallet at all
  stakeable: false,
  waitSeconds: 30,   // no bots here; the wait is for real players
  roundMode: "sandbox-lbs-online",
});

export const MODES = Object.freeze({
  [ARENA]: CLASSIC_RULES,
  [SANDBOX_LBS]: LBS_RULES,
});

const ALIASES = Object.freeze({ classic: ARENA, lbs: SANDBOX_LBS });

export const DEFAULT_MODE = SANDBOX_LBS; // an unknown request never lands in the staked mode

/** Solo round modes, all sandbox. */
export const SOLO_MODES = Object.freeze(["sandbox-classic-solo", "sandbox-lbs-solo"]);

/** The lobby mode for a client request: a known mode or alias, else the default. */
export function lobbyModeFor(requested) {
  if (typeof requested !== "string") return DEFAULT_MODE;
  if (Object.hasOwn(MODES, requested)) return requested;
  if (Object.hasOwn(ALIASES, requested)) return ALIASES[requested];
  return DEFAULT_MODE;
}

/** The ruleset for a lobby mode. Throws on an unknown mode: that is a server bug. */
export function rulesFor(mode) {
  const r = MODES[mode];
  if (!r) throw new Error(`rulesFor: unknown mode ${mode}`);
  return r;
}

/** True only for the one round mode phase 3 settles. */
export function isStakeableRoundMode(roundMode) {
  return roundMode === CLASSIC_RULES.roundMode;
}

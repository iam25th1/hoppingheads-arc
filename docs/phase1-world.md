# Phase 1: the server owns the world

Before this phase the server was a relay plus a scoreboard. It never knew where a fragment was. This phase makes the server generate the fragment layout from a seed it issues, hold every fragment's state, validate every collection and every mint against its own record, select the ruleset per lobby, and count what it refuses. No bots, no chain code.

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server (lobby)
  participant L as shared/layout.cjs
  participant D as Postgres
  S->>S: issueRound: seed = 256 bits of OS entropy, map picked or validated
  S->>D: INSERT rounds (seed, map_index, mode, status active)
  S->>L: createLayout(seed, map)
  L-->>S: 71 fragments, ids 0..70, positions
  S->>C: round:start { seed, mapIndex, mode }
  C->>L: createLayout(seed, map)  (same file, served as a classic script)
  L-->>C: the same 71 positions, byte for byte
  C->>S: pos { x, z } at 15 per second
  C->>S: frag:collected { id }
  S->>S: exists, unclaimed, not in shadow, dist(server pos, fragment) <= 6
  alt accepted
    S->>C: frag:taken { id, by, rarity, score } to everyone
    S->>S: three of a rarity: chest on record
  else rejected
    S->>S: tally reason on the player, log with running total
    S->>C: frag:rejected { id, reason }
  end
  C->>S: mint:done {}
  S->>S: highest chest on record, old enough: points from its rarity
  S->>C: mint:broadcast, frag:respawn { rarity, fragments } to everyone
  S->>D: UPDATE rounds completed; INSERT round_results per seat
```

## What recon found, and what it changed

The brief assumed the client layout was already a pure function of the seed literal and the map. It was not. `safePosInMap` reads the live collider set, the map builders draw decoration positions from the same global `rng` stream the fragments draw from, every `switchMapInPlace` rebuilds decorations from wherever that stream is and re-places all fragments, and `completeMint` re-placed a whole rarity per client. Two clients in a lobby could already disagree on where fragments were, and after the first mint they always did.

Three moves made the layout portable:

1. **Decoration builds reseed** a fixed stream on every build and restore the gameplay stream after. The collider set became a pure function of `mapIndex`, verified in the real client across two rebuilds per map: 387, 383, 120, 85, 55, 60 colliders for maps 0 to 5.
2. **The collider sets were recorded** into `shared/mapObstacles.cjs` by `scripts/extract-obstacles.mjs`, which drives the real client in headless Chromium. It is not part of the gate; run it after any map builder change and it exits 1 on drift.
3. **The layout draws from its own stream**, seeded by the full 256 bit round seed, and avoids the recorded colliders with the client's exact rule. Both sides run the same bytes.

## The shared module

<details>
<summary><code>shared/layout.cjs</code> and <code>shared/prng.cjs</code> API</summary>

Both files are UMD: `module.exports` under Node, `globalThis.HHLayout` / `HHPrng` / `HHMapObstacles` as classic browser scripts. The server requires them; the client loads the same bytes from `/game/lib/*.js`, which `index.js` serves with an explicit JavaScript content type (helmet sets `nosniff`, the files are `.cjs`). There is no build step and no copy.

```
HHPrng.createRng(seed)              32 bit path (string via FNV-1a, or number). Tests, and anything
                                    that only needs an unguessable stream.
HHPrng.createRngFromHex(hex256)     0x + 64 hex. All 256 bits reach the 128 bit xoshiro state by
                                    XOR folding the two halves. A test flips every one of the 64
                                    digits and asserts each changes the stream.
HHPrng.isHexSeed(v)

HHLayout.createLayout(seed, mapIndex) -> { seed, mapIndex, fragments, respawn }
  fragments   [{ id 0..70, rarity 0..4, x, z }], rarity major over FRAG_N = [30,18,12,7,4]
  respawn(r)  re-places every fragment of rarity r from the same stream, returns the moved ones
HHLayout.FRAG_N, MAP (300), MAP_COUNT (6), COLLECT_RADIUS (3)
```

Placement rule, unchanged from the client: 20 attempts in the 0.38 band of the 300 unit map, blocked if within `r + 1.5` of any recorded collider, then one draw in the 0.2 band. Positions are x and z in the flat map; y is always 0.
</details>

<details>
<summary>Why 256 bits</summary>

The phase 0 PRNG reduced any seed to 32 bits. That is a weekend of brute force, and phase 3 commits to this seed on chain, so an attacker who could enumerate seeds could enumerate layouts. `createRngFromHex` keeps every bit: four state words, each the XOR of one 32 bit word from the low half and one from the high half of the seed. `server/src/game/rounds.js` is the only issuer, `crypto.randomBytes(32)`. The layout test also asserts that two seeds equal in their first 8 hex digits still produce different layouts, which the old path could not.
</details>

## Seed issuance

`issueRound({ mode, mapIndex, issuedTo })` in `server/src/game/rounds.js` is the one path for every round: lobby rounds call it from `startRound`, solo rounds through `POST /api/round/start`. The row is written before any client sees the seed. `mapIndex` is a request the server validates; a bad one becomes a `crypto.randomInt` pick. If Postgres is down the round is still issued with no row, logged, so dev without a database keeps working.

Solo: a signed in player's row carries `issued_to`; `POST /api/score` closes that row (404 unknown, 403 not theirs, 400 wrong mode, 409 already closed, with the close as a conditional UPDATE so a race lets exactly one through). A guest gets a seed and no row, and cannot score. The `0xf7a2c1de` literal is no longer a gameplay input; it survives only as the fixed decoration stream and the menu placeholder a round start replaces.

## Collection

<details>
<summary>Validation rules, server side, in order</summary>

`frag:collected { id }`, in `gameSocket.js`, backed by the pure `tryCollect` in `server/src/game/lobbyFrags.js`:

| Check | On failure |
|---|---|
| lobby rules allow fragments (mode) | `wrong_mode` |
| round started (fragment state exists) | ignored silently, as before |
| rate limit 3 per second (unchanged) | ignored silently, as before |
| `fragCount < maxFrags` (unchanged, second layer) | ignored silently, as before |
| `id` is an integer | `bad_id` |
| fragment exists in this round | `missing` |
| fragment unclaimed | `claimed` |
| player not in shadow form (server tracked) | `shadow` |
| `hypot(p.x - f.x, p.z - f.z) <= COLLECT_RANGE` | `range`, with the distance |

Every failure increments `p.rejections[reason]` and `p.rejections.total`, logs `[MP] REJECT frag:collected <player> <reason> id= dist= total=`, and emits `frag:rejected { id, reason }` to that client only. Nothing is clamped. On success the player's per rarity count, `fragCount` and score (+3) move, `noteCollect` records a chest at every third fragment of a rarity, and `frag:taken` goes to everyone in the lobby.

**COLLECT_RANGE is 6.** The client collects at 3 from the authoritative position. Position updates arrive at up to 15 per second, the player moves up to 18 units per second, and the round trip adds more; 3 units of margin covers that. The boink handler uses the same idea (5 for a client 3.5). Whether 6 *feels* right is a manual check, below.
</details>

<details>
<summary>Mints</summary>

`mint:done {}` reads nothing from the payload. `tryMint` on the player's own record: no chest on record is `mint_no_chest`, a chest younger than its rarity's mint time less 500ms grace is `mint_early`, over the cap is `mint_cap`. The chest consumed is the highest rarity pending; the player's real collections bound what that can be. Points come from that chest. A mint respawns that rarity for everyone through `frag:respawn`, from the server's layout stream.

**Re-placement kept, on purpose, and moved entirely server side.** The option of minted fragments leaving the world was weighed and turned down for pacing: 71 fragments, 8 seats, 180 seconds. A player needs 9 fragments for three chests; eight players need 72, the whole map. A full lobby would empty the map in about the first minute and play the rest on nothing, and the chest mechanic assumes recollecting a rarity after a mint. The layout stays pinned regardless: every respawn is the next draw of the same seeded stream, so the full trajectory is a pure function of the seed plus the ordered validated mints, which the server holds and records on the round. The client places nothing in either path: lobbies apply `frag:respawn`, and solo rounds ask `POST /api/round/respawn { key, rarity }`, answered from the server's own copy of that round's stream (`server/src/game/soloRounds.js`, keyed by 128 bits returned once at round start, guests included). `switchMapInPlace` re-applies the round's own layout when it rebuilds the map being played, so a same map rebuild cannot swap it for the menu placeholder.

`MINT_LIMIT` is 5 everywhere now. It was 5 on the client and in `gameSocket.js` and 10 in `collection.js`, the Mint Rush value for maps of 15 to 25 assets. A 180 second round on 71 fragments is tuned for 5.
</details>

## Modes

`server/src/game/modes.js`. Lobbies are per mode and carry their rules. `classic` has fragments and mints and is the only **stakeable** mode. `lbs` has neither; a claim in an LBS lobby is `wrong_mode`. An unknown request is classic. LBS stays playable unstaked: it needs no server state, and phase 2 reads `stakeable` before any USDC touches a round.

## Movement

The speed clamp still clamps, so a latency spike does not eject an honest player, but it now increments `p.violations.move` and logs `[MP] FLAG pos` on the first three and every fiftieth after. No ejection.

**A finding the counter surfaced, not fixed in this phase.** The clamp allows `adjustedMaxSpeed * elapsed + 2` per update. That 2 unit knockback margin is per update, so at 15 updates a second it buys 28 units a second on top of the 25 cap: roughly 53 units a second before a clamp fires. In a real session a teleport of 322 units was flagged at once, while a continuous 43 unit per second hack (2.4 times the real 18) ran for 60 updates unflagged. A slow continuous cheat under about 2.9x is still invisible to this counter. The fix is a margin that does not scale with update rate (a rolling window over the last second, or a per second knockback allowance); that changes the clamp formula itself and belongs to phase 5 hardening.

At round end every player with a nonzero tally gets one line: `[MP] Flags lobby <id> <player>: rejections={...} moveClamps=N`. Phase 5 reads these.

## What the sessions showed

Real socket sessions, two signed in wallets, one honest and one lying, against a booted server:

```
A honest collect of id 5 -> frag:taken seen by both clients
A second claim of id 5   -> claimed
B at the origin, id 1    -> range dist=43.8
B id 9999                -> missing
B id 5                   -> claimed
B id "five", id undefined -> bad_id, bad_id
B mint:done x5, nothing collected (the old exploit) -> mint_no_chest x5, mint score 0
A three commons, mint at once -> mint_early (elapsed 1939 of 2500 less 500)
A after the mint time         -> accepted, rarity 0, +10, frag:respawn to both
A classic, B lbs, C lbs, D bogus -> lobbies 1, 2, 2, 1; B's claim and mint -> wrong_mode
[MP] Flags lobby 1 0xe1fa..e6a9: rejections={"total":2,"claimed":1,"mint_early":1} moveClamps=0
[MP] Flags lobby 1 0xdb24..1af9: rejections={"total":10,"range":1,"missing":1,"claimed":1,"bad_id":2,"mint_no_chest":5} moveClamps=0
[MP] Round ended lobby 1. Winner: 0xe1fa..e6a9 (22)
round:end [["0xe1fa..e6a9",22,4,1,1],["0xdb24..1af9",0,0,0,2]]
```

On the build before commit 4 the same B finished the round on 1250 points from five phantom legendary mints. On the final build B finished on 0. The teleport flag and the continuous speed hack finding came from a separate movement session, below.

## Still client authoritative after this phase

- **Position itself.** The server tracks and clamps what the client reports; it does not simulate movement or collision. A client can still stand inside a wall.
- **Boink damage and elimination.** The server checks proximity and forwards `boink:hit`; health, knockback and LBS eliminations resolve on the client.
- **Powerups, fever zone, crown, bots.** All client side, all drawing from the client's gameplay stream.
- **Stolen and scattered fragments.** Client only entities with no server record. They no longer report `frag:collected` online (the server would reject the ids and poison the tally), so they no longer score online. Bringing them server side is a phase decision.
- **Solo rounds.** The seed is issued, every respawn is performed, and the row is closed by the server, but a solo score is what the client reports; there is no lobby to validate against. Phase 5 bots are the answer there.
- **Round timing.** The countdown and the clock are server side; the client's local countdown for solo is local.

## Gate

```sh
npm run gate     # typecheck, lint, test, build
```

`npm run test` covers the layout module both ways (require, and the three files run as classic scripts in a bare context), the full width seed, round issuance with an injected query, fragment state and collection, mints including the exploit, modes, and solo round state.

Two browser driven checks live outside the gate because they need a Chromium build and a running server: `scripts/extract-obstacles.mjs` (collider data drift) and `scripts/verify-client-layout.mjs`, which drives the real client through every path that used to re-place fragments (menu map cycling before a round, a same map rebuild mid round, the round:start handler body after cycling, and a solo respawn) and compares the client's fragments to the shared module byte for byte. All six checks pass on this build.

## What cannot be confirmed headlessly

A green gate proves the layouts match and the handlers reject what they should. It does not prove the game plays. Each of these needs a person:

| Claim | Manual check |
|---|---|
| Collection still feels right after the range check | Play a classic online round with two browsers. Run through fragments at full speed, hop over them, brush past them at the edge of the pickup radius. Every fragment the client shows as collected must stay collected: no NOT COUNTED floats for honest play. If they appear on fast passes, COLLECT_RANGE (6) is too tight for real latency and needs raising, not the client radius |
| Fragments appear where the client draws them | In the same two browser round, both players should see fragments at the same places, and after either player mints, both should see the respawned rarity move to the same new places |
| A full classic round completes | Solo: coin, classic, play to the end screen, score submits (leaderboard shows the round). Online: two wallets, join, 30s wait, countdown, play 3 minutes, round:end with both scores, `/api/leaderboard/recent` shows two rows on one round id |
| **Bot movement and powerup placement after the reseed edit.** The decoration reseed at `client/index.html:574-577, 2173, 2537` was a prerequisite, not a planned change, and it moved the position of the global gameplay `rng` stream that bot wander targets, bot respawn positions and powerup positions draw from. Deterministic is not the same as right | Play a classic solo round and an LBS round on two different maps. Bots should wander, chase and respawn across the map as before, not cluster, freeze or pile into one corner; powerups should appear spread over open ground at the usual rate (every `PW_SPAWN_INTERVAL` in classic, 8s in LBS), not inside structures or all in one spot. Compare against a phase 0 build if anything looks off |
| The emote wheel, still empty | unchanged from phase 0 |

_(clip of a two browser round with a mint and the respawn landing in the same places on both screens goes here once someone runs it)_

## Flagged rewrites over ten lines

`gameSocket.js` `frag:collected` and `mint:done` handlers, `startRound`, `saveResults`; `api.js` `POST /score`; the client's fragment construction line and `startGame`'s entry. All required by the brief and each verified by a live session or a headless client run. No regex bulk edit touched `client/index.html`: every edit was a single anchored line, printed before and after.

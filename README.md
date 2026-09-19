# Hopping Heads Arc

Staked arena build of Hopping Heads. Phase 0: the fork stood up, stripped to the arena model, wallet admission in place of X login. No chain calls yet.

Phase records:

- [docs/phase0-strip.md](docs/phase0-strip.md): the fork stood up, stripped, wallet gate, schema.
- [docs/phase1-world.md](docs/phase1-world.md): the server owns the world. Seeds, the shared layout module, collection and mint validation, modes, movement flags, and what is still client side.
- [docs/phase2-bots.md](docs/phase2-bots.md): server side bots and powerups. Bot seats and driver, the shared collection and mint actions, the powerup authority model, the per seat speed cap.
- [docs/phase2b-modes.md](docs/phase2b-modes.md): Quick Play and Arena. The free sandbox, the one staked mode, the stakeable flag, guest seats.

## Run it

```sh
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm run dev            # node --watch server/src/index.js, reads env from the process
```

Env comes from Pier (see `pier.json`) or your host. `.env.example` lists every variable; nothing else is read. Without `SESSION_SECRET` sign in answers 503 and no lobby is joinable, on purpose.

Under Pier: `pier start hh-arc`, then `http://hh-arc.test:7080/game`.

## Gate

Every commit runs green through all four before it lands, and CI runs the same set after `npm ci --ignore-scripts`:

```sh
npm run gate           # typecheck, lint, test, build, in that order
npm run typecheck      # node --check over every .js and .mjs source
npm run lint           # ESLint bug rules over server/src and the inline client scripts
npm run test           # node --test over server/tests
npm run build          # served artifact set is complete and parses
npm run install-hooks  # pre-push hook that refuses a red gate
```

## Layout

```
client/index.html        the game, one file, served at /game
server/src/index.js      express + socket.io entry
server/src/ws/           lobby, tick, boink proximity check
server/src/game/         rounds (seed issuance), lobbyFrags (fragment state, collection and mint rules),
                         lobbyActions (the collection and mint paths, human or bot), bots and
                         botDriver (seats and the tick driver), powerups, movement (speed judge),
                         modes, mapGenerator, collection rules reference, participant ids
shared/                  prng, layout, mapObstacles: one copy, loaded by server and client
scripts/extract-obstacles.mjs
                         re-records shared/mapObstacles.cjs from the real client (needs Chromium)
server/src/utils/        wallet admission gate
server/src/db/           pool, schema
server/landing/          landing, terms, privacy
server/tests/            node:test suites
scripts/                 gate scripts and the pre-push hook
docs/                    phase records
```

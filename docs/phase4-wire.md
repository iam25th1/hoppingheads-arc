# Phase 4: the Arena wired to the escrow

A player stakes to enter, plays, and claims a payout, end to end on Arc testnet, from the game. Quick Play keeps working with no wallet and never touches the chain. Read [phase 3](phase3-escrow.md) first: the contract, the CLI and the deployed address are unchanged.

```mermaid
sequenceDiagram
  participant W as wallet (browser)
  participant G as game server (no key)
  participant D as database
  participant K as settler (operator key)
  participant S as signer (signer key)
  participant E as ArenaEscrow
  W->>G: join the Arena (verified wallet)
  G->>D: round row: onchain id, seed commit, open_requested
  K->>E: openRound(id, commit)
  K->>D: open
  G-->>W: stake:open, entry $0.50
  W->>E: enterWithPermit2 (one signature) or approve and enter
  W->>G: stake:submitted(tx)
  G->>E: entered(id, wallet)? (read)
  G-->>W: stake:confirmed; the wait to countdown starts
  Note over G: round plays; endRound ranks seats, saveResults writes them
  K->>D: completed and open? build placements (humans the chain says entered)
  K->>S: sign Settlement{roundId, seed, placements}
  K->>E: settleRound via Memo (credits, transfers nothing)
  K->>D: settled: tx, block, memo index, payouts
  W->>G: /api/chain/round/:id (results screen), /api/chain/claimable (CLAIM page)
  W->>E: withdraw() (pull)
```

## Recon

**Hook points, confirmed.** Entry: the `quickmatch` handler in `server/src/ws/gameSocket.js`, where `verifySessionToken(session)` recovers the wallet and `lobby.players.set(playerId, createSeat(...))` seats it; a stakeable lobby now issues its round there (`issueLobbyRound`) so the on chain id exists before anyone can stake. Result: `endRound`, which ranks seats by score (`rankSeats`) and emits `round:end`, and `saveResults`, which writes `round_results`; the worker picks the round up from there.

**Disconnect mid round.** Before this phase a leaving seat was deleted from the roster and vanished from the results; if the last human left, the lobby was torn down and no results were written. What should happen to the stake: nothing is refunded and nothing is invented. The seat is frozen at the score it had (`departedSnapshot`) and ranked with the live seats, so a leader who crashed still gets paid and a quitter is placed where they stood. A live staked round that loses its last human ends at once with those seats in the results, so the worker settles it. A human who staked and left before the countdown loses the stake to the pool: the contract has no refund path (phase 5 could add `refundRound`; flagged in the threat model).

**All bots.** A round cannot start with no human: a stakeable lobby with no staked human at countdown is abandoned. The worker still settles an opened round with an empty placement list so the escrow's record is closed; an abandoned round with entries pays no one and the entries stay in the pool.

**Wallet session and the seat.** The session is an HS256 token from `walletAuth.js`, minted after an EIP-4361 style signature, kept by the client in `localStorage.hh_wallet_session`. `quickmatch` verifies it server side and the recovered address is the seat id; the client never names its address. A seat is staked when the chain says `entered(roundId, address)`; `stake:submitted` is a hint about when to look, one look per seat, ninety seconds. The chain id itself is not configured: the server asks the RPC at boot and refuses anything that is not Arc (or a local node), so a stale env value cannot send a wallet to the wrong network.

## Score distribution

Recorded per seat for every Arena round, human and bot (`round_results`, phase 2). `scripts/score-distribution.mjs` prints it; the sample after eight scripted rounds plus the earlier idle ones:

```
Arena, completed rounds: 12 (12 with a human), seats 48: 12 human, 36 bot
  human score    n= 12 min=0 p25=40.5 median=63 p75=76.5 max=137 mean=57.2
  bot score      n= 36 min=9 p25=157.25 median=180 p75=208.25 max=339 mean=180.7
  human placements: {"4":12}; win rate 0%; top 3 rate 0%
  tiers 1.20 / 0.70 / 0.40 USDC, entry 0.50: expected payout per human entry 0.00 USDC (0% of entry)
  SAMPLE TOO SMALL to set tiers from: 12 human seats over 12 rounds. Tiers stay provisional.
```

Every human seat in it is a scripted or idle client placing fourth behind three bots. That is not a distribution of humans, and **the tier table was not set from it**: 1.20 / 0.70 / 0.40 on a 0.50 entry stay the phase 3 provisional values. The report is what the tiers get set from once real rounds exist; the script says so itself under 30 human seats or 20 rounds with a human.

## The services

| service | key | does | Pier |
|---|---|---|---|
| `hh-arc` (game server) | none | seats, plays, ranks; reads the escrow over a public RPC | existing |
| `hh-arc-signer` | `SIGNER_KEY` | signs the EIP-712 Settlement, loopback only, shared token, one struct | own service, own env, pinned commit |
| `hh-arc-settler` | `OPERATOR_KEY` | opens and settles rounds, nonce discipline, dead letters, alerts | own service (worker), own env, pinned commit |

The signer validates the struct to the contract's rules before touching the key and refuses to start without a 32 character token or a key. The worker takes a Postgres advisory lock so a second worker on the same database refuses to run.

### Nonce discipline (services/settler/tx.js)

The failure mode from phase 3: a transaction under 20 gwei is accepted, never mined, and leaves the pending nonce advanced, so everything behind it queues with no error anywhere. The sender: nonce from the last **mined** transaction, never the pending count; a stall found at start is an `ALERT`; `maxFeePerGas` explicit, twice base plus a tip bumped a quarter per attempt, never under the floor; signed and submitted raw; receipt awaited with a deadline (90 s); replacement at the same nonce on timeout; `StallError` after three attempts; `RevertError` at once. The round is marked `stalled` or `dead` with the error and an `ALERT` line. Tested against a stub of Arc's mempool: the trap itself (a swallowed send replaced at the same nonce with a higher fee, nothing queued behind), a stall left by an earlier process, exhaustion, a revert, and a mine between the deadline and the replacement.

### What is persisted per round

`rounds`: `onchain_round_id`, `seed_commit`, `chain_status`, `open_tx_hash`, `tx_hash`, `settled_block`, `chain_attempts`, `chain_error`, and `settlement` (JSON: seed, commitment, digest, signer, signature, placements, payouts, tiers, tx hash, block, nonce, attempts, memo index). `round_results.payout_units` per human seat. Enough to replay any settlement and to audit it against the explorer.

## Testnet, from the game

Both rounds were driven through the real client, headless, with a wallet bridged to the player key (the page's `window.ethereum` is the bridge: it signs and sends through viem exactly what the page asks, and refuses a fee under the floor). Every line quoted is what the player would read.

### Rounds A, with bots (rounds 55 and 56, the second identical in shape)

| step | what the player saw | chain |
|---|---|---|
| lobby | `OPENING THE ROUND` / THE ROUND IS BEING OPENED ON CHAIN. A FEW SECONDS. | worker: [openRound](https://explorer.testnet.arc.io/tx/0x99b5623cf3c72b34b93afd40efdc69b870c308bc72088addb0519a2a1fc4dcc2) block 63033098 |
| open | `STAKE $0.50` / ONE SIGNATURE. YOUR STAKE GOES TO THE ESCROW, NOT TO US. | |
| stake | `CONFIRM IN WALLET`, then `STAKING $0.50` / TX PENDING 0x5095ba..4bda | [enterWithPermit2](https://explorer.testnet.arc.io/tx/0x5095ba424b3182c9097a0325f31d17b8bde4cffaa974b8ce0efff948b9094bda) at 30 gwei, block 63033105; balance 21.388956 to 20.886261. Round 56: [0xba6e8deb...](https://explorer.testnet.arc.io/tx/0xba6e8deb9be404bad1c351ae69afeefd853f779652e9222d0a42fa7d6de15786), 20.886261 to 20.383568 |
| confirmed | `STAKED $0.50` / YOUR SEAT IS PAID. THE ROUND STARTS WHEN THE TIMER ENDS.; MATCH STARTS IN 10s | server read `entered` true |
| round | three bots filled; the idle human placed 4th | |
| results | `SETTLING ON CHAIN...` then `NO PAYOUT AT 4TH PLACE` | worker: [settleRound via Memo](https://explorer.testnet.arc.io/tx/0xf979923c7916ae4681742673cc0dafc23af7c9088f54ac16004a5b5ed091685e), Memo index 783041, block 63033501, 1 placement, payout 0. Round 56: [0xbbe38e75...](https://explorer.testnet.arc.io/tx/0xbbe38e75424bb00b9a8f37009216e1668083d5462be5d090a60b453f4fb05d2f), Memo index 783042, block 63034012 |
| CLAIM | `CLAIMABLE $0.00` / `NOTHING TO CLAIM` | |

### Round B, solo, the payout and the claim (round 57)

The Pier server fills every Arena lobby to four seats (BOT_FILL_TO lives in its env), and an idle client cannot beat three bots, so this round ran through a second game server process on another port with BOT_FILL_TO=1, the same code, the same chain, the same worker: one seat, first place by default. It is the payout path that is being proven here, not the play.

| step | what the player saw | chain |
|---|---|---|
| open | `OPENING THE ROUND` then `STAKE $0.50` | worker opened round 57 |
| stake | `CONFIRM IN WALLET`, `STAKING $0.50` / TX PENDING 0x34e0c4..76b6, `STAKED $0.50`; STAKED: 1 on the lobby count | [enterWithPermit2](https://explorer.testnet.arc.io/tx/0x34e0c4cfac5961d3a36291f872daacc087b8246a4de6c93df39254b7a30c76b6) block 63034140; balance 20.383568 to 19.880874 |
| results | `YOU WIN! 1ST PLACE`; `SETTLING ON CHAIN...` then `$1.20 CLAIMABLE. CLAIM FROM THE MENU.` | worker: [settleRound via Memo](https://explorer.testnet.arc.io/tx/0x78e375e690c01c244a294120cdf1fb34194549cedbff23e4576a5d5d39c6ba39), Memo index 783043, block 63034540, payout_units 1200000 written on the seat |
| CLAIM | `CLAIMABLE $1.20` / `CLAIM $1.20` / PULLS $1.20 TO YOUR WALLET; then `CONFIRM IN WALLET`, `CLAIMING` / TX PENDING 0x4c2a04..4e89, `CLAIMED` / IN YOUR WALLET. 0x4c2a04..4e89; the page rereads `CLAIMABLE $0.00` | [withdraw](https://explorer.testnet.arc.io/tx/0x4c2a04d2631d532b0a6b7af431263880b7c202ae768c7d1cb0c27579f84a4e89) block 63034548; balance 19.880874 to 21.079701 |

After the three rounds: pool 8.90 USDC (three entries in, one 1.20 payout out), player 21.079701, operator 19.973463 (three opens and three settlements through Memo, about 0.0053 USDC each pair). Every settlement carries its Memo index; every round row carries its settlement record; no page errors in any run.

The same flow ran first against arc-anvil with a locally deployed escrow and the services pointed at it (settled directly, since that node lacks the Memo precompile): an idle seat fourth behind three bots with no payout, then a solo seat first with $1.20 claimed. Identical screens, identical records.

## Threat model, what changed

| threat | outcome |
|---|---|
| client claims it staked | ignored; the server reads `entered` on chain and marks the seat only then |
| client ignores `stake:missing` and stays | the server drops the socket at countdown; an unstaked human is never in a staked round |
| wallet pointed at the wrong chain | the client switches or adds Arc from the server's config, whose chain id came from the RPC, not from env |
| a sub floor transaction from the worker | never produced (fee rule floor) and, if one ever were, detected by the missing receipt and replaced at the same nonce; `ALERT` logged |
| two workers on one database | the second refuses to start (advisory lock) |
| signer key stolen | it signs, it cannot submit; caps in the contract bound the rest (phase 3) |
| operator key stolen | can open and submit real signatures; cannot forge |
| a human staked and left before the countdown | stake stays in the pool; no refund path exists; a `refundRound` in the contract is the phase 5 fix |
| settlement delayed or dead | the results screen says so and the stake is recorded; the round is retried or dead lettered with the error in `chain_error` |

## Manual checks, not confirmed headlessly

A green gate proves the plumbing. It does not prove a player understands what happened to their money.

- **A real wallet entering from a browser.** Open the game with MetaMask (or any injected wallet) on Arc testnet with a little USDC, connect, ARENA, STAKE $0.50: expect a chain switch prompt if needed, one approval prompt the first time (Permit2), one signature, one transaction, and the button reading STAKED $0.50 with the lobby timer running. The bridged wallet cannot show what the prompts look like.
- **The pending and failure states as a player sees them.** Cancel the wallet prompt: the button must read RETRY STAKE $0.50 with STAKE FAILED: CANCELLED IN WALLET under it. Let a transaction sit: TX PENDING with the explorer link. Reject the approval: the same. Nothing may read gwei.
- **Whether the claim flow is clear.** After a winning round the results screen must say the amount and CLAIM FROM THE MENU; CLAIM must show the dollar amount, one wallet prompt, CLAIMED with the link, and the balance moving in the wallet.
- **Stake, leave, return.** Stake, hit BACK, re-enter ARENA within the wait: the seat must come back as STAKED without a second charge (the server recognises the entry).

_(a phone or desktop recording of stake, play, settle, claim goes here once someone runs it)_

<details>
<summary>Environment variables</summary>

| service | variable | meaning |
|---|---|---|
| game server | `ESCROW_ADDRESS` | the deployed escrow; unset means the Arena is offline |
| game server | `ARC_RPC_URL` | public RPC the server reads through; its chain id decides the network |
| game server | `EXPLORER_URL` | links in the client |
| game server | `ARC_MAINNET_CONFIRM` | `I_UNDERSTAND` to allow a mainnet RPC; unset in this phase |
| signer | `SIGNER_KEY`, `SIGNER_TOKEN`, `CHAIN_ID`, `ESCROW_ADDRESS`, `PORT`, `BIND` | the one key, the shared token, the EIP-712 domain, loopback |
| settler | `OPERATOR_KEY`, `CHAIN_ID`, `ARC_RPC_URL`, `ESCROW_ADDRESS`, `DATABASE_URL`, `SIGNER_URL`, `SIGNER_TOKEN`, `POLL_MS`, `RECEIPT_DEADLINE_MS`, `MAX_ATTEMPTS`, `SETTLE_VIA_MEMO` | see `services/settler/.env.example` |
</details>

<details>
<summary>Pier service layout</summary>

Three services, three env blocks, three processes. The game server runs from the main checkout and pulls on deploy. The signer and the settler run from their own clones of the repo, registered with `pier add <clone>/services/signer` and `pier add <clone>/services/settler`, and their `pier.json` deploySteps check out a named commit instead of pulling:

```
git fetch --quiet origin
git checkout --quiet <reviewed commit>
npm ci --ignore-scripts
```

To move a service to a newer commit: review it, put its hash in that service's `pier.json`, commit, and `pier deploy`. The env blocks are imported from each service directory's gitignored `.env` at registration (see the `.env.example` beside each) and never leave Pier. Log lines starting with `ALERT` are the ones to page on: a stall, a dead letter, or a second worker.
</details>

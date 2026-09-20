# Phase 3: the escrow on Arc testnet

The money surface, standalone. ArenaEscrow holds a house funded USDC pool on Arc and pays on placement in an Arena round; a CLI drives it with no game attached. Two cleanups came first because they get expensive once a seed carries money: the PRNG warm up and the bot speed cap. Nothing here is wired to the game; that is phase 4.

## Recon

**Toolchain.** Arc Foundry (circlefin/arc-foundry, a fork of Foundry that runs Arc's own EVM) installs here: the v0.8.0-1 release ships an Apple Silicon build (v0.8.0-2 ships Linux only), checksum verified, installed as `arc-forge`, `arc-cast`, `arc-anvil`, plus `brew install libusb` for a dylib the binaries link. `arc-anvil --network arc` comes up with the predeploys: USDC at `0x3600...0000` (6 decimals, one balance with the 18 decimal native view), Permit2, Memo, Multicall3, and a 21 gwei base fee that refuses anything under it. One gap: the callFrom precompile (`0x18...03`) that the Memo contract forwards through is not implemented in v0.8.0-1 (`OpcodeNotFound`), so the Memo stamp can only be exercised on testnet. Everything else about the contract is tested locally, on Arc semantics, in the gate.

**What the round rows carry.** `rounds` has `seed`, `stakeable` (arena only, by constraint), `commit_hash`, `signature`, `tx_hash`, `entry_fee_wei`, `prize_pool_wei`, `winner`. `round_results` has `participant`, `is_bot`, `score`, `placement`, unique per round and participant. Missing for settlement: the on chain `roundId` (bytes32; the SERIAL `id` is not it), the seed commitment as its own column (`commit_hash` was reserved for the result set), a per participant payout in USDC units, and the settlement block. Not added here; phase 4 wires the game and adds them with the service that needs them.

**Three id spaces, provably disjoint** (`server/src/game/ids.js`): humans `^0x[0-9a-f]{40}$`, bots `^bot:[0-9a-f]{8}:\d{1,3}$`, guests `^guest:[0-9a-f]{16}$`. A payout can only reference a human: `Placement.player` is an `address` by ABI type, so a bot or guest id cannot be encoded into a settlement at all, and on top of that the contract requires the address to be non zero, seated in that round (it paid the entry) and listed once. The settlement service will filter with `isHumanId` before signing; the contract does not rely on it.

**Where placement is decided today.** `endRound` (`server/src/ws/gameSocket.js`) sorts seats by score, assigns `placement = index + 1`, emits `round:end` and writes `round_results`. A settlement service signs `Settlement { roundId, seed, placements[] }` under the EIP-712 domain `ArenaEscrow / 1 / chainId / contract`, for the human seats that entered on chain, in placement order, and the operator submits it. The seed it reveals is the one `issueRound` generated at countdown and committed at `openRound`.

## The two cleanups

**Seeds.** Every derived stream replaces the seed's last byte (bot slots, powerups, spawns). After the XOR fold that changed one byte of one xoshiro state word, and the first two outputs came from another, so every derived stream opened with the raw seed's two draws and every bot brain with every other. `createRngFromHex` now discards 16 steps after seeding. Measured: 256 tags on one seed give 256 different openings, none equal to the raw seed's, adjacent tags differ in 16.2 of 32 bits on the first draw. This changes every stream for every seed, before any seed is committed to on chain. The hex golden vector is regenerated and pinned (the old test only compared a draw with itself). Client and server share the file byte for byte and the test that runs both paths passes.

**Bot speed.** `BOT_SPEED` was a flat 14 while the cap shrinks with fragments, so grown bots were clamped every tick. `movement.js` exports `growCap`, `botDriver.js` exports `botSpeed`, and the driver runs each bot under exactly the cap the judge holds it to. Test: four bots over a 180 second round of jittered ticks, growing with every claim, fresh and starting grown: zero flags; the old flat pace under a grown cap is flagged, as the control.

## Architecture

```mermaid
sequenceDiagram
  participant P as player wallet
  participant E as ArenaEscrow
  participant O as operator
  participant G as game server
  participant S as signer
  O->>E: openRound(roundId, keccak256(seed))
  P->>E: enterWithPermit2(roundId, nonce, deadline, sig) or enter(roundId)
  Note over E: entry USDC joins the pool
  G->>G: round plays on the seed
  G->>S: placements for the human seats that entered
  S-->>O: EIP-712 signature over {roundId, seed, placements}
  O->>E: settleRound(roundId, placements, seed, sig) via Memo
  Note over E: seed checked against the commit, caps applied, claimable credited, nothing transferred
  P->>E: withdraw()
  E-->>P: USDC, pull only
```

One contract, no proxy, no upgrade path, no selfdestruct, no payable function, no `msg.value`. The settlement interface (`IArenaSettlement`) is what the pooled pot and the personal best models implement in later phases; only the house backed implementation ships now.

### Roles

| role | holds | can |
|---|---|---|
| owner | the pool's key | set operator and signer, tiers, caps, pause, withdraw the free pool (never what players are owed), hand over ownership in two steps |
| operator | gas | open rounds, submit settlements |
| signer | nothing | sign settlements |

A settlement needs the signer's signature and the operator's transaction. The three must be distinct addresses; the contract refuses otherwise.

### Caps, in the contract

| cap | what it bounds |
|---|---|
| `maxPayoutPerRound` | credited per settlement; a tier table must fit it |
| `maxPayoutPerPlayerPerWindow` over `windowBlocks` | credited to one address per rolling window, measured in blocks |
| pool solvency | never more owed in total than the contract holds |
| pause | enter, settle and withdraw stop; owner only |

A compromised signer cannot settle alone (the operator submits). A compromised signer and operator together are bounded per round and per player per window, cannot pay an address that did not enter, and cannot reach the pool except through those credits; the owner pauses and rotates the keys.

## Arc constraints and where each lands

| fact | where it is handled |
|---|---|
| USDC is native gas and an ERC-20 at `0x3600...0000`, one balance, 18 and 6 decimals | contract and CLI use only the ERC-20 view; no payable, no `msg.value`, no native reads; the fork test `oneBalanceTwoViews` shows the two views of the escrow's balance agree at 1e12 |
| mempool silently drops `maxFeePerGas` under 20 gwei | one `send` in the CLI sets it on every transaction, twice base plus a 1 gwei tip, never under the floor; `floor-check` proves the rule and the node's refusal; testnet base fee measured at exactly 20 gwei |
| PREVRANDAO is 0, no VRF | no on chain randomness anywhere; the seed is generated off chain, committed before the round, revealed at settlement |
| value transfers to the zero address and to or from blocklisted addresses revert and consume gas | payouts are pull only; a blocked recipient's withdraw reverts alone, its credit stays, nobody else is affected (tested) |
| timestamps are non decreasing, not increasing | the rolling window is `block.number` based; nothing in the contract reads a timestamp (Permit2's deadline is Permit2's own check) |
| Permit2 predeployed | `enterWithPermit2`: one signature per entry after a one time approval of Permit2 (fork tested against the real predeploy) |
| Memo predeployed, EOA only, sequential index | the CLI settles through `Memo.memo(escrow, calldata, roundId, note)`, so each settlement has a Memo event carrying the roundId; local arc-anvil lacks the precompile behind it, so that path is testnet only |
| finality on inclusion | receipts are final; the CLI waits for one and prints it |
| blocks every 0.5 s on testnet (2000 blocks in 1000 s, measured) | `WINDOW_BLOCKS=172800` is a day |

## Threat model

| threat | outcome |
|---|---|
| signer key stolen | cannot submit (operator only); if the operator is also lost, credits are bounded by the round cap, the per player window cap and the pool, and only to addresses that entered; owner pauses and rotates |
| operator key stolen | can open rounds and submit real signatures only; cannot forge a settlement |
| owner key stolen | can retune tiers and caps, rotate roles, pause, and withdraw the free pool: the trust root. Use a multisig for it in production |
| replay of a settlement | roundId is single use, the round is marked settled, the digest binds roundId, seed, placements, chain id and contract address |
| tampered placements or seed | signature no longer recovers to the signer; the seed must hash to the commit |
| a settlement naming an address that never paid | `NotEntered` |
| a bot or guest in a settlement | unencodable (`address` type) and unseated |
| reentrancy on withdraw | nonReentrant, balance zeroed before the transfer |
| draining the pool through many rounds | round cap and per player window cap, on chain; the owner sees `freePool` fall and pauses |
| a blocklisted winner | their withdraw reverts, their credit stays; no one else blocked |
| a transaction under the fee floor | never produced by the harness; the node refuses or never mines it |
| more than eight entrants in a round | allowed on chain (entries add to the pool, at most eight placements are paid); phase 4 matches seats to entries before the round starts |

## Tiers and how to tune them

Constructor parameters, owner settable after deploy (`setTiers`, `setCaps`, `setEntryAmount`), all in USDC 6 decimal units:

| parameter | default | meaning |
|---|---|---|
| `ENTRY_AMOUNT` | 500000 | 0.50 USDC per seat |
| `TIERS` | 1200000, 700000, 400000 | 1st 1.20, 2nd 0.70, 3rd 0.40; a place beyond the table pays 0 |
| `MAX_PAYOUT_PER_ROUND` | 2300000 | the table must fit it |
| `MAX_PAYOUT_PER_PLAYER_PER_WINDOW` | 20000000 | 20 USDC per address per window |
| `WINDOW_BLOCKS` | 172800 | a day of 0.5 s blocks |

With eight humans a round takes in 4.00 and pays at most 2.30; with one human and seven bots it takes in 0.50 and can still pay 1.20, so the pool subsidises thin rounds by design. Tuning: change `TIERS` and the caps with the owner key (a table that does not fit the round cap is refused; the round cap and the window cap are the true bounds). Whether these numbers make sense against real score distributions cannot be known yet; see the last section.

## Tests

26 unit tests against a 6 decimal USDC mock with a blocklist and 4 fork tests against arc-anvil's real predeploys (one skipped locally, the Memo path), all in the gate: `npm run contracts`. Listed in the commit message of the contract and in `contracts/test`. The fee floor check runs after them against the same arc-anvil.

## The CLI cycle, measured on arc-anvil

`node cli/cycle.mjs 5 --permit2` with arc-anvil's default accounts as the four roles (local only; those keys are public):

| step | pool | owed | free | owner | player | claimable | gas | cost |
|---|---|---|---|---|---|---|---|---|
| start | 0 | 0 | 0 | 999999.94 | 1000000.00 | 0 | | |
| fund 5 (approve, fundPool) | 5.00 | 0 | 5.00 | 999994.94 | 1000000.00 | 0 | 55438 + 52098 | 0.0023 |
| open | 5.00 | 0 | 5.00 | | | | 75316 | 0.0016 |
| enter via Permit2 (approve Permit2 once, enterWithPermit2) | 5.50 | 0 | 5.50 | | 999999.50 | 0 | 55726 + 126559 | 0.0038 |
| settle, player first | 5.50 | 1.20 | 4.30 | | 999999.50 | 1.20 | 163030 | 0.0034 |
| withdraw | 4.30 | 0 | 4.30 | | 1000000.69 | 0 | 55814 | 0.0012 |

A second cycle on the approve path: enter 85858 gas, settle 148116 (0.0031 USDC), withdraw 55814. Deploy: 2731018 gas, 0.057 USDC. Costs are gas times the effective price (22 gwei there, 20 gwei base on testnet), read from the receipt in the native 18 decimal view and shown as USDC.

**Gas cost of a settlement: 148k to 163k gas, about 0.003 USDC at Arc's floor.**

## Testnet

Keys for the four roles were generated with `node cli/keys.mjs --write` into the gitignored `contracts/.env` (mode 600). Addresses:

| role | address |
|---|---|
| owner | `0x10EA64B8576644D814A31438642E28B14e129a5d` |
| operator | `0x0a8e8563fF548c71850a916690cd938994E92F79` |
| signer | `0xB5C020E301481713D104e474E7A2550012Aed9ff` |
| player | `0x70d4172FF4392e2Ed1996dB6430b706c8cD3859b` |

All four hold 0 USDC on testnet at the time of writing. The faucet (https://faucet.circle.com) is a browser step, so the deployment waits on it. Once the owner holds about 12 USDC (0.06 for the deploy, the rest for the pool), the operator about 0.5 (gas for open and settle), and the player about 1 (0.50 entry plus gas):

### Runbook

```sh
cd contracts && arc-forge build
node cli/deploy.mjs                     # owner deploys; prints ESCROW_ADDRESS, put it in .env
node cli/status.mjs                     # roles, tiers, caps, balances
node cli/cycle.mjs 10 --permit2         # fund 10, open, enter with one signature, settle via Memo, withdraw
node cli/status.mjs <roundId>           # the round's commit, block, settled flag, entrants
```

Then on https://explorer.testnet.arc.io: the contract address, the settlement transaction with its `RoundSettled` and `Credited` events, and the Memo event carrying the roundId. The deployed address and links go here once the faucet step is done:

_(testnet address, explorer links and the live cycle output go here after funding)_

Never mainnet in this phase. The CLI refuses `ARC_NETWORK=mainnet` without `ARC_MAINNET_CONFIRM=I_UNDERSTAND`, and no mainnet key exists in this environment.

<details>
<summary>ABI</summary>

**Functions**
- `MAX_PLACEMENTS()` view returns (uint256)
- `MAX_TIERS()` view returns (uint256)
- `acceptOwnership()`
- `claimable(address )` view returns (uint256)
- `commitFor(bytes32 seed)` view returns (bytes32)
- `eip712Domain()` view returns (bytes1, string, string, uint256, address, bytes32, uint256[])
- `enter(bytes32 roundId)`
- `enterWithPermit2(bytes32 roundId, uint256 nonce, uint256 deadline, bytes signature)`
- `entered(bytes32 , address )` view returns (bool)
- `entryAmount()` view returns (uint256)
- `freePool()` view returns (uint256)
- `fundPool(uint256 amount)`
- `maxPayoutPerPlayerPerWindow()` view returns (uint256)
- `maxPayoutPerRound()` view returns (uint256)
- `openRound(bytes32 roundId, bytes32 seedCommit)`
- `operator()` view returns (address)
- `owner()` view returns (address)
- `pause()`
- `paused()` view returns (bool)
- `pendingOwner()` view returns (address)
- `permit2()` view returns (address)
- `placed(bytes32 , address )` view returns (bool)
- `renounceOwnership()`
- `rounds(bytes32 )` view returns (bytes32, uint64, bool, uint32)
- `setCaps(uint256 maxPayoutPerRound_, uint256 maxPayoutPerPlayerPerWindow_, uint256 windowBlocks_)`
- `setEntryAmount(uint256 entryAmount_)`
- `setOperator(address operator_)`
- `setSigner(address signer_)`
- `setTiers(uint256[] tiers_)`
- `settleRound(bytes32 roundId, (address player,uint8 place)[] placements, bytes32 seed, bytes signature)`
- `settlementDigest(bytes32 roundId, bytes32 seed, (address player,uint8 place)[] placements)` view returns (bytes32)
- `signer()` view returns (address)
- `tiers()` view returns (uint256[])
- `totalClaimable()` view returns (uint256)
- `transferOwnership(address newOwner)`
- `unpause()`
- `usdc()` view returns (address)
- `windowBlocks()` view returns (uint256)
- `windows(address )` view returns (uint64, uint192)
- `withdraw()`
- `withdrawPool(address to, uint256 amount)`

**Events**
- `CapsSet(uint256 maxPayoutPerRound, uint256 maxPayoutPerPlayerPerWindow, uint256 windowBlocks)`
- `Credited(bytes32 indexed roundId, address indexed player, uint8 place, uint256 amount)`
- `EIP712DomainChanged()`
- `Entered(bytes32 indexed roundId, address indexed player, uint256 amount, bool viaPermit2)`
- `EntryAmountSet(uint256 entryAmount)`
- `OperatorSet(address indexed operator)`
- `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)`
- `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`
- `Paused(address account)`
- `PoolFunded(address indexed from, uint256 amount)`
- `PoolWithdrawn(address indexed to, uint256 amount)`
- `RoundOpened(bytes32 indexed roundId, bytes32 seedCommit, uint256 entryAmount, uint256 blockNumber)`
- `RoundSettled(bytes32 indexed roundId, bytes32 seed, uint256 credited, uint256 placements)`
- `SignerSet(address indexed signer)`
- `TiersSet(uint256[] tiers)`
- `Unpaused(address account)`
- `Withdrawn(address indexed player, uint256 amount)`

**Errors**
- `AlreadyEntered()`
- `AlreadySettled()`
- `BadCaps()`
- `BadCommit()`
- `BadEntryAmount()`
- `BadPlacement(address player, uint8 place)`
- `BadSignature()`
- `BadTiers()`
- `DuplicatePlacement(address player)`
- `ECDSAInvalidSignature()`
- `ECDSAInvalidSignatureLength(uint256 length)`
- `ECDSAInvalidSignatureS(bytes32 s)`
- `EnforcedPause()`
- `ExceedsFreePool(uint256 requested, uint256 free)`
- `ExpectedPause()`
- `InvalidShortString()`
- `NotEntered(address player)`
- `NotOperator()`
- `NothingToWithdraw()`
- `OwnableInvalidOwner(address owner)`
- `OwnableUnauthorizedAccount(address account)`
- `PlayerWindowCapExceeded(address player, uint256 total, uint256 cap)`
- `PoolInsufficient(uint256 owed, uint256 held)`
- `ReentrancyGuardReentrantCall()`
- `RolesMustDiffer()`
- `RoundCapExceeded(uint256 total, uint256 cap)`
- `RoundExists()`
- `RoundNotOpen()`
- `SafeERC20FailedOperation(address token)`
- `StringTooLong(string str)`
- `TooManyPlacements()`
- `ZeroAddress()`
</details>

<details>
<summary>Environment variables</summary>

| variable | used by | meaning |
|---|---|---|
| `ARC_NETWORK` | CLI | `testnet` (default), `local` (arc-anvil), `mainnet` (refused without confirmation) |
| `ARC_TESTNET_RPC_URL`, `ARC_MAINNET_RPC_URL` | CLI, foundry.toml | public RPC URLs; viem's built in chain gives the chain id |
| `ARC_RPC_URL` | CLI, gate | the local arc-anvil |
| `OWNER_KEY`, `OPERATOR_KEY`, `SIGNER_KEY`, `PLAYER_KEY` | CLI | the four roles; from Pier or the gitignored `contracts/.env` |
| `ESCROW_ADDRESS` | CLI | set after deploy |
| `ENTRY_AMOUNT`, `TIERS`, `MAX_PAYOUT_PER_ROUND`, `MAX_PAYOUT_PER_PLAYER_PER_WINDOW`, `WINDOW_BLOCKS` | deploy | constructor parameters |
| `ARC_MAINNET_CONFIRM` | CLI | must equal `I_UNDERSTAND` for mainnet; unset in this phase |
| `CONTRACTS_REQUIRED` | gate | `1` makes a missing toolchain fatal (CI) |
</details>

<details>
<summary>Typed data</summary>

Settlement, domain `{ name: "ArenaEscrow", version: "1", chainId, verifyingContract }`:

```
Settlement(bytes32 roundId,bytes32 seed,Placement[] placements)
Placement(address player,uint8 place)
```

Entry through Permit2, domain `{ name: "Permit2", chainId, verifyingContract: 0x000000000022D473030F116dDEE9F6B43aC78BA3 }`, spender the escrow, amount the entry, an unordered random nonce, a one hour deadline:

```
PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)
TokenPermissions(address token,uint256 amount)
```

The CLI computes the settlement digest locally, reads `settlementDigest` from the contract, and refuses to sign if they differ.
</details>

## What cannot be confirmed headlessly

- **Whether a real wallet can enter from a browser.** Nothing in this phase touches the client. Manual check, once phase 4 wires it: connect a wallet on Arc testnet, enter an Arena round, and confirm the single Permit2 signature prompt (after the one time approval) and the entry showing on the explorer.
- **Whether the tier numbers make sense.** There are no real score distributions yet. Manual check, after real rounds: take the placement distribution of humans against bots from `round_results`, compute the expected payout per entry at the default tiers, and set `TIERS` and the caps so the pool's drift per round is what the operator intends. A green gate proves the contract logic, not the economics.
- **The Memo stamp itself**, until the testnet cycle runs (local arc-anvil lacks the precompile).

_(explorer screenshot of a settlement with its Memo event goes here once the testnet cycle has run)_

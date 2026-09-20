/**
 * The escrow, read only.
 *
 * The game server holds no key. It reads Arc testnet through a public RPC to
 * learn what the chain says: whether an address entered a round, what a round
 * looks like, what an address can claim, the entry amount. Every transaction
 * belongs to a wallet (the player's, in the browser) or to the settlement
 * worker (its own service, its own key). Quick Play never comes here.
 *
 * Config from env: ESCROW_ADDRESS and ARC_RPC_URL. The chain id is not
 * configured: initChain asks the RPC at boot and the Arena is offline unless
 * the answer is an Arc chain (or a local node), so a stale CHAIN_ID can never
 * send a wallet to the wrong network. Without ESCROW_ADDRESS the Arena is
 * offline and says so; nothing here is ever called for a sandbox lobby.
 */

import { JsonRpcProvider, Contract, isAddress, getAddress } from "ethers";

export const USDC = "0x3600000000000000000000000000000000000000";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;

let detectedChainId = null;
const isLocalRpc = (url) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);

/**
 * Ask the RPC which chain it is and accept only Arc testnet, Arc mainnet with
 * ARC_MAINNET_CONFIRM=I_UNDERSTAND, or any chain on a local node. Called once at
 * boot; until it succeeds the Arena is offline. probe is injectable for tests.
 */
export async function initChain(probe = probeChainId) {
  detectedChainId = null;
  const escrow = process.env.ESCROW_ADDRESS;
  if (!escrow || !isAddress(escrow)) { console.warn("[Chain] ESCROW_ADDRESS unset or malformed: the Arena is offline"); return null; }
  const rpcUrl = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
  let id;
  try { id = await probe(rpcUrl); } catch (err) { console.error(`[Chain] could not read the chain id from ${rpcUrl}: ${err.message}; the Arena is offline`); return null; }
  const ok = id === ARC_TESTNET_CHAIN_ID || (id === ARC_MAINNET_CHAIN_ID && process.env.ARC_MAINNET_CONFIRM === "I_UNDERSTAND") || isLocalRpc(rpcUrl);
  if (!ok) { console.error(`[Chain] ${rpcUrl} is chain ${id}, not an Arc chain this server may use; the Arena is offline`); return null; }
  detectedChainId = id;
  console.log(`[Chain] Arena escrow ${getAddress(escrow)} on chain ${id} via ${rpcUrl} (read only)`);
  return id;
}

async function probeChainId(rpcUrl) {
  const p = new JsonRpcProvider(rpcUrl);
  const n = await p.getNetwork();
  p.destroy();
  return Number(n.chainId);
}

const ABI = [
  "function entered(bytes32 roundId, address player) view returns (bool)",
  "function rounds(bytes32 roundId) view returns (bytes32 seedCommit, uint64 openedAtBlock, bool settled, uint32 entrants)",
  "function claimable(address player) view returns (uint256)",
  "function entryAmount() view returns (uint256)",
  "function tiers() view returns (uint256[])",
  "function freePool() view returns (uint256)",
];

let cached = null;

/** The chain config the client is told, or null when the Arena is offline. */
export function chainConfig() {
  const escrow = process.env.ESCROW_ADDRESS;
  if (!escrow || !isAddress(escrow) || detectedChainId === null) return null;
  return {
    chainId: detectedChainId,
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io",
    explorer: process.env.EXPLORER_URL || "https://explorer.testnet.arc.io",
    escrow: getAddress(escrow),
    usdc: USDC,
    permit2: PERMIT2,
  };
}

export const chainEnabled = () => chainConfig() !== null;

function contract() {
  const cfg = chainConfig();
  if (!cfg) throw new Error("escrow: ESCROW_ADDRESS not configured");
  if (!cached || cached.escrow !== cfg.escrow || cached.rpcUrl !== cfg.rpcUrl) {
    const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
    cached = { escrow: cfg.escrow, rpcUrl: cfg.rpcUrl, c: new Contract(cfg.escrow, ABI, provider) };
  }
  return cached.c;
}

export async function entered(roundId, address) {
  return contract().entered(roundId, address);
}

export async function roundState(roundId) {
  const r = await contract().rounds(roundId);
  return { seedCommit: r.seedCommit, openedAtBlock: Number(r.openedAtBlock), settled: r.settled, entrants: Number(r.entrants) };
}

export async function claimable(address) {
  return contract().claimable(address);
}

let entryCache = { at: 0, value: null };
/** The entry amount in USDC units (6 decimals), cached for a minute. */
export async function entryAmount() {
  if (Date.now() - entryCache.at < 60_000 && entryCache.value !== null) return entryCache.value;
  const v = await contract().entryAmount();
  entryCache = { at: Date.now(), value: v };
  return v;
}

/**
 * Poll until the chain says `address` entered `roundId`, or the deadline
 * passes. Used after a player reports a stake transaction: the report is a
 * hint about when to look, never a fact.
 */
export async function waitForEntry(roundId, address, deadlineMs, everyMs = 2000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try { if (await entered(roundId, address)) return true; } catch (e) { console.warn(`[Chain] entered() failed: ${e.message}`); }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** USDC units to a dollar string for the UI: 500000 to "$0.50". */
export function usd(units) {
  const n = Number(units) / 1e6;
  return `$${n.toFixed(2)}`;
}

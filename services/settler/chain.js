/**
 * The chain side of the worker: viem clients for Arc, the escrow ABI the
 * build produced (contracts/abi/ArenaEscrow.json, checked against the build
 * by the gate), the Memo predeploy, and the small rpc interface tx.js needs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, hashTypedData, toHex, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, arc, foundry } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ESCROW_ABI = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "contracts", "abi", "ArenaEscrow.json"), "utf8"));
export const MEMO_ABI = [
  { type: "function", name: "memo", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }, { name: "memoId", type: "bytes32" }, { name: "memoData", type: "bytes" }], outputs: [] },
  { type: "event", name: "Memo", inputs: [{ name: "sender", type: "address", indexed: true }, { name: "target", type: "address", indexed: true }, { name: "callDataHash", type: "bytes32", indexed: false }, { name: "memoId", type: "bytes32", indexed: true }, { name: "memo", type: "bytes", indexed: false }, { name: "memoIndex", type: "uint256", indexed: false }] },
];
export const SETTLEMENT_TYPES = {
  Settlement: [{ name: "roundId", type: "bytes32" }, { name: "seed", type: "bytes32" }, { name: "placements", type: "Placement[]" }],
  Placement: [{ name: "player", type: "address" }, { name: "place", type: "uint8" }],
};

export function chainFor(chainId) {
  if (chainId === arcTestnet.id) return arcTestnet;
  if (chainId === arc.id) return arc;
  return { ...foundry, id: chainId };
}

export function createChain(cfg) {
  const chain = chainFor(cfg.chainId);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const account = privateKeyToAccount(cfg.operatorKey);
  const rpc = {
    getTransactionCount: (address, blockTag) => pub.getTransactionCount({ address, blockTag }),
    getBlock: () => pub.getBlock(),
    estimateGas: (tx) => pub.estimateGas(tx),
    sendRaw: (raw) => pub.request({ method: "eth_sendRawTransaction", params: [raw] }),
    getReceipt: (hash) => pub.getTransactionReceipt({ hash }).catch(() => null),
  };
  const read = (functionName, args = []) => pub.readContract({ address: cfg.escrow, abi: ESCROW_ABI, functionName, args });
  return { chain, pub, account, rpc, read };
}

export const encodeOpen = (roundId, commit) => encodeFunctionData({ abi: ESCROW_ABI, functionName: "openRound", args: [roundId, commit] });
export const encodeSettle = (roundId, placements, seed, signature) => encodeFunctionData({ abi: ESCROW_ABI, functionName: "settleRound", args: [roundId, placements, seed, signature] });
export const encodeMemo = (target, data, memoId, note) => encodeFunctionData({ abi: MEMO_ABI, functionName: "memo", args: [target, data, memoId, toHex(note)] });

export function settlementDigest(chainId, escrow, value) {
  return hashTypedData({ domain: { name: "ArenaEscrow", version: "1", chainId, verifyingContract: escrow }, types: SETTLEMENT_TYPES, primaryType: "Settlement", message: value });
}

export async function recoverSigner(chainId, escrow, value, signature) {
  return recoverTypedDataAddress({ domain: { name: "ArenaEscrow", version: "1", chainId, verifyingContract: escrow }, types: SETTLEMENT_TYPES, primaryType: "Settlement", message: value, signature });
}

/** The Memo event's index from a receipt, or null. */
export function memoIndexFrom(receipt, memoAddress) {
  const ev = MEMO_ABI.find((x) => x.type === "event" && x.name === "Memo");
  for (const l of receipt.logs || []) {
    if (l.address.toLowerCase() !== memoAddress.toLowerCase()) continue;
    try { const d = decodeEventLog({ abi: [ev], data: l.data, topics: l.topics }); return d.args.memoIndex.toString(); } catch { /* BeforeMemo */ }
  }
  return null;
}

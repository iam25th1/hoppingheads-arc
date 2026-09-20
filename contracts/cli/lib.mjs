// The CLI harness that drives ArenaEscrow with no game attached. One place for the network,
// the keys, the fee rule and every action; the scripts beside this file are thin wrappers.
//
// Arc rules this file enforces on every outbound transaction:
//   - maxFeePerGas is set explicitly and never below 20 Gwei (the mempool drops lower
//     silently: no error, no receipt, never mined);
//   - USDC is moved only through its ERC-20 interface (6 decimals); the native 18 decimal view
//     appears here only to turn a gas receipt into a USDC figure;
//   - mainnet is config only in phase 3: refused unless ARC_MAINNET_CONFIRM=I_UNDERSTAND.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, parseGwei, formatUnits, parseUnits, getAddress, isAddress,
  encodeFunctionData, decodeEventLog, keccak256, hashTypedData, toHex, maxUint256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, arc, foundry } from 'viem/chains';

export const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- env: Pier or a gitignored contracts/.env; never printed ----
export function loadEnv() {
  const file = path.join(DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();

// ---- Arc constants (docs.arc.io/arc/references/contract-addresses) ----
export const USDC = '0x3600000000000000000000000000000000000000';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const MEMO = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
export const FEE_FLOOR = parseGwei('20');
export const USDC_DECIMALS = 6;

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
export const MEMO_ABI = [
  { type: 'function', name: 'memo', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'memoIndex', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Memo', inputs: [{ name: 'sender', type: 'address', indexed: true }, { name: 'target', type: 'address', indexed: true }, { name: 'callDataHash', type: 'bytes32', indexed: false }, { name: 'memoId', type: 'bytes32', indexed: true }, { name: 'memo', type: 'bytes', indexed: false }, { name: 'memoIndex', type: 'uint256', indexed: false }] },
];

let artifact = null;
export function escrowArtifact() {
  if (artifact) return artifact;
  const file = path.join(DIR, 'out', 'ArenaEscrow.sol', 'ArenaEscrow.json');
  if (!fs.existsSync(file)) throw new Error('contracts/out missing: run arc-forge build in contracts/');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  artifact = { abi: j.abi, bytecode: j.bytecode.object };
  return artifact;
}

// ---- network ----
export function network() {
  const name = process.env.ARC_NETWORK || 'testnet';
  if (name === 'mainnet') {
    if (process.env.ARC_MAINNET_CONFIRM !== 'I_UNDERSTAND') {
      throw new Error('ARC_NETWORK=mainnet is config only in phase 3. Refusing without ARC_MAINNET_CONFIRM=I_UNDERSTAND.');
    }
    return { name, chain: arc, url: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io' };
  }
  if (name === 'local') {
    return { name, chain: foundry, url: process.env.ARC_RPC_URL || 'http://127.0.0.1:8545', explorer: null };
  }
  // viem ships arcTestnet (chain id 5042002); the RPC comes from the documented URL.
  return { name: 'testnet', chain: arcTestnet, url: process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io', explorer: 'https://explorer.testnet.arc.io' };
}

export function clients(role) {
  const net = network();
  const pub = createPublicClient({ chain: net.chain, transport: http(net.url) });
  if (!role) return { net, pub };
  const key = process.env[`${role.toUpperCase()}_KEY`];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${role.toUpperCase()}_KEY missing or malformed (set it in Pier or contracts/.env)`);
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.url) });
  return { net, pub, wallet, account };
}

export function escrowAddress() {
  const a = process.env.ESCROW_ADDRESS;
  if (!a || !isAddress(a)) throw new Error('ESCROW_ADDRESS missing (deploy first, then set it)');
  return getAddress(a);
}

// ---- fees: the floor, explicitly, on every transaction ----
export async function fees(pub) {
  const block = await pub.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas = parseGwei('1');
  let maxFeePerGas = base * 2n + maxPriorityFeePerGas;
  if (maxFeePerGas < FEE_FLOOR) maxFeePerGas = FEE_FLOOR;
  if (maxFeePerGas < FEE_FLOOR) throw new Error('fee rule broken'); // belt and braces: never below the floor
  return { maxFeePerGas, maxPriorityFeePerGas };
}

export const usdcFmt = (v) => `${formatUnits(v, USDC_DECIMALS)} USDC`;
export const usdcParse = (s) => parseUnits(String(s), USDC_DECIMALS);
/** A gas receipt in USDC: gas is paid in the native 18 decimal view of the same balance. */
export const gasCostUsdc = (r) => formatUnits(r.gasUsed * r.effectiveGasPrice, 18);

export function explorerTx(net, hash) { return net.explorer ? `${net.explorer}/tx/${hash}` : hash; }
export function explorerAddr(net, a) { return net.explorer ? `${net.explorer}/address/${a}` : a; }

/** Send, wait, print. Every transaction goes through here and carries the fee rule. */
export async function send(ctx, label, request) {
  const f = await fees(ctx.pub);
  const hash = await ctx.wallet.writeContract({ ...request, ...f, account: ctx.account });
  const r = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  ${label}: ${r.status} gas=${r.gasUsed} (${gasCostUsdc(r)} USDC) maxFeePerGas=${formatUnits(f.maxFeePerGas, 9)} gwei ${explorerTx(ctx.net, hash)}`);
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return r;
}

export async function usdcBalance(pub, a) {
  return pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] });
}
export async function readEscrow(pub, functionName, args = []) {
  return pub.readContract({ address: escrowAddress(), abi: escrowArtifact().abi, functionName, args });
}

// ---- round files: the operator's seed between open and settle (gitignored) ----
const roundsDir = path.join(DIR, 'cli', 'rounds');
export function saveRound(rec) { fs.mkdirSync(roundsDir, { recursive: true }); fs.writeFileSync(path.join(roundsDir, `${rec.roundId}.json`), JSON.stringify(rec, null, 2)); }
export function loadRound(roundId) {
  const f = path.join(roundsDir, `${roundId}.json`);
  if (!fs.existsSync(f)) throw new Error(`no round file for ${roundId} (opened elsewhere?)`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ---- actions ----

export async function deploy() {
  const ctx = clients('owner');
  const { abi, bytecode } = escrowArtifact();
  const operator = privateKeyToAccount(process.env.OPERATOR_KEY).address;
  const signer = privateKeyToAccount(process.env.SIGNER_KEY).address;
  const tiers = (process.env.TIERS || '1200000,700000,400000').split(',').map((t) => BigInt(t.trim()));
  const args = [
    USDC, PERMIT2, ctx.account.address, operator, signer,
    BigInt(process.env.ENTRY_AMOUNT || '500000'), tiers,
    BigInt(process.env.MAX_PAYOUT_PER_ROUND || '2300000'), BigInt(process.env.MAX_PAYOUT_PER_PLAYER_PER_WINDOW || '20000000'),
    BigInt(process.env.WINDOW_BLOCKS || '172800'),
  ];
  const chainId = await ctx.pub.getChainId();
  if (chainId !== ctx.net.chain.id) throw new Error(`RPC is chain ${chainId}, expected ${ctx.net.chain.id}`);
  console.log(`deploy on ${ctx.net.name} (chain ${chainId}) as owner ${ctx.account.address}; operator ${operator}; signer ${signer}`);
  console.log(`  entry ${usdcFmt(args[5])}; tiers ${tiers.map(usdcFmt).join(', ')}; caps round ${usdcFmt(args[7])}, player/window ${usdcFmt(args[8])}, window ${args[9]} blocks`);
  const f = await fees(ctx.pub);
  const hash = await ctx.wallet.deployContract({ abi, bytecode, args, ...f, account: ctx.account });
  const r = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  deploy: ${r.status} gas=${r.gasUsed} (${gasCostUsdc(r)} USDC) ${explorerTx(ctx.net, hash)}`);
  console.log(`ESCROW_ADDRESS=${r.contractAddress}`);
  console.log(`  ${explorerAddr(ctx.net, r.contractAddress)}`);
  return r.contractAddress;
}

export async function fund(amountStr) {
  const ctx = clients('owner');
  const esc = escrowAddress();
  const amount = usdcParse(amountStr);
  console.log(`fund pool with ${usdcFmt(amount)} from owner ${ctx.account.address}`);
  const allowance = await ctx.pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.account.address, esc] });
  if (allowance < amount) await send(ctx, 'approve', { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [esc, amount] });
  await send(ctx, 'fundPool', { address: esc, abi: escrowArtifact().abi, functionName: 'fundPool', args: [amount] });
  console.log(`  pool now ${usdcFmt(await usdcBalance(ctx.pub, esc))}, free ${usdcFmt(await readEscrow(ctx.pub, 'freePool'))}`);
}

export async function open(label) {
  const ctx = clients('operator');
  const esc = escrowAddress();
  const roundId = keccak256(toHex(`hh-arc:round:${label || Date.now()}`));
  const seed = `0x${crypto.randomBytes(32).toString('hex')}`;
  const commit = keccak256(seed);
  console.log(`open round ${roundId} (label ${label || 'timestamp'}) as operator ${ctx.account.address}`);
  await send(ctx, 'openRound', { address: esc, abi: escrowArtifact().abi, functionName: 'openRound', args: [roundId, commit] });
  saveRound({ roundId, seed, commit, network: ctx.net.name, escrow: esc, label: label || null });
  console.log(`  seed committed as ${commit}; seed kept in cli/rounds/ until settlement`);
  return roundId;
}

export async function enter(roundId, viaPermit2) {
  const ctx = clients('player');
  const esc = escrowAddress();
  const abi = escrowArtifact().abi;
  const entry = await readEscrow(ctx.pub, 'entryAmount');
  console.log(`enter ${roundId} as player ${ctx.account.address}, stake ${usdcFmt(entry)}${viaPermit2 ? ' via Permit2' : ''}`);
  console.log(`  player before: ${usdcFmt(await usdcBalance(ctx.pub, ctx.account.address))}`);
  if (viaPermit2) {
    // One time: let Permit2 move this player's USDC. After that, an entry is one signature.
    const toPermit2 = await ctx.pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.account.address, PERMIT2] });
    if (toPermit2 < entry) await send(ctx, 'approve Permit2 (once)', { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] });
    const nonce = BigInt(`0x${crypto.randomBytes(31).toString('hex')}`); // unordered nonce, never reused
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await ctx.wallet.signTypedData({
      account: ctx.account,
      domain: { name: 'Permit2', chainId: ctx.net.chain.id, verifyingContract: PERMIT2 },
      types: {
        PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
      },
      primaryType: 'PermitTransferFrom',
      message: { permitted: { token: USDC, amount: entry }, spender: esc, nonce, deadline },
    });
    await send(ctx, 'enterWithPermit2', { address: esc, abi, functionName: 'enterWithPermit2', args: [roundId, nonce, deadline, signature] });
  } else {
    const allowance = await ctx.pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [ctx.account.address, esc] });
    if (allowance < entry) await send(ctx, 'approve', { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [esc, entry] });
    await send(ctx, 'enter', { address: esc, abi, functionName: 'enter', args: [roundId] });
  }
  console.log(`  player after:  ${usdcFmt(await usdcBalance(ctx.pub, ctx.account.address))}; pool ${usdcFmt(await usdcBalance(ctx.pub, esc))}`);
}

/**
 * placements: [{ player, place }] in the order the settlement lists them. useMemo: stamp the
 * settlement through Arc's Memo predeploy (default on testnet and mainnet). arc-anvil v0.8.0-1
 * has the Memo contract but not the callFrom precompile behind it, so local runs settle directly.
 */
export async function settle(roundId, placements, useMemo = null) {
  const signerCtx = clients('signer');
  const ctx = clients('operator');
  const esc = escrowAddress();
  const abi = escrowArtifact().abi;
  const rec = loadRound(roundId);
  if (useMemo === null) useMemo = ctx.net.name !== 'local';
  for (const p of placements) if (!isAddress(p.player) || !(p.place >= 1 && p.place <= 255)) throw new Error(`bad placement ${JSON.stringify(p)}`);
  const ps = placements.map((p) => ({ player: getAddress(p.player), place: p.place }));
  const domain = { name: 'ArenaEscrow', version: '1', chainId: ctx.net.chain.id, verifyingContract: esc };
  const types = { Settlement: [{ name: 'roundId', type: 'bytes32' }, { name: 'seed', type: 'bytes32' }, { name: 'placements', type: 'Placement[]' }], Placement: [{ name: 'player', type: 'address' }, { name: 'place', type: 'uint8' }] };
  const message = { roundId, seed: rec.seed, placements: ps };
  // The contract's own digest must be what we sign; if the two disagree nothing is submitted.
  const local = hashTypedData({ domain, types, primaryType: 'Settlement', message });
  const onchain = await readEscrow(ctx.pub, 'settlementDigest', [roundId, rec.seed, ps]);
  if (local !== onchain) throw new Error(`digest mismatch: local ${local} chain ${onchain}`);
  const signature = await signerCtx.wallet.signTypedData({ account: signerCtx.account, domain, types, primaryType: 'Settlement', message });
  console.log(`settle ${roundId}: ${ps.map((p) => `${p.player}#${p.place}`).join(' ')} signed by ${signerCtx.account.address}, submitted by operator ${ctx.account.address}`);
  const before = Object.fromEntries(await Promise.all(ps.map(async (p) => [p.player, await readEscrow(ctx.pub, 'claimable', [p.player])])));
  const data = encodeFunctionData({ abi, functionName: 'settleRound', args: [roundId, ps, rec.seed, signature] });
  if (useMemo) {
    // Stamped through Arc's Memo predeploy: the call runs from the operator (callFrom keeps the
    // sender) and the explorer shows a Memo event carrying the roundId.
    const r = await send(ctx, 'settleRound via Memo', { address: MEMO, abi: MEMO_ABI, functionName: 'memo', args: [esc, data, roundId, toHex(`hh-arc settle ${rec.label || ''}`.trim())] });
    // The predeploy emits BeforeMemo then Memo; decode the Memo one and report its index.
    const memoEvent = MEMO_ABI.find((x) => x.type === 'event' && x.name === 'Memo');
    let stamped = null;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== MEMO.toLowerCase()) continue;
      try { const d = decodeEventLog({ abi: [memoEvent], data: l.data, topics: l.topics }); stamped = d.args; } catch { /* BeforeMemo or another shape */ }
    }
    console.log(stamped ? `  memo event: index ${stamped.memoIndex}, memoId ${stamped.memoId}, sender ${stamped.sender}, target ${stamped.target}` : '  memo event: MISSING');
  } else {
    await send(ctx, 'settleRound', { address: esc, abi, functionName: 'settleRound', args: [roundId, ps, rec.seed, signature] });
  }
  for (const p of ps) {
    const now = await readEscrow(ctx.pub, 'claimable', [p.player]);
    console.log(`  ${p.player} place ${p.place}: claimable ${usdcFmt(before[p.player])} -> ${usdcFmt(now)}`);
  }
  console.log(`  pool ${usdcFmt(await usdcBalance(ctx.pub, esc))}, owed ${usdcFmt(await readEscrow(ctx.pub, 'totalClaimable'))}, free ${usdcFmt(await readEscrow(ctx.pub, 'freePool'))}`);
}

export async function withdraw() {
  const ctx = clients('player');
  const esc = escrowAddress();
  const owed = await readEscrow(ctx.pub, 'claimable', [ctx.account.address]);
  console.log(`withdraw as player ${ctx.account.address}: claimable ${usdcFmt(owed)}, wallet ${usdcFmt(await usdcBalance(ctx.pub, ctx.account.address))}`);
  await send(ctx, 'withdraw', { address: esc, abi: escrowArtifact().abi, functionName: 'withdraw', args: [] });
  console.log(`  wallet after: ${usdcFmt(await usdcBalance(ctx.pub, ctx.account.address))}; claimable ${usdcFmt(await readEscrow(ctx.pub, 'claimable', [ctx.account.address]))}`);
}

export async function status(roundId) {
  const { net, pub } = clients();
  const esc = escrowAddress();
  const [entry, tiers, capRound, capPlayer, window, owed, free, operator, signer, owner, paused] = await Promise.all(
    ['entryAmount', 'tiers', 'maxPayoutPerRound', 'maxPayoutPerPlayerPerWindow', 'windowBlocks', 'totalClaimable', 'freePool', 'operator', 'signer', 'owner', 'paused'].map((f) => readEscrow(pub, f)),
  );
  console.log(`escrow ${esc} on ${net.name} ${explorerAddr(net, esc)}`);
  console.log(`  owner ${owner} operator ${operator} signer ${signer} paused=${paused}`);
  console.log(`  entry ${usdcFmt(entry)}; tiers ${tiers.map(usdcFmt).join(', ')}; cap/round ${usdcFmt(capRound)}; cap/player/window ${usdcFmt(capPlayer)} over ${window} blocks`);
  console.log(`  pool ${usdcFmt(await usdcBalance(pub, esc))}; owed ${usdcFmt(owed)}; free ${usdcFmt(free)}`);
  for (const role of ['owner', 'operator', 'signer', 'player']) {
    const key = process.env[`${role.toUpperCase()}_KEY`];
    if (!key) continue;
    const a = privateKeyToAccount(key).address;
    console.log(`  ${role.padEnd(8)} ${a} wallet ${usdcFmt(await usdcBalance(pub, a))} claimable ${usdcFmt(await readEscrow(pub, 'claimable', [a]))}`);
  }
  if (roundId) {
    const [commit, openedAt, settled, entrants] = await readEscrow(pub, 'rounds', [roundId]);
    console.log(`  round ${roundId}: commit ${commit} openedAtBlock ${openedAt} settled=${settled} entrants=${entrants}`);
  }
}

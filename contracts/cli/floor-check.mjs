// Arc drops any transaction whose maxFeePerGas is under 20 Gwei, silently on the real network.
// Two checks: the harness never produces such a transaction, and the node in front of us
// refuses or never mines one. Against arc-anvil the refusal is an RPC error; against testnet
// it is silence, so the second check waits for a receipt and reports its absence.
import { createPublicClient, createWalletClient, http, parseGwei, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { fees, FEE_FLOOR, network, clients } from './lib.mjs';

const isLocal = (process.env.ARC_NETWORK || 'local') === 'local';
const net = isLocal ? { name: 'local', chain: foundry, url: process.env.ARC_RPC_URL || 'http://127.0.0.1:8545' } : network();
const pub = createPublicClient({ chain: net.chain, transport: http(net.url) });

const f = await fees(pub);
if (f.maxFeePerGas < FEE_FLOOR) { console.error('[floor] harness fee rule broken'); process.exit(1); }
console.log(`[floor] harness maxFeePerGas ${formatUnits(f.maxFeePerGas, 9)} gwei (floor 20) on ${net.name}`);

// a throwaway sender: arc-anvil's ninth default account locally, PLAYER_KEY elsewhere
const key = isLocal ? '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97' : process.env.PLAYER_KEY;
if (!key) { console.log('[floor] no key for the live check; harness rule verified only'); process.exit(0); }
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.url) });
try {
  const hash = await wallet.sendTransaction({ account, to: account.address, value: 0n, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('1') });
  try {
    await pub.waitForTransactionReceipt({ hash, timeout: 8000 });
    console.error(`[floor] a 1 gwei transaction was mined (${hash}); this node does not enforce the Arc floor`);
    process.exit(1);
  } catch {
    console.log(`[floor] 1 gwei transaction accepted by the RPC but never mined within 8s (${hash}): the silent drop, as documented`);
  }
} catch (e) {
  console.log(`[floor] 1 gwei transaction refused by the node: ${String(e.shortMessage || e.message).split('\n')[0]}`);
}
if (isLocal) void clients;

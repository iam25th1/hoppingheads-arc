// Arc drops any transaction whose maxFeePerGas is under 20 Gwei. Measured on testnet: the RPC
// accepts the raw transaction and returns a hash, it never mines, and the sender's pending
// nonce stays advanced until a replacement at the same nonce with a proper fee lands. A
// client that pre-flights with eth_estimateGas (viem's writeContract does) sees an error
// instead, so a worker that signs and submits raw would see nothing at all. arc-anvil refuses
// at submission. Three checks: the harness never produces such a transaction; what this
// node does with one, sent raw; and that the account is left clean.
import { createPublicClient, http, parseGwei, formatUnits } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { fees, FEE_FLOOR, network } from './lib.mjs';

const isLocal = (process.env.ARC_NETWORK || 'local') === 'local';
const net = isLocal ? { name: 'local', chain: foundry, url: process.env.ARC_RPC_URL || 'http://127.0.0.1:8545' } : network();
const pub = createPublicClient({ chain: net.chain, transport: http(net.url) });

const f = await fees(pub);
if (f.maxFeePerGas < FEE_FLOOR) { console.error('[floor] harness fee rule broken'); process.exit(1); }
console.log(`[floor] harness maxFeePerGas ${formatUnits(f.maxFeePerGas, 9)} gwei (floor 20) on ${net.name}`);

// A throwaway sender: locally, arc-anvil's tenth default account, derived from Foundry's
// published test mnemonic so no key sits in the repo; elsewhere, PLAYER_KEY.
const account = isLocal
  ? mnemonicToAccount('test test test test test test test test test test test junk', { accountIndex: 9 })
  : process.env.PLAYER_KEY ? privateKeyToAccount(process.env.PLAYER_KEY) : null;
if (!account) { console.log('[floor] no key for the live check; harness rule verified only'); process.exit(0); }

const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
const tx = { chainId: net.chain.id, nonce, to: account.address, value: 0n, gas: 21000n, maxPriorityFeePerGas: parseGwei('1'), type: 'eip1559' };
const raw = await account.signTransaction({ ...tx, maxFeePerGas: parseGwei('1') });
let hash = null;
try {
  hash = await pub.request({ method: 'eth_sendRawTransaction', params: [raw] });
} catch (e) {
  console.log(`[floor] 1 gwei transaction refused at submission: ${String(e.shortMessage || e.message).split('\n')[0]}`);
}
if (hash) {
  await new Promise((r) => setTimeout(r, 8000));
  const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt) { console.error(`[floor] a 1 gwei transaction was mined (${hash}); this node does not enforce the Arc floor`); process.exit(1); }
  const pending = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  console.log(`[floor] 1 gwei transaction accepted (${hash}) and not mined in 8s: the silent drop. pending nonce ${pending} vs sent ${nonce}${pending > nonce ? ': it is still queued and would block the next one' : ''}`);
  // Leave the account clean: replacements with a proper fee for every nonce still queued,
  // from the last mined one up, since a queued nonce blocks everything behind it. The tip is
  // doubled so the replacement outbids the queued transaction under any bump rule.
  // Mining one replacement can release proper fee transactions queued behind it, so the last
  // mined nonce is re-read before each step and a nonce that has meanwhile mined is skipped.
  for (;;) {
    const latest = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' });
    if (latest >= pending) break;
    const clean = await account.signTransaction({ ...tx, nonce: latest, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: parseGwei('2') });
    try {
      const h2 = await pub.request({ method: 'eth_sendRawTransaction', params: [clean] });
      const r2 = await pub.waitForTransactionReceipt({ hash: h2, timeout: 60000 });
      console.log(`[floor] replacement at nonce ${latest} with ${formatUnits(f.maxFeePerGas, 9)} gwei: ${r2.status}`);
    } catch (e) {
      if (!/nonce too low/i.test(String(e.details || e.message))) throw e;
    }
  }
  const [l, p] = await Promise.all([pub.getTransactionCount({ address: account.address, blockTag: 'latest' }), pub.getTransactionCount({ address: account.address, blockTag: 'pending' })]);
  console.log(`[floor] nonce latest ${l} pending ${p}${l === p ? ' (clean)' : ' (STILL QUEUED)'}`);
  if (l !== p) process.exit(1);
}

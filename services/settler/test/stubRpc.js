// A stand in for Arc's RPC and mempool, as measured on testnet in phase 3: a transaction
// under the fee floor is accepted (a hash comes back), never mined, and it advances the
// account's pending nonce so everything behind it queues; a proper fee transaction at a
// nonce at or above the last mined one mines; a nonce below it is refused "nonce too low".
import { keccak256, parseTransaction, parseGwei } from 'viem';

export function createStubRpc({ floor = parseGwei('20'), baseFee = parseGwei('20'), mineAfterPolls = 0 } = {}) {
  const st = { latest: 0, pending: 0, txs: new Map(), block: 100n, sent: [], revertNext: false, polls: new Map() };
  const rpc = {
    async getTransactionCount(_address, tag) { return tag === 'pending' ? st.pending : st.latest; },
    async getBlock() { return { baseFeePerGas: baseFee, number: st.block }; },
    async estimateGas() { return 100000n; },
    async sendRaw(raw) {
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      st.sent.push({ hash, nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
      if (tx.nonce < st.latest) throw new Error('nonce too low: next nonce ' + st.latest + ', tx nonce ' + tx.nonce);
      const under = tx.maxFeePerGas < floor;
      st.txs.set(hash, { nonce: tx.nonce, under, mined: false, reverted: false, pollsLeft: under ? Infinity : mineAfterPolls });
      st.pending = Math.max(st.pending, tx.nonce + 1);
      if (!under && mineAfterPolls === 0) mine(hash);
      return hash;
    },
    async getReceipt(hash) {
      const t = st.txs.get(hash);
      if (!t) return null;
      if (!t.mined && Number.isFinite(t.pollsLeft)) { t.pollsLeft--; if (t.pollsLeft <= 0) mine(hash); }
      if (!t.mined) return null;
      return { status: t.reverted ? 'reverted' : 'success', blockNumber: st.block, gasUsed: 90000n, effectiveGasPrice: baseFee + parseGwei('1'), logs: [] };
    },
  };
  function mine(hash) {
    const t = st.txs.get(hash);
    if (t.mined || t.nonce !== st.latest) return; // only the next nonce can mine
    t.mined = true; t.reverted = st.revertNext; st.revertNext = false;
    st.latest = t.nonce + 1; st.pending = Math.max(st.pending, st.latest); st.block += 1n;
    // anything else at that nonce is superseded
    for (const [h, o] of st.txs) if (h !== hash && o.nonce === t.nonce) o.superseded = true;
  }
  /** Pretend an earlier raw signing bug left a stalled transaction at the next nonce. */
  rpc.seedStall = () => { st.txs.set('0xstall', { nonce: st.latest, under: true, mined: false, pollsLeft: Infinity }); st.pending = st.latest + 1; };
  rpc.state = st;
  return rpc;
}

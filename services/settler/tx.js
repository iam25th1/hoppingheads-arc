/**
 * Nonce discipline.
 *
 * Arc's mempool drops a transaction whose maxFeePerGas is under 20 gwei with
 * no error, no receipt, and the sender's pending nonce left advanced, so
 * every later transaction from that account queues unmined behind it. A
 * worker that trusts the pending nonce, or that does not wait for receipts,
 * goes blind. This sender:
 *
 *   - takes its nonce from the last MINED transaction, never from the pending
 *     count, so a stalled transaction is replaced instead of queued behind;
 *   - reports a stall it finds (pending above latest) as an ALERT;
 *   - sets maxFeePerGas explicitly on every transaction and never under the
 *     floor, and signs and submits raw so nothing pre-flights on its behalf;
 *   - waits for the receipt with a deadline, and on timeout replaces at the
 *     same nonce with a higher fee, up to maxAttempts;
 *   - after that raises StallError; a revert raises RevertError at once.
 *
 * `rpc` is a small interface (see rpcFrom in chain.js) so the whole thing is
 * tested against a stub that behaves like Arc's mempool.
 */
import { parseGwei, formatUnits } from "viem";

export const FEE_FLOOR = parseGwei("20");

export class StallError extends Error {}
export class RevertError extends Error {}

/** Twice the base fee plus a tip, bumped a quarter per attempt, never under the floor. */
export function defaultFeeRule(base, attempt) {
  const maxPriorityFeePerGas = parseGwei("1") * BigInt(attempt);
  let maxFeePerGas = ((base * 2n + maxPriorityFeePerGas) * BigInt(100 + 25 * (attempt - 1))) / 100n;
  if (maxFeePerGas < FEE_FLOOR) maxFeePerGas = FEE_FLOOR;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

export function createSender({ rpc, account, chainId, deadlineMs = 90_000, maxAttempts = 3, feeRule = defaultFeeRule, pollMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  const gwei = (v) => `${formatUnits(v, 9)} gwei`;

  async function receiptWithin(hashes, ms) {
    const until = Date.now() + ms;
    for (;;) {
      for (const h of hashes) { const r = await rpc.getReceipt(h); if (r) return { hash: h, receipt: r }; }
      if (Date.now() >= until) return null;
      await sleep(pollMs);
    }
  }

  /** @returns {{ hash, receipt, nonce, attempts }} */
  async function send({ to, data, label }) {
    const latest = await rpc.getTransactionCount(account.address, "latest");
    const pending = await rpc.getTransactionCount(account.address, "pending");
    if (pending > latest) log.warn(`[Settler] ALERT stall detected on ${account.address}: nonce ${latest} accepted but unmined (pending ${pending}); replacing it with ${label}`);
    const nonce = latest;
    const gas = ((await rpc.estimateGas({ account: account.address, to, data })) * 12n) / 10n;
    const hashes = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const base = (await rpc.getBlock()).baseFeePerGas ?? 0n;
      const fee = feeRule(base, attempt);
      if (fee.maxFeePerGas < FEE_FLOOR) throw new Error(`fee rule produced ${gwei(fee.maxFeePerGas)}, under the floor`);
      const raw = await account.signTransaction({ chainId, nonce, to, data, gas, value: 0n, type: "eip1559", maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
      let hash;
      try {
        hash = await rpc.sendRaw(raw);
      } catch (e) {
        // The previous attempt may have mined between the deadline and this send.
        if (/nonce too low/i.test(String(e.message)) && hashes.length) {
          const late = await receiptWithin(hashes, pollMs * 4);
          if (late) return finish(late, nonce, attempt - 1);
        }
        throw e;
      }
      hashes.push(hash);
      log.info(`[Settler] ${label} nonce ${nonce} attempt ${attempt} maxFeePerGas ${gwei(fee.maxFeePerGas)} sent ${hash}`);
      const got = await receiptWithin(hashes, deadlineMs);
      if (got) return finish(got, nonce, attempt);
      log.warn(`[Settler] ALERT ${label} nonce ${nonce} not mined within ${deadlineMs}ms (${hash}); replacing at the same nonce with a higher fee`);
    }
    throw new StallError(`${label} nonce ${nonce} unmined after ${maxAttempts} attempts: ${hashes.join(", ")}`);
  }

  function finish({ hash, receipt }, nonce, attempts) {
    if (receipt.status !== "success") throw new RevertError(`reverted in ${hash}`);
    return { hash, receipt, nonce, attempts };
  }

  return { send };
}

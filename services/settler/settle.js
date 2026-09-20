/**
 * Opening and settling rounds. The pure parts (who gets placed, what they
 * are paid) are exported for tests; processRound runs one round through
 * whatever state it is in, idempotent per roundId: the chain is asked
 * before anything is sent.
 */
import { encodeOpen, encodeSettle, encodeMemo, settlementDigest, recoverSigner, memoIndexFrom } from "./chain.js";
import { StallError, RevertError } from "./tx.js";

const HUMAN = /^0x[0-9a-f]{40}$/;

/**
 * The placements a settlement names: human seats (address shaped), in the
 * round's placement order, keeping only the addresses the chain says entered.
 * Placement numbers are the round's, not renumbered.
 */
export function buildPlacements(rows, enteredSet) {
  return rows
    .filter((r) => !r.is_bot && HUMAN.test(String(r.participant)) && enteredSet.has(r.participant.toLowerCase()))
    .sort((a, b) => a.placement - b.placement)
    .map((r) => ({ player: r.participant, place: r.placement }));
}

/** What the tier table credits each placement, USDC units; 0 beyond the table. */
export function payoutsFor(placements, tiers) {
  const out = new Map();
  for (const p of placements) out.set(p.player.toLowerCase(), p.place <= tiers.length ? BigInt(tiers[p.place - 1]) : 0n);
  return out;
}

export async function askSigner(cfg, value) {
  const r = await fetch(`${cfg.signerUrl}/sign`, { method: "POST", headers: { "content-type": "application/json", "x-signer-token": cfg.signerToken }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`signer answered ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

/**
 * One round, one step. deps: { cfg, db (query), chain (createChain), sender (createSender), log }.
 * Returns what it did, for the loop's log.
 */
export async function processRound(deps, row) {
  const { cfg, db, chain, sender, log } = deps;
  const roundId = row.onchain_round_id;
  const attempt = async (fn) => {
    try { return await fn(); } catch (e) {
      const dead = e instanceof RevertError || row.chain_attempts + 1 >= cfg.maxAttempts;
      const status = e instanceof StallError ? "stalled" : dead ? "dead" : row.chain_status;
      await db(`UPDATE rounds SET chain_attempts = chain_attempts + 1, chain_error = $2, chain_status = $3 WHERE id = $1`, [row.id, String(e.message).slice(0, 500), status]);
      log.error(`[Settler] ${status === "dead" ? "ALERT dead letter" : status === "stalled" ? "ALERT stalled" : "retry later"} round ${row.id} ${roundId}: ${e.message}`);
      return { status, error: e.message };
    }
  };

  // ---- open ----
  if (row.chain_status === "open_requested" || (row.chain_status === "stalled" && !row.open_tx_hash)) {
    return attempt(async () => {
      const state = await chain.read("rounds", [roundId]);
      if (state[0] !== "0x" + "0".repeat(64)) {
        await db(`UPDATE rounds SET chain_status = 'open', chain_error = NULL WHERE id = $1`, [row.id]);
        return { status: "open", note: "already open on chain" };
      }
      const { hash, receipt, nonce, attempts } = await sender.send({ to: cfg.escrow, data: encodeOpen(roundId, row.seed_commit), label: `openRound ${roundId.slice(0, 10)}` });
      await db(`UPDATE rounds SET chain_status = 'open', open_tx_hash = $2, chain_error = NULL WHERE id = $1`, [row.id, hash]);
      log.info(`[Settler] opened round ${row.id} ${roundId} in ${hash} (block ${receipt.blockNumber}, nonce ${nonce}, attempts ${attempts})`);
      return { status: "open", hash };
    });
  }

  // ---- settle ----
  if ((row.chain_status === "open" || row.chain_status === "settling" || row.chain_status === "stalled") && (row.status === "completed" || row.status === "abandoned")) {
    return attempt(async () => {
      const state = await chain.read("rounds", [roundId]);
      if (state[2] === true) {
        await db(`UPDATE rounds SET chain_status = 'settled', chain_error = NULL WHERE id = $1`, [row.id]);
        return { status: "settled", note: "already settled on chain" };
      }
      await db(`UPDATE rounds SET chain_status = 'settling' WHERE id = $1`, [row.id]);
      const results = (await db(`SELECT participant, is_bot, placement FROM round_results WHERE round_id = $1 ORDER BY placement`, [row.id])).rows;
      const humans = results.filter((r) => !r.is_bot && HUMAN.test(String(r.participant)));
      const entered = new Set();
      for (const h of humans) if (await chain.read("entered", [roundId, h.participant])) entered.add(h.participant.toLowerCase());
      const placements = buildPlacements(results, entered);
      const tiers = (await chain.read("tiers")).map((t) => t.toString());
      const payouts = payoutsFor(placements, tiers);
      const value = { roundId, seed: row.seed, placements };
      const signed = await askSigner(cfg, value);
      const expectSigner = await chain.read("signer");
      // A signature that cannot be recovered, or recovers to anyone but the escrow's signer,
      // is deterministic: dead at once, nothing sent.
      let recovered;
      try { recovered = await recoverSigner(cfg.chainId, cfg.escrow, value, signed.signature); } catch (e) { throw new RevertError(`signature unrecoverable: ${e.message}`); }
      if (recovered.toLowerCase() !== expectSigner.toLowerCase()) throw new RevertError(`signature recovers to ${recovered}, escrow signer is ${expectSigner}`);
      const localDigest = settlementDigest(cfg.chainId, cfg.escrow, value);
      const chainDigest = await chain.read("settlementDigest", [roundId, row.seed, placements]);
      if (localDigest !== chainDigest || signed.digest !== chainDigest) throw new RevertError(`digest mismatch: local ${localDigest} signer ${signed.digest} chain ${chainDigest}`);
      const data = encodeSettle(roundId, placements, row.seed, signed.signature);
      const viaMemo = cfg.useMemo;
      const tx = viaMemo ? { to: cfg.memo, data: encodeMemo(cfg.escrow, data, roundId, `hh-arc settle round ${row.id}`) } : { to: cfg.escrow, data };
      const { hash, receipt, nonce, attempts } = await sender.send({ ...tx, label: `settleRound ${roundId.slice(0, 10)}${viaMemo ? " via Memo" : ""}` });
      const memoIndex = viaMemo ? memoIndexFrom(receipt, cfg.memo) : null;
      const record = { roundId, seed: row.seed, seedCommit: row.seed_commit, digest: chainDigest, signer: recovered, signature: signed.signature, placements, payouts: Object.fromEntries([...payouts].map(([k, v]) => [k, v.toString()])), tiers, txHash: hash, block: receipt.blockNumber.toString(), nonce, attempts, memoIndex, settledAt: new Date().toISOString() };
      await db(`UPDATE rounds SET chain_status = 'settled', tx_hash = $2, settled_block = $3, settlement = $4, chain_error = NULL WHERE id = $1`, [row.id, hash, receipt.blockNumber.toString(), JSON.stringify(record)]);
      for (const h of humans) {
        const units = entered.has(h.participant.toLowerCase()) ? (payouts.get(h.participant.toLowerCase()) ?? 0n).toString() : null;
        await db(`UPDATE round_results SET payout_units = $3 WHERE round_id = $1 AND participant = $2`, [row.id, h.participant, units]);
      }
      log.info(`[Settler] settled round ${row.id} ${roundId} in ${hash} (block ${receipt.blockNumber}, ${placements.length} placements, memo ${memoIndex ?? "none"}, nonce ${nonce}, attempts ${attempts})`);
      return { status: "settled", hash, placements: placements.length, memoIndex };
    });
  }
  return { status: row.chain_status, note: "nothing to do" };
}

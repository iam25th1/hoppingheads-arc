/**
 * hh-arc-settler: opens stakeable rounds at the escrow when the game server
 * issues them, settles them when they complete, and leaves an auditable
 * record per round. Its own process, its own Pier service, the operator key
 * and nothing else (signatures come from hh-arc-signer over loopback).
 *
 * Every transaction goes through tx.js: explicit fee never under the floor,
 * nonce from the last mined transaction, receipt awaited with a deadline,
 * replacement at the same nonce on timeout, dead letter after repeated
 * failure, ALERT lines on stalls. One nonce stream, so rounds are processed
 * one at a time.
 */
import pg from "pg";
import { loadConfig } from "./config.js";
import { createChain } from "./chain.js";
import { createSender } from "./tx.js";
import { processRound } from "./settle.js";

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
const db = (text, params) => pool.query(text, params);

// One worker per database. Two workers would share one operator nonce stream and race on
// the same rounds (one of them may even be pointed at another chain). The lock is held on a
// dedicated connection for the life of the process and released by Postgres if it dies.
const lockClient = await pool.connect();
const lock = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('hh-arc-settler')) AS ok");
if (!lock.rows[0].ok) { console.error('[Settler] another settlement worker holds the lock on this database; refusing to start'); process.exit(1); }
const chain = createChain(cfg);
const sender = createSender({ rpc: chain.rpc, account: chain.account, chainId: cfg.chainId, deadlineMs: cfg.receiptDeadlineMs, maxAttempts: cfg.maxAttempts });
const log = console;
const deps = { cfg, db, chain, sender, log };

const PICK = `SELECT id, status, chain_status, onchain_round_id, seed, seed_commit, open_tx_hash, chain_attempts
                FROM rounds
               WHERE stakeable AND onchain_round_id IS NOT NULL
                 AND (chain_status IN ('open_requested', 'settling', 'stalled')
                      OR (chain_status = 'open' AND status IN ('completed', 'abandoned')))
               ORDER BY id LIMIT 5`;

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const { rows } = await db(PICK);
    for (const row of rows) {
      const out = await processRound(deps, row);
      if (out.status !== row.chain_status || out.hash) log.info(`[Settler] round ${row.id}: ${row.chain_status} -> ${out.status}${out.note ? " (" + out.note + ")" : ""}`);
    }
  } catch (e) {
    log.error(`[Settler] tick failed: ${e.message}`);
  } finally { busy = false; }
}

log.info(`[Settler] operator ${chain.account.address} for ${cfg.escrow} on chain ${cfg.chainId} via ${cfg.rpcUrl}; signer at ${cfg.signerUrl}; memo ${cfg.useMemo ? "on" : "off"}`);
const stallCheck = async () => {
  try {
    const [latest, pending] = await Promise.all([chain.rpc.getTransactionCount(chain.account.address, "latest"), chain.rpc.getTransactionCount(chain.account.address, "pending")]);
    if (pending > latest) log.warn(`[Settler] ALERT operator nonce ${latest} has an unmined transaction queued (pending ${pending}); the next send replaces it`);
  } catch (e) { log.warn(`[Settler] nonce check failed: ${e.message}`); }
};
await stallCheck();
setInterval(tick, cfg.pollMs);
setInterval(stallCheck, 60_000);
tick();

import { Router } from "express";
import { query } from "../db/pool.js";
import { verifySessionToken, shortAddress } from "../utils/walletAuth.js";
import { isHumanId } from "../game/ids.js";
import { issueRound } from "../game/rounds.js";
import { SOLO_MODES } from "../game/modes.js";
import { registerSoloRound, respawnSoloRound } from "../game/soloRounds.js";

const SOLO_MODE_SET = new Set(SOLO_MODES);

const router = Router();

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

// ---------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------

// Top scores (all time)
router.get("/leaderboard", async (req, res) => {
  try {
    const result = await query(
      `SELECT address, total_score, total_wins, total_rounds, total_minted, best_score
       FROM player_stats ORDER BY total_score DESC LIMIT 20`
    );
    res.json({ players: result.rows.map((r) => ({ ...r, player_name: shortAddress(r.address) })) });
  } catch (err) {
    console.error("[API] Leaderboard error:", err.message);
    res.json({ players: [] });
  }
});

// Recent matches
router.get("/leaderboard/recent", async (req, res) => {
  try {
    const result = await query(
      `SELECT rr.participant, rr.is_bot, rr.score, rr.minted, rr.fragments, rr.placement,
              r.map_index, r.mode, r.seed, rr.created_at AS played_at
       FROM round_results rr JOIN rounds r ON r.id = rr.round_id
       ORDER BY rr.created_at DESC LIMIT 30`
    );
    res.json({ matches: result.rows.map((r) => ({ ...r, player_name: isHumanId(r.participant) ? shortAddress(r.participant) : r.participant })) });
  } catch (err) {
    console.error("[API] Recent matches error:", err.message);
    res.json({ matches: [] });
  }
});

// ---------------------------------------------------------------
// Solo rounds: the seed comes from the server, same path as a lobby
// ---------------------------------------------------------------

// POST /api/round/start { mode, mapIndex } -> { id, seed, mapIndex, mode }
// A signed in player gets a rounds row (issued_to = address) that /score
// later closes. A guest gets a seed with no row and cannot score.
router.post("/round/start", async (req, res) => {
  const mode = req.body?.mode;
  if (!SOLO_MODE_SET.has(mode)) return res.status(400).json({ error: "Invalid mode" });
  const address = verifySessionToken(req.get("x-session") || req.body?.session);
  try {
    const round = await issueRound({ mode, mapIndex: req.body?.mapIndex, issuedTo: address, persist: !!address });
    // The server keeps this round's layout stream; the client never places a
    // fragment itself. The key is what the client presents to advance it.
    const key = registerSoloRound(round);
    res.json({ ...round, key });
  } catch (err) {
    if (err.message === "solo_rounds_full") return res.status(429).json({ error: "Too many open rounds, try again shortly" });
    console.error("[API] Round start error:", err.message);
    res.status(500).json({ error: "Failed to start round" });
  }
});

// POST /api/round/respawn { key, rarity } -> { rarity, fragments: [{id, rarity, x, z}] }
// A solo mint respawns that rarity. The positions come from the server's
// copy of the round's layout stream, the same call a lobby makes before it
// broadcasts frag:respawn.
router.post("/round/respawn", (req, res) => {
  const moved = respawnSoloRound(req.body?.key, req.body?.rarity);
  if (!moved) return res.status(404).json({ error: "Unknown round or rarity" });
  res.json({ rarity: req.body.rarity, fragments: moved });
});

// ---------------------------------------------------------------
// Classic mode score submission
// ---------------------------------------------------------------

router.post("/score", async (req, res) => {
  try {
    // Identity comes from the wallet session, never from the payload
    const address = verifySessionToken(req.get("x-session") || req.body?.session);
    if (!address) {
      return res.status(401).json({ error: "Sign in with a wallet to submit a score" });
    }
    const { round_id, score, minted, fragments } = req.body;
    if (!Number.isInteger(round_id) || typeof score !== "number") {
      return res.status(400).json({ error: "Invalid score data" });
    }

    // The round must have been issued to this address by /round/start and
    // still be open. Its seed and map are already on the row.
    const found = await query("SELECT mode, issued_to, status FROM rounds WHERE id = $1", [round_id]);
    const round = found.rows[0];
    if (!round) return res.status(404).json({ error: "Unknown round" });
    if (round.issued_to !== address) return res.status(403).json({ error: "Round was not issued to this wallet" });
    if (round.mode !== "sandbox-classic-solo") return res.status(400).json({ error: "This round mode does not score" });
    if (round.status !== "active") return res.status(409).json({ error: "Round already closed" });

    const safeScore = Math.max(0, Math.min(99999, Math.floor(score)));
    const safeMinted = Math.max(0, Math.min(50, Math.floor(minted || 0)));
    const safeFrags = Math.max(0, Math.min(999, Math.floor(fragments || 0)));

    // Close the round. The status guard makes this atomic: two submissions
    // racing for the same round get exactly one row through.
    const closed = await query(
      `UPDATE rounds SET status = 'completed', end_time = NOW(), winner = $2
       WHERE id = $1 AND status = 'active' RETURNING id`,
      [round_id, address]
    );
    if (closed.rows.length === 0) return res.status(409).json({ error: "Round already closed" });
    await query(
      `INSERT INTO round_results (round_id, participant, is_bot, score, minted, fragments, placement)
       VALUES ($1, $2, false, $3, $4, $5, 1)`,
      [round_id, address, safeScore, safeMinted, safeFrags]
    );

    // Upsert player_stats (cumulative), keyed by the full address
    await query(
      `INSERT INTO player_stats (address, total_score, total_wins, total_rounds, total_minted, best_score)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (address) DO UPDATE SET
         total_score = player_stats.total_score + $2,
         total_wins = player_stats.total_wins + $3,
         total_rounds = player_stats.total_rounds + 1,
         total_minted = player_stats.total_minted + $4,
         best_score = GREATEST(player_stats.best_score, $5)`,
      [address, safeScore, safeScore >= 300 ? 1 : 0, safeMinted, safeScore]
    );

    res.json({ ok: true, round_id });
  } catch (err) {
    console.error("[API] Score submit error:", err.message);
    res.status(500).json({ error: "Failed to save score" });
  }
});

export default router;

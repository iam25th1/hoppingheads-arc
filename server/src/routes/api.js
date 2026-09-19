import { Router } from "express";
import { query } from "../db/pool.js";
import { verifySessionToken, shortAddress } from "../utils/walletAuth.js";

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
      `SELECT player_name, total_score, total_wins, total_rounds, total_minted, best_score
       FROM player_stats ORDER BY total_score DESC LIMIT 20`
    );
    res.json({ players: result.rows });
  } catch (err) {
    console.error("[API] Leaderboard error:", err.message);
    res.json({ players: [] });
  }
});

// Recent matches
router.get("/leaderboard/recent", async (req, res) => {
  try {
    const result = await query(
      `SELECT player_name, score, minted, fragments, placement, map_index, played_at
       FROM leaderboard ORDER BY played_at DESC LIMIT 30`
    );
    res.json({ matches: result.rows });
  } catch (err) {
    console.error("[API] Recent matches error:", err.message);
    res.json({ matches: [] });
  }
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
    const { score, minted, fragments, map_index } = req.body;
    if (typeof score !== "number") {
      return res.status(400).json({ error: "Invalid score data" });
    }
    const safeName = shortAddress(address);
    const safeScore = Math.max(0, Math.min(99999, Math.floor(score)));
    const safeMinted = Math.max(0, Math.min(50, Math.floor(minted || 0)));
    const safeFrags = Math.max(0, Math.min(999, Math.floor(fragments || 0)));
    const safeMap = Math.max(0, Math.min(5, Math.floor(map_index || 0)));

    // Insert into leaderboard (match history)
    await query(
      `INSERT INTO leaderboard (player_name, score, minted, fragments, placement, map_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [safeName, safeScore, safeMinted, safeFrags, 1, safeMap]
    );

    // Upsert player_stats (cumulative)
    await query(
      `INSERT INTO player_stats (player_name, total_score, total_wins, total_rounds, total_minted, best_score)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (player_name) DO UPDATE SET
         total_score = player_stats.total_score + $2,
         total_wins = player_stats.total_wins + $3,
         total_rounds = player_stats.total_rounds + 1,
         total_minted = player_stats.total_minted + $4,
         best_score = GREATEST(player_stats.best_score, $5)`,
      [safeName, safeScore, safeScore >= 300 ? 1 : 0, safeMinted, safeScore]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[API] Score submit error:", err.message);
    res.status(500).json({ error: "Failed to save score" });
  }
});

export default router;

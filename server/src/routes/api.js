import { Router } from "express";
import { ethers } from "ethers";
import { generateNonce, verifySignature, authMiddleware } from "../utils/auth.js";
import { query } from "../db/pool.js";
import { createRound as createRoundInMemory } from "../game/roundManager.js";
import { createRoundOnchain } from "../services/contractService.js";
import { THEME_KEYS } from "../game/mapGenerator.js";

const router = Router();

// Health check for Railway
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
    const { player_name, score, minted, fragments, map_index } = req.body;
    if (!player_name || typeof score !== "number") {
      return res.status(400).json({ error: "Invalid score data" });
    }
    const safeName = String(player_name).slice(0, 16).replace(/[^a-zA-Z0-9@_\- ]/g, "");
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

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------

router.post("/auth/nonce", (req, res) => {
  const { wallet } = req.body;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }
  const { nonce, message } = generateNonce(wallet);
  res.json({ nonce, message });
});

router.post("/auth/verify", async (req, res) => {
  const { wallet, signature } = req.body;
  if (!wallet || !signature) {
    return res.status(400).json({ error: "Missing wallet or signature" });
  }
  try {
    const result = verifySignature(wallet, signature);

    // Upsert player record
    await query(
      `INSERT INTO players (wallet) VALUES ($1)
       ON CONFLICT (wallet) DO NOTHING`,
      [result.wallet]
    );

    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Lobbies / Rounds
// ---------------------------------------------------------------

router.get("/rounds/open", async (_req, res) => {
  const result = await query(
    `SELECT id, theme, status, entry_fee_wei, max_players, duration_secs,
            (SELECT COUNT(*) FROM round_players WHERE round_id = rounds.id) as player_count
     FROM rounds
     WHERE status IN ('pending', 'lobby')
     ORDER BY created_at DESC
     LIMIT 20`
  );
  res.json({ rounds: result.rows });
});

router.get("/rounds/:id", async (req, res) => {
  const { id } = req.params;
  const result = await query("SELECT * FROM rounds WHERE id = $1", [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Round not found" });
  }

  const players = await query(
    "SELECT wallet, score, placement FROM round_players WHERE round_id = $1 ORDER BY score DESC",
    [id]
  );

  const assets = await query(
    "SELECT * FROM round_assets WHERE round_id = $1 ORDER BY rarity DESC",
    [id]
  );

  res.json({
    round: result.rows[0],
    players: players.rows,
    assets: assets.rows,
  });
});

router.post("/rounds/create", authMiddleware, async (req, res) => {
  const { theme, entryFee, maxPlayers, duration } = req.body;

  if (!theme || !THEME_KEYS.includes(theme)) {
    return res.status(400).json({ error: "Invalid theme", validThemes: THEME_KEYS });
  }

  const fee = entryFee || "1000000000000000"; // 0.001 ETH default
  const max = Math.min(Math.max(maxPlayers || 6, 2), 8);
  const dur = Math.min(Math.max(duration || 300, 120), 600);

  const themeHash = ethers.keccak256(ethers.toUtf8Bytes(theme));

  // Insert into DB
  const dbResult = await query(
    `INSERT INTO rounds (theme, theme_hash, entry_fee_wei, max_players, duration_secs, status)
     VALUES ($1, $2, $3, $4, $5, 'lobby')
     RETURNING id`,
    [theme, themeHash, fee, max, dur]
  );

  const roundDbId = dbResult.rows[0].id;

  // Create in-memory round
  createRoundInMemory(roundDbId, { theme, entryFee: fee, maxPlayers: max, duration: dur });

  // Create onchain (async, don't block response)
  createRoundOnchain(themeHash, fee, max, dur).then((onchainId) => {
    if (onchainId) {
      query("UPDATE rounds SET onchain_id = $1 WHERE id = $2", [onchainId, roundDbId]);
    }
  }).catch((err) => console.error("[API] Onchain round creation failed:", err.message));

  res.json({ roundId: roundDbId, theme, entryFee: fee, maxPlayers: max, duration: dur });
});

// ---------------------------------------------------------------
// Player stats
// ---------------------------------------------------------------

router.get("/players/:wallet", async (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  const result = await query("SELECT * FROM players WHERE wallet = $1", [wallet]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Player not found" });
  }

  const recentRounds = await query(
    `SELECT r.id, r.theme, r.status, rp.score, rp.placement
     FROM round_players rp
     JOIN rounds r ON r.id = rp.round_id
     WHERE rp.wallet = $1
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [wallet]
  );

  res.json({
    player: result.rows[0],
    recentRounds: recentRounds.rows,
  });
});

export default router;

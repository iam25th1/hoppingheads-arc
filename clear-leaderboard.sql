-- Run this ONCE before playtest launch to clear all existing scores
-- This resets leaderboard history and cumulative player stats

TRUNCATE TABLE leaderboard RESTART IDENTITY;
TRUNCATE TABLE player_stats RESTART IDENTITY;

-- Verify tables are empty
SELECT 'leaderboard' AS tbl, COUNT(*) AS rows FROM leaderboard
UNION ALL
SELECT 'player_stats', COUNT(*) FROM player_stats;

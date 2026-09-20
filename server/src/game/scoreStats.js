/**
 * Score distribution
 *
 * Before any payout tier is set, the system records what scores and placements
 * actually look like, human and bot, and this turns those rows into a report.
 * Pure: takes the round_results rows joined with their rounds, returns numbers.
 * scripts/score-distribution.mjs prints it from the database.
 *
 * A row is { round_id, participant, is_bot, score, placement, seats } where
 * seats is the number of results in that round.
 */

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summary(scores) {
  const s = [...scores].sort((a, b) => a - b);
  if (s.length === 0) return { n: 0 };
  return {
    n: s.length,
    min: s[0],
    p25: quantile(s, 0.25),
    median: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    max: s[s.length - 1],
    mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10,
  };
}

/**
 * @returns {{ rounds, seats, humans, bots, byPlacement: {human, bot}, humanPlacements, humanTop3Rate, humanWinRate, scoreOverall, humanShare }}
 */
export function distribution(rows) {
  const rounds = new Set(rows.map((r) => r.round_id));
  const humans = rows.filter((r) => !r.is_bot), bots = rows.filter((r) => r.is_bot);
  const byPlacement = { human: {}, bot: {} };
  for (const r of rows) {
    const bucket = byPlacement[r.is_bot ? 'bot' : 'human'];
    (bucket[r.placement] = bucket[r.placement] || []).push(r.score);
  }
  const fold = (bucket) => Object.fromEntries(Object.entries(bucket).map(([place, scores]) => [place, summary(scores)]));
  const humanPlacements = {};
  for (const r of humans) humanPlacements[r.placement] = (humanPlacements[r.placement] || 0) + 1;
  const humanRounds = new Set(humans.map((r) => r.round_id)).size;
  const top3 = humans.filter((r) => r.placement <= 3).length, wins = humans.filter((r) => r.placement === 1).length;
  return {
    rounds: rounds.size,
    seats: rows.length,
    humans: humans.length,
    bots: bots.length,
    roundsWithHumans: humanRounds,
    byPlacement: { human: fold(byPlacement.human), bot: fold(byPlacement.bot) },
    humanPlacements,
    humanTop3Rate: humans.length ? Math.round((top3 / humans.length) * 1000) / 10 : null,
    humanWinRate: humans.length ? Math.round((wins / humans.length) * 1000) / 10 : null,
    scoreHuman: summary(humans.map((r) => r.score)),
    scoreBot: summary(bots.map((r) => r.score)),
  };
}

/**
 * What a tier table pays out per human seat on average under this distribution: the
 * expected credit per human entry, for comparing against the entry amount. tiers in
 * USDC units by placement index.
 */
export function expectedPayoutPerHuman(rows, tiers) {
  const humans = rows.filter((r) => !r.is_bot);
  if (humans.length === 0) return null;
  let total = 0;
  for (const r of humans) total += r.placement <= tiers.length ? tiers[r.placement - 1] : 0;
  return Math.round(total / humans.length);
}

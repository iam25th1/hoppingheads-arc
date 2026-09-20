// Print the Arena score and placement distribution, human and bot, from the database, and
// what the current tier table would pay per human entry under it. Read only.
//   DATABASE_URL=... node scripts/score-distribution.mjs [--tiers 1200000,700000,400000] [--json]
import { query } from '../server/src/db/pool.js';
import { distribution, expectedPayoutPerHuman } from '../server/src/game/scoreStats.js';

const args = process.argv.slice(2);
const tiersArg = args.includes('--tiers') ? args[args.indexOf('--tiers') + 1] : (process.env.TIERS || '1200000,700000,400000');
const tiers = tiersArg.split(',').map((t) => Number(t.trim()));
const entry = Number(process.env.ENTRY_AMOUNT || 500000);

const { rows } = await query(
  `SELECT rr.round_id, rr.participant, rr.is_bot, rr.score, rr.placement,
          (SELECT count(*) FROM round_results x WHERE x.round_id = rr.round_id)::int AS seats
     FROM round_results rr JOIN rounds r ON r.id = rr.round_id
    WHERE r.mode = 'arena' AND r.status = 'completed'
    ORDER BY rr.round_id, rr.placement`,
);
const d = distribution(rows);
const usd = (u) => (u / 1e6).toFixed(2);
if (args.includes('--json')) { console.log(JSON.stringify({ ...d, tiers, entry, expectedPayoutPerHuman: expectedPayoutPerHuman(rows, tiers) }, null, 2)); process.exit(0); }
console.log(`Arena, completed rounds: ${d.rounds} (${d.roundsWithHumans} with a human), seats ${d.seats}: ${d.humans} human, ${d.bots} bot`);
const line = (label, s) => console.log(`  ${label.padEnd(14)} n=${String(s.n).padStart(3)} min=${s.min} p25=${s.p25} median=${s.median} p75=${s.p75} max=${s.max} mean=${s.mean}`);
if (d.scoreHuman.n) line('human score', d.scoreHuman);
if (d.scoreBot.n) line('bot score', d.scoreBot);
console.log('  by placement (score summary):');
for (const kind of ['human', 'bot']) for (const [place, s] of Object.entries(d.byPlacement[kind])) line(`${kind} #${place}`, s);
console.log(`  human placements: ${JSON.stringify(d.humanPlacements)}; win rate ${d.humanWinRate}%; top 3 rate ${d.humanTop3Rate}%`);
const ev = expectedPayoutPerHuman(rows, tiers);
console.log(`  tiers ${tiers.map(usd).join(' / ')} USDC, entry ${usd(entry)}: expected payout per human entry ${ev === null ? 'n/a' : usd(ev)} USDC (${ev === null ? 'n/a' : Math.round((ev / entry) * 100) + '% of entry'})`);
if (d.humans < 30 || d.roundsWithHumans < 20) console.log(`  SAMPLE TOO SMALL to set tiers from: ${d.humans} human seats over ${d.roundsWithHumans} rounds. Tiers stay provisional.`);
process.exit(0);

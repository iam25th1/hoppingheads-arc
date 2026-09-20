import { settle } from './lib.mjs';
// usage: node cli/settle.mjs <roundId> 0xplayer:1,0xplayer:2 [--memo|--no-memo]
const [roundId, list] = process.argv.slice(2);
if (!roundId || !list) { console.error('usage: node cli/settle.mjs <roundId> <0xaddr:place,...> [--memo|--no-memo]'); process.exit(2); }
const placements = list.split(',').map((s) => { const [player, place] = s.split(':'); return { player, place: Number(place) }; });
await settle(roundId, placements, process.argv.includes('--memo') ? true : process.argv.includes('--no-memo') ? false : null);

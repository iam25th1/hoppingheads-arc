import { enter } from './lib.mjs';
const roundId = process.argv[2];
if (!roundId) { console.error('usage: node cli/enter.mjs <roundId> [--permit2]'); process.exit(2); }
await enter(roundId, process.argv.includes('--permit2'));

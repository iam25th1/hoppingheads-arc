// The whole money path with no game attached: fund, open, enter, settle, withdraw, with the
// balances at every step. usage: node cli/cycle.mjs [fundAmount] [--permit2] [--memo|--no-memo]
import { clients, escrowAddress, usdcBalance, readEscrow, usdcFmt, fund, open, enter, settle, withdraw } from './lib.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const args = process.argv.slice(2);
const amount = args.find((a) => !a.startsWith('--')) || '5';
const { pub } = clients();
const esc = escrowAddress();
const player = privateKeyToAccount(process.env.PLAYER_KEY).address;
const owner = privateKeyToAccount(process.env.OWNER_KEY).address;
const snap = async (label) => console.log(`[${label}] pool ${usdcFmt(await usdcBalance(pub, esc))} owed ${usdcFmt(await readEscrow(pub, 'totalClaimable'))} free ${usdcFmt(await readEscrow(pub, 'freePool'))} | owner ${usdcFmt(await usdcBalance(pub, owner))} | player ${usdcFmt(await usdcBalance(pub, player))} claimable ${usdcFmt(await readEscrow(pub, 'claimable', [player]))}`);

await snap('start');
await fund(amount); await snap('after fund');
const roundId = await open(`cycle-${Date.now()}`); await snap('after open');
await enter(roundId, args.includes('--permit2')); await snap('after enter');
await settle(roundId, [{ player, place: 1 }], args.includes('--memo') ? true : args.includes('--no-memo') ? false : null); await snap('after settle');
await withdraw(); await snap('after withdraw');
console.log('cycle complete');

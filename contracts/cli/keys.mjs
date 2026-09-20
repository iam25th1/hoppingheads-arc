// Four fresh keys for the four roles. Prints the addresses; with --write, appends the keys to
// contracts/.env when that file does not exist yet. Keys are never printed. Fund the owner
// (deploy, pool) and the player (entry) from https://faucet.circle.com on testnet; the
// operator needs gas for openRound and settleRound; the signer needs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DIR } from './lib.mjs';

const roles = ['OWNER', 'OPERATOR', 'SIGNER', 'PLAYER'];
const keys = Object.fromEntries(roles.map((r) => [r, generatePrivateKey()]));
for (const r of roles) console.log(`${r.padEnd(9)} ${privateKeyToAccount(keys[r]).address}`);
if (process.argv.includes('--write')) {
  const file = path.join(DIR, '.env');
  if (fs.existsSync(file)) { console.error(`${file} exists; not touching it`); process.exit(1); }
  const example = fs.readFileSync(path.join(DIR, '.env.example'), 'utf8');
  let out = example;
  for (const r of roles) out = out.replace(`${r}_KEY=0x\n`, `${r}_KEY=${keys[r]}\n`);
  fs.writeFileSync(file, out, { mode: 0o600 });
  console.log(`wrote ${file} (mode 600, gitignored). Move these into Pier when the settlement service lands.`);
}

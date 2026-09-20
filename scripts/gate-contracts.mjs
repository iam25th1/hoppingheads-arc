// Contracts gate: build, unit tests, and the Arc fork tests against a throwaway arc-anvil.
//
// Needs Arc Foundry (circlefin/arc-foundry, installed as arc-forge and arc-anvil). Without it
// the step is skipped with a loud notice, so the server gate stays runnable on a machine that
// has never touched Solidity; with CONTRACTS_REQUIRED=1 (CI) a missing toolchain fails.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'contracts');
const required = process.env.CONTRACTS_REQUIRED === '1';

function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const forge = which('arc-forge') || which('forge');
// arc-forge runs Arc's own EVM under --network arc; upstream forge has no such flag.
const NET = forge && forge.endsWith('arc-forge') ? ['--network', 'arc'] : [];
const anvil = which('arc-anvil');
if (!forge) {
  const msg = '[contracts] arc-forge not found. Install circlefin/arc-foundry (see docs/phase3-escrow.md).';
  if (required) { console.error(msg); process.exit(1); }
  console.warn(msg + ' SKIPPED. Set CONTRACTS_REQUIRED=1 to make this fatal.');
  process.exit(0);
}
if (!fs.existsSync(path.join(DIR, 'node_modules', '@openzeppelin'))) {
  console.error('[contracts] contracts/node_modules missing. Run: npm --prefix contracts ci --ignore-scripts');
  process.exit(1);
}
if (!fs.existsSync(path.join(DIR, 'lib', 'forge-std', 'src'))) {
  console.error('[contracts] contracts/lib/forge-std missing. Run: git submodule update --init');
  process.exit(1);
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: DIR, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) { console.error(`[contracts] ${path.basename(cmd)} ${args.join(' ')} failed`); process.exit(r.status || 1); }
}

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

run(forge, ['build']);
run(forge, ['test', '--no-match-contract', 'Arc', ...NET]);

if (!anvil) {
  const msg = '[contracts] arc-anvil not found; the Arc fork tests and the fee floor check did not run.';
  if (required) { console.error(msg); process.exit(1); }
  console.warn(msg);
  process.exit(0);
}
const port = await freePort();
const node = spawn(anvil, ['--network', 'arc', '--port', String(port), '--silent'], { stdio: 'ignore' });
const url = `http://127.0.0.1:${port}`;
try {
  const started = Date.now();
  for (;;) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch {}
    if (Date.now() - started > 15000) { console.error('[contracts] arc-anvil did not come up'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 200));
  }
  run(forge, ['test', '--match-contract', 'Arc', ...NET], { ARC_FORK_URL: url });
  const floor = path.join(DIR, 'cli', 'floor-check.mjs');
  if (fs.existsSync(floor)) run(process.execPath, [floor], { ARC_RPC_URL: url, ARC_NETWORK: 'local' });
  console.log('[contracts] OK - build, unit tests, Arc fork tests, fee floor check.');
} finally {
  node.kill();
}

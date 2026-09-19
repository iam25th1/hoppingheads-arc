#!/usr/bin/env node
// Extract the per map collider set from the real client in headless Chromium
// and compare it to shared/mapObstacles.cjs. Not part of the gate: it needs a
// running server and a Chromium build. Run it after changing a map builder.
//
//   PW_CORE=/path/to/node_modules/playwright-core CHROME=/path/to/chrome-headless-shell \
//   BASE=http://localhost:7510 node scripts/extract-obstacles.mjs [--write]
//
// --write overwrites the data in shared/mapObstacles.cjs with the fresh
// extraction. Without it the script exits 1 on drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const exe = process.env.CHROME
  || `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const BASE = process.env.BASE || 'http://localhost:7510';
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'mapObstacles.cjs');

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

const fresh = [];
for (let m = 0; m < 6; m++) {
  await page.goto(`${BASE}/game/?map=${m}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof colliders !== 'undefined' && typeof switchMapInPlace === 'function', null, { timeout: 15000 });
  const r = await page.evaluate((m) => {
    // Build twice, the way a session does (load, then startGame), and prove
    // the set is the same both times before recording it.
    switchMapInPlace(m);
    const a = colliders.map((c) => [+c.x.toFixed(4), +c.z.toFixed(4), +c.r.toFixed(4)]);
    switchMapInPlace(m);
    const b = colliders.map((c) => [+c.x.toFixed(4), +c.z.toFixed(4), +c.r.toFixed(4)]);
    return { count: a.length, stable: JSON.stringify(a) === JSON.stringify(b), colliders: a };
  }, m);
  if (!r.stable) { console.error(`map ${m}: collider set differs between two builds; the builders are not reseeding`); process.exit(2); }
  console.log(`map ${m}: ${r.count} colliders, stable across rebuilds`);
  fresh.push(r.colliders);
}
await browser.close();
if (errors.length) console.log('pageerrors:', errors);

const current = require(DATA);
const same = JSON.stringify(fresh) === JSON.stringify(current);
console.log(same ? 'shared/mapObstacles.cjs matches the client' : 'DRIFT: shared/mapObstacles.cjs differs from the client');

if (process.argv.includes('--write')) {
  const body = fresh.map((m, i) => `  // map ${i}: ${m.length} colliders\n  [${m.map((c) => `[${c.join(',')}]`).join(',')}]`).join(',\n');
  const src = fs.readFileSync(DATA, 'utf8');
  fs.writeFileSync(DATA, src.replace(/return \[\n[\s\S]*?\n  \];/, `return [\n${body}\n  ];`));
  console.log('written shared/mapObstacles.cjs');
} else if (!same) {
  process.exit(1);
}

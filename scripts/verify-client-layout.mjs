#!/usr/bin/env node
// Drive the real client in headless Chromium and prove the layout it plays
// is the server's, through every path that used to re-place fragments:
//   1. menu map cycling before a round, then a solo start
//   2. a rebuild of the same map after the round layout is applied
//   3. the round:start handler body after cycling (what an online client runs)
//   4. a solo mint respawn, which now comes from the server
// Needs a running server and a Chromium build; not part of the gate.
//
//   PW_CORE=/path/to/node_modules/playwright-core BASE=http://localhost:7510 node scripts/verify-client-layout.mjs
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const layout = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'layout.cjs'));
const BASE = process.env.BASE || 'http://localhost:7510';
const exe = process.env.CHROME
  || `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const snap = (frags) => JSON.stringify(frags.map((f) => [f.rarity, +f.x.toFixed(6), +f.z.toFixed(6)]));
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures++; };

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
page.on('dialog', async (d) => { errors.push('dialog: ' + d.message()); await d.dismiss(); });
let issued = null;
page.on('response', async (r) => { if (r.url().endsWith('/api/round/start')) { try { issued = await r.json(); } catch {} } });

await page.goto(`${BASE}/game/?map=2`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => typeof startGame === 'function' && typeof HHLayout !== 'undefined', null, { timeout: 15000 });

// 1. cycle maps in the menu, then start a solo round
await page.evaluate(() => { switchMapInPlace(4); switchMapInPlace(0); switchMapInPlace(5); switchMapInPlace(1); });
await page.evaluate(() => { gamePhase = 'title'; gameMode = 'classic'; startGame(); });
await page.waitForFunction(() => currentLayout && currentLayout.seed !== SOLO_PLACEHOLDER_SEED, null, { timeout: 15000 });
let s = await page.evaluate(() => ({ seed: currentLayout.seed, map: mapIdx, frags: fragments.map((f) => ({ rarity: f.rarity, x: f.x, z: f.z })) }));
check(`after menu cycling then solo start: client == module(seed, map ${s.map})`, issued && s.seed === issued.seed && snap(s.frags) === snap(layout.createLayout(s.seed, s.map).fragments));

// 2. rebuild the same map after the round layout is applied
await page.evaluate(() => switchMapInPlace(mapIdx));
s = await page.evaluate(() => ({ seed: currentLayout.seed, map: mapIdx, frags: fragments.map((f) => ({ rarity: f.rarity, x: f.x, z: f.z })) }));
check('same map rebuilt mid round keeps the round layout', snap(s.frags) === snap(layout.createLayout(s.seed, s.map).fragments));

// 3. the round:start handler body after cycling, on a fresh page
await page.goto(`${BASE}/game/?map=3`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => typeof switchMapInPlace === 'function' && typeof applyLayout === 'function', null, { timeout: 15000 });
const seed = '0x' + 'e5'.repeat(32);
s = await page.evaluate((seed) => { switchMapInPlace(0); switchMapInPlace(5); switchMapInPlace(3); applyLayout(HHLayout.createLayout(seed, 3)); return fragments.map((f) => ({ rarity: f.rarity, x: f.x, z: f.z })); }, seed);
check('round:start body after cycling: client == module(seed, 3)', snap(s) === snap(layout.createLayout(seed, 3).fragments));

// 4. a solo mint respawn comes from the server and lands where the server said
await page.evaluate(() => { gamePhase = 'title'; gameMode = 'classic'; startGame(); });
await page.waitForFunction(() => currentLayout && currentLayout.seed !== SOLO_PLACEHOLDER_SEED && currentRoundKey, null, { timeout: 15000 });
const before = await page.evaluate(() => fragments.filter((f) => f.rarity === 2).map((f) => [f.x, f.z]));
const resp = await page.evaluate(async () => {
  const r = await fetch('/api/round/respawn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: currentRoundKey, rarity: 2 }) });
  const d = await r.json(); applyRespawn(d.fragments);
  return { moved: d.fragments, now: fragments.filter((f) => f.rarity === 2).map((f) => [f.x, f.z]) };
});
check('solo respawn: positions applied are exactly the server response', JSON.stringify(resp.now) === JSON.stringify(resp.moved.map((m) => [m.x, m.z])) && JSON.stringify(resp.now) !== JSON.stringify(before));
check('solo respawn: the server response is the module stream continued', JSON.stringify(resp.moved) === JSON.stringify((() => { const l = layout.createLayout(issued.seed, 3); return l.respawn(2); })()));

await browser.close();
check('no page errors', errors.length === 0);
if (errors.length) console.log(errors);
process.exit(failures ? 1 : 0);

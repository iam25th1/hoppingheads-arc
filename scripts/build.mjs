#!/usr/bin/env node
// Build check for a no bundle app: prove the served artifact set is complete
// and parses, so a deploy cannot ship a missing page or a client that throws
// on load.
//
// There is nothing to compile here. The server is plain ESM and the client is
// one HTML file with inline scripts. What a build step can still catch:
//   1. every file the server serves by path is present
//   2. every relative import in server/src resolves to a real file
//   3. every inline <script> in the client parses under the real V8 parser
// Lint also parses the client, through ESLint, but lint can be skipped in a
// hurry and this cannot: it is what `npm run build` means for this repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// 1. Served files. Paths the server references in index.js by sendFile or
//    static mount, plus the assets the landing page links.
const SERVED = [
  'client/index.html',
  'server/landing/index.html',
  'server/landing/terms.html',
  'server/landing/privacy.html',
  'server/landing/favicon.png',
  'server/landing/og-banner.png',
];
for (const rel of SERVED) {
  if (!fs.existsSync(path.join(ROOT, rel))) failures.push(`missing served file: ${rel}`);
}

// 2. Relative imports under server/src resolve.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}
const IMPORT_RE = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
for (const file of walk(path.join(ROOT, 'server', 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] || m[2];
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) failures.push(`${path.relative(ROOT, file)} imports missing ${spec}`);
  }
}

// 3. Client inline scripts parse.
const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/g;
const tmpDir = fs.mkdtempSync(path.join(ROOT, '.build-tmp-'));
let scripts = 0;
let m;
while ((m = SCRIPT_RE.exec(html)) !== null) {
  const [, attrs, body] = m;
  if (attrs.includes('src=') || body.trim().length < 20) continue;
  scripts++;
  const tmp = path.join(tmpDir, `script-${scripts}.js`);
  fs.writeFileSync(tmp, body);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const line = html.slice(0, m.index).split('\n').length;
    failures.push(`client/index.html inline script #${scripts} (starts line ${line}) does not parse:\n${String(err.stderr).trim().split('\n').slice(0, 4).join('\n')}`);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length) {
  for (const f of failures) console.error(`[build] ${f}`);
  console.error(`[build] ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`[build] OK - ${SERVED.length} served files present, server imports resolve, ${scripts} client scripts parse.`);

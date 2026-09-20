#!/usr/bin/env node
// Parse-level typecheck for the repo's JavaScript.
//
// This repo is plain ESM JavaScript with no TypeScript build, so there is no
// tsc step to run. `node --check` is the strongest check available without
// adopting TypeScript: it runs the real V8 parser over every source file in
// the module goal Node would use at runtime, so it catches syntax errors,
// bad module syntax and early errors before they reach a running server.
//
// Inline scripts in HTML are not covered here on purpose. `npm run lint`
// extracts and parses those via ESLint, so checking them twice buys nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Directories walked for .js / .mjs sources. Generated and vendored trees
// are left out.
const ROOTS = ['server/src', 'server/tests', 'scripts', 'shared', 'contracts/cli'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.lint-tmp', 'artifacts', 'cache', 'typechain-types']);

function collect(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(abs, out);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

const files = ROOTS.flatMap((r) => collect(path.join(ROOT, r), []));

if (files.length === 0) {
  console.error('[typecheck] no source files found. Check the ROOTS list.');
  process.exit(2);
}

const failures = [];
await Promise.all(
  files.map(async (file) => {
    try {
      await execFileAsync(process.execPath, ['--check', file]);
    } catch (err) {
      failures.push({ file: path.relative(ROOT, file), message: String(err.stderr || err.message).trim() });
    }
  })
);

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`[typecheck] ${f.file}`);
    console.error(f.message);
    console.error('');
  }
  console.error(`[typecheck] ${failures.length} file(s) failed to parse.`);
  process.exit(1);
}

console.log(`[typecheck] OK - ${files.length} file(s) parsed.`);

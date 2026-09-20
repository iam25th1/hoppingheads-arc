#!/usr/bin/env node
// Run the node:test suites under server/tests.
//
// `node --test <glob>` only works on Node 22 and newer, and `node --test <dir>`
// changed behaviour between 20 and 24. The Dockerfile targets node:20-slim
// while local dev runs newer, so the file list is resolved here and passed to
// the runner explicitly, which every version accepts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'server', 'tests');
// Phase 4: the signer and the settlement worker carry their own suites and their own
// node_modules; resolution walks up from each file, so they run from here unchanged.
const SERVICE_TEST_DIRS = ['services/signer/test', 'services/settler/test'].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(abs, out);
    else if (/\.test\.(js|mjs)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

const files = [TEST_DIR, ...SERVICE_TEST_DIRS].flatMap((d) => collect(d));

if (files.length === 0) {
  console.error(`[test] no *.test.js files found under ${path.relative(ROOT, TEST_DIR)}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: ROOT });
process.exit(result.status ?? 1);

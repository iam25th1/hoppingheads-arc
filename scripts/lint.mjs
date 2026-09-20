#!/usr/bin/env node
// Lint server code + extracted inline scripts from client/landing HTML.
// Uses the ESLint Node.js API (cross-platform; no shebang/spawn issues on Windows).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.lint-tmp');

// Load ESLint API with a friendly error when node_modules is missing.
let ESLint;
try {
  ({ ESLint } = await import('eslint'));
} catch {
  console.error('[lint] eslint not installed. Run: npm install');
  process.exit(2);
}

let globalsPkg;
try {
  globalsPkg = (await import('globals')).default;
} catch {
  console.error('[lint] globals package not installed. Run: npm install');
  process.exit(2);
}

// -------- HTML inline-script extraction ---------------------------------

if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// The game client is the one file under client/. The landing page is the
// only other HTML with inline script worth linting.
const htmlFiles = [
  'client/index.html',
  'server/landing/index.html',
];

const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/g;
const extractedFiles = [];

for (const rel of htmlFiles) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const html = fs.readFileSync(abs, 'utf8');
  const chunks = [];
  SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const [, attrs, body] = m;
    if (attrs.includes('src=')) continue;
    if (body.trim().length < 20) continue;
    const startLine = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
    chunks.push(`// ---- SCRIPT at ${rel} line ${startLine} ----\n${body}`);
  }
  if (chunks.length === 0) continue;
  const out = path.join(TMP, rel.replace(/[\\/.]/g, '_') + '.js');
  // Pad so first-chunk line numbers roughly match the HTML.
  const firstStartLine = Math.max(0, html.slice(0, html.indexOf('<script')).split('\n').length - 1);
  fs.writeFileSync(out, '\n'.repeat(firstStartLine) + chunks.join('\n\n'));
  extractedFiles.push(out);
}

// -------- Rules + globals ----------------------------------------------

const bugRules = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-cond-assign': 'error',
  'no-setter-return': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-useless-backreference': 'error',
};

const threeGlobals = {
  THREE: 'readonly', Scene: 'readonly', PerspectiveCamera: 'readonly', WebGLRenderer: 'readonly',
  Color: 'readonly', Fog: 'readonly', AmbientLight: 'readonly', DirectionalLight: 'readonly',
  Mesh: 'readonly', BoxGeometry: 'readonly', SphereGeometry: 'readonly', CylinderGeometry: 'readonly',
  PlaneGeometry: 'readonly', ConeGeometry: 'readonly', TorusGeometry: 'readonly', RingGeometry: 'readonly',
  CircleGeometry: 'readonly', DodecahedronGeometry: 'readonly', IcosahedronGeometry: 'readonly',
  OctahedronGeometry: 'readonly', TetrahedronGeometry: 'readonly',
  MeshStandardMaterial: 'readonly', MeshBasicMaterial: 'readonly',
  MeshLambertMaterial: 'readonly', MeshPhongMaterial: 'readonly',
  Vector3: 'readonly', Vector2: 'readonly', Quaternion: 'readonly', Euler: 'readonly',
  Matrix4: 'readonly', Group: 'readonly', Clock: 'readonly', Raycaster: 'readonly', Box3: 'readonly',
  CanvasTexture: 'readonly', TextureLoader: 'readonly',
  BufferGeometry: 'readonly', Float32BufferAttribute: 'readonly',
  Line: 'readonly', LineBasicMaterial: 'readonly', Points: 'readonly', PointsMaterial: 'readonly',
  ShaderMaterial: 'readonly', DoubleSide: 'readonly', FrontSide: 'readonly', BackSide: 'readonly',
  AdditiveBlending: 'readonly', NormalBlending: 'readonly',
  SpriteMaterial: 'readonly', Sprite: 'readonly',
  MathUtils: 'readonly', CatmullRomCurve3: 'readonly', TubeGeometry: 'readonly',
  io: 'readonly', Chart: 'readonly',
  HHPrng: 'readonly', HHMapObstacles: 'readonly', HHLayout: 'readonly',
};

// -------- Run ESLint via Node.js API -----------------------------------

async function runEslint({ overrideConfig, files }) {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true, // ignore any project config files; use only what we pass
    overrideConfig,
  });
  const results = await eslint.lintFiles(files);
  const formatter = await eslint.loadFormatter('stylish');
  const output = await formatter.format(results);
  if (output && output.trim()) process.stdout.write(output + '\n');
  return results.reduce((a, r) => a + r.errorCount, 0);
}

let totalErrors = 0;

// Server code (Node, ESM)
totalErrors += await runEslint({
  overrideConfig: {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globalsPkg.node },
    },
    rules: bugRules,
  },
  files: ['server/src/**/*.js', 'shared/**/*.cjs', 'contracts/cli/**/*.mjs', 'services/*/*.js'],
});

// Extracted HTML inline scripts (browser, script mode)
if (extractedFiles.length > 0) {
  totalErrors += await runEslint({
    overrideConfig: {
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'script',
        globals: { ...globalsPkg.browser, ...threeGlobals },
      },
      rules: bugRules,
    },
    files: extractedFiles,
  });
}

if (totalErrors === 0) {
  fs.rmSync(TMP, { recursive: true });
  console.log('[lint] OK');
  process.exit(0);
} else {
  console.error(`[lint] ${totalErrors} error(s). Temp files left in .lint-tmp/ for inspection.`);
  process.exit(1);
}

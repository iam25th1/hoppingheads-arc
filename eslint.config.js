// ESLint flat config - catches bug-class errors across client and server.
// Run: npm run lint
import globals from 'globals';

const bugRules = {
  // These catch logic bugs, not style. Style is intentionally left alone.
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-unreachable-loop': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'warn',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-dupe-class-members': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-misleading-character-class': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-setter-return': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-useless-backreference': 'error',
  'no-loss-of-precision': 'warn',
};

// Globals the browser game uses (Three.js r128 destructured names + socket.io client)
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
};

export default [
  // Ignore non-source files
  {
    ignores: [
      'node_modules/**', 'artifacts/**', 'cache/**', 'typechain-types/**',
      '**/package-lock.json', 'server/package-lock.json',
          ],
  },
  // Server code (Node/ESM)
  {
    files: ['server/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: bugRules,
  },
];

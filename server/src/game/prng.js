/**
 * Deterministic PRNG (xoshiro128**)
 *
 * A run seeded with the same value always produces the same sequence, in this
 * process or any other, on any platform. Nothing here reads the clock, the
 * global Math.random or any module level mutable state, so a generator is a
 * pure function of its seed.
 *
 * Each createRng() call returns an independent generator with its own state.
 * Two generators built from the same seed never interfere with each other, so
 * a caller does not have to care what other subsystems draw or in what order.
 *
 * Chosen over the mulberry32 already in mapGenerator.js because xoshiro128**
 * carries 128 bits of state instead of 32, which removes the short period and
 * the correlated low bits that make mulberry32 a poor fit for a run that has
 * to stay verifiable. mapGenerator.js is deliberately left alone: its output
 * is already committed to by existing round rows.
 *
 * Reference: Blackman and Vigna, "Scrambled Linear Pseudorandom Number
 * Generators" (2021).
 */

// -- Helpers ---------------------------------------------------

/** Rotate a 32 bit word left by k bits. */
function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * SplitMix32. Used only to expand a single 32 bit seed into the four words
 * xoshiro needs. Running the seed through a mixer first is what stops nearby
 * seeds (1, 2, 3) from producing correlated first outputs.
 */
function splitmix32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

/**
 * Reduce any seed to the uint32 the generator actually consumes.
 *
 * Numbers are truncated toward zero and wrapped. Strings are hashed with
 * FNV-1a, so a hex round seed, a UUID or a human readable label all work and
 * all hash the same way on every platform.
 *
 * @param {string|number} seed
 * @returns {number} uint32
 */
export function seedFrom(seed) {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new TypeError('seedFrom: numeric seed must be finite');
    return Math.trunc(seed) >>> 0;
  }
  if (typeof seed !== 'string') {
    throw new TypeError(`seedFrom: seed must be a string or number, got ${typeof seed}`);
  }
  if (seed.length === 0) throw new TypeError('seedFrom: seed string must not be empty');

  // FNV-1a over UTF-16 code units.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// -- Generator -------------------------------------------------

/**
 * Build a generator from a seed.
 *
 * @param {string|number} seed
 * @returns {{ nextUint32: () => number, nextFloat: () => number }}
 */
export function createRng(seed) {
  const mix = splitmix32(seedFrom(seed));

  // Uint32Array keeps every XOR and shift in unsigned 32 bit space without a
  // >>> 0 on each line.
  const s = new Uint32Array(4);
  s[0] = mix();
  s[1] = mix();
  s[2] = mix();
  s[3] = mix();

  // The all zero state is a fixed point: xoshiro would emit 0 forever. Only
  // reachable if SplitMix32 emits four zeros in a row, which it does not for
  // any uint32 seed, but the cost of being sure is one comparison at startup.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 0x9e3779b9;

  /** @returns {number} the next uint32 in the sequence */
  function nextUint32() {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;

    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);

    return result;
  }

  /** @returns {number} the next float in [0, 1) */
  function nextFloat() {
    return nextUint32() / 4294967296;
  }

  return { nextUint32, nextFloat };
}

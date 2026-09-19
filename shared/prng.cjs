/**
 * Deterministic PRNG (xoshiro128**)
 *
 * One file, loaded by both sides:
 *   server   import prng from '../../shared/prng.cjs'   (CommonJS, so Node
 *            never parses it as ESM whatever the nearest package.json says)
 *   client   <script src="/game/lib/prng.js">             (classic script,
 *            the same bytes, exposes globalThis.HHPrng)
 * There is no build step and no second copy. The server serves this file at
 * that path with a JavaScript content type.
 *
 * A run seeded with the same value always produces the same sequence, in
 * this process or any other, on any platform. Nothing here reads the clock,
 * Math.random or any module level mutable state, so a generator is a pure
 * function of its seed. Each createRng call is independent.
 *
 * Two ways in:
 *   createRng(seed)          seed is a string or number, reduced to 32 bits
 *                            (FNV-1a for strings). Kept for tests and for
 *                            anything that only needs an unguessable stream.
 *   createRngFromHex(hex)    hex is 0x plus 64 hex digits (256 bits). All
 *                            256 bits reach the state: the 128 bit xoshiro
 *                            state is the XOR fold of the two 128 bit halves.
 *                            Use this for anything that gets committed to,
 *                            because a 32 bit seed space is a weekend of
 *                            brute force and this one is not.
 *
 * Reference: Blackman and Vigna, "Scrambled Linear Pseudorandom Number
 * Generators" (2021).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HHPrng = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function rotl(x, k) {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }

  // SplitMix32: expands a 32 bit seed into the four state words, and stops
  // nearby seeds from producing correlated openings.
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

  function seedFrom(seed) {
    if (typeof seed === "number") {
      if (!Number.isFinite(seed)) throw new TypeError("seedFrom: numeric seed must be finite");
      return Math.trunc(seed) >>> 0;
    }
    if (typeof seed !== "string") {
      throw new TypeError("seedFrom: seed must be a string or number, got " + typeof seed);
    }
    if (seed.length === 0) throw new TypeError("seedFrom: seed string must not be empty");
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  const HEX256 = /^0x[0-9a-fA-F]{64}$/;

  /** True when value is a 0x prefixed 64 hex digit string. */
  function isHexSeed(value) {
    return typeof value === "string" && HEX256.test(value);
  }

  /** The four uint32 state words for a 256 bit hex seed, XOR folded. */
  function stateFromHex(hex) {
    if (!isHexSeed(hex)) throw new TypeError("createRngFromHex: seed must be 0x followed by 64 hex digits");
    const s = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      const lo = parseInt(hex.slice(2 + i * 8, 10 + i * 8), 16) >>> 0;
      const hi = parseInt(hex.slice(34 + i * 8, 42 + i * 8), 16) >>> 0;
      s[i] = (lo ^ hi) >>> 0;
    }
    return s;
  }

  function generator(s) {
    // The all zero state is a fixed point: xoshiro would emit 0 forever.
    if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 0x9e3779b9;

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

    function nextFloat() {
      return nextUint32() / 4294967296;
    }

    return { nextUint32: nextUint32, nextFloat: nextFloat };
  }

  function createRng(seed) {
    const mix = splitmix32(seedFrom(seed));
    const s = new Uint32Array(4);
    s[0] = mix();
    s[1] = mix();
    s[2] = mix();
    s[3] = mix();
    return generator(s);
  }

  function createRngFromHex(hex) {
    return generator(stateFromHex(hex));
  }

  return { seedFrom: seedFrom, isHexSeed: isHexSeed, createRng: createRng, createRngFromHex: createRngFromHex };
});

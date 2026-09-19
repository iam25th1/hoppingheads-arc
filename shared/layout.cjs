/**
 * Fragment layout
 *
 * The one place the fragment layout of a round is computed. Loaded by both
 * sides from this file (see prng.cjs for how):
 *   server   import layout from '../../shared/layout.cjs'
 *   client   <script src="/game/lib/layout.js">  ->  globalThis.HHLayout
 *
 * createLayout(seed, mapIndex) is a pure function of its inputs. It draws
 * from its own xoshiro stream seeded by the full 256 bit round seed, never
 * from the client's gameplay stream, and it avoids the map's colliders using
 * the same rule the client used: 20 attempts inside a 0.38 band of the
 * 300 unit map, blocked if within collider radius plus 1.5, then a fallback
 * draw inside the centre 0.2 band. Rarity is the fixed quota FRAG_N.
 *
 * Colliders come from mapObstacles.cjs, the recorded per map collider set of
 * the client's map builders, not from the live scene. Both sides therefore
 * see the same obstacles and produce the same positions byte for byte.
 *
 * respawn(rarity) re-places every fragment of one rarity from the same
 * stream. The server holds the stream and broadcasts the new positions; the
 * client applies what it is told.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./prng.cjs"), require("./mapObstacles.cjs"));
  } else {
    root.HHLayout = factory(root.HHPrng, root.HHMapObstacles);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (prng, mapObstacles) {
  "use strict";

  const MAP = 300;
  const PLACE_RANGE = 0.38;
  const FALLBACK_RANGE = 0.2;
  const COLLIDER_MARGIN = 1.5;
  const ATTEMPTS = 20;
  const FRAG_N = [30, 18, 12, 7, 4]; // common, uncommon, rare, epic, legendary
  const MAP_COUNT = mapObstacles.length;

  function safePos(rng, colliders) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const x = (rng.nextFloat() - 0.5) * MAP * PLACE_RANGE;
      const z = (rng.nextFloat() - 0.5) * MAP * PLACE_RANGE;
      let blocked = false;
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        const dx = x - c[0], dz = z - c[1];
        if (Math.sqrt(dx * dx + dz * dz) < c[2] + COLLIDER_MARGIN) { blocked = true; break; }
      }
      if (!blocked) return { x: x, z: z };
    }
    return {
      x: (rng.nextFloat() - 0.5) * MAP * FALLBACK_RANGE,
      z: (rng.nextFloat() - 0.5) * MAP * FALLBACK_RANGE,
    };
  }

  /**
   * @param {string} seed      0x plus 64 hex digits, issued by the server
   * @param {number} mapIndex  0..5
   * @returns {{ seed, mapIndex, fragments: Array<{id,rarity,x,z}>, respawn }}
   */
  function createLayout(seed, mapIndex) {
    if (!prng.isHexSeed(seed)) throw new TypeError("createLayout: seed must be 0x followed by 64 hex digits");
    if (!Number.isInteger(mapIndex) || mapIndex < 0 || mapIndex >= MAP_COUNT) {
      throw new RangeError("createLayout: mapIndex must be an integer 0.." + (MAP_COUNT - 1));
    }
    const rng = prng.createRngFromHex(seed);
    const colliders = mapObstacles[mapIndex];
    const fragments = [];
    let id = 0;
    for (let r = 0; r < FRAG_N.length; r++) {
      for (let i = 0; i < FRAG_N[r]; i++) {
        const p = safePos(rng, colliders);
        fragments.push({ id: id++, rarity: r, x: p.x, z: p.z });
      }
    }

    /** Re-place every fragment of one rarity. Returns the moved fragments. */
    function respawn(rarity) {
      const moved = [];
      for (let i = 0; i < fragments.length; i++) {
        const f = fragments[i];
        if (f.rarity !== rarity) continue;
        const p = safePos(rng, colliders);
        f.x = p.x;
        f.z = p.z;
        moved.push({ id: f.id, rarity: f.rarity, x: f.x, z: f.z });
      }
      return moved;
    }

    return { seed: seed, mapIndex: mapIndex, fragments: fragments, respawn: respawn };
  }

  /**
   * A stream of safe positions on a map, for things placed during a round
   * that are not fragments (powerups, spawns). Seeded from the round seed
   * with its last byte replaced by tag, so it never overlaps a fragment or
   * bot stream: "ff" (the default) for powerups, "fe" for spawns.
   * range is the placement band, 0.35 for powerups as the client used.
   */
  function createPositionStream(seed, mapIndex, range, tag) {
    if (!prng.isHexSeed(seed)) throw new TypeError("createPositionStream: seed must be 0x followed by 64 hex digits");
    if (!Number.isInteger(mapIndex) || mapIndex < 0 || mapIndex >= MAP_COUNT) throw new RangeError("createPositionStream: bad mapIndex");
    if (tag !== undefined && !/^[0-9a-f]{2}$/.test(tag)) throw new RangeError("createPositionStream: tag must be two hex digits");
    const rng = prng.createRngFromHex(seed.slice(0, 64) + (tag || "ff"));
    const colliders = mapObstacles[mapIndex];
    const band = typeof range === "number" ? range : PLACE_RANGE;
    return {
      next: function () {
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const x = (rng.nextFloat() - 0.5) * MAP * band;
          const z = (rng.nextFloat() - 0.5) * MAP * band;
          let blocked = false;
          for (let i = 0; i < colliders.length; i++) {
            const c = colliders[i];
            const dx = x - c[0], dz = z - c[1];
            if (Math.sqrt(dx * dx + dz * dz) < c[2] + COLLIDER_MARGIN) { blocked = true; break; }
          }
          if (!blocked) return { x: x, z: z };
        }
        return { x: (rng.nextFloat() - 0.5) * MAP * FALLBACK_RANGE, z: (rng.nextFloat() - 0.5) * MAP * FALLBACK_RANGE };
      },
      nextFloat: function () { return rng.nextFloat(); },
    };
  }

  return {
    MAP: MAP,
    FRAG_N: FRAG_N,
    MAP_COUNT: MAP_COUNT,
    COLLECT_RADIUS: 3, // the client collects at dist <= 3 from the fragment's authoritative position
    createLayout: createLayout,
    createPositionStream: createPositionStream,
  };
});

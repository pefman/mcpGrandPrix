/**
 * Deterministic PRNG (mulberry32). Race simulation randomness flows through
 * this so tests can pin a seed and assert exact outcomes.
 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return {
    /** Uniform float in [0, 1). */
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** True with probability p. */
    chance(p) {
      return this.next() < p;
    },
    /** Random integer in [min, max] inclusive. */
    int(min, max) {
      return min + Math.floor(this.next() * (max - min + 1));
    },
    /** Pick a random element from an array. */
    pick(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    },
  };
}

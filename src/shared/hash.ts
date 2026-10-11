/**
 * Deterministic hash and PRNG, shared between server and client.
 * No imports: this module is compiled into both targets.
 */

/** 32-bit FNV-1a. Deterministic and stable across machines: it is the basis of the layout. */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, in 32-bit arithmetic without float overflow
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Seeded PRNG: the same seed must draw the same habitat and the same walk, every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Masks a path segment while preserving its shape.
 * Used both by level 2 (client-side mask) and by level 3 (--redact-paths).
 */
export function maskSegment(segment: string): string {
  if (segment.length === 0) return segment;
  return fnv1a32(segment).toString(36).slice(0, 4);
}

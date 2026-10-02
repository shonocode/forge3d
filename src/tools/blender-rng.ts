/**
 * `BLI_rng` — Blender's `RandomNumberGenerator` (`blenlib/BLI_rand.hh`,
 * `intern/rand.cc`, 5.1.1): the 48-bit `drand48` recurrence.
 *
 * `BLI_rng_new_srandom(seed)` is what Subdivide's fractal reads
 * (`bmo_subdivide_edges`): the seed goes through the 512-entry hash three
 * times before the first number is taken.
 */
import { HASH } from "./texture/noise-tables";

const MASK = 0xffffffffffffn;

export class BlenderRng {
  private x = 0n;

  /** `RandomNumberGenerator::seed`: `x = seed << 16 | 0x330E`. */
  seed(seed: number): void {
    this.x = ((BigInt(seed >>> 0) << 16n) | 0x330en) & MASK;
  }

  /** `RandomNumberGenerator::seed_random`: three rounds through the hash table. */
  seedRandom(seed: number): void {
    this.seed((seed + HASH[seed & 255]!) >>> 0);
    seed = this.uint32();
    this.seed((seed + HASH[seed & 255]!) >>> 0);
    seed = this.uint32();
    this.seed((seed + HASH[seed & 255]!) >>> 0);
  }

  /** `get_uint32`: step, then the top 31 bits of the 48. */
  uint32(): number {
    this.x = (0x5deece66dn * this.x + 0xbn) & MASK;
    return Number(this.x >> 17n) >>> 0;
  }

  /** `get_float`: `float(get_int32()) / 0x80000000`, in `[0, 1)`. */
  float(): number {
    return Math.fround(Math.fround(this.uint32()) / 0x80000000);
  }
}

/** `BLI_rng_new_srandom(seed)`. */
export function rngSrandom(seed: number): BlenderRng {
  const r = new BlenderRng();
  r.seedRandom(seed);
  return r;
}

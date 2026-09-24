/**
 * Exact rational arithmetic — the ground the boolean stands on (ADR-012).
 *
 * Blender's exact boolean (`blenlib/intern/mesh_intersect.cc`) computes every
 * intersection point as a GMP rational (`mpq3`) and decides every "which side
 * of this plane" question exactly. That is why its coplanar, touching and
 * identical cases come out right where the float solver's do not — measured in
 * `probe-boolean.py`. This file is the same idea on `BigInt`: a rational is a
 * reduced `n / d` with `d > 0`, and a float64 input converts to one **exactly**
 * (every double is `m · 2^e`), so no rounding enters until a caller asks for a
 * number back.
 *
 * It is slow next to doubles, and ADR-012 names that as the decision point:
 * `bench-exact.ts` measures it before anything is built on top.
 */

/** A rational `n / d`, reduced, with `d > 0`. */
export interface Q {
  readonly n: bigint;
  readonly d: bigint;
}

const ZERO_N = 0n;
const ONE_N = 1n;

function gcd(a: bigint, b: bigint): bigint {
  if (a < ZERO_N) a = -a;
  if (b < ZERO_N) b = -b;
  while (b !== ZERO_N) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Build a reduced rational. Throws on a zero denominator. */
export function q(n: bigint, d: bigint = ONE_N): Q {
  if (d === ZERO_N) throw new Error("exact: division by zero");
  if (d < ZERO_N) {
    n = -n;
    d = -d;
  }
  if (n === ZERO_N) return QZERO;
  const g = gcd(n, d);
  return g === ONE_N ? { n, d } : { n: n / g, d: d / g };
}

export const QZERO: Q = { n: ZERO_N, d: ONE_N };
export const QONE: Q = { n: ONE_N, d: ONE_N };

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

/**
 * The exact rational value of a float64 — no rounding. Every finite double
 * is `mantissa · 2^exponent`, so this is a bit-level decode rather than a
 * decimal conversion.
 */
export function fromDouble(x: number): Q {
  if (!Number.isFinite(x)) throw new Error(`exact: ${x} is not finite`);
  if (x === 0) return QZERO;
  F64[0] = x;
  const bits = U64[0]!;
  const sign = bits >> 63n ? -1n : 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn;
  let e: number;
  if (exp === 0) e = -1074; // subnormal
  else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  return e >= 0 ? q(sign * (mant << BigInt(e))) : q(sign * mant, 1n << BigInt(-e));
}

const bitLength = (x: bigint): number => (x === ZERO_N ? 0 : x.toString(2).length);

/**
 * The nearest double, **correctly rounded** — including the subnormals, which
 * a plain `Number(n) / Number(d)` gets wrong twice over (both parts overflow
 * to Infinity, or the quotient flushes to zero).
 *
 * Divide in BigInt to a 64-bit quotient with a sticky bit for the remainder,
 * let `Number()` round that to 53 bits, then scale by the power of two in
 * two steps so neither overflows. Exact for anything `fromDouble` produced.
 */
export function toDouble(a: Q): number {
  if (a.n === ZERO_N) return 0;
  const negative = a.n < ZERO_N;
  const n = negative ? -a.n : a.n;
  // Choose k so that (n · 2^k) / d has 64 or 65 bits.
  const k = 64 - (bitLength(n) - bitLength(a.d));
  const num = k >= 0 ? n << BigInt(k) : n;
  const den = k >= 0 ? a.d : a.d << BigInt(-k);
  let quot = num / den;
  if (num % den !== ZERO_N) quot |= ONE_N; // sticky: something was left over

  // |a| = quot · 2^-k. Below 2^-1022 the double's grid is fixed at 2^-1074,
  // so round there ourselves: r = round-half-even(quot / 2^s), s = k − 1074.
  // (quot has 64+ bits and |a| < 2^-1022 forces s ≥ 12, so the sticky bit
  // sits below the rounding position, where it belongs.)
  const floorLog2 = bitLength(quot) - 1 - k;
  if (floorLog2 < -1022) {
    const s = BigInt(k - 1074);
    const kept = quot >> s;
    const rest = quot - (kept << s);
    const half = ONE_N << (s - ONE_N);
    const r = rest > half || (rest === half && (kept & ONE_N) === ONE_N) ? kept + ONE_N : kept;
    const v = Number(r) * 2 ** -1074; // r < 2^53: exact
    return negative ? -v : v;
  }

  // Normal range: Number() rounds the 64-bit quotient to 53 bits correctly
  // (the sticky bit rules out a false tie), and scaling by a power of two is
  // then exact. Two factors so 2^e never overflows on its own.
  const e = -k;
  const e1 = Math.max(e, -1000);
  const v = Number(quot) * 2 ** e1 * 2 ** (e - e1);
  return negative ? -v : v;
}

export const add = (a: Q, b: Q): Q =>
  a.d === b.d ? q(a.n + b.n, a.d) : q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q =>
  a.d === b.d ? q(a.n - b.n, a.d) : q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
export const neg = (a: Q): Q => (a.n === ZERO_N ? a : { n: -a.n, d: a.d });
export const sign = (a: Q): -1 | 0 | 1 => (a.n > ZERO_N ? 1 : a.n < ZERO_N ? -1 : 0);
/** -1, 0 or 1 as `a` is less than, equal to or greater than `b`. */
export const cmp = (a: Q, b: Q): -1 | 0 | 1 => sign(sub(a, b));
export const eq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;

/** A point or vector with exact coordinates. */
export type Q3 = readonly [Q, Q, Q];

export const q3FromDoubles = (x: number, y: number, z: number): Q3 => [
  fromDouble(x),
  fromDouble(y),
  fromDouble(z),
];
export const q3Sub = (a: Q3, b: Q3): Q3 => [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2])];
export const q3Add = (a: Q3, b: Q3): Q3 => [add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2])];
export const q3Scale = (a: Q3, k: Q): Q3 => [mul(a[0], k), mul(a[1], k), mul(a[2], k)];
export const q3Dot = (a: Q3, b: Q3): Q => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
export const q3Cross = (a: Q3, b: Q3): Q3 => [
  sub(mul(a[1], b[2]), mul(a[2], b[1])),
  sub(mul(a[2], b[0]), mul(a[0], b[2])),
  sub(mul(a[0], b[1]), mul(a[1], b[0])),
];
export const q3Eq = (a: Q3, b: Q3): boolean => eq(a[0], b[0]) && eq(a[1], b[1]) && eq(a[2], b[2]);
export const q3ToDoubles = (a: Q3): [number, number, number] => [
  toDouble(a[0]),
  toDouble(a[1]),
  toDouble(a[2]),
];

/**
 * Which side of the plane through `a`, `b`, `c` the point `d` lies on,
 * **exactly**: the sign of `(b − a) × (c − a) · (d − a)`. Positive when `d` is
 * on the side the triangle's right-hand normal points to.
 */
export function orient3dExact(a: Q3, b: Q3, c: Q3, d: Q3): -1 | 0 | 1 {
  return sign(q3Dot(q3Cross(q3Sub(b, a), q3Sub(c, a)), q3Sub(d, a)));
}

/**
 * The same predicate on doubles, with a filter: answer in floating point when
 * the result is clearly away from zero, and fall back to the exact form only
 * when it is not. This is the shape Blender uses (`filter_plane_side`) and
 * the reason exact arithmetic is affordable at all — the fallback is rare
 * outside coplanar and touching configurations.
 *
 * The bound is Shewchuk's static one for `orient3d` over the absolute
 * permanent of the terms, `(7 + 56ε) ε · permanent`, which is conservative:
 * when it says "sure", the sign is right.
 */
export function orient3d(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): -1 | 0 | 1 {
  const adx = a[0]! - d[0]!, ady = a[1]! - d[1]!, adz = a[2]! - d[2]!;
  const bdx = b[0]! - d[0]!, bdy = b[1]! - d[1]!, bdz = b[2]! - d[2]!;
  const cdx = c[0]! - d[0]!, cdy = c[1]! - d[1]!, cdz = c[2]! - d[2]!;
  const bdxcdy = bdx * cdy, cdxbdy = cdx * bdy;
  const cdxady = cdx * ady, adxcdy = adx * cdy;
  const adxbdy = adx * bdy, bdxady = bdx * ady;
  const det = adz * (bdxcdy - cdxbdy) + bdz * (cdxady - adxcdy) + cdz * (adxbdy - bdxady);
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * Math.abs(adz) +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * Math.abs(bdz) +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * Math.abs(cdz);
  const EPS = 1.1102230246251565e-16; // 2^-53
  const bound = (7 + 56 * EPS) * EPS * permanent;
  // This det is (a−d)·((b−d)×(c−d)), which has the opposite sign to the
  // exact form's (b−a)×(c−a)·(d−a) — negate so the two agree.
  if (det > bound) return -1;
  if (-det > bound) return 1;
  return orient3dExact(
    q3FromDoubles(a[0]!, a[1]!, a[2]!),
    q3FromDoubles(b[0]!, b[1]!, b[2]!),
    q3FromDoubles(c[0]!, c[1]!, c[2]!),
    q3FromDoubles(d[0]!, d[1]!, d[2]!),
  );
}

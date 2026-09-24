/**
 * Suzanne — Blender's `bmesh.ops.create_monkey`, the test head.
 *
 * Built the way `bmo_create_monkey_exec` builds it: each of the 271 table
 * vertices is made, then its mirror across x = 0 **right after it** (or the
 * same vertex, when it sits on the plane, `|x| < 0.001`) — so the vertex
 * order interleaves, 507 in all. Faces come in pairs: each of the 250 table
 * faces, then its mirror wound the other way — 500 faces.
 *
 * Y-up, facing −Z, like forge3d's other generators: Blender's head faces −Y
 * with Z up, and the parity row turns it by −90° about X to compare
 * (`(x, y, z) → (x, z, −y)`), which here is just reading the table's second
 * and third columns straight.
 *
 * ```ts
 * const head = createMonkey();            // about 2.7 wide, as Blender's
 * const small = createMonkey({ size: 0.5 });
 * ```
 */
import type { MeshData } from "../lib/mesh";
import { MONKEY_F, MONKEY_V } from "./monkey-data";

export interface MonkeyOptions {
  /** Uniform scale. Default 1 — Blender's size. */
  size?: number;
}

export function createMonkey(opts: MonkeyOptions = {}): MeshData {
  const s = opts.size ?? 1;
  const nv = MONKEY_V.length / 3;
  const positions: number[] = [];
  const tv: number[] = new Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const x = Math.fround((MONKEY_V[i * 3]! + 127) / 128);
    const y = Math.fround(MONKEY_V[i * 3 + 1]! / 128);
    const z = Math.fround(MONKEY_V[i * 3 + 2]! / 128);
    tv[i] = positions.length / 3;
    positions.push(x * s, y * s, z * s);
    if (Math.abs(-x) < 0.001) tv[nv + i] = tv[i]!;
    else {
      tv[nv + i] = positions.length / 3;
      positions.push(-x * s, y * s, z * s);
    }
  }
  const O = 4; // `monkeyo`
  const polys: number[][] = [];
  const nf = MONKEY_F.length / 4;
  for (let i = 0; i < nf; i++) {
    const f = [0, 1, 2, 3].map((k) => MONKEY_F[i * 4 + k]! + i - O);
    const quad = MONKEY_F[i * 4 + 3] !== MONKEY_F[i * 4 + 2];
    polys.push(quad ? [tv[f[0]!]!, tv[f[1]!]!, tv[f[2]!]!, tv[f[3]!]!] : [tv[f[0]!]!, tv[f[1]!]!, tv[f[2]!]!]);
    polys.push(
      quad
        ? [tv[nv + f[2]!]!, tv[nv + f[1]!]!, tv[nv + f[0]!]!, tv[nv + f[3]!]!]
        : [tv[nv + f[2]!]!, tv[nv + f[1]!]!, tv[nv + f[0]!]!],
    );
  }
  return { positions: Float32Array.from(positions), polys };
}

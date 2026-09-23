/**
 * Close open wire chains so `edgenetFill` has loops to fill —
 * Blender's `bmesh.ops.edgenet_prepare(edges=)`.
 *
 * **It only ever adds edges, and only to chains that are open.** That is why
 * the API matrix recorded it for three sessions as "measured, and it returns
 * the edges without changing the input": the shape it was handed was a closed
 * loop, which is precisely the input with nothing to do. The other half of the
 * entry — "`MeshData` has nowhere to put a wire net" — stopped being true on
 * 2026-09-22 when `MeshData` grew `edges`.
 *
 * ## The rule, from `bmo_edgenet.cc`
 *
 * 1. **Refuse** if any input edge has a vertex with more than two input edges
 *    on it. A net that branches is not handled, and the operator returns
 *    having done nothing rather than guessing.
 * 2. Find up to **two open chains**: start each walk at an input edge with an
 *    end that carries only one input edge, and follow unvisited input edges.
 * 3. Drop a chain that turns out to be closed — if the first is closed the
 *    second takes its place, and if both are, stop.
 * 4. **One chain** → add one edge joining its two ends, closing it into a
 *    loop. A chain of a single edge gets nothing.
 * 5. **Two chains** → add two edges bridging their ends, choosing the pairing
 *    whose two triangles come closest to coplanar. That is the bow-tie guard:
 *    reverse one chain's geometry and the pairing flips with it.
 *
 * ## Measured
 *
 * Blender 5.1.1, `probe-edgenet-prepare.py`. A chain of 3 gains `(0,3)`, of 5
 * gains `(0,5)`, of 1 gains nothing; a closed quad is untouched; two facing
 * chains gain `(0,3)` and `(2,5)`, and the same pair with one chain's
 * coordinates mirrored gains `(0,5)` and `(2,3)` instead; a T of three edges
 * is refused; and with three chains only the first two are bridged.
 */
import type { MeshData } from "../../lib/mesh";

export interface EdgenetPrepareOptions {
  /**
   * Which of `mesh.edges` to treat as the net, by index. Left out, all of
   * them — which is what Blender's `edges=` slot gets from a wire selection.
   */
  edges?: ReadonlySet<number>;
}

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalized(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  return len > 1e-30 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

/** The unit normal of a triangle, the way `normal_tri_v3` gives one. */
const triNormal = (a: Vec3, b: Vec3, c: Vec3): Vec3 => normalized(cross(sub(b, a), sub(c, a)));

/**
 * Close what is open in a wire net.
 *
 * ```ts
 * const closed = edgenetPrepare(strokes);
 * const filled = edgenetFill(closed, …);
 * ```
 *
 * @returns a new mesh with the joining edges appended. Nothing else moves, no
 *   vertex is added, and no face is made — this is the step before the fill,
 *   not the fill.
 */
export function edgenetPrepare(data: MeshData, options: EdgenetPrepareOptions = {}): MeshData {
  const all = (data.edges ?? []).map((e) => [e[0]!, e[1]!] as [number, number]);
  const chosen = all
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !options.edges || options.edges.has(i));
  const keep = (): MeshData => ({
    positions: Float32Array.from(data.positions),
    polys: data.polys.map((p) => [...p]),
    ...(data.edges ? { edges: all.map((e) => [...e]) } : {}),
    ...(data.creases ? { creases: new Map(data.creases) } : {}),
    ...(data.seams ? { seams: new Set(data.seams) } : {}),
  });
  if (chosen.length === 0) return keep();

  // How many of the net's edges sit on each vertex.
  const at = new Map<number, number[]>();
  for (const { e, i } of chosen)
    for (const v of e) {
      const list = at.get(v);
      if (list) list.push(i);
      else at.set(v, [i]);
    }
  // A branching net is refused outright, not partly handled.
  for (const list of at.values()) if (list.length > 2) return keep();

  const edgeAt = new Map<number, [number, number]>();
  for (const { e, i } of chosen) edgeAt.set(i, e);

  // ── up to two open chains ────────────────────────────────────────────────
  const visited = new Set<number>();
  const chains: number[][] = [];
  while (chains.length < 2) {
    const seed = chosen.find(
      ({ e, i }) =>
        !visited.has(i) && e.some((v) => (at.get(v)?.length ?? 0) === 1),
    );
    if (!seed) break;
    const chain: number[] = [];
    let current: number | undefined = seed.i;
    while (current !== undefined) {
      visited.add(current);
      chain.push(current);
      const e = edgeAt.get(current)!;
      let next: number | undefined;
      for (const v of e) {
        for (const other of at.get(v) ?? [])
          if (other !== current && !visited.has(other)) {
            next = other;
            break;
          }
        if (next !== undefined) break;
      }
      current = next;
    }
    chains.push(chain);
  }

  /** The two vertices a chain ends at, in its own walking order. */
  const endsOf = (chain: number[]): [number, number] => {
    const first = edgeAt.get(chain[0]!)!;
    if (chain.length === 1) return [first[0], first[1]];
    const second = edgeAt.get(chain[1]!)!;
    const v1 = second.includes(first[0]) ? first[1] : first[0];
    const last = edgeAt.get(chain[chain.length - 1]!)!;
    const beforeLast = edgeAt.get(chain[chain.length - 2]!)!;
    const v2 = beforeLast.includes(last[0]) ? last[1] : last[0];
    return [v1, v2];
  };
  const isClosed = (chain: number[]): boolean => {
    if (chain.length <= 2) return false;
    const [a, b] = endsOf(chain);
    return a === b;
  };

  let first = chains[0] ?? [];
  let second = chains[1] ?? [];
  if (isClosed(first)) {
    if (isClosed(second)) return keep();
    first = second;
    second = [];
  }
  if (isClosed(second)) second = [];

  const added: [number, number][] = [];
  const point = (v: number): Vec3 => [
    data.positions[v * 3]!,
    data.positions[v * 3 + 1]!,
    data.positions[v * 3 + 2]!,
  ];

  if (first.length > 0 && second.length > 0) {
    const [v1, v2] = endsOf(first);
    let [v3, v4] = endsOf(second);
    // Pick the pairing whose two triangles are closest to coplanar: the other
    // one folds back on itself, which is the bow tie this guard exists for.
    const dot24 = dot(
      triNormal(point(v1), point(v2), point(v4)),
      triNormal(point(v1), point(v4), point(v3)),
    );
    const dot13 = dot(
      triNormal(point(v1), point(v2), point(v3)),
      triNormal(point(v1), point(v3), point(v4)),
    );
    if (dot24 < dot13) [v3, v4] = [v4, v3];
    added.push([v1, v3], [v2, v4]);
  } else if (first.length > 1) {
    added.push(endsOf(first));
  }

  const have = new Set(all.map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)));
  const out = all.map((e) => [...e]);
  for (const [a, b] of added) {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (a === b || have.has(k)) continue; // `BM_CREATE_NO_DOUBLE`
    have.add(k);
    out.push([a, b]);
  }

  const result: MeshData = {
    positions: Float32Array.from(data.positions),
    polys: data.polys.map((p) => [...p]),
  };
  if (out.length > 0) result.edges = out;
  if (data.creases) result.creases = new Map(data.creases);
  if (data.seams) result.seams = new Set(data.seams);
  return result;
}

/**
 * Blender's edge loop and edge ring walkers with their delimiters (`bmesh_walkers_impl.cc`, compat-backlog C80): Select ▸ Select Loops ▸
 * Edge Loops and Edge Rings (`mesh.select_edge_loop_multi` / `select_edge_ring_multi`) from every selected edge.
 *
 * {@link selectEdgeLoop} and {@link selectEdgeRing} in `edge-walk.ts` carry the rules that were measured on Blender; these are the walkers
 * themselves, ported so that what stops a walk — a seam, a sharp edge, an n-gon, a corner — can be asked for. A walker is a stack of states;
 * `BMW_begin` first **rewinds** (walks to the far end of the loop, then turns round and walks it back), which is why starting on a delimiting
 * edge or in the middle of a boundary can give a different loop from starting at the end. Everything here is set-valued: the edges the walker
 * yields are selected, the mode's flush follows.
 *
 * Not offered: the face loop (`BMW_FACELOOP`) and boundary (`BMW_EDGEBOUNDARY`) walkers, which Blender reaches only from the cursor-pick
 * operators — they need a mouse, so there is nothing to compare a port against.
 */
import type { MeshData } from "../../lib/mesh";
import {
  diskEdges,
  edgeExists,
  faceOtherVertLoop,
  isBoundary,
  isManifold,
  liveEdges,
  loopsOfVert,
  otherVert,
  radialLoops,
  type BE,
  type BF,
  type BL,
  type BV,
} from "../bmesh-lite";
import { Selection, type MeshSelection, type SelectMode, type SelectionSeed } from "./select-topology";

/** What stops an edge loop (`delimit_edge_loop`). */
export type EdgeLoopDelimit = "seam" | "sharp" | "ngons" | "innerCorners" | "outerCorners";
/** What stops an edge ring (`delimit_edge_ring`). */
export type EdgeRingDelimit = "seam" | "sharp" | "material" | "ngons";

/** Blender's defaults: `OUTER_CORNERS | NGONS` for loops, `NGONS` for rings. */
const LOOP_DEFAULT: EdgeLoopDelimit[] = ["outerCorners", "ngons"];
const RING_DEFAULT: EdgeRingDelimit[] = ["ngons"];

const nonwireEdgeCount = (v: BV): number => diskEdges(v).filter((e) => e.l).length;
const isWire = (e: BE): boolean => !e.l;
/** `BM_loop_other_edge_loop`: the loop of the face's other edge at `v`. */
const otherEdgeLoop = (l: BL, v: BV): BL => (l.v === v ? l.prev : l.next);
/** `bm_edge_is_single`: a boundary edge of an n-gon whose neighbouring edge on the boundary is one too. */
const edgeIsSingle = (e: BE): boolean => isBoundary(e) && e.l!.f.len > 4 && (isBoundary(e.l!.next.e!) || isBoundary(e.l!.prev.e!));

interface Marks {
  seam: (e: BE) => boolean;
  sharp: (e: BE) => boolean;
  material: (f: BF) => number;
}

function marksOf(mesh: MeshData): Marks {
  const key = (e: BE): string => (e.v1.index < e.v2.index ? `${e.v1.index}_${e.v2.index}` : `${e.v2.index}_${e.v1.index}`);
  return {
    seam: (e) => !!mesh.seams?.has(key(e)),
    sharp: (e) => !!mesh.sharp?.has(key(e)),
    material: (f) => mesh.materials?.[f.src] ?? 0,
  };
}

// ── edge loop ──────────────────────────────────────────────────────────────

interface LoopState {
  cur: BE;
  lastv: BV;
  start: BE;
  startv: BV;
  isBoundary: boolean;
  isSingle: boolean;
  fHub: BF | null;
}

/** `BMW_EDGELOOP` from `seed`: the edges it yields. */
function walkEdgeLoop(seed: BE, delimit: ReadonlySet<EdgeLoopDelimit>, marks: Marks): Set<BE> {
  const stack: LoopState[] = [];
  let visit = new Set<BE>();

  /** `bmw_EdgeLoopWalker_delimit_by_mark`. */
  const byMark = (v: BV, e: BE, l: BL, test: (x: BE) => boolean): boolean => {
    if (test(e)) return !test(l.e!) && !isWire(l.e!);
    return diskEdges(v).some((o) => test(o) && !isWire(o));
  };
  const markCheck = (v: BV, e: BE, l: BL): boolean =>
    (delimit.has("seam") && byMark(v, e, l, marks.seam)) || (delimit.has("sharp") && byMark(v, e, l, marks.sharp));

  const push = (from: LoopState, cur: BE, lastv: BV): void => {
    stack.push({ cur, lastv, start: from.start, startv: from.startv, isBoundary: from.isBoundary, isSingle: from.isSingle, fHub: from.fHub });
    visit.add(cur);
  };

  /** `bmw_EdgeLoopWalker_step`: pops the top state, pushes what follows, returns the edge. */
  const step = (): BE => {
    const owalk = stack.pop()!;
    const e = owalk.cur;
    let l = e.l;
    if (owalk.fHub) {
      const v = otherVert(e, owalk.lastv);
      if (nonwireEdgeCount(v) === 3) {
        const lh = faceOtherVertLoop(owalk.fHub, owalk.lastv, v)!;
        const next = edgeExists(v, lh.v);
        if (next && !visit.has(next) && !isBoundary(next)) push(owalk, next, v);
      }
    } else if (!l) {
      for (const v of [e.v1, e.v2])
        for (const next of diskEdges(v)) if (!next.l && !visit.has(next)) push(owalk, next, v);
    } else if (!owalk.isBoundary) {
      const v = otherVert(e, owalk.lastv);
      const count = nonwireEdgeCount(v);
      let found: BL | null = l;
      if (count === 4 || count === 2) {
        const opposite = count / 2;
        let i = 0;
        do {
          found = otherEdgeLoop(found!, v);
          if (isManifold(found.e!)) found = found.rn!;
          else {
            found = null;
            break;
          }
        } while (++i !== opposite);
      } else found = null;
      if (found && markCheck(v, e, found)) found = null;
      if (found && found !== e.l && !visit.has(found.e!)) push(owalk, found.e!, v);
    } else {
      const v = otherVert(e, owalk.lastv);
      const count = nonwireEdgeCount(v);
      let cornerDelimit = false;
      if (delimit.has("innerCorners") && count > 3) cornerDelimit = true;
      if (delimit.has("outerCorners") && !cornerDelimit && count === 2 && !edgeIsSingle(e)) cornerDelimit = true;
      let found: BL | null = l;
      if (!cornerDelimit) {
        for (;;) {
          found = otherEdgeLoop(found!, v);
          if (isManifold(found.e!)) found = found.rn!;
          else if (isBoundary(found.e!)) break;
          else {
            found = null;
            break;
          }
        }
      }
      if (found && markCheck(v, e, found)) found = null;
      // Stop at delimiting n-gons here so that the rewind picks the right edge to start from.
      if (found && delimit.has("ngons") && owalk.isSingle !== edgeIsSingle(found.e!)) found = null;
      if (found && found !== e.l && !visit.has(found.e!)) push(owalk, found.e!, v);
    }
    return e;
  };

  // `bmw_EdgeLoopWalker_begin`.
  const isBoundarySeed = isBoundary(seed);
  const first: LoopState = {
    cur: seed,
    start: seed,
    lastv: seed.v1,
    startv: seed.v1,
    isBoundary: isBoundarySeed,
    isSingle: isBoundarySeed && edgeIsSingle(seed),
    fHub: null,
  };
  const faceCount = [seed.v1, seed.v2].map((v) => loopsOfVert(v).length);
  const edgeCount = [seed.v1, seed.v2].map(nonwireEdgeCount);
  // A face hub: an n-gon on one side of an edge with a vertex of three edges and three faces.
  if (!first.isBoundary && ((edgeCount[0] === 3 && faceCount[0] === 3) || (edgeCount[1] === 3 && faceCount[1] === 3))) {
    let best: BF | null = null;
    for (const l of radialLoops(seed)) if (!best || best.len < l.f.len) best = l.f;
    first.fHub = best && best.len > 4 ? best : null;
  }
  stack.push(first);
  visit.add(seed);
  // Rewind: walk to the far end.
  let owalk = first;
  while (stack.length > 0) {
    owalk = { ...stack[stack.length - 1]! };
    step();
  }
  stack.push({ ...owalk, lastv: otherVert(owalk.cur, owalk.lastv), startv: otherVert(owalk.cur, owalk.lastv) });
  visit = new Set([owalk.cur]);

  const out = new Set<BE>();
  out.add(stack[stack.length - 1]!.cur);
  while (stack.length > 0) out.add(step());
  return out;
}

/** `BMW_EDGELOOP_NONMANIFOLD` from `seed`: along edges with the same number of faces (more than two). */
function walkNonManifoldLoop(seed: BE): Set<BE> {
  const visit = new Set<BE>([seed]);
  const out = new Set<BE>([seed]);
  const faceCount = radialLoops(seed).length;
  const isLoopManifold = (l: BL): boolean => l !== l.rn && l === l.rn!.rn;
  const findNext = (l0: BL, v: BV): BL | null => {
    let l = l0;
    for (;;) {
      l = otherEdgeLoop(l, v);
      if (isLoopManifold(l)) l = l.rn!;
      else if (radialLoops(l.e!).length === faceCount) return l;
      else return null;
    }
  };
  let cur = seed;
  let lastv = seed.v1;
  for (;;) {
    let next: BL | null = null;
    let v = otherVert(cur, lastv);
    for (let pass = 0; pass < 2; pass++) {
      const e = pass === 1 ? seed : cur;
      v = pass === 1 ? seed.v1 : otherVert(cur, lastv);
      for (const l of radialLoops(e)) {
        const candidate = findNext(l, v);
        if (candidate && !visit.has(candidate.e!)) {
          if (!next) next = candidate;
          else if (next.e !== candidate.e) {
            // More than one way on: a junction, so this pass finds nothing (and the other direction is tried).
            next = null;
            break;
          }
        }
      }
      if (next) break;
    }
    if (!next) break;
    cur = next.e!;
    lastv = v;
    visit.add(cur);
    out.add(cur);
  }
  return out;
}

// ── edge ring ──────────────────────────────────────────────────────────────

interface RingState {
  l: BL | null;
  wireedge: BE | null;
  noCalc: boolean;
}

/** `BMW_EDGERING` from `seed`: the edges it yields. */
function walkEdgeRing(seed: BE, delimit: ReadonlySet<EdgeRingDelimit>, marks: Marks): Set<BE> {
  const stack: RingState[] = [];
  let visit = new Set<BE>();
  const ngon = delimit.has("ngons");
  const edgeOk = (e: BE): boolean => isBoundary(e) || isManifold(e);
  /** `bmw_EdgeringWalker_delimit_check`. */
  const delimitCheck = (e: BE): boolean => {
    if (!isManifold(e)) return false;
    if (delimit.has("seam") && marks.seam(e)) return true;
    if (delimit.has("sharp") && marks.sharp(e)) return true;
    if (delimit.has("material") && marks.material(e.l!.f) !== marks.material(e.l!.rn!.f)) return true;
    return false;
  };
  /** The ring takes the next face across: quads only with the n-gon delimiter, otherwise faces with an even number of sides. */
  const wrongSide = (l: BL): boolean => (ngon ? l.f.len !== 4 : l.f.len % 2 !== 0);

  const step = (): BE | null => {
    const owalk = stack.pop()!;
    let l = owalk.l;
    if (!l) return owalk.wireedge;
    const e = l.e!;
    if (!edgeOk(e) || owalk.noCalc) return e;
    let stepOk = false;
    if (ngon) {
      l = l.rn!;
      l = l.next.next;
      if (l.f.len !== 4 || !edgeOk(l.e!)) l = owalk.l!.next.next;
      stepOk = l.f.len === 4 && edgeOk(l.e!) && !visit.has(l.e!);
    } else {
      l = l.rn!;
      let i = l.f.len;
      const len = l.f.len;
      while (i > 0) {
        l = l.next;
        i -= 2;
      }
      if (len <= 0 || len % 2 !== 0 || !edgeOk(l.e!)) {
        l = owalk.l!;
        i = len;
        while (i > 0) {
          l = l.next;
          i -= 2;
        }
      }
      stepOk = l.f.len % 2 === 0 && edgeOk(l.e!) && !visit.has(l.e!);
    }
    if (stepOk) {
      stack.push({ l, wireedge: null, noCalc: delimitCheck(l.e!) });
      visit.add(l.e!);
    }
    return e;
  };

  // `bmw_EdgeringWalker_begin`.
  const first: RingState = { l: seed.l, wireedge: null, noCalc: false };
  if (!first.l) return new Set([seed]);
  // A delimiting edge is treated as a wire edge: only it is selected.
  if (delimitCheck(seed)) return new Set([seed]);
  stack.push(first);
  visit.add(first.l!.e!);
  let owalk = first;
  while (stack.length > 0) {
    owalk = { ...stack[stack.length - 1]! };
    step();
  }
  const turned: RingState = { ...owalk };
  if (wrongSide(turned.l!)) turned.l = turned.l!.rn!;
  stack.push(turned);
  visit = new Set([turned.l!.e!]);
  // Both sides are walked.
  if (turned.l!.rn !== turned.l && wrongSide(turned.l!)) stack.push({ l: turned.l!.rn!, wireedge: null, noCalc: false });

  const out = new Set<BE>();
  const top = stack[stack.length - 1]!;
  out.add(top.l ? top.l.e! : top.wireedge!);
  while (stack.length > 0) {
    const e = step();
    if (e) out.add(e);
  }
  return out;
}

// ── operators ──────────────────────────────────────────────────────────────

/**
 * Blender's Select ▸ Select Loops ▸ Edge Loops (`mesh.select_edge_loop_multi`): from each selected edge, the loop through it. An edge with more
 * than two faces takes the non-manifold walker instead. `delimit` is `delimit_edge_loop`: `seam` / `sharp` stop at marked edges, `ngons` at the
 * boundary of an n-gon, `outerCorners` / `innerCorners` at the corners of a boundary loop (default `outerCorners` and `ngons`, Blender's).
 * The mode's flush follows. Nothing happens with no edge selected.
 */
export function selectEdgeLoops(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { delimit?: readonly EdgeLoopDelimit[] } = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (sel.se.size === 0) return sel.result();
  const delimit = new Set(options.delimit ?? LOOP_DEFAULT);
  const marks = marksOf(mesh);
  const edges = liveEdges(sel.bm).filter((e) => sel.se.has(e));
  for (const e of edges) {
    const walked = radialLoops(e).length > 2 ? walkNonManifoldLoop(e) : walkEdgeLoop(e, delimit, marks);
    for (const x of walked) sel.edge(x);
  }
  sel.flush(mode);
  return sel.result();
}

/**
 * Blender's Select ▸ Select Loops ▸ Edge Rings (`mesh.select_edge_ring_multi`): from each selected edge, the ring across the faces. `delimit` is
 * `delimit_edge_ring`: `seam` / `sharp` / `material` stop at a marked edge or a change of material (a delimiting seed is selected alone), `ngons`
 * keeps to quads (default, Blender's) — without it the ring crosses n-gons with an even number of sides.
 */
export function selectEdgeRings(
  mesh: MeshData,
  mode: SelectMode,
  seed: SelectionSeed,
  options: { delimit?: readonly EdgeRingDelimit[] } = {},
): MeshSelection {
  const sel = new Selection(mesh, seed, mode);
  if (sel.se.size === 0) return sel.result();
  const delimit = new Set(options.delimit ?? RING_DEFAULT);
  const marks = marksOf(mesh);
  const edges = liveEdges(sel.bm).filter((e) => sel.se.has(e));
  for (const e of edges) for (const x of walkEdgeRing(e, delimit, marks)) sel.edge(x);
  sel.flush(mode);
  return sel.result();
}

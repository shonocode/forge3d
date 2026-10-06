/**
 * The patches Blender's OpenSubdiv evaluator puts on the limit surface, for
 * Subdivision Surface levels **above** `quality` (compat-backlog C28).
 *
 * Blender refines adaptively to the isolation level `quality` and evaluates
 * every vertex of the subdivided mesh on a patch of that refinement
 * (`intern/opensubdiv/internal/evaluator/evaluator_impl.cc`: `RefineAdaptive`,
 * `ENDCAP_GREGORY_BASIS`, `useInfSharpPatch`). At or below `quality` the
 * vertices are patch corners, which is the limit mask (`limitPositions` in
 * `subdivide.ts`); above it they fall inside the patches:
 *
 *  - a face whose four corners are regular is a bicubic B-spline, its missing
 *    rows extrapolated across the boundary — the limit surface itself;
 *  - a face at an extraordinary vertex is a Gregory patch, whose 20 points
 *    OpenSubdiv derives from the 1-rings of its corners. Near the
 *    extraordinary vertex it is **not** the limit surface.
 *
 * A boundary vertex with one face is read as a sharp corner (Far's
 * `generateLegacySharpCornerPatches`, on by default: `approxSmoothCornerWithSharp`
 * in `patchBuilder.cpp`) — which is why such a corner sits where `quality`
 * rounds of refinement put it.
 *
 * Ported from OpenSubdiv 3.7.0 (the version Blender 5.1.1 builds) — Copyright
 * 2013 Pixar, Copyright 2018 DreamWorks Animation LLC, licensed under the
 * Tomorrow Open Source Technology License 1.0 (https://opensubdiv.org/license);
 * altered: translated to TypeScript, the patch points computed directly
 * rather than as a sparse matrix — see NOTICE.md: `far/catmarkPatchBuilder.cpp`
 * (`CatmarkLimits`, `GregoryConverter`), `far/patchBasis.cpp`
 * (`EvalBasisBSpline`, `EvalBasisGregory`) and the regular-patch test of
 * `far/patchBuilder.cpp` (`IsPatchRegular`). Creases and face-varying data
 * are not ported.
 */

type Vec = [number, number, number];

/** One corner of a level-`quality` face, as `GregoryConverter` sees it. */
interface Corner {
  v: number;
  isBoundary: boolean;
  /** A boundary vertex with one face — sharpened, see the module comment. */
  isSharp: boolean;
  isRegular: boolean;
  numFaces: number;
  valence: number;
  /** The index of the patch face among the corner's faces. */
  faceInRing: number;
  /** Edge ends and face diagonals in turn: e0, d0, e1, d1, … (and the last edge on a boundary). */
  ring: number[];
  cos: number;
}

/** Where a vertex of the fine mesh lies: a face of the `quality` mesh and its (u, v) there. */
export interface PatchParam {
  face: number;
  u: number;
  v: number;
}

/**
 * Evaluate the patches of the level-`quality` mesh (`P` / `polys`, all quads)
 * at `params`, one per output vertex.
 */
export function evaluatePatches(P: Float32Array, polys: number[][], params: PatchParam[]): Float32Array {
  const pos = (i: number): Vec => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
  // Directed edge a→b → the face that has it.
  const half = new Map<string, number>();
  polys.forEach((p, f) => {
    if (p.length !== 4) throw new Error("evaluatePatches: the quality mesh must be all quads.");
    p.forEach((a, i) => {
      const key = `${a},${p[(i + 1) % 4]}`;
      if (half.has(key)) throw new Error("catmullClark: limitSurface at a non-manifold or inconsistently wound edge is not measured.");
      half.set(key, f);
    });
  });
  const faceCount = new Map<number, number>();
  for (const p of polys) for (const v of p) faceCount.set(v, (faceCount.get(v) ?? 0) + 1);
  const next = (f: number, v: number): number => {
    const p = polys[f]!;
    return p[(p.indexOf(v) + 1) % 4]!;
  };
  const prev = (f: number, v: number): number => {
    const p = polys[f]!;
    return p[(p.indexOf(v) + 3) % 4]!;
  };

  const cornerOf = (f: number, v: number): Corner => {
    // Rotate back across the edge to `next` until the boundary (or round).
    let first = f;
    let isBoundary = false;
    for (let guard = 0; ; guard++) {
      const g = half.get(`${next(first, v)},${v}`);
      if (g === undefined) {
        isBoundary = true;
        break;
      }
      if (g === f) break;
      first = g;
      if (guard > polys.length) throw new Error("evaluatePatches: a vertex ring does not close.");
    }
    if (!isBoundary) first = f;
    const faces: number[] = [];
    for (let g: number | undefined = first; g !== undefined; ) {
      faces.push(g);
      g = half.get(`${v},${prev(g, v)}`);
      if (g === first) break;
      if (faces.length > polys.length) throw new Error("evaluatePatches: a vertex ring does not close.");
    }
    const ring: number[] = [];
    for (const g of faces) {
      const p = polys[g]!;
      ring.push(next(g, v), p[(p.indexOf(v) + 2) % 4]!);
    }
    if (isBoundary) ring.push(prev(faces[faces.length - 1]!, v));
    const numFaces = faces.length;
    if (numFaces !== faceCount.get(v))
      throw new Error("catmullClark: limitSurface at a non-manifold vertex is not measured.");
    const isSharp = isBoundary && numFaces === 1;
    const isRegular = numFaces << (isBoundary ? 1 : 0) === 4 && !isSharp;
    const angle = isRegular ? Math.PI / 2 : (isBoundary ? Math.PI : 2 * Math.PI) / numFaces;
    return {
      v,
      isBoundary,
      isSharp,
      isRegular,
      numFaces,
      valence: numFaces + (isBoundary ? 1 : 0),
      faceInRing: faces.indexOf(f),
      ring,
      cos: isRegular ? 0 : Math.cos(angle),
    };
  };

  type Patch = { kind: "bspline"; points: (number | -1)[]; boundary: number } | { kind: "gregory"; points: Vec[] };
  const patches = new Map<number, Patch>();
  const patchOf = (f: number): Patch => {
    let patch = patches.get(f);
    if (patch) return patch;
    const corners = polys[f]!.map((v) => cornerOf(f, v));
    // IsPatchRegular: every corner regular, a one-face corner counting as a sharp (regular) corner.
    patch = corners.every((c) => c.isRegular || c.isSharp)
      ? bsplinePatch(polys[f]!, corners)
      : { kind: "gregory", points: gregoryPoints(corners, pos) };
    patches.set(f, patch);
    return patch;
  };

  const out = new Float32Array(params.length * 3);
  params.forEach((param, i) => {
    if (param.face < 0) return;
    const patch = patchOf(param.face);
    const p: Vec = [0, 0, 0];
    if (patch.kind === "bspline") {
      const w = bsplineWeights(param.u, param.v, patch.boundary);
      patch.points.forEach((pi, k) => {
        if (w[k] === 0) return;
        if (pi < 0) throw new Error("evaluatePatches: a B-spline point is missing inside the boundary.");
        addScaled(p, pos(pi), w[k]!);
      });
    } else {
      const w = gregoryWeights(param.u, param.v);
      patch.points.forEach((pt, k) => addScaled(p, pt, w[k]!));
    }
    out.set(p, i * 3);
  });
  return out;
}

function addScaled(acc: Vec, p: Vec, s: number): void {
  acc[0] += p[0] * s;
  acc[1] += p[1] * s;
  acc[2] += p[2] * s;
}

/**
 * The 16 points of a regular face, row-major with s along corner 0 → 1 and t
 * along corner 0 → 3 (the face at the middle four), and the boundary mask of
 * the sides whose row is missing (1: t = 0, 2: s = 1, 4: t = 1, 8: s = 0).
 */
function bsplinePatch(face: number[], corners: Corner[]): { kind: "bspline"; points: (number | -1)[]; boundary: number } {
  const points: (number | -1)[] = new Array(16).fill(-1);
  // Corner 0's ring laid out by offset from the patch face: edge k and the diagonal of face k.
  const edgeAt: [number, number][] = [[2, 1], [1, 2], [0, 1], [1, 0]];
  const diagAt: [number, number][] = [[2, 2], [0, 2], [0, 0], [2, 0]];
  const rotate = ([x, y]: [number, number], c: number): [number, number] => {
    for (let i = 0; i < c; i++) [x, y] = [3 - y, x];
    return [x, y];
  };
  const put = (xy: [number, number], v: number): void => {
    points[xy[1] * 4 + xy[0]] = v;
  };
  corners.forEach((corner, c) => {
    put(rotate([1, 1], c), face[c]!);
    const edges = corner.isBoundary ? corner.valence : corner.numFaces;
    for (let i = 0; i < edges; i++) {
      const k = (((i - corner.faceInRing) % 4) + 4) % 4;
      put(rotate(edgeAt[k]!, c), corner.ring[2 * i]!);
      if (i < corner.numFaces) put(rotate(diagAt[k]!, c), corner.ring[2 * i + 1]!);
    }
  });
  let boundary = 0;
  if (points[1] === -1 && points[2] === -1) boundary |= 1;
  if (points[7] === -1 && points[11] === -1) boundary |= 2;
  if (points[13] === -1 && points[14] === -1) boundary |= 4;
  if (points[4] === -1 && points[8] === -1) boundary |= 8;
  return { kind: "bspline", points, boundary };
}

/** `EvalBasisBSpline` with `boundBasisBSpline`'s phantom points. */
function bsplineWeights(s: number, t: number, boundary: number): number[] {
  const curve = (x: number): number[] => {
    const x2 = x * x;
    const x3 = x * x2;
    return [(1 - 3 * (x - x2) - x3) / 6, (4 - 6 * x2 + 3 * x3) / 6, (1 + 3 * (x + x2 - x3)) / 6, x3 / 6];
  };
  const sw = curve(s);
  const tw = curve(t);
  const w: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) w.push(sw[j]! * tw[i]!);
  if (boundary & 1)
    for (let i = 0; i < 4; i++) {
      w[i + 8]! -= w[i]!;
      w[i + 4]! += w[i]! * 2;
      w[i] = 0;
    }
  if (boundary & 2)
    for (let i = 0; i < 16; i += 4) {
      w[i + 1]! -= w[i + 3]!;
      w[i + 2]! += w[i + 3]! * 2;
      w[i + 3] = 0;
    }
  if (boundary & 4)
    for (let i = 0; i < 4; i++) {
      w[i + 4]! -= w[i + 12]!;
      w[i + 8]! += w[i + 12]! * 2;
      w[i + 12] = 0;
    }
  if (boundary & 8)
    for (let i = 0; i < 16; i += 4) {
      w[i + 2]! -= w[i]!;
      w[i + 1]! += w[i]! * 2;
      w[i] = 0;
    }
  return w;
}

/** `EvalBasisGregory`: the 20 weights, five per corner (P, Ep, Em, Fp, Fm). */
function gregoryWeights(s: number, t: number): number[] {
  const bez = (x: number): number[] => {
    const xc = 1 - x;
    return [xc * xc * xc, xc * xc * x * 3, x * x * xc * 3, x * x * x];
  };
  const Bs = bez(s);
  const Bt = bez(t);
  const sC = 1 - s;
  const tC = 1 - t;
  const inv = (d: number): number => (d <= 0 ? 1 : 1 / d);
  const df0 = inv(s + t);
  const df1 = inv(sC + t);
  const df2 = inv(sC + tC);
  const df3 = inv(s + tC);
  const G = [s * df0, 1 - s * df0, t * df1, 1 - t * df1, sC * df2, 1 - sC * df2, tC * df3, 1 - tC * df3];
  const boundaryGregory = [0, 1, 7, 5, 2, 6, 16, 12, 15, 17, 11, 10];
  const boundaryS = [0, 1, 2, 3, 0, 3, 0, 3, 0, 1, 2, 3];
  const boundaryT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3];
  const interiorGregory = [3, 4, 8, 9, 13, 14, 18, 19];
  const interiorS = [1, 1, 2, 2, 2, 2, 1, 1];
  const interiorT = [1, 1, 1, 1, 2, 2, 2, 2];
  const w = new Array<number>(20).fill(0);
  for (let i = 0; i < 12; i++) w[boundaryGregory[i]!] = Bs[boundaryS[i]!]! * Bt[boundaryT[i]!]!;
  for (let i = 0; i < 8; i++) w[interiorGregory[i]!] = Bs[interiorS[i]!]! * Bt[interiorT[i]!]! * G[i]!;
  return w;
}

/** `CatmarkLimits::computeCoefficient`. */
function tangentCoefficient(valence: number): number {
  const table = [
    0.0, 0.0, 0.0, 8.1281572906372312e-1, 0.5, 3.6364406329142801e-1, 2.8751379706077085e-1, 2.3868786685851678e-1,
    2.0454364190756097e-1, 1.7922903958061159e-1, 1.5965737079986253e-1, 1.4404233443011302e-1, 1.3127568415883017e-1,
    1.2063172212675841e-1, 1.116143750667693e-1, 1.0387245516114274e-1, 9.7150019090724835e-2, 9.1255917505950648e-2,
    8.6044378511602668e-2, 8.1402211336798411e-2, 7.7240129516184072e-2, 7.3486719751997026e-2, 7.0084157479797987e-2,
    6.698510403072544e-2, 6.4150420569810074e-2, 6.1547457638637268e-2, 5.9148757447233989e-2, 5.6931056818776957e-2,
    5.4874512279256417e-2, 5.2962091433796134e-2,
  ];
  if (valence < 30) return table[valence]!;
  const inv = 1 / valence;
  const cosT = Math.cos(2 * Math.PI * inv);
  return (16 * inv) / (cosT + 5 + Math.sqrt((cosT + 9) * (cosT + 1)));
}

/**
 * `CatmarkLimits::ComputeInteriorPointWeights`: weights over the corner and
 * its ring (index 0 the corner, i ≥ 1 ring[i − 1]) for P, Ep and Em.
 */
function interiorWeights(valence: number, faceInRing: number): [number[], number[], number[]] {
  const oneOverValence = 1 / valence;
  const oneOverValPlus5 = 1 / (valence + 5);
  const pCoeff = oneOverValence * oneOverValPlus5;
  const tanCoeff = tangentCoefficient(valence) * 0.5 * oneOverValPlus5;
  const faceAngle = 2 * Math.PI * oneOverValence;
  const width = 1 + 2 * valence;
  const p = new Array<number>(width).fill(0);
  const tan = new Array<number>(width).fill(0);
  p[0] = valence * oneOverValPlus5;
  for (let i = 0; i < valence; i++) {
    p[1 + 2 * i] = pCoeff * 4;
    p[1 + 2 * i + 1] = pCoeff;
    const iPrev = (i + valence - 1) % valence;
    const iNext = (i + 1) % valence;
    const c = tanCoeff * Math.cos(faceAngle * i);
    tan[1 + 2 * iPrev]! += c * 2;
    tan[1 + 2 * iPrev + 1]! += c;
    tan[1 + 2 * i]! += c * 4;
    tan[1 + 2 * i + 1]! += c;
    tan[1 + 2 * iNext]! += c * 2;
  }
  const epOffset = 2 * ((valence - faceInRing) % valence);
  const emOffset = 2 * ((valence - faceInRing - 1 + valence) % valence);
  const ep = [p[0]!];
  const em = [p[0]!];
  for (let i = 1; i < width; i++) {
    let ip = i + epOffset;
    if (ip >= width) ip -= width - 1;
    let im = i + emOffset;
    if (im >= width) im -= width - 1;
    ep.push(p[i]! + tan[ip]!);
    em.push(p[i]! + tan[im]!);
  }
  return [p, ep, em];
}

/** `CatmarkLimits::ComputeBoundaryPointWeights`, indexed as {@link interiorWeights}. */
function boundaryWeights(valence: number, faceInRing: number): [number[], number[], number[]] {
  const numFaces = valence - 1;
  const faceAngle = Math.PI / numFaces;
  const width = 2 * valence;
  const N = width - 1;
  const p = new Array<number>(width).fill(0);
  p[0] = 4 / 6;
  p[1] = 1 / 6;
  p[N] = 1 / 6;
  const tan = new Array<number>(width).fill(0);
  const k = numFaces;
  const c = Math.cos(faceAngle);
  const s = Math.sin(faceAngle);
  const div3 = 1 / 3;
  const div3kc = 1 / (3 * k + c);
  const gamma = -4 * s * div3kc;
  const alpha0k = (-((1 + 2 * c) * Math.sqrt(1 + c)) * div3kc) / Math.sqrt(1 - c);
  const beta0 = s * div3kc;
  tan[0] = gamma * div3;
  tan[1] = alpha0k * div3;
  tan[2] = beta0 * div3;
  tan[N] = alpha0k * div3;
  for (let i = 1; i < valence - 1; i++) {
    const sinI = Math.sin(faceAngle * i);
    const sinI1 = Math.sin(faceAngle * (i + 1));
    tan[1 + 2 * i] = 4 * sinI * div3kc * div3;
    tan[1 + 2 * i + 1] = (sinI + sinI1) * div3kc * div3;
  }
  const along = (edge: number): number[] => {
    const ca = Math.cos(faceAngle * edge);
    const sa = Math.sin(faceAngle * edge);
    const w = tan.map((x) => x * sa);
    w[0]! += p[0]!;
    w[1]! += p[1]! + (1 / 6) * ca;
    w[N]! += p[N]! + (-1 / 6) * ca;
    return w;
  };
  let ep: number[];
  if (faceInRing === 0) {
    ep = new Array<number>(width).fill(0);
    ep[0] = 2 / 3;
    ep[1] = 1 / 3;
  } else ep = along(faceInRing);
  let em: number[];
  if (faceInRing === numFaces - 1) {
    em = new Array<number>(width).fill(0);
    em[0] = 2 / 3;
    em[N] = 1 / 3;
  } else em = along((faceInRing + 1) % valence);
  return [p, ep, em];
}

/** `GregoryConverter`: the 20 points of the patch, corner by corner (P, Ep, Em, Fp, Fm). */
function gregoryPoints(corners: Corner[], pos: (i: number) => Vec): Vec[] {
  const combine = (terms: [number, number][]): Vec => {
    const out: Vec = [0, 0, 0];
    for (const [v, w] of terms) addScaled(out, pos(v), w);
    return out;
  };
  const ringTerms = (c: Corner, w: number[]): [number, number][] =>
    w.map((x, i): [number, number] => [i === 0 ? c.v : c.ring[i - 1]!, x]);
  const P: Vec[] = [];
  const Ep: Vec[] = [];
  const Em: Vec[] = [];
  const corner = (c: number): Corner => corners[c & 3]!;
  corners.forEach((c, ci) => {
    const r = c.ring;
    const nextV = corner(ci + 1).v;
    const prevV = corner(ci + 3).v;
    if (c.isRegular && !c.isBoundary) {
      const f = c.faceInRing;
      const iEp = 2 * f;
      const iEm = 2 * ((f + 1) & 3);
      const iOp = 2 * ((f + 2) & 3);
      const iOm = 2 * ((f + 3) & 3);
      P.push(combine([[c.v, 4 / 9], [r[0]!, 1 / 9], [r[2]!, 1 / 9], [r[4]!, 1 / 9], [r[6]!, 1 / 9],
        [r[1]!, 1 / 36], [r[3]!, 1 / 36], [r[5]!, 1 / 36], [r[7]!, 1 / 36]]));
      Ep.push(combine([[c.v, 4 / 9], [r[iEp]!, 2 / 9], [r[iEm]!, 1 / 9], [r[iOm]!, 1 / 9], [r[iEp + 1]!, 1 / 18], [r[iOm + 1]!, 1 / 18]]));
      Em.push(combine([[c.v, 4 / 9], [r[iEm]!, 2 / 9], [r[iEp]!, 1 / 9], [r[iOp]!, 1 / 9], [r[iEp + 1]!, 1 / 18], [r[iEm + 1]!, 1 / 18]]));
    } else if (c.isRegular) {
      const epOnBoundary = c.faceInRing === 0;
      const iBoundary = epOnBoundary ? 0 : 4;
      P.push(combine([[c.v, 2 / 3], [r[0]!, 1 / 6], [r[4]!, 1 / 6]]));
      const eBoundary = combine([[c.v, 2 / 3], [r[iBoundary]!, 1 / 3]]);
      const eInterior = combine([[c.v, 4 / 9], [r[2]!, 2 / 9], [r[0]!, 1 / 9], [r[4]!, 1 / 9], [r[1]!, 1 / 18], [r[3]!, 1 / 18]]);
      Ep.push(epOnBoundary ? eBoundary : eInterior);
      Em.push(epOnBoundary ? eInterior : eBoundary);
    } else if (c.isSharp) {
      P.push(pos(c.v));
      Ep.push(combine([[c.v, 2 / 3], [nextV, 1 / 3]]));
      Em.push(combine([[c.v, 2 / 3], [prevV, 1 / 3]]));
    } else if (!c.isBoundary) {
      const [p, ep, em] = interiorWeights(c.valence, c.faceInRing);
      P.push(combine(ringTerms(c, p)));
      Ep.push(combine(ringTerms(c, ep)));
      Em.push(combine(ringTerms(c, em)));
    } else {
      const [p, ep, em] = boundaryWeights(c.valence, c.faceInRing);
      P.push(combine(ringTerms(c, p)));
      Ep.push(combine(ringTerms(c, ep)));
      Em.push(combine(ringTerms(c, em)));
    }
  });

  // Face points: regular ones from the four corners, the rest from P, Ep, Em and the ring across the edge.
  const regularFace = (ci: number): Vec =>
    combine([[corner(ci).v, 4 / 9], [corner(ci + 3).v, 2 / 9], [corner(ci + 1).v, 2 / 9], [corner(ci + 2).v, 1 / 9]]);
  const irregularFace = (ci: number, edge: number, far: number, eNear: Vec, eFar: Vec, sign: number): Vec => {
    const near = corner(ci);
    const cosNear = near.cos;
    const cosFar = corner(far).cos;
    const out: Vec = [0, 0, 0];
    addScaled(out, P[ci]!, cosFar / 3);
    addScaled(out, eNear, (3 - 2 * cosNear - cosFar) / 3);
    addScaled(out, eFar, (2 * cosNear) / 3);
    const n = near.valence;
    const iPrev = (edge + n - 1) % n;
    const iNext = (edge + 1) % n;
    const r = near.ring;
    addScaled(out, pos(r[2 * iPrev]!), -sign / 9);
    addScaled(out, pos(r[2 * iPrev + 1]!), -sign / 18);
    addScaled(out, pos(r[2 * edge + 1]!), sign / 18);
    addScaled(out, pos(r[2 * iNext]!), sign / 9);
    return out;
  };
  const points: Vec[] = [];
  corners.forEach((c, ci) => {
    const nextC = corner(ci + 1);
    const prevC = corner(ci + 3);
    let fpRegular = c.isRegular && nextC.isRegular;
    let fmRegular = c.isRegular && prevC.isRegular;
    let fpCopied = false;
    let fmCopied = false;
    if (c.isBoundary) {
      const epOnBoundary = c.faceInRing === 0;
      const emOnBoundary = c.faceInRing === c.numFaces - 1;
      if (c.numFaces > 1) {
        if (epOnBoundary) {
          fpRegular = fmRegular;
          fpCopied = !fpRegular;
        }
        if (emOnBoundary) {
          fmRegular = fpRegular;
          fmCopied = !fmRegular;
        }
      } else {
        fpRegular = true;
        fmRegular = true;
      }
    }
    let fp: Vec | undefined = fpRegular ? regularFace(ci) : undefined;
    let fm: Vec | undefined = fmRegular ? regularFace(ci) : undefined;
    if (!fpRegular && !fpCopied) fp = irregularFace(ci, c.faceInRing, ci + 1, Ep[ci]!, Em[(ci + 1) & 3]!, 1);
    if (!fmRegular && !fmCopied) fm = irregularFace(ci, (c.faceInRing + 1) % c.valence, ci + 3, Em[ci]!, Ep[(ci + 3) & 3]!, -1);
    if (fpCopied) fp = fm;
    if (fmCopied) fm = fp;
    points.push(P[ci]!, Ep[ci]!, Em[ci]!, fp!, fm!);
  });
  return points;
}

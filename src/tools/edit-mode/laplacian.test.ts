import { describe, it, expect } from "vitest";
import { smoothLaplacianVert } from "./laplacian";
import type { MeshData } from "../../lib/mesh";

// Every expected number below is Blender 5.1.1, printed by
// tools/modeling/parity/probe-laplacian-fixtures.py and the probes beside it.
// The tolerance is 1e-6 because Blender stores coordinates in float32 — a
// mesh handed to it through `from_pydata` comes back with its own input
// rounded, so nothing here can be pinned tighter than that.
const EPS = 1e-6;

const at = (m: MeshData, v: number): [number, number, number] => [
  m.positions[v * 3]!,
  m.positions[v * 3 + 1]!,
  m.positions[v * 3 + 2]!,
];

function expectClose(got: readonly number[], want: readonly number[], what: string): void {
  for (let k = 0; k < 3; k++) expect(got[k]!, `${what}[${k}]`).toBeCloseTo(want[k]!, 6);
}

/** A regular hexagonal fan, apex 0.3 above the origin. The rim is boundary. */
function fan(angles: number[], radii: number[], h = 0.3): MeshData {
  const positions = [0, 0, h];
  for (let i = 0; i < angles.length; i++) {
    const a = (angles[i]! * Math.PI) / 180;
    positions.push(radii[i]! * Math.cos(a), radii[i]! * Math.sin(a), 0);
  }
  const polys: number[][] = [];
  for (let i = 1; i <= angles.length; i++)
    polys.push([0, i, i < angles.length ? i + 1 : 1]);
  return { positions: new Float32Array(positions), polys };
}

const REGULAR = (): MeshData => fan([0, 60, 120, 180, 240, 300], [1, 1, 1, 1, 1, 1]);
const IRREGULAR = (): MeshData =>
  fan([0, 50, 110, 165, 235, 300], [1.0, 0.6, 1.3, 0.9, 1.1, 0.7]);

/** The 4x4 checkerboard sheet, as triangles or as quads. */
function sheet(quads: boolean, n = 4, size = 2, bump = 0.25): MeshData {
  const positions: number[] = [];
  for (let r = 0; r <= n; r++)
    for (let c = 0; c <= n; c++)
      positions.push((c * size) / n - size / 2, (r * size) / n - size / 2,
        (r + c) % 2 ? bump : -bump);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const a = r * (n + 1) + c;
      if (quads) polys.push([a, a + 1, a + n + 2, a + n + 1]);
      else {
        polys.push([a, a + 1, a + n + 2]);
        polys.push([a, a + n + 2, a + n + 1]);
      }
    }
  return { positions: new Float32Array(positions), polys };
}

describe("smoothLaplacianVert", () => {
  it("is an implicit solve, not an explicit step", () => {
    // The apex of a regular fan, at three values of lambda. An explicit step
    // would be linear in lambda; these are 1/(1+L*lambda), which is what
    // first said the operator solves a system.
    for (const [lambda, z] of [
      [0.5, 0.29552168],
      [1.0, 0.29117507],
      [2.0, 0.28285447],
    ] as const) {
      const out = smoothLaplacianVert(REGULAR(), { lambda });
      expect(at(out, 0)[2], `lambda ${lambda}`).toBeCloseTo(z, 6);
    }
  });

  it("holds the boundary", () => {
    const before = REGULAR();
    const out = smoothLaplacianVert(before, { lambda: 1 });
    for (let v = 1; v <= 6; v++) expectClose(at(out, v), at(before, v), `rim ${v}`);
  });

  it("gates each axis on its own, after the solve", () => {
    // Blender, on the irregular fan: all axes give
    // (-0.000356, -0.000095, 0.289723), and each flag on its own gives that
    // component with the others left alone. A gate applied *before* the solve
    // would change the answer, not just mask it.
    const all = smoothLaplacianVert(IRREGULAR(), { lambda: 1 });
    expectClose(at(all, 0), [-0.000356, -0.000095, 0.289723], "all axes");

    const x = smoothLaplacianVert(IRREGULAR(), { lambda: 1, useY: false, useZ: false });
    expectClose(at(x, 0), [-0.000356, 0, 0.3], "x only");
    const y = smoothLaplacianVert(IRREGULAR(), { lambda: 1, useX: false, useZ: false });
    expectClose(at(y, 0), [0, -0.000095, 0.3], "y only");
    const z = smoothLaplacianVert(IRREGULAR(), { lambda: 1, useX: false, useY: false });
    expectClose(at(z, 0), [0, 0, 0.289723], "z only");
  });

  it("couples interior vertices — it is one solve over the whole sheet", () => {
    // A fan's one interior vertex decouples, so it cannot tell a solve from a
    // sweep. Here v6, v7 and v12 all move and all pull on each other.
    const out = smoothLaplacianVert(sheet(false), { lambda: 1 });
    expectClose(at(out, 6), [-0.49999997, -0.49999997, -0.23010352], "v6");
    expectClose(at(out, 7), [0, -0.49999997, 0.23030357], "v7");
    expectClose(at(out, 12), [0, 0, -0.23029746], "v12");
    // the rim is boundary
    expectClose(at(out, 0), [-1, -1, -0.25], "v0");
    expectClose(at(out, 1), [-0.5, -1, 0.25], "v1");
  });

  it("treats a quad as both its triangulations, not one", () => {
    // The same sheet, same vertices, quads instead of triangles. Blender's
    // answer is **different** — -0.2213641 against -0.23010352 — and plain
    // triangulation either way round misses it by 1.4e-2, a hundred thousand
    // times the tolerance here.
    const out = smoothLaplacianVert(sheet(true), { lambda: 1 });
    expectClose(at(out, 6), [-0.5, -0.5, -0.2213641], "v6");
    expectClose(at(out, 7), [0, -0.5, 0.22157854], "v7");
    expectClose(at(out, 12), [0, 0, -0.22156581], "v12");

    const tris = smoothLaplacianVert(sheet(false), { lambda: 1 });
    expect(Math.abs(at(out, 6)[2] - at(tris, 6)[2])).toBeGreaterThan(0.008);
  });

  it("smooths a closed shell, where nothing is boundary", () => {
    // A subdivision-1 icosphere with vertex 0 pushed out to 1.4. Every vertex
    // is free, so the system has no pinned rows at all — the case where a
    // wrong solver drifts instead of converging.
    const ico = icosphere();
    const out = smoothLaplacianVert(ico, { lambda: 1 });
    expectClose(at(out, 0), [0, 0, -1.37524843], "the spike");
    expectClose(at(out, 1), [0.71152329, -0.51694578, -0.44115278], "v1");
    expectClose(at(out, 2), [-0.27177218, -0.83644295, -0.44115278], "v2");
    expectClose(at(out, 5), [0.71152329, 0.51694578, -0.44115278], "v5");
  });

  it("does not care where the mesh sits", () => {
    // Blender's own `lambda_border` fails this — it scales the rim toward the
    // world origin and gives up entirely past an offset of about 4 — which is
    // why this implementation does not offer it. With the border held, the
    // operator is exact under translation, measured at (10, -7, 3).
    const here = smoothLaplacianVert(REGULAR(), { lambda: 1 });
    const moved = REGULAR();
    for (let v = 0; v < moved.positions.length / 3; v++) {
      moved.positions[v * 3] += 10;
      moved.positions[v * 3 + 1] -= 7;
      moved.positions[v * 3 + 2] += 3;
    }
    const there = smoothLaplacianVert(moved, { lambda: 1 });
    expectClose(
      [at(there, 0)[0] - 10, at(there, 0)[1] + 7, at(there, 0)[2] - 3],
      at(here, 0),
      "translated",
    );
    // and Blender's own answer for the translated mesh
    expectClose(at(there, 0), [10, -7, 3.29117513], "against Blender");
  });

  it("lambda 0 changes nothing", () => {
    const before = REGULAR();
    const out = smoothLaplacianVert(before, { lambda: 0 });
    for (let v = 0; v < 7; v++) expectClose(at(out, v), at(before, v), `v${v}`);
  });

  it("carries the other layers through", () => {
    const base = sheet(false);
    const out = smoothLaplacianVert(
      { ...base, seams: new Set(["0-1"]), creases: new Map([["0-1", 0.5]]) },
      { lambda: 1 },
    );
    expect(out.seams).toEqual(new Set(["0-1"]));
    expect(out.creases).toEqual(new Map([["0-1", 0.5]]));
    expect(out.polys).toEqual(base.polys);
  });

  it("refuses an n-gon, because Blender's n-gon path is not measured", () => {
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0.5, 1.5, 0, 0, 1, 0]),
      polys: [[0, 1, 2, 3, 4]],
    };
    expect(() => smoothLaplacianVert(m)).toThrow(/5-gon/);
  });

  it("moves a near-degenerate pair exactly where Blender moves it", () => {
    // A 4x4 alternating sheet with two interior vertices brought 0.0005 apart
    // instead of a full 0.1 step. The solve pulls that edge to 79x its length
    // — far past `validate_solution`'s 1.8x ceiling — and **neither side
    // freezes them**, which is the case that says this implementation of the
    // clamps does not over-reject. Measured: probe-laplacian24.py.
    const nx = 4;
    const nz = 4;
    const step = 0.1;
    const bump = 0.05;
    const pts: number[][] = [];
    for (let r = 0; r <= nz; r++)
      for (let c = 0; c <= nx; c++)
        pts.push([c * step - 0.2, (r + c) % 2 ? bump : -bump, r * step - 0.2]);
    const a = 2 * (nx + 1) + 1;
    const b = a + 1;
    const mid = (pts[a]![0]! + pts[b]![0]!) / 2;
    pts[a]![0] = mid - 0.00025;
    pts[b]![0] = mid + 0.00025;
    const polys: number[][] = [];
    for (let r = 0; r < nz; r++)
      for (let c = 0; c < nx; c++)
        polys.push([
          r * (nx + 1) + c,
          (r + 1) * (nx + 1) + c,
          (r + 1) * (nx + 1) + c + 1,
          r * (nx + 1) + c + 1,
        ]);

    const out = smoothLaplacianVert({ positions: Float32Array.from(pts.flat()), polys });
    expectClose(at(out, a), [-0.065847, 0.012859, 0], "the near pair, first");
    expectClose(at(out, b), [-0.034196, -0.010813, 0], "the near pair, second");
    // and the corner of the sheet is still a corner
    expectClose(at(out, 0), [-0.2, -0.05, -0.2], "a pinned corner");
  });
});

/** The subdivision-1 icosphere the fixtures probe used, with v0 pushed out. */
function icosphere(): MeshData {
  const verts: number[][] = [
    [0, 0, -1.4], [0.7236, -0.52572, -0.447215], [-0.276385, -0.85064, -0.447215],
    [-0.894425, 0, -0.447215], [-0.276385, 0.85064, -0.447215],
    [0.7236, 0.52572, -0.447215], [0.276385, -0.85064, 0.447215],
    [-0.7236, -0.52572, 0.447215], [-0.7236, 0.52572, 0.447215],
    [0.276385, 0.85064, 0.447215], [0.894425, 0, 0.447215], [0, 0, 1],
  ];
  const polys = [
    [0, 1, 2], [1, 0, 5], [0, 2, 3], [0, 3, 4], [0, 4, 5],
    [1, 5, 10], [2, 1, 6], [3, 2, 7], [4, 3, 8], [5, 4, 9],
    [1, 10, 6], [2, 6, 7], [3, 7, 8], [4, 8, 9], [5, 9, 10],
    [6, 10, 11], [7, 6, 11], [8, 7, 11], [9, 8, 11], [10, 9, 11],
  ];
  return { positions: Float32Array.from(verts.flat()), polys };
}

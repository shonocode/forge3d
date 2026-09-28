import { describe, expect, it } from "vitest";
import { meshFromData } from "../../lib/mesh";
import { toPolygons } from "./half-edge";
import { connectVertPair, connectVertPath } from "./connect-pair";

/** `concaveL` of the parity inputs: an L-shaped prism, bottom face 0 1 2 3 4 5. */
function concaveL(): ReturnType<typeof meshFromData> {
  const outline = [[0, 0], [0.2, 0], [0.2, 0.1], [0.1, 0.1], [0.1, 0.2], [0, 0.2]] as const;
  const pos: number[] = [];
  for (const [x, z] of outline) pos.push(x, 0, z);
  for (const [x, z] of outline) pos.push(x, 0.1, z);
  const polys = [[0, 1, 2, 3, 4, 5], [11, 10, 9, 8, 7, 6], [0, 6, 7, 1], [1, 7, 8, 2], [2, 8, 9, 3], [3, 9, 10, 4], [4, 10, 11, 5], [5, 11, 6, 0]];
  return meshFromData({ positions: new Float32Array(pos), polys });
}

function grid(n: number): ReturnType<typeof meshFromData> {
  const pos: number[] = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) pos.push(c, 0, r);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) polys.push([r * (n + 1) + c, (r + 1) * (n + 1) + c, (r + 1) * (n + 1) + c + 1, r * (n + 1) + c + 1]);
  return meshFromData({ positions: new Float32Array(pos), polys });
}

const faceSet = (em: ReturnType<typeof meshFromData>): string[] =>
  toPolygons(em).map((p) => [...p].sort((a, b) => a - b).join(",")).sort();

describe("connectVertPair (bmo_connect_pair.cc)", () => {
  // Blender 5.1.1, `probe-connect-pair-concave.py`.
  it("leaves a concave face whole when the chord leaves it (BM_face_splits_check_legal)", () => {
    const em = concaveL();
    expect(connectVertPair(em, 2, 4).size).toBe(0);
    expect(em.faces).toHaveLength(8);
  });

  it("cuts a concave face where the chord stays inside", () => {
    const em = concaveL();
    connectVertPair(em, 1, 3);
    expect(faceSet(em)).toContain("1,2,3");
    expect(faceSet(em)).toContain("0,1,3,4,5");
  });

  it("walks round the prism to a vertex on the far cap", () => {
    // 0 to 9: a new vertex on edge 6–11, the side quad and both caps cut.
    const em = concaveL();
    connectVertPair(em, 0, 9);
    expect(em.vertices).toHaveLength(13);
    expect(faceSet(em)).toEqual(
      ["0,1,2,3,4,5", "0,1,6,7", "0,5,11,12", "0,6,12", "1,2,7,8", "2,3,8,9", "3,4,9,10", "4,5,10,11", "6,7,8,9,12", "9,10,11,12"],
    );
  });
});

describe("connectVertPath (MESH_OT_vert_connect_path)", () => {
  it("joins three vertices each to the next", () => {
    const em = grid(4);
    expect(connectVertPath(em, [0, 13, 21])).toBe(true);
    expect(em.vertices).toHaveLength(28);
    expect(em.faces).toHaveLength(22);
  });

  it("closes an open path of existing edges", () => {
    // 0–1 and 1–6 are edges; 0 and 6 are corners of one quad.
    const em = grid(4);
    expect(connectVertPath(em, [0, 1, 6])).toBe(true);
    expect(em.faces).toHaveLength(17);
  });

  it("reports a closed path it cannot add to", () => {
    const em = grid(4);
    expect(() => connectVertPath(em, [0, 1, 6, 5])).toThrow(/invalid selection order/);
  });

  it("refuses a vertex on no face", () => {
    const em = meshFromData({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 5, 5, 5]), polys: [[0, 1, 2, 3]] });
    expect(() => connectVertPath(em, [0, 4])).toThrow(/on no face/);
  });
});

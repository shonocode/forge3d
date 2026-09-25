# forge3d

A **modelling library you call from code**, and a browser GUI to look at what
it makes. Built on Babylon.js and TypeScript.

**Status: maintenance (since 2026-09-25).** The library matches Blender 5.1.1
wherever it claims to — measured, not assumed — and the GUI was rebuilt in
React. New work is fixes and small additions driven by use.

## The library

The public API is [`src/lib/index.ts`](src/lib/index.ts). Everything exported
there is headless: no DOM, no editor state, no scene. Callers are build
scripts, asset pipelines, and agents writing modelling code.

```ts
import { meshFromData, meshToData, extrudeFaces, catmullClark } from "forge3d";

const em = meshFromData({ positions, polys });
extrudeFaces(em, new Set([topFace]));
const { positions: p, polys: f, creases } = meshToData(em);
const smooth = catmullClark(p, f, 2, creases);
```

What it covers, compared with Blender 5.1.1 (details in the chiikawa-soul docs):

| Blender surface | Status |
|---|---|
| `bmesh.ops` (80 operators) | 76 match Blender, 1 implemented but unmeasurable (`create_vert`), 3 are type conversions with no counterpart |
| `bpy.ops.mesh`-only operators | 15 / 15 |
| Modifiers (36 mesh modifiers) | 31 present, all matching Blender. The rest need OpenVDB (Remesh Voxel, volume ↔ mesh) or a rest shape (Corrective Smooth, Laplacian Deform) |
| Procedural textures | Clouds, Wood, Marble, Magic, Blend, Stucci, Musgrave, Voronoi, Distorted Noise (not Noise: Blender seeds it from the clock) |

"Match" means a parity row: the same input through Blender and through
forge3d, compared vertex by vertex and face by face. The harness and every
row's notes live in the chiikawa-soul repository under
`tools/modeling/parity/`.

## The GUI

A React app (`src/app/`) over a Babylon viewport: edit mode, sculpt, texture
and weight paint, bones and animation, modifiers, import / export (GLB, glTF,
OBJ). Keyboard shortcuts follow Blender's (`src/keymap.ts`). Every tool, tab
and panel section carries a plain-language explanation, written once in
`src/app/guide/guide.ts`; [`MANUAL.html`](MANUAL.html) is generated from the
same text (`npm run manual`).

## Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm run test       # Vitest (node; React components under jsdom)
npm run build      # tsc && vite build — read tsc's output, its exit code is 0 even with errors
npm run manual     # regenerate MANUAL.html from the guide
npm run deploy     # build and deploy with wrangler
```

## License

**Not settled.** Much of `src/tools/` is ported from Blender's source
(GPL-2.0-or-later) and one part from OpenSubdiv (Apache-2.0), so forge3d is a
derivative work of GPL code and must be distributed under a compatible
licence — GPL-3.0-or-later is the one that also admits Apache-2.0. Until that
is decided, treat the repository as private.

## Where things are written down

In the chiikawa-soul repository (this one is checked out inside it):

- `docs/architecture/forge3d.md` — the entry point: state, how to change
  things safely, what is still open
- `docs/architecture/forge3d-blender-api-matrix.md`,
  `forge3d-blender-surface-map.md` — the Blender comparison tables
- `docs/architecture/adr-012` / `013` / `014` — boolean, remesh, and the React GUI
- `docs/architecture/archive/forge3d/` — the development-era roadmap and logs

In this repository, [`CLAUDE.md`](CLAUDE.md) holds the working rules.

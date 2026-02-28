# FORGE 3D

Browser-based 3D modeling, rigging, and animation tool built with Babylon.js.
Runs entirely in the browser as a Progressive Web App (PWA) — no server required.

## Features

- **Primitive Modeling** — Box, Sphere, Cylinder, Torus, Plane, Cone, Tube, Disc, Icosphere, Capsule
- **CSG Boolean Operations** — Union, Subtract, Intersect
- **Sculpt Mode** — 6 brush types: Push, Pull, Smooth, Flatten, Pinch, Inflate
- **Texture Paint** — Paint directly on mesh surfaces (DynamicTexture)
- **Morph Targets** — Capture mesh deformations as blend shapes
- **Skeleton & Rigging** — Create bone hierarchies, assign to meshes
- **Weight Painting** — Paint vertex weights with heatmap overlay
- **Keyframe Animation** — Record bone poses, easing curves, loop modes, preview playback
- **Modifier Stack** — Subdivision, Mirror, Array
- **Material Editor** — PBR material properties, color palettes
- **Lighting System** — Point and spot lights
- **Map Editor** — Place saved models in a scene, export/import layouts
- **Measurement Tool** — Distance between points
- **Layer System** — Organize meshes into layers
- **Post-Processing** — FXAA, Bloom, SSAO, Chromatic Aberration, Vignette
- **Import/Export** — GLB, glTF, OBJ, STL (drag & drop supported)
- **Save to Library** — Persistent browser storage (OPFS/IndexedDB)
- **Auto-Save** — Automatic checkpoint every 30 seconds with crash recovery
- **Undo/Redo** — Full undo support for all operations
- **Accessibility** — ARIA labels, keyboard navigation, focus management
- **PWA** — Installable, works offline

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

### Build

```bash
npm run build
```

### Test

```bash
npm run test
```

### Deploy (Cloudflare Pages)

```bash
npm run deploy
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| 3D Engine | Babylon.js 8.x |
| Language | TypeScript 5.9 (strict mode) |
| Build Tool | Vite 7.x |
| Testing | Vitest + fake-indexeddb |
| PWA | vite-plugin-pwa |
| Hosting | Cloudflare Pages |
| Storage | OPFS / IndexedDB |

## Architecture

```
src/
  main.ts              — Entry point, render loop
  state.ts             — Global state (single source of truth)
  input.ts             — Pointer/keyboard/touch event handling
  undo.ts              — Undo/redo history
  shaders.ts           — Centralized shader registration
  styles.css           — All styles (desktop + mobile responsive)

  viewport/
    viewport.ts        — Engine, scene, camera, gizmo setup
    camera-presets.ts   — Camera angle presets, orthographic toggle
    environment.ts     — HDRI environment
    shadows.ts         — Shadow generator
    shading.ts         — Viewport render modes (solid/wire/matcap/textured)
    postprocess.ts     — Post-processing pipeline

  tools/
    primitives.ts      — Primitive mesh creation
    selection.ts       — Mesh selection, gizmo management
    sculpt.ts          — Sculpt brushes (spatial hash grid optimization)
    texture-paint.ts   — Texture painting
    skeleton-tool.ts   — Bone creation and management
    weight-paint.ts    — Weight painting
    animation-tool.ts  — Keyframe animation system
    morph.ts           — Morph targets
    modifiers.ts       — Modifier stack (subdivision, mirror, array)
    csg.ts             — CSG boolean operations
    mesh-utils.ts      — Normals, weld, center origin
    actions.ts         — Duplicate, delete
    snap.ts            — Transform snapping
    parenting.ts       — Parent/child relationships
    lighting.ts        — Dynamic lights
    measure.ts         — Distance measurement
    layers.ts          — Layer system
    map-editor.ts      — Scene instance placement
    easing.ts          — Animation easing curves

  ui/
    builders.ts        — UI construction (pills, grids, mobile bar)
    bindings.ts        — Event binding for all controls
    panels.ts          — Panel content updates
    escape.ts          — HTML escaping utility
    file-input.ts      — File dialog utility

  materials/
    pbr-helpers.ts     — PBR material utilities

  storage/
    metadata-store.ts  — Model metadata persistence
    model-store.ts     — Model binary storage (OPFS/IndexedDB)
    autosave.ts        — Automatic checkpoint save/restore

  export/
    gltf-exporter.ts   — GLB/OBJ/STL export, file import
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Select |
| G | Move |
| R | Rotate |
| S | Scale |
| D | Sculpt |
| P | Paint |
| B | Bone |
| W | Weight |
| A | Animation |
| Ctrl+D | Duplicate |
| Delete | Delete selected |
| Esc | Deselect |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Numpad 1/3/7 | Front / Right / Top |
| Ctrl+Numpad | Back / Left / Bottom |
| Numpad 5 | Toggle orthographic |

## Camera Controls

| Input | Action |
|-------|--------|
| Left drag | Orbit |
| Right drag / 2-finger | Pan |
| Scroll / Pinch | Zoom |

## Mobile

- Tool pills scroll horizontally in the header
- Side panels open via hamburger/gear buttons, swipe to close
- Bottom action bar: Prim, Undo, Dup, Del, Export, Save, Load
- Camera lock button — freeze camera for gizmo-only interaction
- Multi-select toggle (replaces Ctrl+click)
- Invert/Smooth toggle buttons in sculpt mode (replaces Ctrl/Shift+drag)
- Gizmo handles are 50% larger on mobile for easier touch targeting
- Camera auto-detaches during gizmo drags to prevent orbit conflicts

## Workflow

1. Add primitives, combine with CSG booleans
2. Sculpt mesh details
3. Paint textures on the surface
4. Create skeleton, assign to mesh
5. Paint vertex weights per bone
6. Record keyframe animations
7. Export as GLB

# Notices

forge3d is licensed under the **GNU General Public License, version 3 or (at
your option) any later version** — see [`LICENSE`](LICENSE).

Much of `src/tools/` is a TypeScript port of other people's code, translated
function by function so that it gives the same answers. Those origins, their
licences, and where the ported code lives:

## Blender

- **Copyright** Blender Authors
- **Licence** GPL-2.0-or-later (distributed here under GPL-3.0-or-later, which
  that licence permits)
- **Source** <https://projects.blender.org/blender/blender>, tag `v5.1.1`
- **Ported into** most of `src/tools/`: the `bmesh` operators and their
  helpers (`bmesh/operators/bmo_*.cc`, `bmesh/intern/`), the mesh modifiers
  (`modifiers/intern/MOD_*.cc`), mesh remapping (`blenkernel/intern/mesh_remap.cc`,
  `mesh_mapping.cc`), the exact boolean solver (`blenlib/intern/mesh_intersect.cc`,
  `mesh_boolean.cc`), the Remesh modifier's dual contouring
  (`intern/dualcon/`, Tao Ju's algorithm as Blender ships it), and the legacy
  procedural textures (`render/intern/texture_procedural.cc`,
  `blenlib/intern/noise_c.cc`). Each ported function names its source file in
  its JSDoc.

## Bullet Physics — `btConvexHullComputer`

Ported into `src/tools/hull/bullet-hull.ts` (as Blender builds it, in
`extern/bullet2/`). The port is an altered version: translated to TypeScript,
with `shrink` / `shiftFace` left out.

```
Copyright (c) 2011 Ole Kniemeyer, MAXON, www.maxon.net

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the use of this software.
Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely,
subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

## Eigen — `JacobiSVD`

- **Copyright** 2009-2010 Benoit Jacob, 2013-2014 Gael Guennebaud
- **Licence** Mozilla Public License 2.0 (<https://mozilla.org/MPL/2.0/>),
  which permits distribution as part of a larger work under the GPL
- **Ported into** `src/tools/remesh/dualcon.ts` (the 3×3 two-sided Jacobi SVD
  that Blender's dual contouring calls). The source of these functions is
  available in this repository under the MPL-2.0 as well as the GPL.

## Referenced, not copied

- **OpenSubdiv** (Pixar, Tomorrow Open Source Technology License 1.0): the UV
  rule of Blender's Subdivision Surface ("Keep Boundaries",
  `FVAR_LINEAR_BOUNDARIES`) is reproduced from its documented behaviour in
  `src/tools/edit-mode/subdivide.ts`; no OpenSubdiv code is included.

## Dependencies

Babylon.js (Apache-2.0) and React (MIT) are used as npm dependencies and are
not part of this repository. Both are compatible with the GPL-3.0.

/**
 * Centralized static shader imports for Babylon.js 8.x.
 *
 * Babylon.js uses dynamic import() inside material/postprocess constructors,
 * which races with Vite's module resolution on first render (returns index.html
 * instead of GLSL). Importing shaders here registers them synchronously in
 * ShaderStore before any rendering occurs.
 *
 * Import this file once from main.ts.
 */

// ── Core rendering ──
import "@babylonjs/core/Shaders/default.vertex";
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/pbr.vertex";
import "@babylonjs/core/Shaders/pbr.fragment";

// ── Lines / color (grid, measurement, bone hierarchy) ──
import "@babylonjs/core/Shaders/color.vertex";
import "@babylonjs/core/Shaders/color.fragment";
import "@babylonjs/core/Shaders/line.vertex";
import "@babylonjs/core/Shaders/line.fragment";

// ── Shadows ──
import "@babylonjs/core/Shaders/shadowMap.vertex";
import "@babylonjs/core/Shaders/shadowMap.fragment";
import "@babylonjs/core/Shaders/depth.vertex";
import "@babylonjs/core/Shaders/depth.fragment";

// ── Post-processing pipeline ──
import "@babylonjs/core/Shaders/postprocess.vertex";
import "@babylonjs/core/Shaders/imageProcessing.fragment";
import "@babylonjs/core/Shaders/fxaa.vertex";
import "@babylonjs/core/Shaders/fxaa.fragment";
import "@babylonjs/core/Shaders/bloomMerge.fragment";
import "@babylonjs/core/Shaders/extractHighlights.fragment";
import "@babylonjs/core/Shaders/pass.fragment";
import "@babylonjs/core/Shaders/chromaticAberration.fragment";
import "@babylonjs/core/Shaders/kernelBlur.vertex";
import "@babylonjs/core/Shaders/kernelBlur.fragment";
import "@babylonjs/core/Shaders/ssao2.fragment";
import "@babylonjs/core/Shaders/ssaoCombine.fragment";

// ── Environment / HDR ──
import "@babylonjs/core/Shaders/rgbdDecode.fragment";
import "@babylonjs/core/Shaders/rgbdEncode.fragment";
import "@babylonjs/core/Shaders/hdrFiltering.vertex";
import "@babylonjs/core/Shaders/hdrFiltering.fragment";

// ── Background (skybox) ──
import "@babylonjs/core/Shaders/background.vertex";
import "@babylonjs/core/Shaders/background.fragment";

// ── Bounding box / picking / outline ──
import "@babylonjs/core/Shaders/boundingBoxRenderer.vertex";
import "@babylonjs/core/Shaders/boundingBoxRenderer.fragment";
import "@babylonjs/core/Shaders/outline.vertex";
import "@babylonjs/core/Shaders/outline.fragment";

// ── Glow / highlight layer ──
import "@babylonjs/core/Shaders/glowMapGeneration.vertex";
import "@babylonjs/core/Shaders/glowMapGeneration.fragment";
import "@babylonjs/core/Shaders/glowMapMerge.vertex";
import "@babylonjs/core/Shaders/glowMapMerge.fragment";
import "@babylonjs/core/Shaders/glowBlurPostProcess.fragment";

// ── Geometry buffer ──
import "@babylonjs/core/Shaders/geometry.vertex";
import "@babylonjs/core/Shaders/geometry.fragment";

// ── Misc utilities ──
import "@babylonjs/core/Shaders/passCube.fragment";
import "@babylonjs/core/Shaders/depthBoxBlur.fragment";
import "@babylonjs/core/Shaders/lod.fragment";
import "@babylonjs/core/Shaders/lodCube.fragment";

import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import { state, isMobile } from "../state";

let pipeline: DefaultRenderingPipeline | null = null;
let ssao: SSAO2RenderingPipeline | null = null;

export function initPostProcess(): void {
  if (isMobile()) return;

  const { scene, camera } = state;
  const pp = state.postProcess;

  pipeline = new DefaultRenderingPipeline("defaultPipeline", true, scene, [camera]);
  pipeline.bloomEnabled = pp.bloomEnabled;
  pipeline.bloomWeight = pp.bloomIntensity;
  pipeline.fxaaEnabled = pp.fxaaEnabled;
  pipeline.chromaticAberrationEnabled = pp.chromaticEnabled;
  pipeline.chromaticAberration.aberrationAmount = pp.chromaticIntensity;
  scene.imageProcessingConfiguration.vignetteEnabled = pp.vignetteEnabled;
  scene.imageProcessingConfiguration.vignetteWeight = pp.vignetteWeight;
}

export function setFxaaEnabled(on: boolean): void {
  state.postProcess.fxaaEnabled = on;
  if (pipeline) pipeline.fxaaEnabled = on;
}

export function setBloomEnabled(on: boolean): void {
  state.postProcess.bloomEnabled = on;
  if (pipeline) pipeline.bloomEnabled = on;
}

export function setBloomIntensity(v: number): void {
  state.postProcess.bloomIntensity = v;
  if (pipeline) pipeline.bloomWeight = v;
}

export function setChromaticEnabled(on: boolean): void {
  state.postProcess.chromaticEnabled = on;
  if (pipeline) pipeline.chromaticAberrationEnabled = on;
}

export function setChromaticIntensity(v: number): void {
  state.postProcess.chromaticIntensity = v;
  if (pipeline?.chromaticAberration) pipeline.chromaticAberration.aberrationAmount = v;
}

export function setVignetteEnabled(on: boolean): void {
  state.postProcess.vignetteEnabled = on;
  if (pipeline) state.scene.imageProcessingConfiguration.vignetteEnabled = on;
}

export function setVignetteWeight(v: number): void {
  state.postProcess.vignetteWeight = v;
  if (pipeline) state.scene.imageProcessingConfiguration.vignetteWeight = v;
}

export function setSsaoEnabled(on: boolean): void {
  state.postProcess.ssaoEnabled = on;
  if (on && !ssao) {
    ssao = new SSAO2RenderingPipeline("ssao", state.scene, { ssaoRatio: 0.5, blurRatio: 1 });
    ssao.radius = 2;
    ssao.totalStrength = state.postProcess.ssaoIntensity;
    ssao.expensiveBlur = false;
    ssao.samples = 16;
    state.scene.postProcessRenderPipelineManager.attachCamerasToRenderPipeline("ssao", state.camera);
  } else if (!on && ssao) {
    ssao.dispose();
    ssao = null;
  }
}

export function setSsaoIntensity(v: number): void {
  state.postProcess.ssaoIntensity = v;
  if (ssao) ssao.totalStrength = v;
}

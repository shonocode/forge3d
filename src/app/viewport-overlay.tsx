/**
 * What sits on top of the 3D view (the old screen's `.vp` children): frame
 * rate and counts, camera presets and orthographic, the shading modes, the
 * sculpt brush circle and the file-drop hint (both driven by input.ts through
 * their ids), and on a phone the Select / Move / Rotate / Scale buttons.
 */
import { useEffect, useState } from "react";
import type { ToolId, ViewportMode } from "../state";
import { state } from "../state";
import { store } from "../store";
import { setTool } from "../input";
import { PRESETS, applyCameraPreset, toggleOrthographic } from "../viewport/camera-presets";
import { setViewportMode } from "../viewport/shading";
import { useForge } from "./use-forge";

const CAMERA: [string, string, string][] = [
  ["front", "F", "Front"],
  ["back", "Bk", "Back"],
  ["right", "R", "Right"],
  ["left", "L", "Left"],
  ["top", "T", "Top"],
  ["bottom", "Bt", "Bottom"],
];

const SHADING: [ViewportMode, string, string][] = [
  ["solid", "○", "Solid"],
  ["wire", "◇", "Wireframe"],
  ["matcap", "◔", "Matcap"],
  ["textured", "●", "Textured"],
];

const FAB: [ToolId, string, string][] = [
  ["select", "↖", "Select tool"],
  ["move", "✥", "Move tool"],
  ["rotate", "↻", "Rotate tool"],
  ["scale", "⤡", "Scale tool"],
];

/** Frame rate and totals, once a second (the old render loop did it every 60 frames). */
function Stats() {
  const [s, setS] = useState({ fps: 0, v: 0, t: 0 });
  useEffect(() => {
    const id = setInterval(() => {
      let v = 0;
      let t = 0;
      for (const m of state.allMeshes) {
        try {
          v += (m.getVerticesData("position")?.length ?? 0) / 3;
          t += (m.getIndices()?.length ?? 0) / 3;
        } catch { /* disposed mesh — skip */ }
      }
      setS({ fps: state.engine ? state.engine.getFps() : 0, v, t });
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="vpo">
      <div className="vtag">{s.fps.toFixed(0)} FPS</div>
      <div className="vtag">{s.v.toLocaleString()} v</div>
      <div className="vtag">{s.t.toLocaleString()} t</div>
      <div className="vtag">Grid: 1 m</div>
    </div>
  );
}

export function ViewportOverlay() {
  const ortho = useForge((s) => s.isOrthographic);
  const mode = useForge((s) => s.viewportMode);
  const tool = useForge((s) => s.tool);
  return (
    <>
      <Stats />
      <div className="scur" id="scur" />
      <div className="drop-zone" id="dropZone">
        <div className="drop-zone-text">
          ここにファイルをドロップ<br />
          <span>.glb .gltf .obj .stl</span>
        </div>
      </div>
      <div className="vp-camera" role="group" aria-label="視点">
        {CAMERA.map(([id, label, name]) => (
          <button key={id} type="button" className="cam-btn" title={name} aria-label={name + " view"} onClick={() => applyCameraPreset(PRESETS[id]!)}>
            {label}
          </button>
        ))}
        <button
          type="button"
          className={"cam-btn" + (ortho ? " on" : "")}
          title="Orthographic（遠近感なし）"
          aria-label="Orthographic toggle"
          aria-pressed={ortho}
          onClick={() => {
            toggleOrthographic();
            store.notify();
          }}
        >
          ⊞
        </button>
      </div>
      <div className="vp-shading" role="group" aria-label="表示モード">
        {SHADING.map(([m, icon, name]) => (
          <button
            key={m}
            type="button"
            className={"shade-btn" + (mode === m ? " on" : "")}
            title={name}
            aria-label={name + " shading"}
            aria-pressed={mode === m}
            onClick={() => setViewportMode(m)}
          >
            {icon}
          </button>
        ))}
      </div>
      <div className="vp-gizmo-fab">
        {FAB.map(([id, icon, name]) => (
          <button key={id} type="button" className={"gfab-btn" + (tool === id ? " on" : "")} aria-label={name} onClick={() => setTool(id)}>
            {icon}
          </button>
        ))}
      </div>
    </>
  );
}

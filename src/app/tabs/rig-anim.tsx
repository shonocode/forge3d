/**
 * Anim tab (ADR-014) — old markup: `tb-anim` in the removed `old-index.html`;
 * behavior from `src/ui/bindings.ts` (clip/timeline/record/playback
 * handlers) and `src/ui/panels.ts` (`updateAnimUI` and its helpers). Logic
 * lives in `src/tools/animation-tool.ts` / `easing.ts` — this file only
 * reads `state` and calls those.
 *
 * `TAB_SECTIONS.anim` (guide.ts) has 4 ids: `clip`, `tl`, `rec`, `play`. The
 * old screen had more `.pg` blocks than that — folded into the nearest:
 *   - Imported Animations (GLB-native clips) → `clip` (both are "what clip
 *     is active", and adopting one is the bridge between them)
 *   - Graph Editor + Dopesheet (canvases) → `tl` (both are timeline views)
 *   - Keyframe Edit (easing, copy/paste) + Keyframes list → `rec` (both are
 *     about the keyframes Record just made)
 *   - Export JSON → `play` (old layout order is Playback then Export; this
 *     is the clip's own JSON export, not the shared GLB/OBJ "io" section,
 *     which belongs to a different agent)
 *
 * Graph Editor / Dopesheet mounting: `src/tools/graph-editor.ts` and
 * `dopesheet.ts` are self-contained canvas widgets that find their DOM by id
 * via `E()` (`state.ts`'s getElementById-or-detached-stub shim) and are
 * idempotent (`if (_canvas) return`). Rendering `<canvas id="graphCanvas">`
 * / `<div id="graphChannels">` / `<div id="graphInfo">` (and the dopesheet's
 * three ids) then calling `initGraphEditor()` / `initDopesheet()` once on
 * mount wires them exactly as the old screen did, without editing either
 * file (verified in `rig.test.tsx`). Redraws are driven the same way as every
 * other cross-section read here: `drawGraphEditor()` / `drawDopesheet()` run
 * in an effect with no dependency array (so every store notify redraws
 * them), paired with `notifyRig()` after frame/selection/keyframe changes.
 */
import { useEffect, useState } from "react";
import { state, status } from "../../state";
import type { AnimLoopMode } from "../../state";
import {
  getActiveClip,
  createClip,
  deleteClip,
  setActiveClip,
  captureKeyframe,
  captureAllKeyframes,
  deleteKeyframe,
  captureMorphKeyframes,
  deleteMorphKeys,
  scrubToFrame,
  playPreview,
  stopPreview,
  exportClipAsJSON,
  copyKeyframe,
  pasteKeyframe,
  setKeyframeEasing,
  getKeyframeEasing,
  setPlaybackTickCallback,
  refreshOnionSkin,
  syncBoneVisuals,
} from "../../tools/animation-tool";
import { EASING_TYPES } from "../../tools/easing";
import type { EasingType } from "../../tools/easing";
import { initGraphEditor, drawGraphEditor } from "../../tools/graph-editor";
import { initDopesheet, drawDopesheet } from "../../tools/dopesheet";
import { useForge } from "../use-forge";
import { LiveSlider, Empty, SubPanel, notifyRig } from "./rig-shared";

// `startImportedVisualSync` / `stopImportedPlayback` are non-exported in
// `src/ui/panels.ts` (lines ~41-52) — copied here rather than editing that
// file. Keeps imported (GLB-native) AnimationGroup playback's bone gizmos in
// sync while it plays, same as the old screen.
let _importedSyncObserver: ReturnType<import("@babylonjs/core/scene").Scene["onBeforeRenderObservable"]["add"]> | null = null;
function startImportedVisualSync(): void {
  if (!state.scene || _importedSyncObserver) return;
  _importedSyncObserver = state.scene.onBeforeRenderObservable.add(syncBoneVisuals);
}
function stopImportedPlayback(): void {
  if (_importedSyncObserver && state.scene) {
    state.scene.onBeforeRenderObservable.remove(_importedSyncObserver);
  }
  _importedSyncObserver = null;
  for (const ag of state.importedAnimGroups) ag.stop();
  state.isPlaying = false;
}

// ── clip: Clip (+ Imported Animations) ──

export function AnimClipSection() {
  useForge(() => null);
  useAnimPlaybackBridge();
  const clip = getActiveClip();
  const [chosenImported, setImportedIdx] = useState(0);
  // A new import replaces the list; an index past its end would show the
  // first option in the select but play nothing. What is shown is what plays.
  const importedIdx = chosenImported < state.importedAnimGroups.length ? chosenImported : 0;

  return (
    <>
      {state.importedAnimGroups.length > 0 && (
        <SubPanel title={`Imported Animations (${state.importedAnimGroups.length})`}>
          <select
            aria-label="Imported animation"
            className="pi"
            value={importedIdx}
            onChange={(e) => setImportedIdx(+e.target.value)}
          >
            {state.importedAnimGroups.map((g, i) => (
              <option key={i} value={i}>{g.name || "Anim_" + i}</option>
            ))}
          </select>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <button
              type="button"
              className="abtn"
              style={{ flex: 1 }}
              onClick={() => {
                const group = state.importedAnimGroups[importedIdx];
                if (!group) return;
                stopPreview();
                stopImportedPlayback();
                group.start(true);
                state.isPlaying = true;
                startImportedVisualSync();
                notifyRig();
              }}
            >
              ▶ Play
            </button>
            <button
              type="button"
              className="abtn"
              style={{ flex: 1 }}
              onClick={() => { stopPreview(); stopImportedPlayback(); notifyRig(); }}
            >
              ■ Stop
            </button>
          </div>
        </SubPanel>
      )}

      <div className="pr" style={{ marginBottom: 4 }}>
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Active</span>
        <select
          aria-label="Active clip"
          className="pi"
          value={state.activeClipId ?? ""}
          disabled={state.animClips.length === 0}
          onChange={(e) => { setActiveClip(e.target.value); notifyRig(); }}
        >
          {state.animClips.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {!clip ? (
        <Empty>クリップを作成してアニメーション</Empty>
      ) : (
        <div style={{ fontSize: 10, color: "var(--t2)", lineHeight: 1.6 }}>
          <div><span style={{ color: "var(--t4)" }}>Name:</span> {clip.name}</div>
          <div><span style={{ color: "var(--t4)" }}>FPS:</span> {clip.frameRate}</div>
          <div><span style={{ color: "var(--t4)" }}>Frames:</span> {clip.maxFrames}</div>
          <div><span style={{ color: "var(--t4)" }}>Loop:</span> {clip.loopMode}</div>
          <div><span style={{ color: "var(--t4)" }}>Tracks:</span> {clip.tracks.length}</div>
          <div><span style={{ color: "var(--t4)" }}>Keyframes:</span> {clip.tracks.reduce((n, t) => n + t.keyframes.length, 0)}</div>
        </div>
      )}
      <button type="button" className="abtn" style={{ marginTop: 6 }} onClick={() => { createClip(); notifyRig(); }}>
        + New Clip
      </button>
      <button
        type="button"
        className="abtn dan"
        onClick={() => { if (clip) { deleteClip(clip.id); notifyRig(); } }}
      >
        Delete Clip
      </button>
    </>
  );
}

// ── tl: Timeline (+ Graph Editor, Dopesheet) ──

function TimelineControls() {
  const clip = getActiveClip();
  return (
    <SubPanel title="Timeline">
      <div className="sr">
        <label>Frame <span>{state.currentFrame}</span> / <span>{clip?.maxFrames ?? 60}</span></label>
        <input
          type="range"
          min={0}
          max={clip?.maxFrames ?? 60}
          step={1}
          value={state.currentFrame}
          aria-label="Animation frame"
          onChange={(e) => { scrubToFrame(+e.target.value); notifyRig(); }}
        />
      </div>
      <LiveSlider
        label="FPS"
        ariaLabel="Frames per second"
        value={clip?.frameRate ?? 30}
        min={1}
        max={60}
        step={1}
        digits={0}
        onChange={(v) => { if (clip) { clip.frameRate = v; notifyRig(); } }}
      />
      <LiveSlider
        label="Max Frames"
        ariaLabel="Max frames"
        value={clip?.maxFrames ?? 60}
        min={10}
        max={300}
        step={10}
        digits={0}
        onChange={(v) => { if (clip) { clip.maxFrames = v; notifyRig(); } }}
      />
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Loop</span>
        <select
          className="pi"
          aria-label="Loop mode"
          value={clip?.loopMode ?? "cycle"}
          onChange={(e) => { if (clip) { clip.loopMode = e.target.value as AnimLoopMode; notifyRig(); } }}
        >
          <option value="cycle">Cycle</option>
          <option value="constant">Constant</option>
        </select>
      </div>
      <div className="pr" style={{ marginTop: 4 }}>
        <span
          className="pl"
          style={{ fontSize: 10, color: "var(--t3)" }}
          title="±offset フレームのゴースト骨格を表示（前=緑 / 次=赤）。ポーズの来し方と行き先が見える"
        >
          👻 Onion Skin
        </span>
        <input
          type="checkbox"
          checked={state.onionSkin.enabled}
          aria-label="Onion skin ghosts"
          style={{ marginLeft: "auto" }}
          onChange={(e) => { state.onionSkin.enabled = e.target.checked; refreshOnionSkin(); notifyRig(); }}
        />
      </div>
      <LiveSlider
        label="Onion Offset"
        ariaLabel="Onion skin frame offset"
        value={state.onionSkin.offset}
        min={1}
        max={20}
        step={1}
        digits={0}
        onChange={(v) => { state.onionSkin.offset = v; refreshOnionSkin(); }}
      />
    </SubPanel>
  );
}

/** Mounts the old screen's Graph Editor + Dopesheet canvases (see file header). */
function GraphAndDopesheet() {
  useEffect(() => {
    initGraphEditor();
    initDopesheet();
  }, []);

  useEffect(() => {
    drawGraphEditor();
    drawDopesheet();
  });

  return (
    <>
      <SubPanel title="Graph Editor">
        <div id="graphChannels" style={{ display: "flex", flexWrap: "wrap", gap: 2, marginBottom: 4, fontSize: 9 }} />
        <canvas
          id="graphCanvas"
          width={280}
          height={160}
          aria-label="Animation graph editor"
          style={{ width: "100%", height: 160, background: "var(--bg3)", borderRadius: 3, cursor: "crosshair", display: "block" }}
        />
        <div id="graphInfo" style={{ fontSize: 9, color: "var(--t4)", marginTop: 2, lineHeight: 1.4 }}>クリックでフレームへスクラブ</div>
      </SubPanel>
      <SubPanel title="Dopesheet">
        <canvas
          id="dopeCanvas"
          width={280}
          height={120}
          aria-label="Animation dopesheet"
          style={{ width: "100%", height: 120, background: "var(--bg3)", borderRadius: 3, cursor: "pointer", display: "block" }}
        />
        <div id="dopeInfo" style={{ fontSize: 9, color: "var(--t4)", marginTop: 2, lineHeight: 1.4 }}>行クリックでボーン選択、キーをクリックでスクラブ</div>
      </SubPanel>
    </>
  );
}

export function AnimTimelineSection() {
  useForge(() => null);
  return (
    <>
      <TimelineControls />
      <GraphAndDopesheet />
    </>
  );
}

// ── rec: Record (+ Keyframe Edit, Keyframes list) ──

function RecordControls() {
  return (
    <SubPanel title="Record">
      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, marginBottom: 4 }}>
        <input
          type="checkbox"
          checked={state.autoKey}
          onChange={(e) => { state.autoKey = e.target.checked; status("Auto-Key: " + (e.target.checked ? "ON" : "OFF")); notifyRig(); }}
        />
        🔑 Auto-Key（ポーズ変更を自動キー）
      </label>
      <button type="button" className="abtn pri" onClick={() => { captureKeyframe(); notifyRig(); }}>
        ⏺ Record Keyframe
      </button>
      <button type="button" className="abtn" onClick={() => { captureAllKeyframes(); notifyRig(); }}>
        ⏺ Record All Bones
      </button>
      <button type="button" className="abtn" onClick={() => { captureMorphKeyframes(); notifyRig(); }}>
        ⏺ Record Morphs（表情キー）
      </button>
      <button type="button" className="abtn dan" onClick={() => { deleteKeyframe(); notifyRig(); }}>
        ✕ Delete Keyframe
      </button>
      <button type="button" className="abtn dan" onClick={() => { deleteMorphKeys(); notifyRig(); }}>
        ✕ Delete Morph Keys
      </button>
    </SubPanel>
  );
}

function KeyframeEditControls() {
  const clip = getActiveClip();
  return (
    <SubPanel title="Keyframe Edit">
      <div className="pr" style={{ marginBottom: 4 }}>
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>Easing</span>
        <select
          className="pi"
          aria-label="Keyframe easing"
          style={{ fontSize: 9 }}
          value={getKeyframeEasing()}
          onChange={(e) => { setKeyframeEasing(e.target.value as EasingType); notifyRig(); }}
        >
          {EASING_TYPES.map((et) => (
            <option key={et} value={et}>{et}</option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" className="abtn" style={{ flex: 1, fontSize: 9 }} onClick={() => copyKeyframe()}>
          Copy KF
        </button>
        <button type="button" className="abtn" style={{ flex: 1, fontSize: 9 }} onClick={() => { pasteKeyframe(); notifyRig(); }}>
          Paste KF
        </button>
      </div>
      {!clip && <Empty>クリップを作成してアニメーション</Empty>}
    </SubPanel>
  );
}

function KeyframeListControls() {
  const clip = getActiveClip();
  const track = clip && state.selectedBoneId ? clip.tracks.find((t) => t.boneId === state.selectedBoneId) : null;
  return (
    <SubPanel title="Keyframes">
      {!clip || !state.selectedBoneId ? (
        <Empty>ボーンを選択してキーフレーム表示</Empty>
      ) : !track || track.keyframes.length === 0 ? (
        <Empty>キーフレームなし</Empty>
      ) : (
        <div className="slist" role="list">
          {track.keyframes.map((kf) => (
            <div
              key={kf.frame}
              role="listitem"
              className="sitem"
              style={{ fontSize: 10, cursor: "pointer" }}
              onClick={() => { scrubToFrame(kf.frame); notifyRig(); }}
            >
              <span style={{ color: "var(--ac)", minWidth: 32, display: "inline-block" }}>F{kf.frame}</span>
              <span style={{ color: "var(--t3)" }}>
                R({kf.rotation.x.toFixed(2)},{kf.rotation.y.toFixed(2)},{kf.rotation.z.toFixed(2)})
              </span>
            </div>
          ))}
        </div>
      )}
    </SubPanel>
  );
}

export function AnimRecordSection() {
  useForge(() => null);
  return (
    <>
      <RecordControls />
      <KeyframeEditControls />
      <KeyframeListControls />
    </>
  );
}

// ── play: Playback (+ Export) ──

export function AnimPlaySection() {
  useForge(() => null);
  return (
    <>
      <SubPanel title="Playback">
        <button type="button" className="abtn pri" onClick={() => { playPreview(); notifyRig(); }}>
          ▶ Play
        </button>
        <button type="button" className="abtn" onClick={() => { stopPreview(); notifyRig(); }}>
          ■ Stop
        </button>
      </SubPanel>
      <SubPanel title="Export">
        <button type="button" className="abtn" onClick={() => exportClipAsJSON()}>
          ⬇ Export JSON
        </button>
      </SubPanel>
    </>
  );
}

/**
 * Registers the playback tick → store notify bridge once, on the top-level
 * Anim tab mount (all of `TAB_SECTIONS.anim`'s sections render together —
 * see `right-panel.tsx` — so any one of them mounting is "the Anim tab is
 * open"). Without this, `state.currentFrame` advancing during Play would
 * move the 3D pose but leave the Frame slider and both timeline canvases
 * showing the frame playback started from — none of the store's three
 * inputs (undo history / status / per-frame fingerprint) see a running
 * preview.
 */
export function useAnimPlaybackBridge(): void {
  useEffect(() => {
    setPlaybackTickCallback((frame) => {
      state.currentFrame = Math.floor(frame);
      notifyRig();
    });
    return () => setPlaybackTickCallback(null);
  }, []);
}

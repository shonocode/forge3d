import { state, E } from "../state";
import { getActiveClip, scrubToFrame } from "./animation-tool";
import { selectBone, getActiveSkeleton } from "./skeleton-tool";

// ── Dopesheet ────────────────────────────────────────────────
//
// Multi-row, all-bones-in-one-glance keyframe view. Complements the
// per-bone graph editor: where the graph shows *value over time* for a
// single track, the dopesheet shows *timing across all tracks* so you
// can verify limb synchronization (e.g., "fist contacts at frame 12
// while torso twists at frame 10–14").
//
// Layout:
//   ┌─────────┬───────────────────────────────────────────────┐
//   │ Bone A  │  ◆       ◆     ◆                              │
//   │ Bone B  │      ◆   ◆ ◆      ◆                           │
//   │ Bone C  │                ◆   ◆     ◆◆                   │
//   └─────────┴───────────────────────────────────────────────┘
//   (labels gutter)         (timeline canvas area)
//
// Each row corresponds to a bone with at least one keyframe in the
// active clip. Empty bones are skipped so the panel stays compact.
//
// Interactions:
//   - Click on a row's label gutter → select that bone
//   - Click on a keyframe diamond → select bone + scrub to that frame
//   - Click on the timeline area (away from any diamond) → scrub
//
// Yellow vertical playhead tracks `state.currentFrame` and refreshes
// on the same hooks as the graph editor (see panels.ts / bindings.ts).
//
// V1 scope: read-only. V2 would add drag-to-move keys (compound undo
// for moving multiple keys simultaneously like Blender's selected-set).

/** Pixel width of the label gutter on the left. Tuned to fit a short
 *  bone name at 9 px monospace without truncation in most cases. */
const LABEL_GUTTER = 70;

/** Vertical space per bone row. Picked to fit a diamond comfortably
 *  without forcing the panel to be huge for skeletons with many bones. */
const ROW_HEIGHT = 14;

/** Diamond half-extent in pixels — slightly larger than the graph
 *  editor's keyframe dots so they read as a distinct shape. */
const DIAMOND_R = 4;

/** Pixel slop for keyframe hit-testing. Wider than `DIAMOND_R` so
 *  touch / coarse-pointer use can reliably hit a key without precise
 *  aiming. */
const HIT_TOLERANCE = 6;

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _info: HTMLElement | null = null;

/** Cached row metadata from the last render — needed for hit-testing
 *  in the click handler. Rebuilt every `drawDopesheet`. Bone rows carry a
 *  boneId; morph rows carry the track reference instead. */
interface RowHit {
  boneId: string | null;
  morphTrack: import("../state").MorphTrack | null;
  y0: number;
  y1: number;
}
let _rowHits: RowHit[] = [];

/**
 * One-time setup: caches DOM refs and installs the click handler.
 * Idempotent.
 */
export function initDopesheet(): void {
  if (_canvas) return;
  _canvas = E("dopeCanvas") as HTMLCanvasElement;
  _ctx = _canvas.getContext("2d");
  _info = E("dopeInfo");

  _canvas.addEventListener("click", (e) => {
    handleClick(e);
  });
}

/**
 * Re-render the dopesheet. Cheap (no allocations in the inner loops),
 * so it's safe to call on every playback tick.
 */
export function drawDopesheet(): void {
  if (!_canvas || !_ctx) return;

  // Match backing size to CSS box every frame so the panel stays crisp
  // when the side panel resizes. Same approach as the graph editor.
  const rect = _canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;

  const ctx = _ctx;
  ctx.clearRect(0, 0, w, h);
  _rowHits = [];

  const clip = getActiveClip();
  if (!clip) { drawEmpty(ctx, w, h, "アクティブなクリップがありません"); return; }

  // Bone display order: walk the active skeleton's bones array so the
  // dopesheet order matches the Bone Hierarchy panel. This makes the
  // "row above me" mental model match across the two panels. Bones
  // without keyframes in this clip are still shown (so the user can
  // tell *which* bones haven't been keyed yet).
  const skel = getActiveSkeleton();
  const morphTracks = clip.morphTracks ?? [];
  const boneRows = skel ? skel.bones : [];
  if (boneRows.length === 0 && morphTracks.length === 0) {
    drawEmpty(ctx, w, h, "ボーンがありません");
    return;
  }

  const trackByBoneId = new Map(clip.tracks.map((t) => [t.boneId, t]));
  const rows = boneRows; // ordered as in the hierarchy

  const timelineX0 = LABEL_GUTTER;
  const timelineW = w - LABEL_GUTTER;

  // Grid: same 10/30 frame interval as the graph editor so timing
  // reads consistently across the two views.
  for (let f = 0; f <= clip.maxFrames; f += 10) {
    const px = timelineX0 + Math.floor((f / clip.maxFrames) * timelineW) + 0.5;
    ctx.strokeStyle = f % 30 === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  // Gutter separator — gives the label column a visual boundary.
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.beginPath();
  ctx.moveTo(timelineX0 + 0.5, 0);
  ctx.lineTo(timelineX0 + 0.5, h);
  ctx.stroke();

  ctx.font = "9px monospace";
  ctx.textBaseline = "middle";

  rows.forEach((bone, i) => {
    const y0 = i * ROW_HEIGHT;
    const y1 = y0 + ROW_HEIGHT;
    const yCenter = y0 + ROW_HEIGHT / 2;
    const isSelected = bone.id === state.selectedBoneId;

    // Alternating row tint for readability when scanning many bones.
    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, y0, w, ROW_HEIGHT);
    }
    if (isSelected) {
      ctx.fillStyle = "rgba(255, 200, 0, 0.12)";
      ctx.fillRect(0, y0, w, ROW_HEIGHT);
    }

    // Bone label — truncate by clipping rather than substr so the
    // exact bone name remains in `dataset` for hit-testing logic if
    // we ever add hover tooltips. For now visual truncation is enough.
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, y0, LABEL_GUTTER - 4, ROW_HEIGHT);
    ctx.clip();
    ctx.fillStyle = isSelected ? "#ffcc44" : "rgba(255,255,255,0.7)";
    ctx.textAlign = "left";
    ctx.fillText(bone.name, 4, yCenter);
    ctx.restore();

    // Keyframe diamonds. Color: yellow when row is selected (matches
    // the row tint), else neutral. We don't channel-color these
    // because a dopesheet row is *all channels* — that's the graph
    // editor's job.
    const track = trackByBoneId.get(bone.id);
    if (track) {
      ctx.fillStyle = isSelected ? "#ffcc44" : "rgba(220,220,220,0.85)";
      ctx.strokeStyle = isSelected ? "#ffaa00" : "rgba(120,120,120,1)";
      ctx.lineWidth = 1;
      for (const kf of track.keyframes) {
        const px = timelineX0 + (kf.frame / clip.maxFrames) * timelineW;
        drawDiamond(ctx, px, yCenter);
      }
    }

    _rowHits.push({ boneId: bone.id, morphTrack: null, y0, y1 });
  });

  // Morph lanes — appended below the bone rows, teal to read as a
  // different channel type at a glance.
  morphTracks.forEach((track, mi) => {
    const i = rows.length + mi;
    const y0 = i * ROW_HEIGHT;
    const yCenter = y0 + ROW_HEIGHT / 2;

    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, y0, w, ROW_HEIGHT);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(2, y0, LABEL_GUTTER - 4, ROW_HEIGHT);
    ctx.clip();
    ctx.fillStyle = "rgba(80,220,200,0.9)";
    ctx.textAlign = "left";
    ctx.fillText("◆" + track.targetName, 4, yCenter);
    ctx.restore();

    ctx.fillStyle = "rgba(80,220,200,0.85)";
    ctx.strokeStyle = "rgba(30,140,125,1)";
    ctx.lineWidth = 1;
    for (const kf of track.keyframes) {
      const px = timelineX0 + (kf.frame / clip.maxFrames) * timelineW;
      drawDiamond(ctx, px, yCenter);
    }

    _rowHits.push({ boneId: null, morphTrack: track, y0, y1: y0 + ROW_HEIGHT });
  });

  // Playhead — yellow, full-height. Matches the graph editor color so
  // the two panels are visually linked.
  const playPx = timelineX0 + Math.floor((state.currentFrame / clip.maxFrames) * timelineW) + 0.5;
  ctx.strokeStyle = "#ffff00";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(playPx, 0);
  ctx.lineTo(playPx, h);
  ctx.stroke();

  if (_info) {
    const totalKeys =
      clip.tracks.reduce((n, t) => n + t.keyframes.length, 0) +
      morphTracks.reduce((n, t) => n + t.keyframes.length, 0);
    const morphNote = morphTracks.length ? ` · ${morphTracks.length} morphs` : "";
    _info.textContent = `${rows.length} bones${morphNote} · ${clip.tracks.length} tracks · ${totalKeys} keys · Frame ${state.currentFrame}/${clip.maxFrames}`;
  }
}

// ── Drawing helpers ──

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - DIAMOND_R);
  ctx.lineTo(x + DIAMOND_R, y);
  ctx.lineTo(x, y + DIAMOND_R);
  ctx.lineTo(x - DIAMOND_R, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawEmpty(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string): void {
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(msg, w / 2, h / 2);
}

// ── Click handling ──

function handleClick(e: MouseEvent): void {
  if (!_canvas) return;
  const clip = getActiveClip();
  if (!clip) return;

  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Find which row was hit. Iterate the cached row metadata from the
  // last render — using the live skeleton would race if the user
  // deleted a bone between render and click.
  const row = _rowHits.find((r) => y >= r.y0 && y < r.y1);
  if (!row) return;

  const timelineX0 = LABEL_GUTTER;
  const timelineW = rect.width - LABEL_GUTTER;

  if (x < timelineX0) {
    // Click in the label gutter — select the bone (morph rows have no
    // selection concept; the gutter click is a no-op for them).
    if (row.boneId) selectBone(row.boneId);
    drawDopesheet();
    return;
  }

  // Click in the timeline area. If it lands within HIT_TOLERANCE of a
  // keyframe diamond, scrub to that exact frame; otherwise scrub to
  // the pointed-at frame. Bone rows also select the row's bone so
  // subsequent edits (graph editor / keyframe panel) reflect the
  // clicked context — saves a separate gutter click.
  const frameAtX = ((x - timelineX0) / timelineW) * clip.maxFrames;
  if (row.boneId) selectBone(row.boneId);

  const keyframes: Array<{ frame: number }> = row.morphTrack
    ? row.morphTrack.keyframes
    : clip.tracks.find((t) => t.boneId === row.boneId)?.keyframes ?? [];
  let snappedFrame = frameAtX;
  for (const kf of keyframes) {
    const keyPx = timelineX0 + (kf.frame / clip.maxFrames) * timelineW;
    if (Math.abs(keyPx - x) <= HIT_TOLERANCE) {
      snappedFrame = kf.frame;
      break;
    }
  }
  const clamped = Math.max(0, Math.min(clip.maxFrames, Math.round(snappedFrame)));
  scrubToFrame(clamped);
  drawDopesheet();
}

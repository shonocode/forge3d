/**
 * forge3d's keyboard map — **Blender 5.1's default keymap** wherever an action
 * exists in both (decided 2026-09-25: "Blender に合わせる"). One table, read by
 * the keyboard handler (`input.ts`) and by every label that shows a key
 * (toolbar, edit-mode buttons), so a key cannot be shown as one thing and do
 * another.
 *
 * What Blender does not have a key for, forge3d does not invent one for:
 *
 * - **Switching to Sculpt / Paint / Bone / Weight / Anim.** Blender switches
 *   modes with Ctrl+Tab (the mode pie), and a browser keeps Ctrl+Tab for
 *   itself. The toolbar does it. The old D / P / B / W / A were forge3d's own
 *   and each collides with a Blender key (A select all, B box select, W the
 *   select tool, P separate in edit mode).
 * - **Subdivide, Mark Seam, Flip Diagonal, Tris to Quads' old J.** Blender
 *   reaches the first three through menus; its J is Connect Vertex Path and
 *   its Tris to Quads is Alt+J, which is what this uses. The buttons stay.
 *
 * Two keys forge3d keeps that Blender does not have: **Esc** clears the
 * selection (Blender's Esc cancels, and Alt+A is its deselect — both work
 * here), and **Backspace** deletes, for keyboards without a Delete key.
 */

/** Where a binding applies. `any` is both Object Mode and Edit Mode. */
export type KeyContext = "object" | "edit" | "any";

export type ActionId =
  | "tool.select" | "tool.move" | "tool.rotate" | "tool.scale"
  | "select.all" | "select.none" | "select.cancel" | "select.box"
  | "object.duplicate" | "object.delete"
  | "view.hide" | "view.hideUnselected" | "view.reveal" | "view.selected" | "view.all"
  | "view.front" | "view.back" | "view.right" | "view.left" | "view.top" | "view.bottom" | "view.ortho"
  | "file.new" | "history.undo" | "history.redo" | "mode.editToggle"
  | "comp.vertex" | "comp.edge" | "comp.face"
  | "edit.move" | "edit.rotate" | "edit.scale"
  | "edit.extrude" | "edit.inset" | "edit.bevel" | "edit.loopCut" | "edit.knife" | "edit.fill"
  | "edit.vertexSlide" | "edit.merge" | "edit.bridge" | "edit.markCrease" | "edit.setCrease"
  | "edit.trisToQuads" | "edit.quadsToTris" | "edit.unwrap" | "edit.delete";

export interface Binding {
  action: ActionId;
  context: KeyContext;
  /** `KeyboardEvent.key`, lower-cased — or, with `code`, ignored. */
  key: string;
  /** Match `KeyboardEvent.code` instead (numpad keys). */
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** What the key is in Blender, for the manual and for anyone checking. */
  blender: string;
}

const b = (action: ActionId, context: KeyContext, key: string, blender: string, mods: Partial<Binding> = {}): Binding => ({
  action, context, key, blender, ...mods,
});

export const KEYMAP: readonly Binding[] = [
  // ── anywhere ──────────────────────────────────────────────────────────────
  b("history.undo", "any", "z", "Undo", { ctrl: true }),
  b("history.redo", "any", "z", "Redo", { ctrl: true, shift: true }),
  b("mode.editToggle", "any", "tab", "Object Mode ⇄ Edit Mode"),
  b("view.front", "any", "", "View ▸ Front", { code: "Numpad1" }),
  b("view.back", "any", "", "View ▸ Back", { code: "Numpad1", ctrl: true }),
  b("view.right", "any", "", "View ▸ Right", { code: "Numpad3" }),
  b("view.left", "any", "", "View ▸ Left", { code: "Numpad3", ctrl: true }),
  b("view.top", "any", "", "View ▸ Top", { code: "Numpad7" }),
  b("view.bottom", "any", "", "View ▸ Bottom", { code: "Numpad7", ctrl: true }),
  b("view.ortho", "any", "", "Perspective / Orthographic", { code: "Numpad5" }),

  // ── Object Mode ───────────────────────────────────────────────────────────
  b("tool.select", "object", "w", "Select tool (W cycles box / circle / lasso)"),
  b("tool.move", "object", "g", "Move"),
  b("tool.rotate", "object", "r", "Rotate"),
  b("tool.scale", "object", "s", "Scale"),
  b("select.all", "object", "a", "Select All"),
  b("select.none", "object", "a", "Select None", { alt: true }),
  b("select.cancel", "object", "escape", "(Esc cancels; forge3d also deselects)"),
  b("object.duplicate", "object", "d", "Duplicate Objects", { shift: true }),
  b("object.delete", "object", "x", "Delete"),
  b("object.delete", "object", "delete", "Delete"),
  b("object.delete", "object", "backspace", "(none — for keyboards without Delete)"),
  b("view.hide", "object", "h", "Hide Selected"),
  b("view.hideUnselected", "object", "h", "Hide Unselected", { shift: true }),
  b("view.reveal", "object", "h", "Reveal Hidden", { alt: true }),
  b("view.selected", "object", "", "View ▸ Frame Selected", { code: "NumpadDecimal" }),
  b("view.all", "object", "home", "View ▸ Frame All"),
  b("file.new", "object", "n", "File ▸ New", { ctrl: true }),

  // ── Edit Mode ─────────────────────────────────────────────────────────────
  b("comp.vertex", "edit", "1", "Vertex select mode"),
  b("comp.edge", "edit", "2", "Edge select mode"),
  b("comp.face", "edit", "3", "Face select mode"),
  b("select.all", "edit", "a", "Select All"),
  b("select.none", "edit", "a", "Select None", { alt: true }),
  b("select.cancel", "edit", "escape", "(Esc cancels; forge3d also deselects)"),
  b("select.box", "edit", "b", "Box Select"),
  b("edit.move", "edit", "g", "Move (G G slides the edge / vertex)"),
  b("edit.rotate", "edit", "r", "Rotate"),
  b("edit.scale", "edit", "s", "Scale"),
  b("edit.extrude", "edit", "e", "Extrude"),
  b("edit.inset", "edit", "i", "Inset Faces"),
  b("edit.bevel", "edit", "b", "Bevel", { ctrl: true }),
  b("edit.loopCut", "edit", "r", "Loop Cut and Slide", { ctrl: true }),
  b("edit.knife", "edit", "k", "Knife"),
  b("edit.fill", "edit", "f", "Make Edge / Face"),
  b("edit.vertexSlide", "edit", "v", "Slide Vertex", { shift: true }),
  b("edit.merge", "edit", "m", "Merge"),
  b("edit.bridge", "edit", "e", "Edge menu (▸ Bridge Edge Loops)", { ctrl: true }),
  b("edit.markCrease", "edit", "e", "Edge Crease", { shift: true }),
  b("edit.setCrease", "edit", "e", "(none — forge3d: set the crease weight exactly)", { ctrl: true, shift: true }),
  b("edit.trisToQuads", "edit", "j", "Triangles to Quads", { alt: true }),
  b("edit.quadsToTris", "edit", "t", "Triangulate Faces", { ctrl: true }),
  b("edit.unwrap", "edit", "u", "UV menu (▸ Smart UV Project)"),
  b("edit.delete", "edit", "x", "Delete menu"),
  b("edit.delete", "edit", "delete", "Delete menu"),
  b("edit.delete", "edit", "backspace", "(none — for keyboards without Delete)"),
];

/** What each action does, for the help table and the manual. */
export const ACTION_TEXT: Record<ActionId, string> = {
  "tool.select": "Select ツール（選択）",
  "tool.move": "Move（移動）",
  "tool.rotate": "Rotate（回転）",
  "tool.scale": "Scale（拡縮）",
  "select.all": "全選択",
  "select.none": "選択解除",
  "select.cancel": "選択解除",
  "select.box": "Box Select（矩形選択）",
  "object.duplicate": "複製",
  "object.delete": "削除",
  "view.hide": "選択したものを隠す",
  "view.hideUnselected": "選択していないものを隠す",
  "view.reveal": "隠したものを全部表示",
  "view.selected": "選択したものに視点を合わせる",
  "view.all": "全体が入るように視点を合わせる",
  "view.front": "正面ビュー",
  "view.back": "背面ビュー",
  "view.right": "右ビュー",
  "view.left": "左ビュー",
  "view.top": "上面ビュー",
  "view.bottom": "下面ビュー",
  "view.ortho": "透視 ⇄ 正射影",
  "file.new": "新しいシーン（確認あり）",
  "history.undo": "元に戻す",
  "history.redo": "やり直し",
  "mode.editToggle": "Object Mode ⇄ Edit Mode",
  "comp.vertex": "頂点を選ぶモード",
  "comp.edge": "辺を選ぶモード",
  "comp.face": "面を選ぶモード",
  "edit.move": "移動（2 回押すと Edge / Vertex Slide）",
  "edit.rotate": "回転",
  "edit.scale": "拡縮",
  "edit.extrude": "Extrude（押し出し）",
  "edit.inset": "Inset（面の内側に面を作る）",
  "edit.bevel": "Bevel（角を面取り）",
  "edit.loopCut": "Loop Cut（輪切りに辺を足す）",
  "edit.knife": "Knife（ドラッグで切る）",
  "edit.fill": "Fill（選んだ頂点・辺から面を張る）",
  "edit.vertexSlide": "Vertex Slide（頂点を辺に沿って滑らせる）",
  "edit.merge": "Merge（頂点をまとめる）",
  "edit.bridge": "Bridge Loops（2 本の縁をつなぐ）",
  "edit.markCrease": "Crease（Subdivide で角を残す）の付け外し",
  "edit.setCrease": "Crease の強さを数値で指定",
  "edit.trisToQuads": "三角形を四角形にまとめる",
  "edit.quadsToTris": "三角形に分ける",
  "edit.unwrap": "UV 展開（Smart UV Project）",
  "edit.delete": "削除",
};

/** The parts of a `KeyboardEvent` a binding is matched against. */
export interface KeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function matches(bd: Binding, e: KeyInput): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!!bd.ctrl !== ctrl || !!bd.shift !== e.shiftKey || !!bd.alt !== e.altKey) return false;
  if (bd.code) return e.code === bd.code;
  // A numpad key only ever means its numpad binding. Numpad 1 is a view, not
  // vertex mode — and with Num Lock off, numpad "." arrives as key "Delete",
  // which would otherwise delete the selection instead of framing it.
  if (e.code.startsWith("Numpad")) return false;
  return e.key.toLowerCase() === bd.key;
}

/** The action a key press means in `context`, or null. */
export function actionFor(e: KeyInput, context: "object" | "edit"): ActionId | null {
  for (const bd of KEYMAP) if ((bd.context === context || bd.context === "any") && matches(bd, e)) return bd.action;
  return null;
}

const KEY_NAMES: Record<string, string> = {
  tab: "Tab", escape: "Esc", delete: "Delete", backspace: "Backspace", home: "Home",
};
const CODE_NAMES: Record<string, string> = {
  Numpad1: "Numpad 1", Numpad3: "Numpad 3", Numpad5: "Numpad 5", Numpad7: "Numpad 7", NumpadDecimal: "Numpad .",
};

/** How a binding is written: "Ctrl+Shift+E", "Alt+J", "Numpad .". */
export function bindingLabel(bd: Binding): string {
  const parts: string[] = [];
  if (bd.ctrl) parts.push("Ctrl");
  if (bd.shift) parts.push("Shift");
  if (bd.alt) parts.push("Alt");
  parts.push(bd.code ? CODE_NAMES[bd.code] ?? bd.code : KEY_NAMES[bd.key] ?? bd.key.toUpperCase());
  return parts.join("+");
}

/** The first key for `action` (in `context` if given), as a label — "" when it has none. */
export function keyLabel(action: ActionId, context?: KeyContext): string {
  const bd = KEYMAP.find((x) => x.action === action && (!context || x.context === context || x.context === "any"));
  return bd ? bindingLabel(bd) : "";
}

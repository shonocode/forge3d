/**
 * The shortcut table's rows, from keymap.ts — shared by the help window
 * (`shortcuts.tsx`) and the manual (`manual.ts`, which runs under Node and
 * so cannot import a component).
 */
import { ACTION_TEXT, KEYMAP, bindingLabel, type ActionId, type KeyContext } from "../../keymap.ts";

export interface ShortcutRow {
  keys: string;
  text: string;
}

/**
 * Rows for one context. Object Mode includes the keys that work anywhere;
 * an action bound to several keys is one row ("X / Delete / Backspace").
 */
export function shortcutRows(ctx: Exclude<KeyContext, "any">): ShortcutRow[] {
  const byAction = new Map<ActionId, string[]>();
  for (const bd of KEYMAP) {
    if (bd.context !== ctx && !(ctx === "object" && bd.context === "any")) continue;
    const list = byAction.get(bd.action) ?? [];
    list.push(bindingLabel(bd));
    byAction.set(bd.action, list);
  }
  const rows = [...byAction].map(([action, keys]) => ({ keys: keys.join(" / "), text: ACTION_TEXT[action] }));
  if (ctx === "edit") rows.push({ keys: "G G", text: "Edit Mode で 2 回：Edge / Vertex Slide" });
  return rows;
}

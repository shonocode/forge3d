/**
 * The shortcut table, written from keymap.ts so it cannot drift from what the
 * keys do — the old screen's `buildHelpKeys`, as data plus a component.
 */
import type { KeyContext } from "../../keymap";
import { shortcutRows } from "./shortcut-rows";

export function Shortcuts() {
  const groups: [string, Exclude<KeyContext, "any">][] = [
    ["Object Mode ／ 共通", "object"],
    ["Edit Mode（Tab で入る）", "edit"],
  ];
  return (
    <section className="shortcuts" aria-label="ショートカット">
      <p className="shortcuts-note">キーは Blender と同じ。覚えたことが Blender でもそのまま使えます。</p>
      {groups.map(([title, ctx]) => (
        <table key={ctx}>
          <caption>{title}</caption>
          <tbody>
            {shortcutRows(ctx).map((r) => (
              <tr key={r.keys + r.text}>
                <td><kbd>{r.keys}</kbd></td>
                <td>{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

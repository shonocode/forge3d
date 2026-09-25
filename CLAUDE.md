# FORGE 3D

**保守フェーズ（2026-09-25〜）。** ライブラリは Blender 5.1.1 と実測で一致させ終え、GUI は
React で作り直した。これからの仕事は、使って出てきた不具合の修正と小さな追加。
状態・手順・未解決の入口は chiikawa-soul の `docs/architecture/forge3d.md`。

## Quick Reference

```bash
npm run dev          # 開発サーバー (localhost:5173)
npm run build        # tsc && vite build ― tsc は型エラーでも exit 0。出力を読むこと
npm run test         # Vitest
npm run test:watch   # Vitest ウォッチ
npm run manual       # MANUAL.html を解説データから作る（コミットしない）
npm run deploy       # ビルドして wrangler でデプロイ
```

型検査だけなら `npx tsc --noEmit -p .` の出力が 0 行で通過。

**GitHub Pages**（`.github/workflows/deploy.yml`、push のたび）は forge3d **単体**で `npm ci` する。
ふだんは chiikawa-soul の workspaces（root のロックファイル）経由で入れるので、この
`package-lock.json` は勝手には更新されない ― 依存を変えたら単体の clone で
`rm package-lock.json && npm install --package-lock-only` して作り直すこと（2026-09 に vite 7 のまま
残っていて、Pages のビルドが毎回落ちていた）。`/forge3d/` 配下への配信は `vite.config.ts` が
`GITHUB_ACTIONS` を見て切り替える。

## 構成

- **ライブラリ**：公開 API は `src/lib/index.ts`。ヘッドレス（DOM・editor 状態・scene 無し）。
  実体は `src/tools/` の純粋な側 ― Blender の移植（`boolean/` `remesh/` `hull/` `texture/` `edit-mode/`
  ほか）。editor 配管（selection / gizmo / undo / canvas paint）は意図的に非公開
- **GUI**：React（`src/app/`、ADR-014）。Babylon と `src/state.ts` は React の外にあり、
  `src/store.ts` の store 1本で知らせる（`useForge(selector)`）
- **3D**：Babylon.js 9.x（`@babylonjs/core` / loaders / serializers）
- **言語**：TypeScript strict（`noUncheckedIndexedAccess`、`erasableSyntaxOnly` ― パリティの
  ハーネスが Node の型除去でこのソースを読むので、`enum` や引数プロパティは書けない）
- **ビルド**：Vite 8 + vite-plugin-pwa + vite-plugin-compression + Cloudflare の Vite プラグイン
- **Undo/Redo**：`src/undo.ts` の UndoHistory（コマンドパターン、最大 50）
- **保存**：OPFS 優先 → IndexedDB（`src/storage/`）、自動保存

## 変えるときの手順

1. **`src/tools/` を触ったら**：単体テスト、`tsc` の出力、そして該当するパリティ行
   （chiikawa-soul の `tools/modeling/parity/`、`compare.ts --op <行>`）。広く触ったら `all.sh` を全部。
   Blender と合わなくなったら、推理する前に Blender `v5.1.1` タグのソースを読む
2. **ライブラリに足すかどうか**は「コードから呼べるか」。ロジックと editor 配管を分け、純粋な側だけを
   `src/lib/index.ts` から出す（`computeAutoWeights` が純、`applyAutoWeights` が scene 依存、が手本）
3. **画面に見えるものを変えたら**、同じコミットで解説を直す（下の Documentation Sync Rule）
4. **ライセンスは GPL-3.0-or-later**（`LICENSE`、移植元の一覧は `NOTICE.md`）。`src/tools/` の多くは
   GPL の Blender からの移植。enki / chiikawa-reign から forge3d を import させない（ゲームが GPL 側に
   入る）。**新しく他所のコードを移植したら `NOTICE.md` に足す**（ライセンスが GPL-3 と両立するか先に確かめる。
   zlib のように「表示を残せ」という条件があるものは、移植したファイルの先頭にも原文を残す）

## Conventions

- HTML エスケープは `src/ui/escape.ts` の `escapeHtml()`（innerHTML に動的文字列を入れる場合は必須）
- ファイル入力ダイアログは `src/ui/file-input.ts` の `openFileDialog()`
- メッシュ削除時は関連リソースを全て cleanup（paint, morph, skeleton, modifier, shading, layer）
- Undo 対応: `state.history.push({ label, undo(), redo() })`
- compound undo は `state.history.popUndo()` で個別エントリを除去してまとめる

## Documentation Sync Rule

The help the user reads — the tool card, each panel section's note, the
modifier lines, the glossary, the shortcut table — and `MANUAL.html` are all
made from **one place** (ADR-014):

- `src/app/guide/guide.ts` — the text. Keys are never written into it: a
  `{key:<action>}` marker is filled from `src/keymap.ts`.
- `src/keymap.ts` — the keys (Blender's).
- `MANUAL.html` is **generated** with `npm run manual` and **not committed**
  (gitignored since 2026-09-25) — generate it when you want to read or share it.

When the code changes what a user sees or does — a new operator, a changed
default, a rebound key, a new tab or section — change `guide.ts` in the same
commit. `guide.test.ts` holds the guide to the code
(every marker names a bound key, the modifier list is the real one, …).

A tutorial for the new screen does not exist yet (the old
`TUTORIAL-KURIMANJU.html` was removed with the old screen).

## Testing

- **Framework:** Vitest（既定は node 環境、globals: true）
- **Storage mock:** fake-indexeddb
- **テストファイル:** `src/**/*.test.ts` / `*.test.tsx`（tsconfig.json の exclude で tsc ビルドから除外済み）。React の部品は先頭に `// @vitest-environment jsdom`
- **設定:** `vitest.config.ts`（vite.config.ts とは独立）

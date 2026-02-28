# FORGE 3D

## Quick Reference

```bash
npm run dev          # 開発サーバー起動 (localhost:5173)
npm run build        # TypeScript 型チェック + Vite ビルド
npm run test         # Vitest ユニットテスト実行
npm run test:watch   # Vitest ウォッチモード
npm run deploy       # Cloudflare Pages デプロイ
```

## Architecture

- **3D Engine:** Babylon.js 8.x (core / loaders / serializers)
- **Language:** TypeScript strict mode (`noUncheckedIndexedAccess` 等すべて有効)
- **Build:** Vite 7.x + vite-plugin-pwa + vite-plugin-compression
- **Hosting:** Cloudflare Pages
- **State:** `src/state.ts` にシングルトンで集約
- **Undo/Redo:** `src/undo.ts` の UndoHistory クラス（コマンドパターン、max 50）
- **Storage:** OPFS 優先 → IndexedDB フォールバック（`src/storage/`）
- **PWA:** Workbox (generateSW)、オフライン対応、自動保存 30秒間隔

## Project Structure

```
src/
  main.ts              — エントリポイント、レンダーループ
  state.ts             — グローバル状態
  input.ts             — ポインター / キーボード / タッチイベント
  undo.ts              — Undo/Redo 履歴
  viewport/            — エンジン、カメラ、環境、シャドウ、シェーディング、ポストプロセス
  tools/               — プリミティブ、選択、スカルプト、ペイント、スケルトン、ウェイト、アニメーション等
  ui/                  — UI構築、イベントバインド、パネル更新
  materials/           — PBR マテリアルヘルパー
  storage/             — メタデータ / モデルバイナリの永続化
  export/              — GLB / OBJ / STL エクスポート、ファイルインポート
```

## Conventions

- HTML エスケープは `src/ui/escape.ts` の `escapeHtml()` を使用（innerHTML に動的文字列を入れる場合は必須）
- ファイル入力ダイアログは `src/ui/file-input.ts` の `openFileDialog()` を使用
- メッシュ削除時は関連リソースを全て cleanup（paint, morph, skeleton, modifier, shading, layer）
- Undo 対応: `state.history.push({ label, undo(), redo() })` パターン
- compound undo は `state.history.popUndo()` で個別エントリを除去してまとめる

## Testing

- **Framework:** Vitest (node 環境、globals: true)
- **Storage mock:** fake-indexeddb
- **テストファイル:** `src/**/*.test.ts`（tsconfig.json の exclude で tsc ビルドから除外済み）
- **設定:** `vitest.config.ts`（vite.config.ts とは独立）

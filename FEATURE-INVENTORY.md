# Forge3D Feature Inventory

> **目的**: 業界標準 DCC（Blender / Maya / Cinema4D / ZBrush 等）と比較するためのチェックリスト。別セッションで「何が足りない / 何が独自 / どこを伸ばすか」をレビューするインプット。
>
> **生成日**: 2026-05-14
> **対象**: `forge3d/src/` 配下、tools 21 ファイル + viewport/export/storage/ui/materials
> **実装ステータス**: 以下すべて実装済み（TODO/スタブは除外）

---

## Modeling / Mesh
- Primitive Creation (Box, Sphere, Cylinder, Cone, Torus, Plane, Torus Knot, Ico Sphere) — 8種類のプリミティブ生成 (`primitives.ts`)
- Mesh Duplication — メッシュの複製とペイント/モーフターゲット状態の保持 (`actions.ts`)
- Mesh Deletion — スケルトン/モーフ/ペイント/シェーディング関連リソース自動クリーンアップ (`actions.ts`)
- Vertex Snapshot/Restore — Undo 用の頂点データ保存 (`mesh-utils.ts`)
- Recalculate Normals — 法線の再計算 (`mesh-utils.ts`)
- Flip Normals — 法線反転 (`mesh-utils.ts`)
- Weld Vertices — 許容値内の頂点統合 (`mesh-utils.ts`)
- Center Origin — メッシュ原点を中心へ移動 (`mesh-utils.ts`)

## Materials / Shading
- PBR Material Creation — デフォルト PBR マテリアル生成 (`pbr-helpers.ts`)
- PBR Properties (Albedo / Metallic / Roughness / Emissive) — PBR 設定の読み書き (`pbr-helpers.ts`)
- Texture Import (Albedo / Normal / Metallic / AO / Emissive) — 複数テクスチャスロットへのインポート (`texture-import.ts`)
- Dynamic Texture Painting — キャンバスベースの 1024×1024 ペイント (`texture-paint.ts`)
- Texture Slot Management — アルベド置換時のペイントテクスチャクリアロジック (`texture-import.ts`)
- Viewport Shading Modes (Solid / Wire / Matcap / Textured) — リアルタイムシェーディング表示切り替え (`shading.ts`)
- Matcap Generation — 動的にラジアルグラデーションで生成 (`shading.ts`)

## Skeleton / Rigging
- Skeleton Creation — 空のスケルトン生成 (`skeleton-tool.ts`)
- Bone Creation at World Position — 親子関係付きボーン作成 (`skeleton-tool.ts`)
- Bone Hierarchy Visualization — ボーン間の接続線表示 (`skeleton-tool.ts`)
- Skeleton Assignment to Mesh — メッシュへのスケルトン割り当て (`skeleton-tool.ts`)
- Bone Selection / Deselection — 個別ボーン選択 (`skeleton-tool.ts`)
- Bone Renaming — ボーン名変更 (`skeleton-tool.ts`)
- Bone Deletion — ボーン削除（自動親移行） (`skeleton-tool.ts`)
- Bone Visual Gizmos — 球体ビジュアルと選択ハイライト (`skeleton-tool.ts`)
- IK Constraint Support — IK 構造体定義（機能部分実装途上） (`skeleton-tool.ts`)

## Animation
- Animation Clip Management — クリップの作成・削除・アクティブ切り替え (`animation-tool.ts`)
- Keyframe Capture (Per-Bone / All Bones) — フレーム指定でボーン姿勢をキャプチャ (`animation-tool.ts`)
- Keyframe Editing (Delete / Copy / Paste) — キーフレーム単位の操作 (`animation-tool.ts`)
- Timeline Scrubbing — フレーム指定再生位置移動 (`animation-tool.ts`)
- Loop Mode Configuration (Cycle / Constant) — アニメーション再生モード設定 (`animation-tool.ts`)
- Playback Preview — リアルタイムプレビュー再生 (`animation-tool.ts`)
- Easing Curves (Linear / Ease-In/Out/InOut 4種×多項式) — キーフレーム補間設定 (`easing.ts`)
- Keyframe Easing Assignment — 個別キーフレームへのイージング適用 (`animation-tool.ts`)
- Animation Export as JSON — クリップを JSON 形式でエクスポート (`animation-tool.ts`)

## Texture / Painting
- Dynamic Texture Creation — UV 対応メッシュ用のペイント用動的テクスチャ (`texture-paint.ts`)
- Brush Painting (Circular Brush) — マウス座標ベースのペイント描画 (`texture-paint.ts`)
- Color / Size / Opacity Controls — カラーピッカー、ブラシサイズ、透明度スライダー (`texture-paint.ts`)
- Eraser Mode — 消去モード (`texture-paint.ts`)
- Paint Texture Clearing — ペイント内容リセット (`texture-paint.ts`)
- Existing Texture Loading to Canvas — インポートテクスチャの既存画像をキャンバスに読み込み (`texture-paint.ts`)

## Sculpt
- Sculpting Brushes (Push / Pull / Smooth / Flatten / Pinch / Inflate) — 6 種類のスカルプト変形 (`sculpt.ts`)
- Spatial Grid Acceleration — 高ポリゴンメッシュ用の三次元ハッシュグリッド最適化 (`sculpt.ts`)
- Brush Radius / Strength / Falloff — スカルプト設定パラメータ (`state.ts`)
- Vertex Falloff Calculation — ガウシアン型フォールオフ (`sculpt.ts`)
- Pinch / Inflate Special Handling — つまみ・膨張の個別ロジック (`sculpt.ts`)

## Viewport / Camera / Lighting
- Arc Rotate Camera — フリーな 3D カメラ制御 (`viewport.ts`)
- Camera Presets (Front / Back / Right / Left / Top / Bottom) — 6 方向の固定カメラビュー (`camera-presets.ts`)
- Orthographic Toggle — 透視/正投影の切り替え (`camera-presets.ts`)
- Multi-Touch Pan/Zoom — モバイル対応の 2 本指操作 (`viewport.ts`)
- Point Light Creation — 点光源追加 (`lighting.ts`)
- Spot Light Creation — スポットライト追加 (`lighting.ts`)
- Light Parameter Editing (Color / Intensity / Range) — ライト色・強度・範囲調整 (`lighting.ts`)
- Light Visual Indicators — ライト位置の球体/円錐ビジュアル (`lighting.ts`)
- Light Selection — 個別ライトの選択・操作 (`lighting.ts`)
- Hemispheric Light Base — 背景照明の事前設定 (`viewport.ts`)
- Directional Light Base — 主方向光とリム光 (`viewport.ts`)

## Tools — Selection / Snap / Measure / Modifiers / CSG / Morph / Layers / Parenting
- Transform Gizmo (Position / Rotation / Scale) — Babylon.js GizmoManager 統合 (`selection.ts`)
- Gizmo Undo/Redo — トランスフォーム操作の履歴対応 (`selection.ts`)
- Multi-Select (Ctrl/Cmd + Click) — 複数メッシュ選択 (`selection.ts`)
- Additive Selection — Shift 延長選択 (`selection.ts`)
- Snap to Grid (Position / Rotation / Scale) — スナップ距離設定 (`snap.ts`)
- Measurement Tool (Point-to-Point) — 世界座標距離測定とマーカー表示 (`measure.ts`)
- Measurement Overlay — リアルタイム距離表示 (`measure.ts`)
- Bounding Box Dimensions — メッシュ寸法計算 (`measure.ts`)
- Subdivision Modifier (Loop-style) — 段階的な細分化 (`modifiers.ts`)
- Mirror Modifier — X/Y/Z 軸ミラー (`modifiers.ts`)
- Array Modifier (Linear / Circular) — 配列複製 (`modifiers.ts`)
- Modifier Stack Evaluation — モディファイア合成 (`modifiers.ts`)
- Morph Targets (Shape Keys) — ターゲット作成・キャプチャ・削除 (`morph.ts`)
- Morph Target Influence Blending — 複数ターゲット混合 (`morph.ts`)
- Layer System — メッシュの階層分類と表示/非表示制御 (`layers.ts`)
- Parenting — 親子関係の設定・解除・循環チェック (`parenting.ts`)
- CSG Operations (Union / Subtract / Intersect) — ブール演算 (`csg.ts`)

## Import / Export
- GLB Export — 完全 3D 形式、スケルトン・アニメーション対応 (`gltf-exporter.ts`)
- OBJ Export — スタティックメッシュエクスポート (`gltf-exporter.ts`)
- STL Export — 3D プリント用形式 (`gltf-exporter.ts`)
- glTF / GLB / OBJ / STL Import — ファイル読み込み (`gltf-exporter.ts`)
- Skeleton Export Bridge — スケルトン構造の正規化 (`skeleton-export-bridge.ts`)
- AnimationGroup Import — 既存アニメーション互換性 (`gltf-exporter.ts`)
- Model Library Storage — OPFS / IndexedDB 保存・復元 (`model-store.ts`, `metadata-store.ts`)
- Scene Layout Export/Import — インスタンス配置の JSON 記録 (`map-editor.ts`)

## Storage / Persistence
- OPFS Primary Storage — 大容量ローカルストレージ優先 (`model-store.ts`)
- IndexedDB Fallback — OPFS 未対応環境のフォールバック (`model-store.ts`)
- Auto-Save Checkpoint — 30 秒間隔でのクラッシュリカバリ (`autosave.ts`)
- Model Metadata Store — タイトル/タイムスタンプ等を別管理 (`metadata-store.ts`)
- Storage Quota Estimation — 利用容量・制限確認 (`metadata-store.ts`)
- PWA Cache Strategy — Workbox 自動生成と可視化 (`main.ts`)

## UI / Panels / Input
- Tool Pill Navigation — Sculpt / Paint / Bone / Weight / Anim タブ (`ui/builders.ts`)
- Hierarchical Mesh Panel — ツリービュー + 色表示 + 削除ボタン (`ui/panels.ts`)
- Property Inspector — トランスフォーム (pos / rot / scale) 表示・編集 (`ui/panels.ts`)
- Bone Hierarchical Panel — ボーン選択 + 親子表示 (`ui/panels.ts`)
- Animation Timeline — フレームスライダー + キーフレーム表示 (`ui/bindings.ts`)
- Weight Paint Overlay — ペイント強度のグレースケール表示 (`weight-paint.ts`)
- Layer Management UI — レイヤーリスト + 表示切り替え (`ui/panels.ts`)
- Light Inspector — ライト選択 + パラメータ編集パネル (`ui/panels.ts`)
- Mobile Bottom Bar — 小画面向け工具バー (`ui/builders.ts`)
- Mobile Gizmo FAB — フローティングアクションボタン (`ui/builders.ts`)
- Keyboard / Touch Input Routing — ツール別イベント分岐 (`input.ts`)
- Touch Modifier Buttons (Ctrl/Shift Emulation) — モバイルキーボード補助 (`input.ts`)
- Status Bar Messages — 操作結果のフローティングテキスト (`state.ts`)
- FPS / Vertex / Triangle Counter — リアルタイムパフォーマンス統計 (`main.ts`)

## Rendering / Effects
- Post-Processing (FXAA / Bloom / Chromatic Aberration / Vignette) — デスクトップ限定の効果 (`postprocess.ts`)
- SSAO (Screen-Space Ambient Occlusion) — デスクトップ版環境光遮蔽 (`postprocess.ts`)
- Shadow System (Dynamic Cascade) — 動的シャドウマップ (`shadows.ts`)
- Environment Presets (Studio / Country HDRI) — 背景・照明プリセット (`environment.ts`)
- Custom HDRI Loading — ユーザーファイルの HDRI 読み込み (`environment.ts`)
- Skybox Toggle — 背景の表示/非表示 (`environment.ts`)
- Edge Rendering — デフォルト/選択時の線描画 (`mesh-utils.ts`)

## Weight Paint
- Weight Paint Initialization — 最大 4 ボーン影響度データ (`weight-paint.ts`)
- Weight Paint Modes (Add / Subtract / Smooth) — Ctrl/Shift 修飾でモード切り替え (`weight-paint.ts`)
- Weight Overlay Refresh — 視覚化の動的更新 (`weight-paint.ts`)

## Misc
- Undo/Redo History — 最大 50 エントリ (`undo.ts`)
- Model Library Management — 複数モデル保存・一覧・削除 (`map-editor.ts`)
- Model Instance Placement — シーン内での複数インスタンス配置 (`map-editor.ts`)
- File Import Dialog — 画像/モデル形式統一入力 (`ui/file-input.ts`)
- HTML Escape Utility — XSS 対策のサニタイズ (`ui/escape.ts`)
- Context Help System — キーバインドと機能説明 (`ui/bindings.ts`)

---

## 別セッションで聞きたいこと（レビュー観点の例）

1. **業界標準との比較**: 各カテゴリで Blender / Maya 等の機能と比べて
   - **欠けている重要機能**は何か？（例：Edit Mode の頂点/辺/面選択、UV 展開、Bevel など）
   - **独自で良いもの** は何か？（例：OPFS storage、PWA、モバイル対応）
   - **形だけあって弱い実装** は何か？
2. **ワークフロー的な抜け穴**: たとえばスケルトンを作ってからウェイトを塗るまでの導線、アニメ作成中のリファレンス参照など
3. **DCC として意外と無いと困る機能**: View 関連（**ボーン/メッシュ非表示トグル**、Iso 表示、ローカル軸切替）、Edit 関連（押し出し、ループカット）、計測関連（角度測定）など
4. **削るべき機能**: 業界標準でも DCC として必要性が薄く、メンテコスト>価値 なもの

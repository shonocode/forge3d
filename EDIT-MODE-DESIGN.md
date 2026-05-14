# Edit Mode 設計ドキュメント

> **目的**: forge3d に頂点/辺/面選択 + 編集機能（Blender の Edit Mode 相当）を追加するための設計書。後続セッションでこのドキュメントを起点に実装する。
>
> **元優先度**: P0 / L 規模（INDUSTRY-STANDARD-REVIEW.md より）
> **想定実装期間**: 1〜2 セッション（約 8〜12 時間相当）
>
> 作成日: 2026-05-14

---

## 1. 目的と現状

### なぜ必要か
- 現状の forge3d は **スカルプト + プリミティブ生成 + CSG** のみ
- メッシュの「特定の頂点 / 辺 / 面を選んで編集する」操作ができない
- 結果として、オリジナルキャラのモデリングが詰む
  - 例：「肘の頂点を 5 個だけ動かしたい」「腰のループに辺を追加したい」「指先の面を押し出して指を生やしたい」が不可能
- スカルプトはあくまで筋肉のような有機的な凹凸用で、トポロジを直接制御する手段が無い

### 業界標準との比較
| DCC | Edit Mode 相当 | 主要オペレータ |
|---|---|---|
| Blender | Tab で切替 | Extrude (E), Bevel (Ctrl+B), Loop Cut (Ctrl+R), Inset (I), Knife (K) |
| Maya | コンポーネントモード | Extrude Face/Edge, Bevel, Insert Edge Loop |
| Modo | Component Mode | 同上 |

forge3d は **Edit Mode の入口（コンポーネント選択）と最重要オペレータ（Extrude / Bevel / Loop Cut / Inset）** が無い。これが入ればキャラモデリングの 80% は forge3d 内で完結できる。

---

## 2. スコープ定義

### V1（このドキュメントの対象）
1. **モード切替**: Object Mode ↔ Edit Mode のトグル（Tab キー）
2. **コンポーネント選択モード**: Vertex / Edge / Face の3モード（数字キー 1/2/3）
3. **クリック選択**: 単一 + Ctrl+クリック追加 + Shift+クリック範囲
4. **ボックス選択** (B): 矩形ドラッグで複数選択
5. **コンポーネント Gizmo**: 選択された頂点群の重心に位置 gizmo
6. **Extrude (E)**: 面 / 辺 / 頂点を押し出す
7. **Bevel (Ctrl+B)**: 辺を面取りする（width スライダー / セグメント数）
8. **Loop Cut (Ctrl+R)**: 連続辺をループとして検出して新規ループを挿入
9. **Inset (I)**: 面の内側に縮小コピーを挿入
10. **Delete (X)**: 選択削除（Vertex / Edge / Face / Only Faces / Edge Loop）

### V2（V1 完了後に検討）
- Knife (K): フリーハンドで面を切る
- Bridge Edge Loops: 二つのループを面でつなぐ
- Merge Vertices: 選択頂点を1点に統合
- Edge Slide: 辺をループに沿ってスライド
- Proportional Editing: 選択範囲外の頂点も滑らかに連動

### 非対象（V3 以降 or 永遠に non-goal）
- スカルプティング統合（既存 sculpt.ts はそのまま）
- UV 編集（別 P0 で扱う）
- N-gon サポート（quad/tri に正規化）

---

## 3. データモデル

### 3.1 Half-Edge 構造（推奨）

Babylon.js のメッシュは「flat な vertex 配列 + index buffer」のみで、辺・面の連結情報を持たない。Edit Mode のオペレータ（隣接面検出、ループ検出、辺スライド）は連結情報が必須。

**Half-Edge データ構造** を導入する：

```typescript
interface HalfEdge {
  /** この half-edge の始点頂点 */
  vertex: number;
  /** 同じ面内の次の half-edge */
  next: HalfEdge;
  /** 反対側の面に属する pair half-edge（境界辺なら null） */
  twin: HalfEdge | null;
  /** この half-edge が属する面 */
  face: Face;
}

interface Vertex {
  index: number;
  /** この頂点から出る代表 half-edge */
  outgoing: HalfEdge;
}

interface Face {
  /** この面の代表 half-edge */
  halfEdge: HalfEdge;
}

interface EditMesh {
  /** Babylon.js Mesh への参照（同期対象） */
  source: Mesh;
  vertices: Vertex[];
  faces: Face[];
  halfEdges: HalfEdge[];
  /** Mesh.getVerticesData の position 配列キャッシュ */
  positions: Float32Array;
}
```

### 3.2 Babylon.js Mesh との同期

Edit Mode に入る時：
1. `mesh.getVerticesData("position")` から positions を取得
2. `mesh.getIndices()` から triangles を取得
3. Half-Edge を構築（O(N) で）

Edit Mode 中：
- オペレータは Half-Edge を書き換える
- 各オペレータ実行後、`mesh.setVerticesData("position", ...)` で位置を書き戻す
- `mesh.updateVerticesData("normal", ...)` で法線も再計算
- Index buffer は変更があったときだけ再生成

Edit Mode を抜ける時：
- 最終 Half-Edge → triangle list 変換
- 全頂点属性（position, normal, uv, weights）を再構築
- skin weights の保持（特に重要）：頂点が増えた場合は親頂点のウェイトをコピー

### 3.3 選択状態

```typescript
type ComponentMode = "vertex" | "edge" | "face";

interface Selection {
  mode: ComponentMode;
  /** 頂点 / 辺 / 面のインデックス集合（モードによって意味が変わる） */
  indices: Set<number>;
}
```

`state.editMesh: EditMesh | null` と `state.editSelection: Selection` を追加。

---

## 4. UI 設計

### 4.1 モード切替

ヘッダーバー（既存のツール pill の右）に「Mode: Object | Edit」のトグル。
- Object Mode: 現状の挙動（メッシュ全体を扱う）
- Edit Mode: 選択メッシュを Half-Edge 化し、コンポーネント操作に切替

ショートカット: **Tab キー**（既存 keybind と衝突なし）

### 4.2 コンポーネントモード切替

Edit Mode 時、ヘッダー内に「V | E | F」（Vertex / Edge / Face）の3-state トグル。

ショートカット: **1 / 2 / 3**（既存の Numpad プリセットと衝突しないよう、`!e.code.startsWith("Numpad")` で分岐）

### 4.3 ツールバー（左サイドの新規パネル）

Edit Mode 時のみ表示:

```
┌─────────────────────┐
│ Edit Tools          │
├─────────────────────┤
│ [Extrude]       (E) │
│ [Bevel]    (Ctrl+B) │
│ [Loop Cut] (Ctrl+R) │
│ [Inset]         (I) │
│ [Delete]        (X) │
│ [Select All]    (A) │
│ [Box Select]    (B) │
├─────────────────────┤
│ Bevel Width: ▬▬○━━ │
│ Bevel Segs:  [ 1 ] │
│ Inset Amount:▬▬○━━ │
└─────────────────────┘
```

### 4.4 描画（ビューポート オーバーレイ）

Edit Mode 時：
- **Vertex モード**: 頂点に小さなドット表示（選択 = 黄色、非選択 = 白）
- **Edge モード**: 辺をハイライトライン表示（選択 = 黄、非選択 = 灰）
- **Face モード**: 選択された面を半透明黄色で塗る

実装方針：
- Vertex / Edge: `LinesMesh` + `PointsCloudSystem` で per-frame に再構築（メッシュ変形に追従）
- Face: 別 Babylon.js Mesh を派生、選択面だけのジオメトリ、`alpha = 0.3` のマテリアル

頂点数が多いメッシュで重くなる場合は LOD（カメラ距離で間引き）を検討。

---

## 5. オペレータ仕様

### 5.1 Extrude (E)

**入力**: 選択された頂点 / 辺 / 面 + 押し出し方向（マウスドラッグ）

**Face モード**:
1. 選択された面の境界辺を検出
2. 各境界辺を「2つの新規辺 + 1つの新規面」に拡張
3. 元の面は新規頂点に移動
4. 押し出し方向 = 面法線（マウス Y 軸でスケール）

**Edge モード**:
1. 選択辺のコピーを作成、新規面で繋ぐ
2. 押し出し方向 = 辺の垂直方向 + 関連面法線の平均

**Vertex モード**:
1. 頂点を複製し、新規辺で繋ぐ
2. 押し出し方向 = 接続辺の平均逆方向

### 5.2 Bevel (Ctrl+B)

**入力**: 選択辺 + width パラメータ + segments パラメータ

**アルゴリズム**:
1. 各選択辺について、両端の頂点を辺の垂直方向に分割
2. 分割幅 = width パラメータ
3. segments > 1 の場合、分割の間を円弧で補完
4. 元の辺は削除、新規 quad（or 複数 quad）で置換

**特殊ケース**:
- 角（複数辺が同じ頂点で交わる）: V字 → 三角形 chamfer に展開

### 5.3 Loop Cut (Ctrl+R)

**入力**: マウスホバー位置から「ループ」を検出 → クリックで確定

**ループ検出アルゴリズム** (quad mesh 前提):
1. ホバー位置で最も近い辺を見つける
2. その辺と「向かい合う辺」（同じ face 内で対辺）を辿る
3. 隣接 face に進んでまた対辺を辿る
4. 元の辺に戻るか境界に到達するまで繰り返す
5. これがループ

**カット**:
1. ループ内の各辺の中点に新規頂点を挿入
2. 中点を直線で繋ぐ新規辺を追加
3. 各 quad を 2 つに分割
4. プレビュー: マウス位置で「カット位置」を 0.0〜1.0 でスライド可能

### 5.4 Inset (I)

**入力**: 選択された面 + amount パラメータ

**アルゴリズム**:
1. 各選択面について、内側にスケールしたコピーを作成
2. amount = 元の面の中心への補間係数
3. 元の面と新規面の間を quad ストリップで繋ぐ

### 5.5 Delete (X)

メニューで選択：
- **Vertices**: 頂点削除 + 接続辺・面も削除
- **Edges**: 辺削除（隣接面はマージ）
- **Faces**: 面削除（頂点・辺は残す）
- **Only Faces**: 面のみ削除（辺・頂点は残す）
- **Edge Loop**: ループ全体を削除（quad ストリップを縮退）

---

## 6. 実装計画（段階的）

### Phase 1: 基盤（推定3〜4時間）
- [ ] `src/tools/edit-mode/` ディレクトリ新設
- [ ] Half-Edge データ構造 (`half-edge.ts`)
- [ ] Mesh → Half-Edge 変換 (`build.ts`)
- [ ] Half-Edge → Mesh 変換 (`commit.ts`)
- [ ] State 拡張: `editMesh`, `editSelection`, `componentMode`
- [ ] Tab キーでモード切替（実メッシュ書き換えなしで往復可能）

### Phase 2: 選択 + 描画（推定3〜4時間）
- [ ] コンポーネント選択描画オーバーレイ（vertex dots, edge lines, face highlights）
- [ ] クリック選択（ピッキング: vertex は近接判定、edge は辺-ray 最近接、face は通常 pick）
- [ ] Ctrl/Shift 修飾子
- [ ] Box Select (B キー → 矩形ドラッグ)
- [ ] Select All (A キー)
- [ ] コンポーネント Gizmo（選択重心に位置 gizmo、ドラッグで頂点群を平行移動）

### Phase 3: Extrude + Delete（推定2〜3時間）
- [ ] Face Extrude
- [ ] Edge Extrude
- [ ] Vertex Extrude
- [ ] Delete メニュー（Vertices / Edges / Faces / Only Faces）

### Phase 4: Bevel + Inset（推定2〜3時間）
- [ ] Edge Bevel (width + segments)
- [ ] Face Inset (amount)
- [ ] パラメータ調整 UI

### Phase 5: Loop Cut + Edge Loop Delete（推定2〜3時間）
- [ ] ループ検出アルゴリズム
- [ ] Loop Cut プレビュー + 確定
- [ ] Edge Loop Delete

### Phase 6: 統合 + Polish（推定1〜2時間）
- [ ] Undo/Redo 統合（Half-Edge スナップショット）
- [ ] Object Mode 復帰時のウェイト保持テスト
- [ ] パンチアニメ作業のくりまんじゅうメッシュで実地テスト

**合計**: 約 13〜19 時間（複数セッション必須）

---

## 7. リスク

### 7.1 Skin Weights 保持
**問題**: 頂点を増やす操作（Extrude, Bevel, Loop Cut）で新規頂点が生まれる。これらが weight data を持っていないと、Object Mode に戻ったときボーンに連動しない。

**対策**:
- 新規頂点は「源となった頂点」（押し出し元 / Bevel 元）から weight をコピー
- Bevel / Loop Cut の中間点は、両端頂点の weight を線形補間

### 7.2 法線の整合性
**問題**: トポロジ変更後、自動法線計算が「flat shading」になりがち（隣接面情報が変わるため）。

**対策**:
- Edit Mode 中は per-face flat normal で描画（編集中の視認性優先）
- Object Mode に戻った時点で `mesh.createNormals(true)` で smooth normal 再計算

### 7.3 パフォーマンス
**問題**: Half-Edge 構築は O(N)、選択描画は O(選択数)。10万頂点級のメッシュで急に重くなる。

**対策**:
- chiikawa-reign のキャラは数千頂点程度（くりまんじゅう: 約 800 頂点）なので問題なし
- 将来 LOD 必要になったらカメラ距離による間引き

### 7.4 既存スカルプト/ペイント/ウェイトとの干渉
**問題**: Edit Mode で頂点数が変わると、`paintTextureMap` / `morphMap` / `weight data` のインデックスがズレる可能性。

**対策**:
- Edit Mode 中はスカルプト / ペイント / ウェイトツールに切替不可（ガード）
- Object Mode 復帰時に paintTexture / morphTarget の vertex count をチェックし、不整合なら警告
- Modifier stack はそのまま（Edit Mode は base mesh だけを編集）

---

## 8. テスト戦略

### 8.1 単体テスト（Vitest）
- Half-Edge 構築: 既知メッシュ（cube, sphere）で正しい連結情報が出るか
- Loop 検出: cube の1辺をホバー → 4辺ループが取れるか
- Extrude: face を押し出すと頂点数が +(face頂点数) になるか
- Bevel: 辺を bevel すると面が 1 → (1 + 2*segments) 個に増えるか

### 8.2 統合テスト（手動）
- くりまんじゅうメッシュで指を生やす（face select → Extrude × 2 → 確定）
- 腰のループに辺を追加（Loop Cut → スライド → 確定）
- 不要な内部頂点を削除（Delete > Vertices）

### 8.3 リグ整合性テスト
- Edit Mode で頂点追加 → Object Mode 復帰 → Bone Tool → Weight Paint → Pose Mode で動かす → 新規頂点もウェイト連動するか

---

## 9. 参照実装

業界標準の Half-Edge 実装で参考になるもの:

- **Blender (BMesh)**: src/blender/source/blender/bmesh/ — production-grade、複雑
- **OpenMesh**: C++ ライブラリ、API が綺麗
- **Polygon Mesh Processing Library (PMP)**: モダンな C++、参考向き
- **three.js BufferGeometryUtils + adjacency**: 比較的シンプル、JS で参考可能

forge3d 用にはこれらを参考に **TypeScript で 0 から書く**（依存追加なし、エンジン非依存に保つ）。

---

## 10. 次セッションへの引き継ぎ

このドキュメントを起点に：

1. 別セッションで `/dev-story` 相当のフローで実装着手
2. 第一目標は **Phase 1（基盤）+ Phase 2（選択 + 描画）** の完了
3. 完成判定: Cube に対して頂点選択 → 位置 Gizmo で動かせる → Tab で Object Mode 復帰 → 動かした結果がメッシュに残る

Phase 3 以降はまた別セッションで段階的に実装。

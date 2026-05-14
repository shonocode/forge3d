# Forge3D Industry-Standard Review

> 比較対象: Blender 4.x（主軸）, Maya, ZBrush, Modo
> レビュー日: 2026-05-14
> ユースケース: ゲームキャラクター（モデル / リグ / アニメ）の個人制作

---

## 総評（3–5 行）

Blender 比で **20〜30 %** の機能カバレッジ。骨格構造（Skeleton / Weight Paint / Animation Clip / Keyframe）を一気通貫でブラウザ上に持っている点は個人製 DCC として異例の完成度であり、実際にキャラを動かすための最低限のパイプラインは成立している。致命的弱点は **Edit Mode の欠如**（頂点 / 辺 / 面の直接編集が不可能）と **UV 展開ツールの完全な欠如**で、これらがある限りオリジナルメッシュを forge3d だけで仕上げることはできない。IK についても `solveIK()` の実装コードは animation-tool.ts に存在するが、ikConstraint を有効化する UI・設定パネルが存在せず、ユーザーから到達できない状態にある（= 事実上未実装）。

---

## 1. 欠けている重要機能

### P0（今すぐ実装すべき——作業が止まる）

| 機能 | なぜ必要か | 推奨実装規模 |
|---|---|---|
| **Edit Mode（頂点 / 辺 / 面の選択・変形）** | Extrude / Bevel / Loop Cut / Inset なしではキャラクター体型の基本形が作れない。プリミティブをスカルプトだけで仕上げるのには限界がある | L |
| **UV 展開（Seam 設定 + Unwrap / Smart UV Project）** | テクスチャペイントが UV なしでは正しく機能しない。インポートメッシュは UV を持つがオリジナル作成時に UV が無い | M |
| **IK 有効化 UI（ikConstraint の設定パネル）** | `solveIK()` のロジックは存在するが、chainLength / target 座標を設定するパネルが皆無。パンチアニメでは手首の IK が必須 | S |
| **Pose Mode（ボーンを独立して回転 / 移動し、アニメ姿勢を作る）** | 現状は World 座標でボーンを移動するだけで「ポーズを付ける」UX が成立していない。キーフレームを撮る前に Pose Mode が必要 | M |

### P1（あると体験が大きく変わる）

| 機能 | なぜ必要か | 推奨実装規模 |
|---|---|---|
| **グラフエディタ（F カーブ編集）** | イージングカーブ種別の選択はあるが、キー間の Bezier ハンドルを視覚的に操作できない。パンチの「溜め → 瞬間 → 残心」を表現するのに必須 | M |
| **ドープシート（全ボーン全キーの 2D 一覧）** | 現状のタイムラインは 1 ボーン分しか見えない。複数ボーンの同期タイミング確認が困難 | M |
| **Mesh / Skeleton の表示 / 非表示トグル（H/Alt+H 相当）** | スケルトン編集中にメッシュが邪魔でボーン配置を確認しにくい。モデリング中はボーンビジュアルを隠したい | S |
| **ループカット（Edge Loop Insert）** | 体型修正時の密度制御。Edit Mode の一部だが用途が特に高いので別掲 | M（Edit Mode の P0 実装後） |
| **頂点グループ（Vertex Group）の表示と管理** | Weight Paint が骨ごとに分離しているが、グループを名前付きで管理する UI がない。ボーン数が増えると作業が困難になる | S |

### P2（あれば便利、代替手段あり）

| 機能 | なぜ必要か | 推奨実装規模 |
|---|---|---|
| **ルートモーションチャンネル対応** | キャラ移動量をアニメに焼き込む。chiikawa-reign の RootMotion システムと連携できると便利 | M |
| **NLA Editor（アニメクリップの非破壊合成）** | 複数クリップを重ねて最終アニメを作る。Phase 2 以降で検討 | L |
| **角度測定（Measure Tool の角度対応）** | 現状は距離測定のみ。リグのボーン角度確認に使う | S |
| **ボーン回転の制限（Bone Constraints / Limit Rotation）** | 膝や肘の過伸展防止。IK との組み合わせで真価を発揮 | M |
| **Custom Bone Shape（ボーンのカスタム表示形状）** | コントロールリグの視認性向上。IK ハンドル等の表示に使う | S |
| **マルチ UV チャンネル** | ライトマップ用の第 2 UV。ゲームキャラでは必要なケースあり | M |

---

## 2. 独自で良いもの（差別化ポイント）

- **OPFS + IndexedDB 二重化ストレージ** — ブラウザ DCC でこのレベルの永続化を持つツールは稀。30 秒オートセーブと容量クォータ確認も揃っている。`Quota Estimation` を UI に出してユーザーに残量を伝える UX を伸ばすと良い
- **PWA オフライン対応** — インターネット接続なしで使える DCC はデスクトップ以外では珍しい。オフライン時に「保存先がない」状態にならない設計が優秀
- **モバイル / タッチファースト UX** — Multi-Touch Pan/Zoom、Bottom Bar、FAB、Touch Modifier Buttons（Ctrl/Shift エミュレーション）は Blender にも Maya にもない。タブレットで使える DCC という独自ポジションを守る価値がある
- **glTF / GLB ネイティブ出力（スケルトン + アニメ同梱）** — gltf-exporter.ts + skeleton-export-bridge.ts の組み合わせで、Babylon.js 互換の形式をそのまま出力できる点は chiikawa-reign との連携コストを劇的に下げる。meta.json との組み合わせで拡張可能な余地も残っている
- **Spatial Hash Grid による高ポリ Sculpt** — 5000 頂点以上でグリッドアクセラレーションに自動切換えする設計は、ブラウザ制約の中でも実用的なスカルプトを維持できる根拠になっている

---

## 3. 形だけあって弱い実装

| 機能 | 何が弱いか | 改善 or 削除 |
|---|---|---|
| **IK Constraint（`solveIK()` は実装済み）** | `ikConstraint` を有効化・設定する UI パネルが一切ない。`ikConstraint.enabled` が false のままで `solveIK()` は呼ばれない。手のひらを目標点に向けて腕全体が追従する動きができない | 改善（P0: IK 有効化 UI を追加） |
| **Weight Paint（Add / Subtract / Smooth）** | 3 モード自体は動作するが、ブラシ半径・強度を変えながらの作業中に「全ボーン合計 = 1.0 の正規化」が強制されるため、複数ボーンの影響を精細にコントロールする "Lock" 機能がない。高密度ポリゴンでは毎ストロークの線形スキャンがカクつく可能性 | 改善（Lock slot 機能、高ポリ時のグリッド最適化） |
| **Bone Visual Gizmo（位置移動のみ）** | `selectBone()` で positionGizmo のみ有効化。回転 Gizmo が無いため、ボーンのロール（捻り）を GUI 操作できない | 改善（Pose Mode 実装時に回転 Gizmo を追加） |
| **Morph Target Influence Blending** | 複数ターゲット混合は可能だが、Shape Key アニメ（フレームごとに influence を変化させる Shape Key トラック）がアニメーション clip に組み込めない | 改善（P2: Shape Key track を BoneTrack と並列で持たせる） |
| **Animation Timeline UI** | フレームスライダーとキーフレームマーカーが表示されるが、全ボーンのキーが同一行に重なって見える。ドープシートに相当するレーンごとの表示がない | 改善（P1: ドープシート） |
| **Easing Curve** | `easing.ts` に Linear / EaseIn / EaseOut / EaseInOut の 4 系統は揃っているが、Bezier ハンドルで任意カーブを引く機能がない。"パンチが当たった瞬間だけ急加速" を表現するには不十分 | 改善（P1: グラフエディタ） |

---

## 4. 削るべき機能

| 機能 | 削る理由 |
|---|---|
| **STL Export** | 3D プリント専用フォーマット。ゲームキャラ制作パイプラインに用途がない。gltf-exporter.ts から削除するとコード量が減り保守負荷が下がる |
| **Scene Layout Export/Import（map-editor.ts）** | インスタンス配置の JSON 記録・複数インスタンス配置は enki-editor（Phase 3 で作成予定）の責務。forge3d の「アセット作成 DCC」という役割からはみ出しており、enki-editor が完成した時点で重複する |
| **Post-Processing (FXAA / Bloom / Chromatic Aberration / Vignette) / SSAO** | プレビュー品質向上のためだが、ゲームキャラ制作では「チェック用のクリーンな Matcap 表示」の方が有用。エフェクトが邪魔でウェイト確認やシルエット確認がしにくくなるケースがある。デスクトップ限定という制約もあり、削除してビルドサイズ削減 |
| **Model Instance Placement (map-editor.ts のインスタンス配置部分)** | 上記 Scene Layout と同様、enki-editor に委譲すべき機能。forge3d は 1 モデル＝1 ファイルの編集に集中すべき |

---

## 5. 推奨ロードマップ（順序付き）

パンチアニメ作業を最優先に、進行中の「くりまんじゅうのパンチアニメ作成」を止めない順序で提案する。

### Step 1: IK 有効化 UI（P0 / 規模 S）

- `skeleton-tool.ts` の `BoneData.ikConstraint` を設定するパネルを `ui/panels.ts` に追加
- Bone Inspector に「IK Enable / Chain Length / Target XYZ」の入力欄を追加
- `animation-tool.ts` の `solveIK()` を毎フレームの Before Render フックから呼ぶ
- **この 1 件で腕の IK が実用になる。パンチアニメの手首制御が激変する**

### Step 2: Pose Mode（P0 / 規模 M）

- Bone ツール時に「Edit（ボーン配置）」と「Pose（姿勢付け）」のトグルを追加
- Pose Mode では positionGizmo に加えて rotationGizmo を有効化
- ボーンの Local 軸での回転（肩 → 肘 → 手首の自然な曲がり方）を実現
- **キーフレームを撮る前の「ポーズ作り」ワークフローが成立する**

### Step 3: グラフエディタ（P1 / 規模 M）

- Timeline 下部に Canvas ベースの F カーブビューを追加
- 既存の `easing.ts` を活かしつつ、キーフレームに Bezier ハンドルの tangent データを追加
- 「溜め → 瞬発 → 残心」の緩急をハンドル操作で調整できるようにする
- **パンチアニメの質が定性的に跳ね上がる**

### Step 4: ドープシート（P1 / 規模 M）

- Timeline エリアを全ボーンのレーン表示に拡張
- 各ボーンのキーをダイヤモンド記号でレーンに表示、Drag でフレーム移動
- **全身アニメのタイミング調整が視覚的に完結する**

### Step 5: Edit Mode（P0 / 規模 L）——パンチアニメ完成後に着手推奨

- パンチアニメが完成した後、次のキャラ制作に入る前に実装
- 頂点 / 辺 / 面の選択モード切り替え（Tab キー）
- Extrude / Bevel / Loop Cut / Inset の 4 操作を最初のターゲットに
- UV 展開は Edit Mode と同フェーズで実装（Seam 設定は Edit Mode 依存）

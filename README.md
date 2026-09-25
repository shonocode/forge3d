# forge3d

> A modelling library for code, and a browser GUI to look at what it makes — ported from Blender 5.1.1 and measured against it. GPL-3.0-or-later. Documentation is in Japanese.

**コードから呼べるモデリングライブラリ**と、作ったものを目で確かめるためのブラウザ GUI。
Babylon.js と TypeScript で作っている。

**状態：保守フェーズ（2026-09-25〜）。** ライブラリは、Blender 5.1.1 と同じだと言っている所は
すべて実測で一致させてある（推測ではなく、同じ入力を両方に通して比べている）。GUI は React で
作り直した。これからの仕事は、使って出てきた不具合の修正と小さな追加。

## ライブラリ

公開 API は [`src/lib/index.ts`](src/lib/index.ts)。ここから出ているものはすべてヘッドレスで、
DOM・エディタの状態・シーンを持たない。想定している使い手は、ビルドスクリプト、アセットの
パイプライン、モデリングのコードを書くエージェント。

```ts
import { meshFromData, meshToData, extrudeFaces, catmullClark } from "forge3d";

const em = meshFromData({ positions, polys });
extrudeFaces(em, new Set([topFace]));
const { positions: p, polys: f, creases } = meshToData(em);
const smooth = catmullClark(p, f, 2, creases);
```

Blender 5.1.1 と比べた範囲（詳細は chiikawa-soul 側の文書）：

| Blender の面 | 状態 |
|---|---|
| `bmesh.ops`（80 個） | 76 個が Blender と一致。1 個は実装済みだが比べようがない（`create_vert`）、3 個は型変換で対応物が無い |
| `bpy.ops.mesh` 専用の操作 | 15 / 15 |
| モディファイア（メッシュ用 36 個） | 31 個あり、すべて一致。残りは OpenVDB が要るもの（Remesh の Voxel、ボリューム⇔メッシュ）と、基準の形が要るもの（Corrective Smooth、Laplacian Deform） |
| 手続きテクスチャ | Clouds・Wood・Marble・Magic・Blend・Stucci・Musgrave・Voronoi・Distorted Noise（Noise は Blender が時計で種を取るので不可） |

「一致」は**パリティの行**があるという意味 ― 同じ入力を Blender と forge3d の両方に通し、
頂点ごと・面ごとに比べている。比較の仕組みと各行の記録は chiikawa-soul の
`tools/modeling/parity/` にある。

## GUI

Babylon のビューポートの上に React の画面（`src/app/`）。編集モード、スカルプト、テクスチャと
ウェイトのペイント、ボーンとアニメーション、モディファイア、読み込み・書き出し（GLB・glTF・OBJ）。

- **ショートカットは Blender と同じ**（`src/keymap.ts`）
- **道具・タブ・パネルの各セクションに、平易な解説が付いている。** 文面は
  `src/app/guide/guide.ts` の1か所に書き、画面のヘルプと単体のマニュアル `MANUAL.html` の
  両方をそこから作る（`npm run manual`、コミットはしない）

## コマンド

```bash
npm install
npm run dev        # http://localhost:5173
npm run test       # Vitest（node 環境。React の部品は jsdom）
npm run build      # tsc && vite build ― tsc は型エラーでも exit 0 なので、出力を読むこと
npm run manual     # MANUAL.html を解説データから作る
npm run preview    # ビルドしてローカルで配信
```

GitHub Pages には push のたびに `.github/workflows/deploy.yml` が出す
（`/forge3d/` の下に配信）。

## ライセンス

**GPL-3.0-or-later** ― [`LICENSE`](LICENSE) を参照。

`src/tools/` の多くは Blender のソース（GPL-2.0-or-later）からの移植なので、forge3d はその
派生物として GPL になる。ほかに Bullet の凸包（zlib）と Eigen の Jacobi SVD（MPL-2.0）から
移植した部分がある。移植元・ライセンス・移植先の一覧は [`NOTICE.md`](NOTICE.md)。

実際の意味：forge3d は自由に使い・変え・配ってよい。forge3d のコードを取り込んだプログラムを
配るなら、それも GPL で配ることになる。forge3d で**作った**メッシュやファイルはあなたのもの
― ライセンスがかかるのはコードで、その出力ではない。

## 文書の置き場

chiikawa-soul リポジトリ側（このリポジトリはその中にチェックアウトされている）：

- `docs/architecture/forge3d.md` ― 入口。状態、安全に変える手順、未解決のこと
- `docs/architecture/forge3d-blender-api-matrix.md`、`forge3d-blender-surface-map.md` ―
  Blender との対応表
- `docs/architecture/adr-012` / `013` / `014` ― boolean、remesh、React の GUI
- `docs/architecture/archive/forge3d/` ― 開発中のロードマップと記録

このリポジトリの作業規約は [`CLAUDE.md`](CLAUDE.md)。

# forge3d

> A modelling library for code, and a browser GUI to look at what it makes — ported from Blender 5.1.1 and measured against it. GPL-3.0-or-later. Documentation is in Japanese.

**コードから呼べるモデリングライブラリ**と、作ったものを目で確かめるためのブラウザ GUI。
Babylon.js と TypeScript で作っている。

ライブラリの多くは Blender 5.1.1 の移植で、「Blender と一致」と書いているものは、同じ入力を両方に
通して比べた結果だ（推測ではない）。いまは新機能より、使って出てきた不具合の修正を優先している。

## 使い方

npm には出していない。GitHub から入れる：

```bash
npm install github:shonocode/forge3d
```

パッケージは TypeScript のソース（`src/lib/index.ts`）をそのまま指している。Vite などのバンドラや
`tsx` からはそのまま読める。素の `node` は `node_modules` の中の `.ts` を実行しないので、
その場合はバンドラを通すこと。

```ts
import { meshFromData, meshToData, extrudeFaces, catmullClark } from "forge3d";

const em = meshFromData({ positions, polys });
extrudeFaces(em, new Set([topFace]));
const { positions: p, polys: f, creases } = meshToData(em);
const smooth = catmullClark(p, f, 2, creases);
```

公開 API は [`src/lib/index.ts`](src/lib/index.ts) に全部ある。どれもヘッドレスで、DOM・エディタの
状態・シーンを持たない。想定している使い手は、ビルドスクリプト、アセットのパイプライン、
モデリングのコードを書くエージェント。

## Blender との一致

| Blender の機能 | 状態 |
|---|---|
| `bmesh.ops`（80 個） | 76 個が一致。1 個は実装済みだが比べようがない（`create_vert`）。3 個は型の変換で、対応するものが無い |
| `bpy.ops.mesh` 専用の操作 | 15 / 15 |
| モディファイア（メッシュ用 36 個） | 31 個。無いのは OpenVDB が要るもの（Remesh の Voxel、ボリューム⇔メッシュ）と、基準の形が要るもの（Corrective Smooth、Laplacian Deform） |
| 手続きテクスチャ | Clouds・Wood・Marble・Magic・Blend・Stucci・Musgrave・Voronoi・Distorted Noise（Noise は Blender が時計から種を取るので比べられない） |

ここでの「一致」は、**測った引数と入力で**、頂点・面・層（UV・色・法線など）まで Blender と
同じ出力が出たという意味だ。比べ方、基準、まだ合っていないオプションの一覧は
[`docs/parity.md`](docs/parity.md) にある。

## GUI

Babylon のビューポートの上に React の画面（`src/app/`）。編集モード、スカルプト、テクスチャと
ウェイトのペイント、ボーンとアニメーション、モディファイア、読み込み・書き出し（GLB・glTF・OBJ）。

- **ショートカットは Blender と同じ**（`src/keymap.ts`）
- **道具・タブ・パネルの各セクションに、平易な解説が付いている。** 文面は
  `src/app/guide/guide.ts` の1か所に書き、画面のヘルプと単体のマニュアル `MANUAL.html` の
  両方をそこから作る（`npm run manual`）

GitHub Pages に公開している：<https://shonocode.github.io/forge3d/>

## 開発

```bash
git clone https://github.com/shonocode/forge3d.git
cd forge3d
npm install
npm run dev        # http://localhost:5173
npm run test       # Vitest（node 環境。React の部品は jsdom）
npm run build      # tsc && vite build
npm run manual     # MANUAL.html を解説データから作る
npm run preview    # ビルドしてローカルで配信
```

`main` に push するたびに `.github/workflows/deploy.yml` が GitHub Pages に出す。

## ライセンス

**GPL-3.0-or-later** ― [`LICENSE`](LICENSE) を参照。

`src/tools/` の多くは Blender のソース（GPL-2.0-or-later）からの移植なので、forge3d はその
派生物として GPL になる。ほかに Bullet の凸包（zlib）と Eigen の Jacobi SVD（MPL-2.0）から
移植した部分がある。移植元・ライセンス・移植先の一覧は [`NOTICE.md`](NOTICE.md)。

実際の意味：forge3d は自由に使い・変え・配ってよい。forge3d のコードを取り込んだプログラムを
配るなら、それも GPL で配ることになる。forge3d で**作った**メッシュやファイルはあなたのもの
― ライセンスがかかるのはコードで、その出力ではない。

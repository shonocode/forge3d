/**
 * What every tool, tab and panel section is for, in plain words — the one
 * place the new screen's help (tool card, section notes, glossary) and the
 * manual are made from (ADR-014, forge3d-roadmap "GUI の役割").
 *
 * Started from the Claude Design proposal's `FORGE_GUIDE`
 * (https://claude.ai/artifact/GBczkoJreBcoevLnGYd9DT) and checked against the
 * code on 2026-09-25. What changed on the way in:
 *
 * - **Keys are not written into the text.** A `{key:<action>}` marker is
 *   filled from `keymap.ts` ({@link fillKeys}), so the help cannot drift from
 *   the bindings. The proposal had its own keys (Select V, Sculpt D, …); the
 *   editor's are Blender's, and Sculpt / Paint / Bone / Weight / Anim have none.
 * - **Only the text.** The proposal also carried mock controls (`c: [...]`)
 *   to draw its picture; the real controls are components.
 * - Facts corrected: the primitives are the eight `PRIMS` (no Tube / Disc /
 *   Capsule), Modifiers are the eight of `modifier-core`, and the glossary
 *   says forge3d is Y-up where Blender is Z-up.
 *
 * `guide.test.ts` holds the text to the code: every tool has a topic, every
 * marker names a real action, the modifier and primitive lists are the real
 * ones.
 */
import type { ModifierType, ToolId } from "../../state.ts";
import { keyLabel, type ActionId } from "../../keymap.ts";

/** The right panel's tabs. */
export type TabId = "xform" | "mat" | "morph" | "sculpt" | "paint" | "bone" | "weight" | "anim" | "edit" | "map" | "scene";

export const TAB_LABELS: Record<TabId, string> = {
  xform: "Transform",
  mat: "Material",
  morph: "Morph",
  sculpt: "Sculpt",
  paint: "Paint",
  bone: "Bone",
  weight: "Weight",
  anim: "Anim",
  edit: "Edit",
  map: "Map",
  scene: "Scene",
};

/** Which tab a tool opens. */
export const TOOL_TAB: Record<ToolId, TabId> = {
  select: "xform",
  move: "xform",
  rotate: "xform",
  scale: "xform",
  sculpt: "sculpt",
  paint: "paint",
  bone: "bone",
  weight: "weight",
  anim: "anim",
};

/** A tool or a tab, explained — what the tool card shows. */
export interface Topic {
  /** Short code on the tool pill. */
  code: string;
  name: string;
  ja: string;
  /** The key that switches to it, when it has one. */
  key?: ActionId;
  /** One sentence: what it is for. */
  one: string;
  /** How to use it, in order. May hold `{key:<action>}` markers. */
  steps: string[];
  /** When you would reach for it. */
  uses: string[];
  /** A tab's topic rather than a tool's. */
  tab?: boolean;
}

export type TopicId = ToolId | "mat" | "morph" | "edit" | "map" | "scene";

export const TOPICS: Record<TopicId, Topic> = {
  select: {
    code: "SEL", name: "Select", ja: "選択", key: "tool.select",
    one: "編集したいオブジェクトを「選ぶ」ツール。ほとんどの操作はまず選択から始まります。",
    steps: [
      "ビューポートのオブジェクトをクリック（輪郭が出たら選択中）",
      "複数選ぶときは Ctrl+クリック（スマホは下部の ⊚ Multi を ON）",
      "{key:select.all} で全部選択、{key:select.none} で選択解除",
    ],
    uses: ["CSG で2つの形を組み合わせる前に", "右パネルで位置や色を数値で変えるとき", "削除・複製したいとき"],
  },
  move: {
    code: "MOV", name: "Move", ja: "移動", key: "tool.move",
    one: "選んだオブジェクトを左右・上下・前後に動かします。",
    steps: [
      "オブジェクトを選択して {key:tool.move}（または MOV）",
      "出てくる矢印をドラッグ（赤＝X 左右 / 緑＝Y 上下 / 青＝Z 前後）",
      "ぴったりの位置にしたい時は Transform に数値を入力",
    ],
    uses: ["パーツを並べて組み立てる", "Snap を ON にして 0.5m 刻みで整列"],
  },
  rotate: {
    code: "ROT", name: "Rotate", ja: "回転", key: "tool.rotate",
    one: "選んだオブジェクトを回転させます。",
    steps: [
      "選択して {key:tool.rotate}（または ROT）",
      "輪っか状のハンドルをドラッグ。色ごとに回る軸が違います",
      "Snap の Rotation を ON にすると 15° 刻みで回せます",
    ],
    uses: ["傾いたパーツをまっすぐ直す", "斜めの屋根や角度のついた部品"],
  },
  scale: {
    code: "SCL", name: "Scale", ja: "拡大縮小", key: "tool.scale",
    one: "選んだオブジェクトを大きく・小さくします。",
    steps: [
      "選択して {key:tool.scale}（または SCL）",
      "軸の先の四角をドラッグで、その方向だけ伸び縮み",
      "中央をドラッグすると全体を均等に拡大縮小",
    ],
    uses: ["箱を平たく伸ばして板や床にする", "全体のサイズ感をそろえる"],
  },
  sculpt: {
    code: "SCP", name: "Sculpt", ja: "彫刻",
    one: "粘土をこねるように、表面を盛ったり削ったりして形を作ります。",
    steps: [
      "メッシュを選択（細かく彫るなら Sphere や Ico がおすすめ）",
      "Mode でブラシの種類を選ぶ（まずは Push）",
      "Size（大きさ）と Strength（強さ）を調整",
      "表面をドラッグ。Ctrl+ドラッグで逆向き、Shift+ドラッグでなめらかに",
    ],
    uses: ["キャラクターの顔や体", "岩・地形などデコボコした形", "角ばった形を丸く整える"],
  },
  paint: {
    code: "PNT", name: "Paint", ja: "ペイント",
    one: "3D モデルの表面に、絵を描くように直接色を塗ります。",
    steps: [
      "メッシュを選択",
      "Color で色を選び、Size と Opacity（不透明度）を調整",
      "モデルの表面をドラッグして塗る",
      "Layers で分けて塗ると後から直しやすい",
    ],
    uses: ["模様やロゴを描き込む", "汚れ・グラデーションの表現"],
  },
  bone: {
    code: "BONE", name: "Bone", ja: "ボーン（骨）",
    one: "人形の針金のような「骨組み」を作ります。骨を動かすとモデルが連動して動きます。",
    steps: [
      "+ New Skeleton で骨格を作る",
      "ビューポートをクリックして骨を追加・つなげる（Edit モード）",
      "Assign to Mesh で動かしたいメッシュに割り当て",
      "Pose モードに切り替えて骨を回すとポーズが付く",
    ],
    uses: ["キャラクターを歩かせる・手を振らせる", "ドアや腕など関節で曲がるもの"],
  },
  weight: {
    code: "WGT", name: "Weight", ja: "ウェイト",
    one: "「どの骨が、モデルのどの部分を、どれだけ動かすか」を色で塗って決めます。",
    steps: [
      "骨を割り当て済みのメッシュを選択",
      "まず ⚡ Auto Weights で自動設定（多くの場合これで十分）",
      "Bone Slots で骨を選ぶと影響範囲が色で出る（赤＝強い / 青＝なし）",
      "おかしい所だけブラシで塗って修正。Ctrl+ドラッグで減らす、Shift+ドラッグでならす",
    ],
    uses: ["腕を曲げたら胴体まで動いてしまう時の修正", "関節の曲がり方をなめらかに"],
  },
  anim: {
    code: "ANM", name: "Anim", ja: "アニメーション",
    one: "ポーズを時間ごとに記録（キーフレーム）して、動きを作ります。",
    steps: [
      "+ New Clip でアニメーションを1本作る",
      "Frame で時間を決め、Pose モードでポーズを付ける",
      "⏺ Record Keyframe で記録（Auto-Key が ON なら自動）",
      "別のフレームで別のポーズを記録し、▶ Play で再生",
    ],
    uses: ["歩く・走るなどのループ動作", "表情（Morph）を変化させる"],
  },
  mat: {
    code: "MAT", name: "Material", ja: "マテリアル（素材）", tab: true,
    one: "表面の「素材感」を決めます。色、金属っぽさ、ツヤ、透明度、発光など。",
    steps: [
      "メッシュを選択",
      "Albedo で基本の色を選ぶ",
      "Metallic（金属感）と Roughness（ザラつき）で質感を調整",
      "光らせたい時は Emissive",
    ],
    uses: ["金属・プラスチック・ガラスの表現", "ネオンのように光る部品"],
  },
  morph: {
    code: "MRPH", name: "Morph", ja: "モーフ（変形）", tab: true,
    one: "モデルの「変形した形」を登録し、スライダーで元の形との間を行き来できるようにします。",
    steps: [
      "メッシュを選択して + ターゲット有効化",
      "Sculpt などで形を変える",
      "📷 形状キャプチャで変形後の形を保存",
      "スライダー（0〜1）で混ぜ具合を調整",
    ],
    uses: ["笑顔・まばたきなどの表情", "ふくらむ・へこむアニメーション"],
  },
  edit: {
    code: "EDIT", name: "Edit Mode", ja: "編集モード", key: "mode.editToggle", tab: true,
    one: "オブジェクトを作っている「点・辺・面」を直接いじる、細かいモデリング用のモードです。",
    steps: [
      "メッシュを選択して {key:mode.editToggle}（スマホは下部の ✎ Edit）",
      "点（{key:comp.vertex}）/ 辺（{key:comp.edge}）/ 面（{key:comp.face}）のどれを触るか選ぶ",
      "クリックで選び、Operators を実行（例: 面を選んで {key:edit.extrude} で押し出す）",
      "もう一度 {key:mode.editToggle} で元のモードに戻る",
    ],
    uses: ["箱から面を押し出して家や椅子を作る", "角を丸める（Bevel）", "Paint の前の UV 展開"],
  },
  map: {
    code: "MAP", name: "Map", ja: "マップ（配置）", tab: true,
    one: "保存したモデルを並べて、ひとつの場面を組み立てます。",
    steps: [
      "モデルを 💾 Save to Library で保存しておく",
      "Model Library から選んでシーンに配置",
      "⬇ Export Layout JSON で配置を書き出す",
    ],
    uses: ["ゲームのステージ作り", "家具を部屋に並べる"],
  },
  scene: {
    code: "SCN", name: "Scene", ja: "シーン（照明・背景）", tab: true,
    one: "ライト、背景の光、影など、画面全体の見え方を設定します。",
    steps: [
      "+ Point（電球）や + Spot（スポットライト）で照明を追加",
      "Environment で背景の光の雰囲気を選ぶ",
      "Shadows で影の ON/OFF と画質を決める",
    ],
    uses: ["作品を見栄えよく見せたい時", "夜・屋外などの雰囲気づくり"],
  },
};

/**
 * The topic the tool card shows: on the Transform tab, the transform tool in
 * use; on a tool's own tab, that tool; on any other tab, the tab.
 */
export function topicFor(tool: ToolId, tab: TabId): Topic {
  if (tab === "xform") return TOPICS[TOOL_TAB[tool] === "xform" ? tool : "select"];
  return TOPICS[tab];
}

/** A panel section's heading and the note under it. */
export interface Section {
  id: string;
  title: string;
  desc: string;
}

/** The left panel, top to bottom. */
export const LEFT_SECTIONS: Section[] = [
  { id: "prim", title: "Primitives", desc: "クリックすると基本の形がシーンの中央に追加されます。モデリングはここからスタート。" },
  {
    id: "csg", title: "CSG Boolean",
    desc: "2つの形を選んで組み合わせます。Union＝くっつけて1つに / Subtract＝先に選んだ形から、後から選んだ形でくり抜く / Intersect＝重なった部分だけ残す。点で触れているだけの形は「重なっていない」扱い（Blender と同じ）。",
  },
  {
    id: "mt", title: "Mesh Tools",
    desc: "表面の調整。黒く見える→Recalc / Flip Normals、カクカク⇔なめらか→Shade Flat / Smooth、回転の中心を形の中心へ→Center Origin。モディファイアが付いていても Shade は効きます。",
  },
  { id: "meas", title: "Measure", desc: "メッシュ上の2点をクリックして距離（メートル）を測ります。" },
  { id: "lyr", title: "Layers", desc: "オブジェクトをグループに分けて、まとめて表示 / 非表示にできます。" },
  { id: "hier", title: "Hierarchy", desc: "シーン内のオブジェクト一覧。クリックで選択。Set Parent で親子にすると、親を動かした時に子もついてきます。" },
];

const IO: Section = {
  id: "io", title: "Export / Save",
  desc: "GLB は色・骨・アニメも含めて書き出す標準形式（迷ったらこれ）。OBJ は形だけ。Save to Library はブラウザ内に保存、Export Project は作業データ（モディファイアや四角形の面も）を丸ごとファイルに保存します。",
};

/** The right panel's sections per tab; every tab ends with Export / Save. */
export const TAB_SECTIONS: Record<TabId, Section[]> = {
  xform: [
    { id: "snap", title: "Snap", desc: "ON にすると、移動・回転・拡縮がキリのいい数値にピタッと吸着します。右の数字が刻み幅です（Position 0.5 ＝ 0.5m ずつ動く）。" },
    { id: "tf", title: "Transform", desc: "選択中オブジェクトの位置（Position）・回転（Rotation）・大きさ（Scale）を数値で入力できます。X＝左右、Y＝上下、Z＝前後。" },
    {
      id: "mod", title: "Modifiers",
      desc: "元の形を壊さずに加工を重ねがけする機能。上から順にかかり、ON/OFF・削除はいつでも、Apply で確定します。種類ごとの説明は追加メニューと各段の下に出ます。",
    },
    IO,
  ],
  mat: [
    { id: "alb", title: "Albedo", desc: "モデルの基本の色。光や影の影響を受ける前の「素の色」です。" },
    { id: "pbr", title: "PBR", desc: "Metallic＝金属っぽさ（0 プラスチック〜1 金属）、Roughness＝表面のザラつき（0 ピカピカ〜1 マット）、Alpha＝透明度（1 不透明〜0 透明）。" },
    { id: "emi", title: "Emissive", desc: "自分で光っているように見せる設定。色と強さを決めます。ネオンや画面の表現に。" },
    { id: "tex", title: "Textures", desc: "画像を表面に貼り付けます。Normal マップを使うと、形はそのままで凹凸があるように見せられます。" },
    IO,
  ],
  morph: [
    { id: "mt", title: "Morph Targets", desc: "ひとつのメッシュに複数の「形のバリエーション」を登録します。登録した形は 0〜1 のスライダーで混ぜられ、アニメにも記録できます。" },
    IO,
  ],
  sculpt: [
    { id: "br", title: "Brush", desc: "Size＝ブラシの大きさ（画面の円）、Strength＝1回で変形する強さ、Falloff＝縁のぼかし具合。Strength を小さめにして少しずつ盛るのがコツ。" },
    { id: "bm", title: "Mode", desc: "Push＝盛り上げる / Pull＝へこませる / Smooth＝凹凸をならす / Flatten＝平らにする / Pinch＝つまんで鋭く / Inflate＝ふくらませる。" },
    { id: "sym", title: "Symmetry", desc: "チェックした軸の反対側にも同じ変形が同時にかかります。顔など左右対称の形は X を ON。" },
    { id: "dyn", title: "Dyntopo", desc: "彫っている場所だけポリゴンを自動で細かくします。細部まで彫れる代わりに重くなります。Detail が小さいほど細かく。" },
    IO,
  ],
  paint: [
    { id: "pb", title: "Paint Brush", desc: "Channel で何を塗るか選びます（Albedo＝色、Roughness / Metallic＝質感を白黒で塗る）。Opacity＝不透明度、Hardness＝縁のくっきり度（0 でエアブラシ風）。" },
    { id: "bi", title: "Brush Image", desc: "画像をハンコのように押したり（Stamp）、型紙越しに塗ったり（Stencil）できます。透明部分のある PNG がおすすめ。" },
    { id: "pl", title: "Layers", desc: "お絵描きアプリと同じ重ね塗りのレイヤー。模様ごとに分けておけば、失敗してもそのレイヤーだけ消せます。" },
    { id: "pa", title: "Actions", desc: "Clear Paint は選んでいるレイヤーだけを消します。" },
    IO,
  ],
  bone: [
    { id: "bmo", title: "Mode", desc: "Edit＝骨の位置や長さを決める（基本姿勢）/ Pose＝骨を回してポーズを付ける（アニメ用）。作る時は Edit、動かす時は Pose。" },
    { id: "sk", title: "Skeleton", desc: "骨格（骨の集まり）を作り、メッシュに割り当てます。割り当てて初めて、骨を動かすとモデルが動きます。" },
    { id: "bh", title: "Bone Hierarchy", desc: "骨の親子関係の一覧。親の骨（例: 肩）を回すと、子の骨（ひじ・手）もついて動きます。" },
    { id: "ik", title: "IK Constraint", desc: "手や足の「先」を動かすだけで、ひじやひざが自動で曲がる仕組み。Chain Length はさかのぼって曲げる骨の本数（腕なら 2）。" },
    IO,
  ],
  weight: [
    { id: "wb", title: "Weight Brush", desc: "Radius＝塗る範囲、Strength＝1回で足す量。赤いほど強く動き、青は影響なし。" },
    { id: "wm", title: "Mode", desc: "Add＝影響を足す / Subtract＝減らす / Smooth＝境目をなめらかに。" },
    { id: "wa", title: "Actions", desc: "まず Auto Weights で自動設定しましょう。Geodesic を ON にすると表面に沿って計算し、腕と胴体のように近いけど離れた部分がくっつきにくくなります。" },
    { id: "bs", title: "Bone Slots", desc: "ここで骨を選ぶと、その骨の影響範囲が色で表示されます。塗るのも選んだ骨に対してです。" },
    IO,
  ],
  anim: [
    { id: "clip", title: "Clip", desc: "クリップ＝ひとつのアニメーション（「歩く」「ジャンプ」など）。動きごとにクリップを分けて作ります。" },
    { id: "tl", title: "Timeline", desc: "Frame＝いま編集している時間。FPS＝1秒あたりのコマ数（30 なら Frame 30 で1秒）。Onion Skin は前後のポーズを半透明で表示します。" },
    { id: "rec", title: "Record", desc: "キーフレーム＝「この時間にこのポーズ」という記録。間のポーズは自動で補間されます。Auto-Key が ON ならポーズを変えるだけで記録。" },
    { id: "play", title: "Playback", desc: "作ったアニメーションを再生して確認します。" },
    IO,
  ],
  edit: [
    { id: "cm", title: "Component Mode", desc: "Vertex＝点、Edge＝辺（線）、Face＝面。どの単位で選んで編集するかを切り替えます。{key:comp.vertex} / {key:comp.edge} / {key:comp.face} でも切替。" },
    { id: "ops", title: "Operators", desc: "選んだ点・辺・面に対する加工。今のモードで使えないものはグレーになります。例: 面を選んで Extrude（{key:edit.extrude}）で押し出す。キーは Blender と同じ。" },
    { id: "uv", title: "UV Unwrap", desc: "3D の表面をハサミで切り開いて平面にする作業（{key:edit.unwrap}）。これをしておくと Paint やテクスチャ画像がきれいに貼れます。" },
    IO,
  ],
  map: [
    { id: "lib", title: "Model Library", desc: "💾 Save to Library で保存したモデルの一覧。ここからシーンに配置します。" },
    { id: "inst", title: "Scene Instances", desc: "シーンに配置したモデルの一覧です。" },
    { id: "lay", title: "Layout", desc: "配置した状態をファイルに書き出したり、読み込んだりできます。" },
    IO,
  ],
  scene: [
    { id: "li", title: "Lights", desc: "Point＝電球のように全方向を照らす / Spot＝懐中電灯のように一方向を照らす。" },
    { id: "env", title: "Environment", desc: "周りの景色から来る光の雰囲気。HDRI を読み込むとリアルな映り込みに。Reference（下絵）は形を作る時のお手本画像です。" },
    { id: "shd", title: "Shadows", desc: "影を表示するかどうかと、その細かさ。High はきれいですが重くなります。" },
    IO,
  ],
};

/** Each modifier in one line — the add menu and the note under each stack entry. */
export const MODIFIER_HELP: Record<ModifierType, { name: string; one: string }> = {
  subdivision: { name: "Subdivision", one: "面を細かく割る。「丸く」は角を丸め、「割るだけ」は形を変えない" },
  mirror: { name: "Mirror", one: "選んだ軸の反対側に鏡写しを足す。真ん中の頂点はくっつく" },
  array: { name: "Array", one: "同じ形を Offset ずつずらして Count 個並べる" },
  solidify: { name: "Solidify", one: "面を法線の内側へ押し出して厚みをつける。マイナスで外側" },
  decimate: { name: "Decimate", one: "形をなるべく保ったまま面を減らす。Ratio は残す割合" },
  smooth: { name: "Smooth", one: "頂点を隣の平均へ寄せて、でこぼこをならす" },
  triangulate: { name: "Triangulate", one: "四角形以上の面を三角形に割る（書き出し先が三角形しか読めないとき）" },
  weld: { name: "Weld", one: "Distance より近い頂点をひとつにまとめる" },
};

export type GlossaryCategory = "基本" | "モデリング" | "見た目" | "リギング・アニメ" | "ファイル";

export const GLOSSARY_CATEGORIES: GlossaryCategory[] = ["基本", "モデリング", "見た目", "リギング・アニメ", "ファイル"];

export interface GlossaryEntry {
  cat: GlossaryCategory;
  en: string;
  ja: string;
  desc: string;
}

export const GLOSSARY: GlossaryEntry[] = (
  [
    ["基本", "Mesh", "メッシュ", "点・辺・面でできた 3D の形そのもの。このアプリで編集する対象です。"],
    ["基本", "Primitive", "プリミティブ", "箱・球・円柱など、最初から用意されている基本の形。"],
    ["基本", "Viewport", "ビューポート", "3D が表示される中央の作業画面。ドラッグで視点を回せます。"],
    ["基本", "Gizmo", "ギズモ", "移動・回転・拡縮のときに出る矢印や輪っかのハンドル。これをドラッグして操作します。"],
    ["基本", "X / Y / Z", "軸", "X＝左右（赤）、Y＝上下（緑）、Z＝前後（青）。forge3d は Y が上で、Blender は Z が上。GLB でやりとりすれば向きは自動で合います。"],
    ["基本", "Snap", "スナップ", "決まった刻み（0.5m、15° など）でピタッと吸着させる機能。"],
    ["基本", "Orthographic", "正射影", "遠近感をなくした、図面のような見え方。{key:view.ortho} で切替。"],
    ["基本", "Origin / Pivot", "原点・ピボット", "回転や拡大縮小の中心になる点。"],
    ["基本", "Hierarchy", "階層（親子）", "オブジェクトの親子関係。親を動かすと子もついてきます。"],
    ["基本", "Layer", "レイヤー", "オブジェクトのグループ分け。まとめて表示 / 非表示できます。"],
    ["モデリング", "Vertex", "頂点", "形を作っている「点」。"],
    ["モデリング", "Edge", "辺", "頂点と頂点を結ぶ「線」。"],
    ["モデリング", "Face", "面", "辺で囲まれた「面」。ポリゴンとも呼びます。"],
    ["モデリング", "Edit Mode", "編集モード", "点・辺・面を直接いじるモード。{key:mode.editToggle} で切替。"],
    ["モデリング", "CSG / Boolean", "ブーリアン", "形同士を足す（Union）・引く（Subtract）・重なりだけ残す（Intersect）操作。"],
    ["モデリング", "Extrude", "押し出し", "面や辺を引っぱり出して、新しい形を伸ばす操作。"],
    ["モデリング", "Bevel", "ベベル（面取り）", "角を削って丸く・なめらかにする操作。"],
    ["モデリング", "Normal", "法線", "面の「表」の向き。逆になると黒く見えたり消えたりします。"],
    ["モデリング", "Modifier", "モディファイア", "元の形を壊さずに加工を重ねがけする機能（Subdivision / Mirror / Array / Solidify / Decimate / Smooth / Triangulate / Weld）。"],
    ["モデリング", "Subdivision", "細分化", "面を細かく分けて、なめらかにすること。"],
    ["モデリング", "Dyntopo", "ダイントポ", "Sculpt 中に、彫る場所だけ自動で面を細かくする機能。"],
    ["モデリング", "UV / Unwrap", "UV 展開", "3D の表面を切り開いて平面にし、画像を貼れるようにする作業。"],
    ["モデリング", "Seam", "シーム", "UV 展開するときの「切れ目」の位置。"],
    ["見た目", "Material", "マテリアル", "色・ツヤ・金属感など、表面の素材の設定。"],
    ["見た目", "PBR", "物理ベース", "現実の光の性質に基づいた質感表現。Metallic と Roughness で決まります。"],
    ["見た目", "Albedo", "アルベド", "光や影の影響を除いた、素の色。"],
    ["見た目", "Metallic", "メタリック", "金属っぽさ。0 ＝ 非金属、1 ＝ 金属。"],
    ["見た目", "Roughness", "ラフネス", "表面のザラつき。0 ＝ 鏡のようにピカピカ、1 ＝ マット。"],
    ["見た目", "Emissive", "エミッシブ", "自分で光っているように見せる設定。"],
    ["見た目", "Texture", "テクスチャ", "表面に貼る画像。"],
    ["見た目", "HDRI", "HDRI", "周囲の光を記録した画像。背景と照明の両方に使います。"],
    ["見た目", "Shade Smooth / Flat", "シェーディング", "面の陰影をなめらかに見せるか（Smooth）、面ごとにカクッと見せるか（Flat）。形そのものは変わりません。"],
    ["見た目", "Wireframe / Matcap", "表示モード", "Wire ＝ 線だけ表示、Matcap ＝ 形を確認しやすい簡易ライティング。"],
    ["リギング・アニメ", "Bone", "ボーン（骨）", "モデルを動かすための骨。"],
    ["リギング・アニメ", "Skeleton", "スケルトン", "骨の集まり（骨格）。"],
    ["リギング・アニメ", "Rigging", "リギング", "骨を仕込んで、モデルを動かせるようにする作業全体。"],
    ["リギング・アニメ", "Weight", "ウェイト", "それぞれの骨がモデルのどの部分をどれだけ動かすかの割合。"],
    ["リギング・アニメ", "Pose", "ポーズ", "骨を回して付けた姿勢。"],
    ["リギング・アニメ", "IK", "インバースキネマティクス", "手先や足先を動かすと、ひじ・ひざが自動で追従して曲がる仕組み。"],
    ["リギング・アニメ", "Keyframe", "キーフレーム", "「この時間にこのポーズ」という記録。間は自動で補間されます。"],
    ["リギング・アニメ", "Clip", "クリップ", "ひとまとまりのアニメーション（歩く、ジャンプなど）。"],
    ["リギング・アニメ", "FPS", "フレームレート", "1秒あたりのコマ数。30 なら 30 フレームで 1 秒。"],
    ["リギング・アニメ", "Easing", "イージング", "動きの加速・減速の付け方。ふわっと止まる、など。"],
    ["リギング・アニメ", "Onion Skin", "オニオンスキン", "前後のフレームのポーズを半透明で重ねて表示する機能。"],
    ["リギング・アニメ", "Morph Target", "モーフ / ブレンドシェイプ", "登録した変形後の形。表情などに使います。"],
    ["ファイル", "GLB / glTF", "ジーエルビー", "3D の標準的な保存形式。色・骨・アニメもまとめて保存できます。"],
    ["ファイル", "OBJ", "オブジェ", "形だけを保存する古くからの形式。"],
    ["ファイル", "Library", "ライブラリ", "ブラウザの中にモデルを保存しておく場所。"],
    ["ファイル", ".forge3d", "プロジェクト", "作業データを丸ごと保存するファイル。続きから作業できます。"],
  ] as const
).map(([cat, en, ja, desc]) => ({ cat, en, ja, desc }));

/** `{key:<action>}` markers. */
const KEY_MARKER = /\{key:([a-zA-Z.]+)\}/g;

/** Every action a text names through a marker. */
export function keyMarkers(text: string): string[] {
  return [...text.matchAll(KEY_MARKER)].map((m) => m[1]!);
}

/**
 * Replace each `{key:<action>}` with that action's key from `keymap.ts`
 * (e.g. `{key:tool.move}` → `G`). An action with no key comes out as `—`,
 * which the tests forbid, so a stale marker shows rather than vanishing.
 */
export function fillKeys(text: string): string {
  return text.replace(KEY_MARKER, (_, action: string) => keyLabel(action as ActionId) || "—");
}

/** A topic's own key, e.g. `G` for Move, or "" when it has none. */
export function topicKey(topic: Topic): string {
  return topic.key ? keyLabel(topic.key) : "";
}

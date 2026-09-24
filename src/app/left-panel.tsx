/**
 * The left panel: primitives, CSG, mesh tools, measure, layers, the scene's
 * meshes (`left-sections.tsx`). Each
 * section carries its note from the guide (variant C).
 */
import { useState } from "react";
import { PRIMS, addPrimitive } from "../tools/primitives";
import { doCSG, type CSGOp } from "../tools/csg";
import { MESH_TOOLS, runMeshTool } from "../tools/mesh-tools";
import { LEFT_SECTIONS } from "./guide/guide";
import { SectionNote } from "./guide/section-note";
import { HierarchyControls, LayerControls, MeasureControls } from "./left-sections";

const section = (id: string) => LEFT_SECTIONS.find((s) => s.id === id)!;

const CSG_OPS: { op: CSGOp; sy: string; label: string }[] = [
  { op: "union", sy: "∪", label: "Union 結合" },
  { op: "subtract", sy: "−", label: "Subtract 差分" },
  { op: "intersect", sy: "∩", label: "Intersect 交差" },
];

export function LeftPanel({ open }: { open: boolean }) {
  const [angle, setAngle] = useState(30);
  return (
    <aside className={"lp" + (open ? " open" : "")} aria-label="左パネル">
      <SectionNote section={section("prim")}>
        <div className="pgrid">
          {PRIMS.map((p) => (
            <button key={p.id} type="button" className="pbtn" onClick={() => addPrimitive(p.id)} aria-label={"Add " + p.label}>
              <span className="ic">{p.icon}</span>
              {p.label}
            </button>
          ))}
        </div>
      </SectionNote>
      <SectionNote section={section("csg")}>
        {CSG_OPS.map((c) => (
          <button key={c.op} type="button" className="cbtn" onClick={() => void doCSG(c.op)}>
            <span className="sy">{c.sy}</span>
            {c.label}
          </button>
        ))}
      </SectionNote>
      <SectionNote section={section("mt")}>
        {MESH_TOOLS.map((t) => (
          <div key={t.id}>
            <button type="button" className="cbtn" title={t.title} onClick={() => runMeshTool(t.id, angle)}>
              {t.label}
            </button>
            {t.id === "autoSmooth" && (
              <label className="angle-row">
                角度°
                <input className="pi" type="number" min={1} max={180} step={5} value={angle} onChange={(e) => setAngle(+e.target.value)} />
              </label>
            )}
          </div>
        ))}
      </SectionNote>
      <SectionNote section={section("meas")}>
        <MeasureControls />
      </SectionNote>
      <SectionNote section={section("lyr")}>
        <LayerControls />
      </SectionNote>
      <SectionNote section={section("hier")}>
        <HierarchyControls />
      </SectionNote>
    </aside>
  );
}

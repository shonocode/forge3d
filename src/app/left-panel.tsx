/**
 * The left panel: primitives, CSG, mesh tools, the scene's meshes. Each
 * section carries its note from the guide (variant C).
 */
import { useState } from "react";
import { PRIMS, addPrimitive } from "../tools/primitives";
import { doCSG, type CSGOp } from "../tools/csg";
import { MESH_TOOLS, runMeshTool } from "../tools/mesh-tools";
import { selectMesh } from "../tools/selection";
import { LEFT_SECTIONS } from "./guide/guide";
import { SectionNote } from "./guide/section-note";
import { useForge } from "./use-forge";

const section = (id: string) => LEFT_SECTIONS.find((s) => s.id === id)!;

const CSG_OPS: { op: CSGOp; sy: string; label: string }[] = [
  { op: "union", sy: "∪", label: "Union 結合" },
  { op: "subtract", sy: "−", label: "Subtract 差分" },
  { op: "intersect", sy: "∩", label: "Intersect 交差" },
];

export function LeftPanel({ open }: { open: boolean }) {
  const [angle, setAngle] = useState(30);
  const meshes = useForge((s) => s.allMeshes.map((m) => ({ mesh: m, id: m.uniqueId, name: m.name, sel: s.selectedMeshes.includes(m) })));
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
      <SectionNote section={section("hier")}>
        {meshes.length === 0 ? (
          <div className="empty">メッシュなし ― 上の Primitives から追加</div>
        ) : (
          <div className="slist" role="list">
            {meshes.map((m) => (
              <div
                key={m.id}
                role="listitem"
                className={"sitem" + (m.sel ? " sel" : "")}
                onClick={(e) => selectMesh(m.mesh, e.ctrlKey || e.metaKey)}
              >
                <span>{m.name}</span>
              </div>
            ))}
          </div>
        )}
      </SectionNote>
    </aside>
  );
}

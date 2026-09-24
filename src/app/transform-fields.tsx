/**
 * Position / Rotation (degrees) / Scale of the last selected mesh as numbers.
 * Typing moves the mesh at once; leaving the field records one undo step.
 * While a field has focus it keeps what is typed; otherwise it follows the
 * mesh (a gizmo drag included — the store's fingerprint holds the transform).
 */
import { useRef, useState } from "react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { state } from "../state";
import { useForge } from "./use-forge";

type Group = "position" | "rotation" | "scaling";
type Axis = "x" | "y" | "z";

const GROUPS: { g: Group; label: string }[] = [
  { g: "position", label: "Position" },
  { g: "rotation", label: "Rotation (°)" },
  { g: "scaling", label: "Scale" },
];

const toShown = (g: Group, v: number): number => (g === "rotation" ? (v * 180) / Math.PI : v);
const fromShown = (g: Group, v: number): number => (g === "rotation" ? (v * Math.PI) / 180 : v);

function Field({ mesh, g, a }: { mesh: AbstractMesh; g: Group; a: Axis }) {
  const [draft, setDraft] = useState<string | null>(null);
  const before = useRef<{ p: Vector3; r: Vector3; s: Vector3 } | null>(null);
  const shown = toShown(g, mesh[g][a]).toFixed(3);
  return (
    <div className="pr">
      <span className={"pl " + a}>{a.toUpperCase()}</span>
      <input
        className="pi"
        type="number"
        step={g === "rotation" ? 5 : 0.1}
        aria-label={`${g} ${a.toUpperCase()}`}
        value={draft ?? shown}
        onFocus={() => {
          before.current = { p: mesh.position.clone(), r: mesh.rotation.clone(), s: mesh.scaling.clone() };
          setDraft(shown);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) mesh[g][a] = fromShown(g, v);
        }}
        onBlur={() => {
          setDraft(null);
          const b = before.current;
          before.current = null;
          if (!b) return;
          const after = { p: mesh.position.clone(), r: mesh.rotation.clone(), s: mesh.scaling.clone() };
          if (b.p.equals(after.p) && b.r.equals(after.r) && b.s.equals(after.s)) return;
          state.history.push({
            label: "Transform",
            undo() { mesh.position.copyFrom(b.p); mesh.rotation.copyFrom(b.r); mesh.scaling.copyFrom(b.s); },
            redo() { mesh.position.copyFrom(after.p); mesh.rotation.copyFrom(after.r); mesh.scaling.copyFrom(after.s); },
          });
        }}
      />
    </div>
  );
}

export function TransformFields() {
  const mesh = useForge((s) => s.selectedMeshes[s.selectedMeshes.length - 1] ?? null);
  if (!mesh) return <div className="empty">メッシュを選択</div>;
  return (
    <>
      {GROUPS.map(({ g, label }) => (
        <div key={g} className="xyz-group">
          <div className="xyz-label">{label}</div>
          {(["x", "y", "z"] as const).map((a) => (
            <Field key={mesh.uniqueId + g + a} mesh={mesh} g={g} a={a} />
          ))}
        </div>
      ))}
    </>
  );
}

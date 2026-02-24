# BONE Tool Crash Trace - Complete Analysis

## Crash Scenario
User adds Box → clicks BONE pill → crash (despite try-catch in updateGizmo())

## Complete Call Chain

### Phase 1: User clicks BONE pill
**File: src/main.ts (line 107)**
```typescript
b.addEventListener("click", () => setTool(t.id));
```

### Phase 2: setTool("bone") executes
**File: src/input.ts (lines 12-47)**

Call sequence in setTool():
1. Line 13: `state.tool = t;` (set tool to "bone")
2. Line 14-16: Update pill UI classes (no crash risk)
3. Line 17-18: Update "modeL" text element (no crash risk)
4. **Line 19: `updateGizmo();`** — wrapped in try-catch ✓
5. Line 24-26: Check if bone mode: **`setBoneVisualsVisible(true);`** ← NO TRY-CATCH!
6. Lines 37-46: Weight overlay logic (only if state.weightOverlayActive is true)

## CRITICAL BUG: Uncaught Crash in setBoneVisualsVisible()

**File: src/tools/skeleton-tool.ts (lines 290-301)**
```typescript
export function setBoneVisualsVisible(visible: boolean): void {
  for (const [, skelData] of state.skeletonMap) {
    for (const bd of skelData.bones) {
      if (bd.visual) {
        bd.visual.isVisible = visible;  // ← CRASH POINT
      }
    }
    if (skelData.hierarchyLines) {
      skelData.hierarchyLines.isVisible = visible;  // ← CRASH POINT
    }
  }
}
```

## Why It Crashes

When user adds a Box and then clicks BONE:
1. Box is created via `addPrimitive()` → calls `selectMesh()` → calls `updateGizmo()` (line 23 in selection.ts)
2. No skeleton exists yet, so `state.skeletonMap` is empty
3. User clicks BONE pill → `setTool("bone")` → line 19: `updateGizmo()` wrapped in try-catch (SAFE)
4. **Line 26: `setBoneVisualsVisible(true);`** — NOT wrapped in try-catch
5. setBoneVisualsVisible() iterates through all skeletons
6. **The crash likely occurs because:**
   - Either `state.skeletonMap` contains a corrupted SkeletonData where `bd.visual.isVisible` throws
   - Or `skelData.hierarchyLines.isVisible` throws on a disposed/invalid object
   - Or there's a timing issue with skeleton disposal/recreation

## Actual Crash Point: NOT in updateGizmo()!

The try-catch on line 41-46 of updateGizmo() only protects that function's logic:
```typescript
try {
  gm.attachToMesh(null);
  gm.positionGizmoEnabled = false;
  gm.rotationGizmoEnabled = false;
  gm.scaleGizmoEnabled = false;
} catch { /* ignore */ }
```

It does NOT protect the subsequent calls at lines 24-30 of setTool():
```typescript
if (t === "bone" || t === "weight" || t === "anim") {
    if (t === "bone") switchTab("bone");
    setBoneVisualsVisible(true);  // ← CRASHES HERE, NOT CAUGHT!
} else {
    setBoneVisualsVisible(false);
    deselectBone();
}
```

## Secondary Crash Risk: deselectBone()

**File: src/tools/skeleton-tool.ts (lines 199-209)**
```typescript
export function deselectBone(): void {
  const skelData = getActiveSkeleton();
  if (skelData && state.selectedBoneId) {
    const prev = skelData.bones.find((b) => b.id === state.selectedBoneId);
    if (prev?.visual) {
      prev.visual.material = getBoneMaterial();  // ← Could crash
    }
  }
  state.selectedBoneId = null;
  state.gizmoManager.attachToMesh(null);  // ← Could crash if gizmoManager undefined
}
```

## Third Crash Risk: switchTab()

**File: src/input.ts (lines 49-56)**
```typescript
export function switchTab(id: string): void {
  document.querySelectorAll<HTMLElement>(".tb").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === id)
  );
  document.querySelectorAll<HTMLElement>(".tbody").forEach((b) =>
    b.classList.toggle("on", b.id === "tb-" + id)
  );
}
```
No try-catch. Could fail if DOM elements don't exist.

## Fourth Crash Risk: UI Updates Called After setTool()

**File: src/ui/panels.ts (lines 144-149)**

The `updateBoneUI()` function is called from main.ts button click handlers (lines 245-247):
```typescript
E("btnNewSkel").addEventListener("click", () => {
  createSkeleton();
  updateBoneUI();  // ← Called when creating skeleton
});
```

But when switching TO bone tool via setTool(), no updateBoneUI() is called. However, line 25 of input.ts calls `switchTab("bone")` which updates the DOM.

## Root Cause Summary

The crash happens because **setBoneVisualsVisible(true)** at line 26 of input.ts is NOT wrapped in try-catch, while the preceding updateGizmo() at line 19 IS wrapped.

When setTool("bone") is called:
- updateGizmo() is protected ✓
- switchTab("bone") is NOT protected (low risk, just DOM)
- setBoneVisualsVisible(true) is NOT protected ✗ **CRASH HERE**
- deselectBone() is NOT protected (only called in else branch)

## Crash Point Confirmation

**EXACT CRASH LOCATION:**
```
src/input.ts:26
setTool("bone") calls setBoneVisualsVisible(true)
  → src/tools/skeleton-tool.ts:294
  → bd.visual.isVisible = visible
  OR skelData.hierarchyLines.isVisible = visible
  → throws (object disposed, null, or invalid property)
  → NOT CAUGHT by any try-catch
  → Uncaught error propagates and crashes
```

## Fix Required

Wrap setBoneVisualsVisible() call in try-catch:

```typescript
// Line 24-30 of src/input.ts should be:
if (t === "bone" || t === "weight" || t === "anim") {
  if (t === "bone") switchTab("bone");
  try {
    setBoneVisualsVisible(true);
  } catch { /* ignore bone visibility errors */ }
} else {
  try {
    setBoneVisualsVisible(false);
    deselectBone();
  } catch { /* ignore bone visibility errors */ }
}
```

OR wrap the setBoneVisualsVisible() function itself:

```typescript
export function setBoneVisualsVisible(visible: boolean): void {
  try {
    for (const [, skelData] of state.skeletonMap) {
      for (const bd of skelData.bones) {
        if (bd.visual) {
          bd.visual.isVisible = visible;
        }
      }
      if (skelData.hierarchyLines) {
        skelData.hierarchyLines.isVisible = visible;
      }
    }
  } catch (e) {
    console.warn("Error updating bone visibility:", e);
  }
}
```

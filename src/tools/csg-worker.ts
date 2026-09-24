/**
 * The exact boolean off the main thread. `booleanMesh` works in exact
 * rational arithmetic and takes seconds on a 10,000-triangle sphere; run on
 * the page's thread it would freeze the viewport for all of that.
 */
import { booleanBuffers, type RenderBuffer } from "./csg-core";
import type { BooleanOperation } from "./boolean/boolean";

interface Request {
  a: RenderBuffer;
  b: RenderBuffer;
  operation: BooleanOperation;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const t0 = performance.now();
  try {
    const r = booleanBuffers(e.data.a, e.data.b, e.data.operation);
    const transfer: Transferable[] = [r.positions.buffer];
    if (r.uvs) transfer.push(r.uvs.buffer);
    (self as unknown as Worker).postMessage({ ok: true, result: r, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message });
  }
};

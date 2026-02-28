import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { metadataStore, type ModelMetadata } from "./metadata-store";

function makeMeta(id: string, overrides?: Partial<ModelMetadata>): ModelMetadata {
  return {
    id,
    name: "Model " + id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: [],
    ...overrides,
  };
}

describe("metadataStore", () => {
  beforeEach(async () => {
    // Clear all entries between tests
    const all = await metadataStore.getAll();
    for (const m of all) {
      await metadataStore.delete(m.id);
    }
  });

  it("save and get round-trip", async () => {
    const meta = makeMeta("m1", { name: "Cube", tags: ["test"] });
    await metadataStore.save(meta);
    const loaded = await metadataStore.get("m1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("m1");
    expect(loaded!.name).toBe("Cube");
    expect(loaded!.tags).toEqual(["test"]);
  });

  it("get returns null for missing id", async () => {
    const result = await metadataStore.get("nonexistent");
    expect(result).toBeNull();
  });

  it("getAll returns all saved entries", async () => {
    await metadataStore.save(makeMeta("a"));
    await metadataStore.save(makeMeta("b"));
    await metadataStore.save(makeMeta("c"));
    const all = await metadataStore.getAll();
    expect(all).toHaveLength(3);
    const ids = all.map((m) => m.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("save updates existing entry (upsert)", async () => {
    await metadataStore.save(makeMeta("m1", { name: "V1" }));
    await metadataStore.save(makeMeta("m1", { name: "V2" }));
    const all = await metadataStore.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("V2");
  });

  it("delete removes entry", async () => {
    await metadataStore.save(makeMeta("m1"));
    await metadataStore.delete("m1");
    const result = await metadataStore.get("m1");
    expect(result).toBeNull();
  });

  it("delete on missing id does not throw", async () => {
    await expect(metadataStore.delete("missing")).resolves.toBeUndefined();
  });
});

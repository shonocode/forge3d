import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { modelStore } from "./model-store";

describe("modelStore (IDB fallback path)", () => {
  beforeEach(async () => {
    // Clean up all stored entries
    const ids = await modelStore.list();
    for (const id of ids) {
      await modelStore.delete(id);
    }
  });

  it("save and load round-trip", async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    await modelStore.save("test1", data);
    const loaded = await modelStore.load("test1");
    expect(loaded).not.toBeNull();
    expect(new Uint8Array(loaded!)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("load returns null for missing id", async () => {
    const result = await modelStore.load("missing");
    expect(result).toBeNull();
  });

  it("list returns saved ids", async () => {
    await modelStore.save("a", new ArrayBuffer(1));
    await modelStore.save("b", new ArrayBuffer(1));
    const ids = (await modelStore.list()).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("delete removes entry", async () => {
    await modelStore.save("x", new ArrayBuffer(1));
    await modelStore.delete("x");
    const result = await modelStore.load("x");
    expect(result).toBeNull();
  });
});

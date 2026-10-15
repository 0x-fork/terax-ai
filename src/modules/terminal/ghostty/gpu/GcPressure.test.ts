import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GC_MIRROR_BATCH_BYTES,
  GC_MIRROR_FACTOR,
  GcPressureMirror,
  gcPressureOptionsFromStorage,
  NATIVE_BYTES_PER_FRAME,
} from "./GcPressure";

afterEach(() => vi.unstubAllGlobals());

describe("GcPressureMirror", () => {
  it("weighs a frame at ten times the native cost it pins", () => {
    const sizes: number[] = [];
    const mirror = new GcPressureMirror({
      allocate: (bytes) => sizes.push(bytes),
    });
    mirror.noteFrame();
    expect(sizes).toEqual([NATIVE_BYTES_PER_FRAME * GC_MIRROR_FACTOR]);
    expect(mirror.diagnostics()).toMatchObject({
      enabled: true,
      frames: 1,
      allocations: 1,
      bytesPerFrame: 129_000,
    });
  });

  it("allocates nothing until a batch of frames has built up", () => {
    const allocate = vi.fn();
    const mirror = new GcPressureMirror({
      bytesPerFrame: 12_900,
      batchBytes: GC_MIRROR_BATCH_BYTES,
      allocate,
    });
    const framesPerBatch = Math.ceil(GC_MIRROR_BATCH_BYTES / 12_900);
    for (let frame = 1; frame < framesPerBatch; frame++) mirror.noteFrame();
    expect(allocate).not.toHaveBeenCalled();
    mirror.noteFrame();
    expect(allocate).toHaveBeenCalledOnce();
  });

  it("mirrors the whole cost without drifting over many frames", () => {
    const sizes: number[] = [];
    const mirror = new GcPressureMirror({
      bytesPerFrame: 12_900,
      batchBytes: 64 * 1024,
      allocate: (bytes) => sizes.push(bytes),
    });
    for (let frame = 0; frame < 6_000; frame++) mirror.noteFrame();
    const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
    // Everything owed was allocated except what is still below one batch.
    expect(total).toBeLessThanOrEqual(6_000 * 12_900);
    expect(6_000 * 12_900 - total).toBeLessThan(64 * 1024);
    expect(
      sizes.every((bytes) => bytes >= 64 * 1024 && bytes < 64 * 1024 + 12_900),
    ).toBe(true);
    expect(mirror.diagnostics()).toMatchObject({
      frames: 6_000,
      allocations: sizes.length,
      allocatedBytes: total,
    });
  });

  it("never allocates a buffer big enough to be a full collection's trigger", () => {
    const sizes: number[] = [];
    const mirror = new GcPressureMirror({
      allocate: (bytes) => sizes.push(bytes),
    });
    for (let frame = 0; frame < 100_000; frame++) mirror.noteFrame();
    expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
    // At 60 frames a second this is about 7 MiB of short-lived buffers a second, not a spike.
    expect(sizes.length).toBe(100_000);
  });

  it("is inert when disabled", () => {
    const allocate = vi.fn();
    const mirror = new GcPressureMirror({ bytesPerFrame: 0, allocate });
    for (let frame = 0; frame < 10_000; frame++) mirror.noteFrame();
    expect(allocate).not.toHaveBeenCalled();
    expect(mirror.diagnostics().enabled).toBe(false);
  });

  it("allocates real ArrayBuffers by default", () => {
    const mirror = new GcPressureMirror({
      bytesPerFrame: 40_000,
      batchBytes: 64 * 1024,
    });
    mirror.noteFrame(2);
    expect(mirror.diagnostics().allocations).toBe(1);
    expect(mirror.diagnostics().allocatedBytes).toBe(80_000);
  });
});

describe("gcPressureOptionsFromStorage", () => {
  const read = (value: string | null | Error) => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          if (value instanceof Error) throw value;
          return value;
        },
      },
    });
    return gcPressureOptionsFromStorage();
  };

  it("reads the override and ignores bad values", () => {
    expect(read(null)).toEqual({});
    expect(read("off")).toEqual({ bytesPerFrame: 0 });
    expect(read("20000")).toEqual({
      bytesPerFrame: 20000,
      batchBytes: undefined,
    });
    expect(read("20000:131072")).toEqual({
      bytesPerFrame: 20000,
      batchBytes: 131072,
    });
    expect(read("soon")).toEqual({
      bytesPerFrame: undefined,
      batchBytes: undefined,
    });
    expect(read(new Error("blocked"))).toEqual({});
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebGpuCanvasPool } from "@/modules/terminal/ghostty/gpu/WebGpuCanvasPool";

const pools: WebGpuCanvasPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebGpuCanvasPool", () => {
  it("reuses configured presentation storage across 100 tab switches", () => {
    const h = harness();
    let lease = h.pool.acquire(h.configuration);
    lease.backingStore.stage(2000, 1300, 1000, 650);
    lease.backingStore.commit();
    const canvas = lease.canvas;
    lease.present();
    for (let index = 0; index < 100; index++) {
      lease.release();
      lease = h.pool.acquire(h.configuration);
      expect(lease.canvas).toBe(canvas);
      expect(canvas.style.visibility).toBe("hidden");
      expect(lease.backingStore.commit()).toBe(false);
      lease.present();
    }
    expect(h.created).toHaveLength(1);
    expect(h.created[0].context.configure).toHaveBeenCalledOnce();
    expect(h.created[0].context.unconfigure).not.toHaveBeenCalled();
    expect(h.pool.diagnostics()).toEqual({
      active: 1,
      idle: 0,
      colorBytes: 10_400_000,
    });
  });

  it("bounds retained pane groups and releases them after the grace period", () => {
    const h = harness();
    const leases = Array.from({ length: 9 }, () =>
      h.pool.acquire(h.configuration),
    );
    for (const lease of leases) lease.release();
    expect(leases[0].canvas.width).toBe(1);
    expect(h.pool.diagnostics().idle).toBe(8);
    vi.advanceTimersByTime(2_000);
    expect(h.pool.diagnostics()).toEqual({ active: 0, idle: 0, colorBytes: 0 });
    for (const lease of leases) expect(lease.canvas.width).toBe(1);
  });

  it("caps aggregate idle storage and does not extend another canvas's deadline", () => {
    const h = harness();
    const leases = Array.from({ length: 4 }, () =>
      h.pool.acquire(h.configuration),
    );
    for (const lease of leases) {
      lease.backingStore.stage(2000, 1300, 1000, 650);
      lease.backingStore.commit();
      lease.release();
    }
    expect(h.pool.diagnostics()).toEqual({
      active: 0,
      idle: 3,
      colorBytes: 31_200_000,
    });
    vi.advanceTimersByTime(1_000);
    const reused = h.pool.acquire(h.configuration);
    reused.release();
    vi.advanceTimersByTime(1_000);
    expect(h.pool.diagnostics().idle).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(h.pool.diagnostics().idle).toBe(0);
  });

  it("does not retain oversized targets or targets reclaimed on sleep", () => {
    const h = harness();
    const large = h.pool.acquire(h.configuration);
    large.backingStore.stage(8000, 4000, 4000, 2000);
    large.backingStore.commit();
    large.release();
    expect(h.pool.diagnostics().idle).toBe(0);
    const sleeping = h.pool.acquire(h.configuration);
    sleeping.release(true);
    expect(h.pool.diagnostics().idle).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates active leases on device loss without resurrecting them", () => {
    const h = harness();
    const stale = h.pool.acquire(h.configuration);
    h.pool.clear();
    const current = h.pool.acquire({ ...h.configuration, generation: 2 });
    stale.present();
    stale.release();
    stale.release();
    expect(stale.canvas.style.visibility).toBe("hidden");
    expect(current.canvas).not.toBe(stale.canvas);
    expect(h.pool.diagnostics()).toMatchObject({ active: 1, idle: 0 });
  });

  it("cleans up failed configuration without retaining an unusable target", () => {
    const h = harness(true);
    expect(() => h.pool.acquire(h.configuration)).toThrow(
      "configuration failed",
    );
    expect(h.created[0].context.unconfigure).toHaveBeenCalledOnce();
    expect(h.pool.diagnostics()).toEqual({ active: 0, idle: 0, colorBytes: 0 });
  });
});

function harness(fail = false) {
  vi.useFakeTimers();
  const created: {
    context: {
      configure: ReturnType<typeof vi.fn>;
      unconfigure: ReturnType<typeof vi.fn>;
    };
  }[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const context = {
        configure: vi.fn(() => {
          if (fail) throw new Error("configuration failed");
        }),
        unconfigure: vi.fn(),
      };
      const canvas = {
        width: 300,
        height: 150,
        style: { width: "", height: "", visibility: "" },
        setAttribute: vi.fn(),
        remove: vi.fn(),
        getContext: () => context,
      };
      created.push({ context });
      return canvas;
    },
  });
  const pool = new WebGpuCanvasPool();
  pools.push(pool);
  return {
    pool,
    created,
    configuration: {
      device: {} as GPUDevice,
      format: "bgra8unorm" as GPUTextureFormat,
      generation: 1,
    },
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CANVAS_PARK_AFTER_MS,
  WebGpuCanvasPool,
} from "@/modules/terminal/ghostty/gpu/WebGpuCanvasPool";

const pools: WebGpuCanvasPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebGpuCanvasPool", () => {
  it("reuses configured presentation storage across 100 tab switches", () => {
    const h = harness();
    let lease = h.pool.acquire(h.configuration);
    lease.backingStore.stage(2000, 1300, 2);
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
      parked: 0,
      colorBytes: 10_400_000,
      created: 1,
      reused: 100,
      reconfigured: 0,
      destroyed: 0,
      parks: 0,
    });
  });

  it("never destroys a presented canvas, whatever its size, count or idle time", () => {
    const h = harness();
    const sizes: Array<[number, number]> = [
      [2000, 1300],
      [8000, 4000], // far above the old 32 MiB idle limit
      ...Array.from({ length: 10 }, (): [number, number] => [640, 400]),
    ];
    const leases = sizes.map(([width, height]) => {
      const lease = h.pool.acquire(h.configuration);
      lease.backingStore.stage(width, height, 2);
      lease.backingStore.commit();
      lease.present();
      return lease;
    });
    for (const lease of leases) lease.release();
    expect(h.pool.diagnostics()).toMatchObject({
      active: 0,
      idle: 12,
      destroyed: 0,
    });
    vi.advanceTimersByTime(60 * 60 * 1_000);
    // Neither time, nor count, nor aggregate size takes a presented canvas away: they are all
    // still configured, and the big ones merely hold a 1x1 swapchain.
    expect(h.pool.diagnostics()).toMatchObject({
      idle: 12,
      parked: 2,
      destroyed: 0,
    });
    for (const { context } of h.created) {
      expect(context.unconfigure).not.toHaveBeenCalled();
    }
    expect(leases[0].canvas.width).toBe(1);
    expect(leases[1].canvas.width).toBe(1);
    expect(leases[2].canvas.width).toBe(640);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.removed(leases[1].canvas)).toBe(1);
  });

  it("keeps an idle canvas at size for tab switches and parks it at 1x1 only after a while", () => {
    const h = harness();
    const lease = h.pool.acquire(h.configuration);
    lease.backingStore.stage(2000, 1300, 2);
    lease.backingStore.commit();
    lease.present();
    const canvas = lease.canvas;
    lease.release();
    vi.advanceTimersByTime(DEFAULT_CANVAS_PARK_AFTER_MS - 1);
    expect(canvas.width).toBe(2000);
    // Taken back in time: nothing was reallocated, and the pending timer does no harm.
    const again = h.pool.acquire(h.configuration, {
      width: 2000,
      height: 1300,
    });
    expect(again.canvas).toBe(canvas);
    expect(again.backingStore.commit()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(canvas.width).toBe(2000);
    expect(h.pool.diagnostics()).toMatchObject({ parks: 0, destroyed: 0 });

    again.release();
    vi.advanceTimersByTime(DEFAULT_CANVAS_PARK_AFTER_MS);
    expect(canvas.width).toBe(1);
    expect(h.created[0].context.unconfigure).not.toHaveBeenCalled();
    expect(h.pool.diagnostics()).toMatchObject({
      idle: 1,
      parked: 1,
      parks: 1,
      colorBytes: 4,
      destroyed: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    // Reused later: sized exactly for its new owner, still the same configured element.
    const back = h.pool.acquire(h.configuration, { width: 2000, height: 1300 });
    expect(back.canvas).toBe(canvas);
    back.backingStore.stage(2000, 1300, 2);
    expect(back.backingStore.commit()).toBe(true);
    expect(canvas.width).toBe(2000);
    expect(h.pool.diagnostics().parked).toBe(0);
  });

  it("does not park small canvases or any canvas when parking is disabled", () => {
    const small = harness();
    const tiny = small.pool.acquire(small.configuration);
    tiny.backingStore.stage(640, 400, 2);
    tiny.backingStore.commit();
    tiny.release();
    vi.advanceTimersByTime(10 * 60_000);
    expect(tiny.canvas.width).toBe(640);
    expect(vi.getTimerCount()).toBe(0);

    const off = harness(false, Number.POSITIVE_INFINITY);
    const big = off.pool.acquire(off.configuration);
    big.backingStore.stage(2000, 1300, 2);
    big.backingStore.commit();
    big.release();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(big.canvas.width).toBe(2000);
  });

  it("takes a parked canvas before resizing one that still holds a swapchain", () => {
    const h = harness();
    const parked = h.pool.acquire(h.configuration);
    const live = h.pool.acquire(h.configuration);
    for (const [lease, width, height] of [
      [parked, 1600, 1000],
      [live, 1500, 900],
    ] as const) {
      lease.backingStore.stage(width, height, 2);
      lease.backingStore.commit();
    }
    parked.release();
    vi.advanceTimersByTime(DEFAULT_CANVAS_PARK_AFTER_MS);
    live.release();
    expect(h.pool.diagnostics()).toMatchObject({ idle: 2, parked: 1 });
    // Neither fits 1000x700. The live one is closer in size, but resizing it frees nothing else.
    const next = h.pool.acquire(h.configuration, { width: 1000, height: 700 });
    expect(next.canvas).toBe(parked.canvas);
    expect(h.created).toHaveLength(2);
  });

  it("holds no more canvases than the peak number of simultaneously leased ones", () => {
    const h = harness();
    const first = Array.from({ length: 4 }, () =>
      h.pool.acquire(h.configuration),
    );
    for (const lease of first) lease.release();
    // A one-pane tab, a four-pane tab, a two-pane tab, in any order: nothing new is made.
    for (const panes of [1, 4, 2, 3, 1, 4]) {
      const leases = Array.from({ length: panes }, () =>
        h.pool.acquire(h.configuration),
      );
      for (const lease of leases) lease.release();
    }
    expect(h.created).toHaveLength(4);
    expect(h.pool.diagnostics()).toMatchObject({
      active: 0,
      idle: 4,
      created: 4,
      destroyed: 0,
    });
    // Growing the peak creates exactly the missing canvas.
    const peak = Array.from({ length: 5 }, () =>
      h.pool.acquire(h.configuration),
    );
    expect(h.created).toHaveLength(5);
    for (const lease of peak) lease.release();
  });

  it("hands a returning pane the canvas that already has its size", () => {
    const h = harness();
    const sizes: Array<[number, number]> = [
      [2000, 1300],
      [1000, 650],
      [500, 300],
    ];
    const leases = sizes.map(([width, height]) => {
      const lease = h.pool.acquire(h.configuration);
      lease.backingStore.stage(width, height, 2);
      lease.backingStore.commit();
      return lease;
    });
    const [large, medium, small] = leases.map((lease) => lease.canvas);
    // Release order is the opposite of what the next acquisitions want.
    for (const lease of [leases[1], leases[0], leases[2]]) lease.release();

    const wantsMedium = h.pool.acquire(h.configuration, {
      width: 1000,
      height: 650,
    });
    expect(wantsMedium.canvas).toBe(medium);
    expect(wantsMedium.backingStore.stage(1000, 650, 2)).toBe(false);
    // Within the backing store's slack counts as a match: no reallocation either.
    const wantsLarge = h.pool.acquire(h.configuration, {
      width: 1960,
      height: 1260,
    });
    expect(wantsLarge.canvas).toBe(large);
    expect(wantsLarge.backingStore.commit()).toBe(false);
    expect(wantsLarge.backingStore.stage(1960, 1260, 2)).toBe(false);
    expect(wantsLarge.backingStore.commit()).toBe(false);
    expect(large.width).toBe(2000);
    // Nothing fits 100x100: take the closest area rather than creating a canvas.
    const odd = h.pool.acquire(h.configuration, { width: 100, height: 100 });
    expect(odd.canvas).toBe(small);
    expect(h.created).toHaveLength(3);
  });

  it("prefers the most recently used canvas when no size is known", () => {
    const h = harness();
    const [a, b, c] = [1, 2, 3].map(() => h.pool.acquire(h.configuration));
    for (const lease of [a, b, c]) lease.release();
    expect(h.pool.acquire(h.configuration).canvas).toBe(c.canvas);
    expect(h.pool.acquire(h.configuration).canvas).toBe(b.canvas);
  });

  it("keeps a reused canvas hidden until its new owner presents", () => {
    const h = harness();
    const lease = h.pool.acquire(h.configuration);
    lease.present();
    expect(lease.canvas.style.visibility).toBe("visible");
    lease.release();
    expect(lease.canvas.style.visibility).toBe("hidden");
    const reused = h.pool.acquire(h.configuration);
    expect(reused.canvas).toBe(lease.canvas);
    expect(reused.canvas.style.visibility).toBe("hidden");
    // The previous owner's lease can no longer reveal the canvas.
    lease.present();
    expect(reused.canvas.style.visibility).toBe("hidden");
    reused.present();
    expect(reused.canvas.style.visibility).toBe("visible");
  });

  it("reconfigures the same canvas for a replacement device instead of creating one", () => {
    const h = harness();
    const first = h.pool.acquire(h.configuration);
    first.backingStore.stage(2000, 1300, 2);
    first.backingStore.commit();
    first.present();
    const canvas = first.canvas;
    first.release();

    const next = { ...h.configuration, device: {} as GPUDevice, generation: 2 };
    const second = h.pool.acquire(next);
    expect(second.canvas).toBe(canvas);
    expect(second.generation).toBe(2);
    expect(second.backingStore.commit()).toBe(false);
    expect(canvas.width).toBe(2000);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].context.configure).toHaveBeenCalledTimes(2);
    expect(h.created[0].context.configure).toHaveBeenLastCalledWith({
      device: next.device,
      format: "bgra8unorm",
      alphaMode: "opaque",
    });
    expect(h.created[0].context.unconfigure).not.toHaveBeenCalled();
    expect(h.pool.diagnostics()).toMatchObject({
      reconfigured: 1,
      destroyed: 0,
    });
  });

  it("reconfigures a leased canvas in place when its device is replaced", () => {
    const h = harness();
    const lease = h.pool.acquire(h.configuration);
    lease.present();
    const next = { ...h.configuration, device: {} as GPUDevice, generation: 2 };
    lease.reconfigure(next);
    lease.reconfigure(next);
    expect(lease.generation).toBe(2);
    expect(lease.canvas.style.visibility).toBe("visible");
    expect(h.created[0].context.configure).toHaveBeenCalledTimes(2);
    expect(h.pool.diagnostics()).toMatchObject({
      active: 1,
      reconfigured: 1,
      destroyed: 0,
    });
  });

  it("keeps a canvas whose reconfiguration failed for a later device", () => {
    const h = harness();
    const lease = h.pool.acquire(h.configuration);
    lease.backingStore.stage(1000, 600, 1);
    lease.backingStore.commit();
    lease.release();
    h.created[0].context.configure.mockImplementationOnce(() => {
      throw new Error("device is lost");
    });
    const next = { ...h.configuration, generation: 2 };
    expect(() => h.pool.acquire(next)).toThrow("device is lost");
    expect(h.pool.diagnostics()).toMatchObject({
      active: 0,
      idle: 1,
      destroyed: 0,
    });
    const retry = h.pool.acquire(next);
    expect(retry.canvas).toBe(lease.canvas);
    expect(retry.generation).toBe(2);
    expect(retry.canvas.width).toBe(1000);
  });

  it("cleans up failed configuration of a new canvas without retaining it", () => {
    const h = harness(true);
    expect(() => h.pool.acquire(h.configuration)).toThrow(
      "configuration failed",
    );
    expect(h.created[0].context.unconfigure).toHaveBeenCalledOnce();
    expect(h.pool.diagnostics()).toMatchObject({
      active: 0,
      idle: 0,
      colorBytes: 0,
      created: 0,
    });
  });

  it("tears canvases down only when the runtime itself is disposed", () => {
    const h = harness();
    const stale = h.pool.acquire(h.configuration);
    const parked = h.pool.acquire(h.configuration);
    parked.release();
    h.pool.dispose();
    expect(h.pool.diagnostics()).toMatchObject({
      active: 0,
      idle: 0,
      destroyed: 2,
    });
    for (const { context } of h.created) {
      expect(context.unconfigure).toHaveBeenCalledOnce();
    }
    // Leases that outlive the pool cannot resurrect their canvases.
    stale.present();
    stale.reconfigure({ ...h.configuration, generation: 2 });
    stale.release();
    stale.release();
    expect(stale.canvas.style.visibility).toBe("hidden");
    expect(h.created[0].context.configure).toHaveBeenCalledOnce();
  });
});

function harness(fail = false, parkAfterMs?: number) {
  vi.useFakeTimers();
  const created: {
    canvas: { width: number; height: number; remove: ReturnType<typeof vi.fn> };
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
      created.push({ canvas, context });
      return canvas;
    },
  });
  const pool = new WebGpuCanvasPool({ parkAfterMs });
  pools.push(pool);
  return {
    pool,
    created,
    removed: (canvas: unknown) =>
      created.find((entry) => entry.canvas === canvas)?.canvas.remove.mock.calls
        .length,
    configuration: {
      device: {} as GPUDevice,
      format: "bgra8unorm" as GPUTextureFormat,
      generation: 1,
    },
  };
}

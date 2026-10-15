import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WebGpuRuntimeSurface,
  WebGpuSharedResources,
} from "./WebGpuTerminalRuntime";
import {
  canvasParkDelayMs,
  WebGpuTerminalRuntime,
} from "./WebGpuTerminalRuntime";

const runtimes: WebGpuTerminalRuntime[] = [];
async function createRuntime() {
  const runtime = await WebGpuTerminalRuntime.create();
  runtimes.push(runtime);
  return runtime;
}

describe("WebGpuTerminalRuntime", () => {
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates no encoder when dirty notifications resolve to unchanged pixels", async () => {
    const h = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    surface.renderFrame.mockReturnValue(false);
    runtime.register(surface);
    runtime.schedule(surface);
    h.flushFrame();
    expect(h.device.createCommandEncoder).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("coalesces all dirty surfaces into one window submission", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const first = createSurface();
    const second = createSurface();
    runtime.register(first);
    runtime.register(second);

    runtime.schedule(first);
    runtime.schedule(first);
    runtime.schedule(second);

    expect(harness.frames.size).toBe(1);
    harness.flushFrame();
    expect(first.renderFrame).toHaveBeenCalledOnce();
    expect(second.renderFrame).toHaveBeenCalledOnce();
    expect(harness.submit).toHaveBeenCalledOnce();
    // One frame, one wait; both surfaces rode the same submission.
    expect(harness.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(runtime.diagnostics()).toMatchObject({
      surfaceCount: 2,
      pendingSurfaces: 0,
      submittedFrames: 1,
      inFlightFrames: 1,
    });
    runtime.dispose();
  });

  it("uses the RAF timestamp so callback jitter does not skip eligible frames", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    for (let frame = 0; frame < 60; frame++) {
      runtime.schedule(surface);
      vi.advanceTimersByTime(frame % 2 ? 17 : 16);
      h.flushFrame((frame * 1_000) / 60);
      await Promise.resolve();
    }
    expect(surface.renderFrame).toHaveBeenCalledTimes(60);
  });

  it("retains dirty work while hidden and resumes once visible", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);

    harness.setVisible(false);
    harness.notifyVisibility();
    runtime.schedule(surface);
    expect(harness.frames.size).toBe(0);
    expect(runtime.diagnostics().pendingSurfaces).toBe(1);

    harness.setVisible(true);
    harness.notifyVisibility();
    expect(surface.handleVisibilityChange).toHaveBeenCalledWith(true);
    expect(harness.frames.size).toBe(1);
    harness.flushFrame();
    expect(surface.renderFrame).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("cancels pending work and notifies surfaces when the window hides", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    runtime.schedule(surface);

    harness.setVisible(false);
    harness.notifyVisibility();

    expect(surface.handleVisibilityChange).toHaveBeenCalledWith(false);
    expect(harness.cancelledFrames).toEqual([1]);
    expect(runtime.diagnostics().pendingSurfaces).toBe(1);
    runtime.dispose();
  });

  it("cancels a pending frame after its final surface unregisters", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    runtime.schedule(surface);
    runtime.unregister(surface);

    expect(harness.cancelledFrames).toEqual([1]);
    expect(harness.frames.size).toBe(0);
    expect(runtime.diagnostics().pendingSurfaces).toBe(0);
    runtime.dispose();
  });

  it("bounds outstanding GPU frames and coalesces output while the GPU is stalled", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const completions: (() => void)[] = [];
    harness.onSubmittedWorkDone.mockImplementation(
      () =>
        new Promise<undefined>((resolve) =>
          completions.push(() => resolve(undefined)),
        ),
    );
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    for (let frame = 0; frame < 2; frame++) {
      runtime.schedule(surface);
      vi.advanceTimersByTime(17);
      harness.flushFrame();
    }
    for (let update = 0; update < 10_000; update++) runtime.schedule(surface);
    vi.advanceTimersByTime(60_000);
    expect(harness.submit).toHaveBeenCalledTimes(2);
    expect(harness.frames.size).toBe(0);
    // One wait at a time: the second frame is covered by the next wait, not a second one.
    expect(completions).toHaveLength(1);
    expect(runtime.diagnostics()).toMatchObject({
      inFlightFrames: 2,
      peakInFlightFrames: 2,
      pendingSurfaces: 1,
      workDoneWaits: 1,
    });
    expect(runtime.diagnostics().stalledFrameRequests).toBeGreaterThan(0);
    completions[0]();
    await Promise.resolve();
    // The first frame is confirmed, so a third may go while the second is still being waited on.
    expect(runtime.diagnostics().inFlightFrames).toBe(1);
    expect(completions).toHaveLength(2);
    expect(harness.frames.size).toBe(1);
    harness.flushFrame();
    expect(harness.submit).toHaveBeenCalledTimes(3);
    expect(runtime.diagnostics().inFlightFrames).toBe(2);
    runtime.dispose();
    for (const complete of completions) complete();
    await Promise.resolve();
    expect(harness.frames.size).toBe(0);
  });

  it("defers device recreation while hidden and resumes it once visible", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    harness.setVisible(false);
    harness.notifyVisibility();
    harness.loseDevice();
    await Promise.resolve();
    expect(harness.requestDevice).toHaveBeenCalledOnce();
    expect(harness.destroyDevice).toHaveBeenCalledOnce();
    expect(surface.handleDeviceLoss).toHaveBeenCalledOnce();
    harness.setVisible(true);
    harness.notifyVisibility();
    await vi.waitFor(() =>
      expect(runtime.diagnostics().deviceRecoveries).toBe(1),
    );
    expect(harness.requestDevice).toHaveBeenCalledTimes(2);
    expect(surface.handleVisibilityChange).toHaveBeenLastCalledWith(true);
    expect(harness.frames.size).toBe(1);
  });

  it("destroys a replacement device that arrives after runtime disposal", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    let deliver: (device: GPUDevice) => void = () => {};
    harness.requestDevice.mockImplementationOnce(
      () =>
        new Promise<GPUDevice>((resolve) => {
          deliver = resolve;
        }),
    );
    harness.loseDevice();
    await vi.waitFor(() =>
      expect(harness.requestDevice).toHaveBeenCalledTimes(2),
    );
    runtime.dispose();
    deliver(harness.device);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.destroyDevice).toHaveBeenCalledTimes(2);
    expect(harness.frames.size).toBe(0);
    expect(runtime.diagnostics().deviceRecoveries).toBe(0);
  });

  it("quarantines a replacement that is lost while its pipelines are still compiling", async () => {
    const h = createHarness();
    const runtime = await createRuntime();
    let finishPipeline: (pipeline: GPURenderPipeline) => void = () => {};
    vi.mocked(h.device.createRenderPipelineAsync).mockImplementationOnce(
      () =>
        new Promise<GPURenderPipeline>((resolve) => {
          finishPipeline = resolve;
        }),
    );
    h.loseDevice();
    await vi.waitFor(() =>
      expect(h.device.createRenderPipelineAsync).toHaveBeenCalledTimes(4),
    );
    h.loseDevice();
    await Promise.resolve();
    expect(runtime.diagnostics().healthy).toBe(false);
    expect(h.requestDevice).toHaveBeenCalledTimes(2);
    finishPipeline({} as GPURenderPipeline);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.diagnostics().deviceRecoveries).toBe(0);
    expect(h.frames.size).toBe(0);
  });

  it("releases the warm glyph atlas after the bounded idle window", async () => {
    vi.useFakeTimers();
    createHarness();
    const runtime = await createRuntime();
    const lease = runtime.acquireGlyphAtlas(METRICS);

    expect(runtime.diagnostics()).toMatchObject({
      atlasCount: 1,
      unusedAtlasCount: 0,
    });
    expect(runtime.diagnostics().atlasBytes).toBeGreaterThan(1_048_576);
    lease.release();
    expect(runtime.diagnostics().unusedAtlasCount).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.diagnostics()).toMatchObject({
      atlasCount: 0,
      atlasBytes: 0,
      atlasCpuBytes: 0,
    });
    runtime.dispose();
  });

  it("defers idle atlas reclamation while replaced resources await a submission", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const runtime = await createRuntime();
    const lease = runtime.acquireGlyphAtlas(METRICS);
    const retired = vi
      .spyOn(lease.atlas, "hasRetired", "get")
      .mockReturnValue(true);
    lease.release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.diagnostics().atlasCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    retired.mockReturnValue(false);
    const surface = createSurface();
    runtime.register(surface);
    runtime.schedule(surface);
    h.flushFrame();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.diagnostics().atlasCount).toBe(0);
  });

  it("pauses through a long occlusion and releases no canvas, atlas texture or device", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    const canvas = runtime.acquireCanvas();
    canvas.backingStore.stage(2000, 1300, 2);
    canvas.backingStore.commit();
    canvas.present();
    const atlas = runtime.acquireGlyphAtlas(METRICS, surface);
    const atlasBytes = runtime.diagnostics().atlasBytes;
    expect(atlasBytes).toBeGreaterThan(1_048_576);

    harness.setVisible(false);
    harness.notifyVisibility();
    runtime.schedule(surface);
    // Far past the old two second reclaim delay and the 30 second idle atlas lifetime.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(surface.handleVisibilityChange).toHaveBeenLastCalledWith(false);
    expect(surface.handleDeviceLoss).not.toHaveBeenCalled();
    expect(harness.frames.size).toBe(0);
    expect(harness.destroyDevice).not.toHaveBeenCalled();
    expect(runtime.diagnostics()).toMatchObject({
      atlasCount: 1,
      atlasBytes,
      canvases: { active: 1, idle: 0, destroyed: 0, colorBytes: 10_400_000 },
    });
    expect(canvas.canvas.width).toBe(2000);

    harness.setVisible(true);
    harness.notifyVisibility();
    expect(surface.handleVisibilityChange).toHaveBeenLastCalledWith(true);
    expect(runtime.diagnostics().canvases).toMatchObject({ destroyed: 0 });
    expect(harness.frames.size).toBe(1);
    atlas.release();
    canvas.release();
    runtime.dispose();
  });

  it("keeps canvases through device recovery and points them at the new device", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    const leased = runtime.acquireCanvas();
    leased.backingStore.stage(1600, 900, 2);
    leased.backingStore.commit();
    leased.present();
    const parked = runtime.acquireCanvas();
    parked.release();
    expect(leased.generation).toBe(1);

    harness.loseDevice();
    await vi.waitFor(() =>
      expect(runtime.diagnostics().deviceRecoveries).toBe(1),
    );
    expect(surface.handleDeviceLoss).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().canvases).toMatchObject({
      active: 1,
      idle: 1,
      destroyed: 0,
    });
    expect(harness.gpuContext.unconfigure).not.toHaveBeenCalled();

    // The leased one is reconfigured in place; the parked one when it is next handed out.
    leased.reconfigure(runtime.resources());
    expect(leased.generation).toBe(runtime.resources().generation);
    expect(leased.canvas.width).toBe(1600);
    const next = runtime.acquireCanvas();
    expect(next.canvas).toBe(parked.canvas);
    expect(next.generation).toBe(runtime.resources().generation);
    expect(runtime.diagnostics().canvases).toMatchObject({
      created: 2,
      reconfigured: 2,
      destroyed: 0,
    });
    expect(harness.gpuContext.unconfigure).not.toHaveBeenCalled();
    leased.release();
    next.release();
  });

  it("tears its canvases down only when the runtime is disposed", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const lease = runtime.acquireCanvas();
    lease.present();
    const parked = runtime.acquireCanvas();
    parked.release();
    expect(harness.gpuContext.unconfigure).not.toHaveBeenCalled();
    runtime.dispose();
    expect(harness.gpuContext.unconfigure).toHaveBeenCalledTimes(2);
  });

  it("releases replaced atlas resources after the frame's submission completes, or at once without one", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    let complete = () => {};
    h.onSubmittedWorkDone.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          complete = () => resolve(undefined);
        }),
    );
    const runtime = await createRuntime();
    const lease = runtime.acquireGlyphAtlas(METRICS);
    const release = vi.spyOn(lease.atlas, "releaseRetired");
    const retired = vi
      .spyOn(lease.atlas, "hasRetired", "get")
      .mockReturnValue(true);
    const surface = createSurface();
    runtime.register(surface);
    runtime.schedule(surface);
    h.flushFrame();
    expect(h.submit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenLastCalledWith(expect.any(Promise));
    // The wait that frees the atlas resources is the same one that confirms the frame.
    expect(h.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().inFlightFrames).toBe(1);
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.diagnostics().inFlightFrames).toBe(0);

    surface.renderFrame.mockReturnValue(false);
    runtime.schedule(surface);
    vi.advanceTimersByTime(20);
    h.flushFrame();
    expect(release).toHaveBeenLastCalledWith(null);
    retired.mockRestore();
    lease.release();
    runtime.dispose();
  });

  it("shares one atlas per font and ratio and keeps ratios apart", async () => {
    createHarness();
    const runtime = await createRuntime();
    const first = runtime.acquireGlyphAtlas(METRICS);
    const second = runtime.acquireGlyphAtlas(METRICS);
    const other = runtime.acquireGlyphAtlas({
      ...METRICS,
      scale: 2,
      deviceCellWidth: 16,
      deviceCellHeight: 32,
      deviceBaseline: 24,
    });

    expect(first.atlas).toBe(second.atlas);
    expect(other.atlas).not.toBe(first.atlas);
    expect(runtime.diagnostics()).toMatchObject({
      atlasCount: 2,
      atlasFlushes: 0,
      atlasCapacityFailures: 0,
    });

    first.release();
    second.release();
    other.release();
    runtime.dispose();
  });

  it("flushes a full atlas between frames, redraws its users and rate limits flushes", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const runtime = await createRuntime();
    const first = createSurface();
    const second = createSurface();
    runtime.register(first);
    runtime.register(second);
    const lease = runtime.acquireGlyphAtlas(METRICS, first);
    const other = runtime.acquireGlyphAtlas(METRICS, second);
    const epoch = lease.atlas.epoch;
    const order: string[] = [];
    first.renderFrame.mockImplementation((getEncoder) => {
      order.push(`first epoch ${lease.atlas.epoch}`);
      getEncoder();
      return true;
    });

    lease.requestFlush();
    expect(runtime.diagnostics().pendingSurfaces).toBe(2);
    harness.flushFrame();
    expect(lease.atlas.epoch).toBe(epoch + 1);
    expect(order).toEqual([`first epoch ${epoch + 1}`]);
    expect(runtime.diagnostics().atlasFlushes).toBe(1);

    lease.requestFlush();
    vi.advanceTimersByTime(17);
    harness.flushFrame();
    expect(lease.atlas.epoch).toBe(epoch + 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(runtime.diagnostics().pendingSurfaces).toBeGreaterThan(0);
    harness.flushFrame();
    expect(lease.atlas.epoch).toBe(epoch + 2);

    lease.release();
    other.release();
    runtime.dispose();
  });

  it("gives every surface in a frame one shared rasterization budget", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const budgets = new Set<unknown>();
    const first = createSurface();
    const second = createSurface();
    for (const surface of [first, second]) {
      surface.renderFrame.mockImplementation(
        (getEncoder, _resources, budget) => {
          budgets.add(budget);
          getEncoder();
          return true;
        },
      );
      runtime.register(surface);
      runtime.schedule(surface);
    }
    harness.flushFrame();
    expect(budgets.size).toBe(1);
    const [budget] = [...budgets] as Array<{ exhausted(ms?: number): boolean }>;
    expect(budget.exhausted(1_000_000)).toBe(false);
    expect(budget.exhausted(0)).toBe(true);
    runtime.dispose();
  });

  it("keeps one GPU wait outstanding and covers the frames submitted meanwhile with the next", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const completions: Array<() => void> = [];
    h.onSubmittedWorkDone.mockImplementation(
      () =>
        new Promise<undefined>((resolve) =>
          completions.push(() => resolve(undefined)),
        ),
    );
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);
    // Frames arrive faster than the GPU confirms them, but never two at a time unconfirmed.
    runtime.schedule(surface);
    vi.advanceTimersByTime(17);
    h.flushFrame();
    runtime.schedule(surface);
    vi.advanceTimersByTime(17);
    h.flushFrame();
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(completions).toHaveLength(1);
    // Confirming frame one starts the wait for frame two at once.
    completions[0]();
    await Promise.resolve();
    expect(completions).toHaveLength(2);
    completions[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.diagnostics()).toMatchObject({
      submittedFrames: 2,
      workDoneWaits: 2,
      peakInFlightFrames: 2,
      inFlightFrames: 0,
    });
    expect(runtime.diagnostics().workDoneLatency.count).toBe(2);
    // Quiet again: the next frame needs a wait of its own.
    runtime.schedule(surface);
    vi.advanceTimersByTime(17);
    h.flushFrame();
    expect(completions).toHaveLength(3);
  });

  it("does not hold the focused pane back while the page sleeps for a background tick", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const runtime = await createRuntime();
    const background = createSurface();
    const focused = createSurface();
    background.isFocused.mockReturnValue(false);
    runtime.register(background);
    runtime.register(focused);
    runtime.schedule(background);
    runtime.schedule(focused);
    h.flushFrame(0);
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(100);
    runtime.schedule(background);
    // Asleep until the tick ending at 133 ms.
    expect(h.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(5);
    runtime.schedule(focused);
    // The focused pane is due now: its frame is requested at once, not after the sleep.
    expect(h.frames.size).toBe(1);
    h.flushFrame(108);
    await Promise.resolve();
    await Promise.resolve();
    expect(focused.renderFrame).toHaveBeenCalledTimes(2);
    expect(background.renderFrame).toHaveBeenCalledTimes(1);
    // The background pane still presents at its tick, in a frame of its own.
    vi.advanceTimersByTime(30);
    expect(h.frames.size).toBe(1);
    h.flushFrame(134);
    expect(background.renderFrame).toHaveBeenCalledTimes(2);
  });

  it("records how long panes wait for a frame, separately for the focused one", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const runtime = await createRuntime();
    const focused = createSurface();
    const other = createSurface();
    other.isFocused.mockReturnValue(false);
    runtime.register(focused);
    runtime.register(other);
    runtime.schedule(focused);
    runtime.schedule(other);
    h.flushFrame();
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    runtime.schedule(focused);
    runtime.schedule(other);
    // The focused pane draws at the next vsync; the other waits for the end of its tick (133 ms).
    h.flushFrame(103);
    expect(focused.renderFrame).toHaveBeenCalledTimes(2);
    expect(other.renderFrame).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30);
    expect(h.frames.size).toBe(1);
    h.flushFrame(134);
    expect(other.renderFrame).toHaveBeenCalledTimes(2);
    const { frameLatency } = runtime.diagnostics();
    expect(frameLatency.focused).toMatchObject({ count: 2, maxMs: 3 });
    expect(frameLatency.background.count).toBe(2);
    expect(frameLatency.background.maxMs).toBeCloseTo(34, 0);
  });

  it("presents background surfaces that turn dirty within one tick in a single frame", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const runtime = await createRuntime();
    const first = createSurface();
    const second = createSurface();
    first.isFocused.mockReturnValue(false);
    second.isFocused.mockReturnValue(false);
    runtime.register(first);
    runtime.register(second);
    runtime.schedule(first);
    runtime.schedule(second);
    h.flushFrame();
    expect(h.submit).toHaveBeenCalledOnce();

    // 100 ms later the first agent redraws; the second does 12 ms after it.
    vi.advanceTimersByTime(100);
    runtime.schedule(first);
    vi.advanceTimersByTime(12);
    runtime.schedule(second);
    // Nothing asks for an animation frame until the vsync that can serve the tick ending at 133 ms.
    expect(h.frames.size).toBe(0);
    vi.advanceTimersByTime(14);
    expect(h.frames.size).toBe(1);
    h.flushFrame((1_000 / 30) * 4);
    expect(first.renderFrame).toHaveBeenCalledTimes(2);
    expect(second.renderFrame).toHaveBeenCalledTimes(2);
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(runtime.diagnostics()).toMatchObject({
      animationFrames: 2,
      idleAnimationFrames: 0,
      timerWakeups: 1,
    });
  });

  it("reads the canvas parking delay override from local storage and ignores bad values", () => {
    const read = (value: string | null | Error) => {
      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => {
            if (value instanceof Error) throw value;
            return value;
          },
        },
      });
      return canvasParkDelayMs();
    };
    expect(read(null)).toBeUndefined();
    expect(read("2500")).toBe(2500);
    expect(read("0")).toBe(0);
    expect(read("off")).toBe(Number.POSITIVE_INFINITY);
    expect(read("-5")).toBeUndefined();
    expect(read("soon")).toBeUndefined();
    expect(read(new Error("storage blocked"))).toBeUndefined();
  });

  it("quarantines a device after an asynchronous validation error", async () => {
    const harness = createHarness();
    const runtime = await createRuntime();
    const surface = createSurface();
    runtime.register(surface);

    harness.reportValidationError("invalid texture upload");

    expect(surface.handleRuntimeError).toHaveBeenCalledOnce();
    expect(runtime.diagnostics()).toMatchObject({
      healthy: false,
      lastError: "WebGPU validation error: invalid texture upload",
      pendingSurfaces: 0,
      atlasCount: 0,
      atlasBytes: 0,
    });
    expect(harness.destroyDevice).toHaveBeenCalledOnce();
    expect(() => runtime.register(createSurface())).toThrow(
      "WebGPU terminal runtime is disabled",
    );
    runtime.dispose();
  });
});

function createHarness() {
  let visible = true;
  let visibilityListener: (() => void) | null = null;
  let uncapturedErrorListener:
    | ((event: { error: { message: string } }) => void)
    | null = null;
  let nextFrame = 1;
  const frames = new Map<number, (frameAt?: number) => void>();
  const cancelledFrames: number[] = [];
  const submit = vi.fn();
  const onSubmittedWorkDone = vi.fn(async () => undefined);
  const destroyDevice = vi.fn();
  const gpuContext = { configure: vi.fn(), unconfigure: vi.fn() };
  let loseDevice: (info: GPUDeviceLostInfo) => void = () => {};
  const device = {
    addEventListener: vi.fn(
      (
        name: string,
        listener: (event: { error: { message: string } }) => void,
      ) => {
        if (name === "uncapturederror") uncapturedErrorListener = listener;
      },
    ),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async () => ({})),
    createSampler: vi.fn(() => ({})),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
      width: (descriptor.size as number[])[0],
      height: (descriptor.size as number[])[1],
      format: descriptor.format,
      createView: vi.fn(() => ({})),
      destroy: vi.fn(),
    })),
    createBuffer: vi.fn(({ size }: GPUBufferDescriptor) => ({
      size,
      getMappedRange: () => new ArrayBuffer(size),
      unmap: vi.fn(),
      destroy: vi.fn(),
    })),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      finish: vi.fn(() => ({})),
      copyTextureToTexture: vi.fn(),
    })),
    limits: { maxTextureDimension2D: 8_192 },
    destroy: destroyDevice,
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      loseDevice = resolve;
    }),
    queue: {
      submit,
      onSubmittedWorkDone,
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
    },
  } as unknown as GPUDevice;

  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUTextureUsage", {
    COPY_DST: 1,
    TEXTURE_BINDING: 2,
    COPY_SRC: 4,
  });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
  const requestDevice = vi.fn(async () => device);
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: vi.fn(async () => ({
        requestDevice,
      })),
      getPreferredCanvasFormat: vi.fn(() => "bgra8unorm"),
    },
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visible ? "visible" : "hidden";
    },
    addEventListener: vi.fn((name: string, listener: () => void) => {
      if (name === "visibilitychange") visibilityListener = listener;
    }),
    removeEventListener: vi.fn(),
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      style: {},
      setAttribute: vi.fn(),
      remove: vi.fn(),
      getContext: vi.fn((kind: string) =>
        kind === "webgpu"
          ? gpuContext
          : {
              clearRect: vi.fn(),
              measureText: () => ({}),
              fillText: vi.fn(),
              getImageData: (
                _x: number,
                _y: number,
                width: number,
                height: number,
              ) => ({
                data: new Uint8ClampedArray(width * height * 4),
              }),
            },
      ),
    })),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: (frameAt?: number) => void) => {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    cancelledFrames.push(handle);
    frames.delete(handle);
  });

  return {
    frames,
    cancelledFrames,
    submit,
    onSubmittedWorkDone,
    destroyDevice,
    gpuContext,
    device,
    requestDevice,
    loseDevice() {
      const resolve = loseDevice;
      Object.assign(device, {
        lost: new Promise<GPUDeviceLostInfo>((done) => {
          loseDevice = done;
        }),
      });
      resolve({
        reason: "unknown",
        message: "simulated sleep loss",
      } as GPUDeviceLostInfo);
    },
    setVisible(value: boolean): void {
      visible = value;
    },
    notifyVisibility(): void {
      visibilityListener?.();
    },
    flushFrame(frameAt?: number): void {
      const entry = frames.entries().next().value;
      if (!entry) throw new Error("No WebGPU frame is pending");
      const [handle, callback] = entry;
      frames.delete(handle);
      callback(frameAt);
    },
    reportValidationError(message: string): void {
      uncapturedErrorListener?.({ error: { message } });
    },
  };
}

const METRICS = {
  font: {
    family: "monospace",
    size: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    weight: "400",
  },
  scale: 1,
  deviceCellWidth: 8,
  deviceCellHeight: 16,
  deviceBaseline: 12,
  cellWidth: 8,
  cellHeight: 16,
  baseline: 12,
} as const;

function createSurface() {
  return {
    renderFrame: vi.fn(
      (
        getEncoder: () => GPUCommandEncoder,
        _resources: WebGpuSharedResources,
        _budget?: unknown,
      ) => {
        getEncoder();
        return true;
      },
    ),
    handleRuntimeReset: vi.fn(),
    handleRuntimeError: vi.fn(),
    handleVisibilityChange: vi.fn<(visible: boolean) => void>(),
    handleDeviceLoss: vi.fn(),
    isFocused: vi.fn(() => true),
  } satisfies WebGpuRuntimeSurface;
}

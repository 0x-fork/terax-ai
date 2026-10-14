import { SurfaceFramePacer } from "@/modules/terminal/ghostty/SurfaceFramePacer";
import {
  subscribeWindowPresentation,
  terminalWindowPresentation,
} from "@/modules/terminal/ghostty/windowPresentation";
import type { WindowPresentation } from "@/modules/terminal/ghostty/WindowPresentationPolicy";
import {
  bindTerminalWindowFocus,
  terminalFrameIntervalMs,
  terminalWindowFocused,
} from "../renderScheduling";
import { GlyphAtlas } from "./GlyphAtlas";
import type { RasterBudget } from "./GlyphMap";
import { WebGpuCanvasPool } from "@/modules/terminal/ghostty/gpu/WebGpuCanvasPool";
import { BACKGROUND_SHADER, GLYPH_SHADER } from "./shaders";
import type { TerminalFontMetrics } from "./terminalVisuals";

const MAX_ATLAS_COUNT = 8;
const MAX_WARM_UNUSED_ATLASES = 1;
const ATLAS_IDLE_TTL_MS = 30_000;
const MAX_IN_FLIGHT_FRAMES = 2;
/** Glyph rasterization allowed per frame across all surfaces. */
export const RASTER_BUDGET_MS = 2;
/** Larger allowance for a surface's first frame, so text appears whole. */
export const FIRST_FRAME_RASTER_BUDGET_MS = 8;
const ATLAS_FLUSH_COOLDOWN_MS = 250;

export type WebGpuSharedResources = {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly backgroundPipeline: GPURenderPipeline;
  readonly glyphPipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** Stands in for the search mask while no search is active. */
  readonly emptyStorage: GPUBuffer;
  readonly generation: number;
};

export interface WebGpuRuntimeSurface {
  handleWindowFocus?(focused: boolean): void;
  renderFrame(
    getEncoder: () => GPUCommandEncoder,
    resources: WebGpuSharedResources,
    budget?: RasterBudget,
  ): boolean;
  handleRuntimeReset(resources: WebGpuSharedResources): void;
  handleRuntimeError(error: Error): void;
  handleVisibilityChange(visible: boolean, reclaim?: boolean): void;
  isFocused(): boolean;
}

type AtlasEntry = {
  readonly key: string;
  readonly users: Set<WebGpuRuntimeSurface>;
  readonly atlas: GlyphAtlas;
  references: number;
  lastUsed: number;
  flushRequested: boolean;
  lastFlush: number;
};

export type GlyphAtlasLease = {
  readonly key: string;
  readonly atlas: GlyphAtlas;
  /**
   * The atlas is full at its largest size. The runtime flushes it before the
   * next frame; every user then re-rasterizes the glyphs it shows.
   */
  requestFlush(): void;
  release(): void;
};

export type WebGpuRuntimeStats = {
  readonly canvases: ReturnType<WebGpuCanvasPool["diagnostics"]>;
  readonly generation: number;
  readonly surfaceCount: number;
  readonly atlasCount: number;
  readonly atlasBytes: number;
  readonly atlasCpuBytes: number;
  readonly glyphCount: number;
  readonly atlasUploads: number;
  readonly atlasUploadedBytes: number;
  readonly unusedAtlasCount: number;
  readonly atlasFlushes: number;
  readonly atlasGrowths: number;
  readonly atlasCapacityFailures: number;
  readonly submittedFrames: number;
  readonly deviceRecoveries: number;
  readonly recoveryPending: boolean;
  readonly pendingSurfaces: number;
  readonly windowFocused: boolean;
  readonly targetFrameIntervalMs: number;
  readonly frameScheduled: boolean;
  readonly healthy: boolean;
  readonly lastError: string | null;
  readonly inFlightFrames: number;
  readonly peakInFlightFrames: number;
  readonly stagingBytes: number;
};

export class WebGpuTerminalRuntime {
  private readonly canvasPool = new WebGpuCanvasPool();
  private readonly surfaces = new Set<WebGpuRuntimeSurface>();
  private dirtySurfaces = new Set<WebGpuRuntimeSurface>();
  private renderSurfaces = new Set<WebGpuRuntimeSurface>();
  private readonly atlases = new Map<string, AtlasEntry>();
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private backgroundPipeline: GPURenderPipeline | null = null;
  private glyphPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private emptyStorage: GPUBuffer | null = null;
  private animationFrame: number | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private atlasReapDeferred = false;
  private atlasReapTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering: Promise<void> | null = null;
  private pendingRecoveryReason: string | null = null;
  private generation = 0;
  private submittedFrames = 0;
  private inFlightFrames = 0;
  private peakInFlightFrames = 0;
  private deviceRecoveries = 0;
  private fatalError: Error | null = null;
  private windowFocused = terminalWindowFocused();
  private readonly pacer = new SurfaceFramePacer();
  private unbindWindowFocus: () => void = () => {};
  private unbindPresentation: () => void = () => {};
  private disposed = false;

  private constructor() {}

  static async create(): Promise<WebGpuTerminalRuntime> {
    const runtime = new WebGpuTerminalRuntime();
    try {
      await runtime.initializeDevice();
      runtime.unbindPresentation = subscribeWindowPresentation(
        runtime.handleVisibility,
      );
      runtime.unbindWindowFocus = bindTerminalWindowFocus(
        runtime.handleWindowFocus,
      );
      return runtime;
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }

  register(surface: WebGpuRuntimeSurface): void {
    this.assertLive();
    this.assertHealthy();
    this.surfaces.add(surface);
    surface.handleWindowFocus?.(this.windowFocused);
    const state = terminalWindowPresentation();
    surface.handleVisibilityChange(
      state.visible && !this.pendingRecoveryReason && !this.recovering,
      state.reclaim,
    );
  }

  unregister(surface: WebGpuRuntimeSurface): void {
    this.surfaces.delete(surface);
    this.dirtySurfaces.delete(surface);
    this.renderSurfaces.delete(surface);
    if (this.dirtySurfaces.size === 0) this.cancelScheduledFrame();
  }

  acquireCanvas() {
    return this.canvasPool.acquire(this.resources());
  }

  interact(surface: WebGpuRuntimeSurface): void {
    if (this.disposed || !this.surfaces.has(surface)) return;
    this.pacer.interact(surface, performance.now());
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.requestFrame();
  }

  schedule(surface: WebGpuRuntimeSurface): void {
    if (this.disposed || this.fatalError || !this.surfaces.has(surface)) return;
    this.dirtySurfaces.add(surface);
    this.requestFrame();
  }

  acquireGlyphAtlas(
    metrics: TerminalFontMetrics,
    user?: WebGpuRuntimeSurface,
  ): GlyphAtlasLease {
    this.assertLive();
    const key = fontAtlasKey(metrics);
    let entry = this.atlases.get(key);
    if (!entry) {
      this.evictUnusedAtlas();
      if (this.atlases.size >= MAX_ATLAS_COUNT) {
        throw new Error(
          `Terminal glyph atlas budget exhausted (${MAX_ATLAS_COUNT} active atlases)`,
        );
      }
      entry = {
        key,
        users: new Set<WebGpuRuntimeSurface>(),
        atlas: new GlyphAtlas(this.resources().device, metrics),
        references: 0,
        lastUsed: performance.now(),
        flushRequested: false,
        lastFlush: Number.NEGATIVE_INFINITY,
      };
      this.atlases.set(key, entry);
    }
    const owned = entry;
    owned.atlas.resume(this.resources().device);
    owned.references += 1;
    if (user) owned.users.add(user);
    owned.lastUsed = performance.now();
    this.scheduleAtlasReap();

    let released = false;
    return {
      key,
      atlas: owned.atlas,
      requestFlush: () => {
        if (released || owned.flushRequested) return;
        owned.flushRequested = true;
        const wait =
          owned.lastFlush + ATLAS_FLUSH_COOLDOWN_MS - performance.now();
        if (wait <= 0) {
          for (const surface of owned.users) this.schedule(surface);
          return;
        }
        // A working set larger than the atlas must not flush every frame.
        setTimeout(() => {
          for (const surface of owned.users) this.schedule(surface);
        }, wait);
      },
      release: () => {
        if (released) return;
        released = true;
        owned.references = Math.max(0, owned.references - 1);
        if (user) owned.users.delete(user);
        owned.lastUsed = performance.now();
        this.scheduleAtlasReap();
      },
    };
  }

  resources(): WebGpuSharedResources {
    this.assertLive();
    if (
      !this.device ||
      !this.backgroundPipeline ||
      !this.glyphPipeline ||
      !this.bindGroupLayout ||
      !this.emptyStorage
    ) {
      throw new Error("WebGPU terminal runtime is not ready");
    }
    return {
      device: this.device,
      format: this.format,
      backgroundPipeline: this.backgroundPipeline,
      glyphPipeline: this.glyphPipeline,
      bindGroupLayout: this.bindGroupLayout,
      emptyStorage: this.emptyStorage,
      generation: this.generation,
    };
  }

  diagnostics(): WebGpuRuntimeStats {
    let atlasBytes = 0;
    let atlasCpuBytes = 0;
    let glyphCount = 0;
    let atlasUploads = 0;
    let atlasUploadedBytes = 0;
    let unusedAtlasCount = 0;
    let atlasFlushes = 0;
    let atlasGrowths = 0;
    let atlasCapacityFailures = 0;
    let stagingBytes = 0;
    for (const entry of this.atlases.values()) {
      atlasBytes += entry.atlas.byteSize;
      atlasCpuBytes += entry.atlas.cpuByteSize;
      glyphCount += entry.atlas.glyphCount;
      atlasUploads += entry.atlas.uploadCount;
      atlasUploadedBytes += entry.atlas.uploadedBytes;
      atlasFlushes += entry.atlas.flushCount;
      atlasGrowths += entry.atlas.growthCount;
      atlasCapacityFailures += entry.atlas.capacityFailureCount;
      stagingBytes += entry.atlas.retiredBytes;
      if (entry.references === 0) unusedAtlasCount += 1;
    }
    return {
      canvases: this.canvasPool.diagnostics(),
      generation: this.generation,
      surfaceCount: this.surfaces.size,
      atlasCount: this.atlases.size,
      atlasBytes,
      atlasCpuBytes,
      glyphCount,
      atlasUploads,
      atlasUploadedBytes,
      unusedAtlasCount,
      atlasFlushes,
      atlasGrowths,
      atlasCapacityFailures,
      submittedFrames: this.submittedFrames,
      inFlightFrames: this.inFlightFrames,
      peakInFlightFrames: this.peakInFlightFrames,
      stagingBytes,
      deviceRecoveries: this.deviceRecoveries,
      recoveryPending:
        this.recovering !== null || this.pendingRecoveryReason !== null,
      pendingSurfaces: this.dirtySurfaces.size,
      windowFocused: this.windowFocused,
      targetFrameIntervalMs: terminalFrameIntervalMs(
        this.windowFocused,
        this.hasFocusedSurface(),
      ),
      frameScheduled: this.animationFrame !== null || this.frameTimer !== null,
      healthy: this.fatalError === null,
      lastError: this.fatalError?.message ?? null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindPresentation();
    this.unbindWindowFocus();
    this.cancelScheduledFrame();
    if (this.atlasReapTimer !== null) clearTimeout(this.atlasReapTimer);
    this.atlasReapTimer = null;
    this.dirtySurfaces.clear();
    this.renderSurfaces.clear();
    this.surfaces.clear();
    for (const entry of this.atlases.values()) entry.atlas.dispose();
    this.atlases.clear();
    this.releaseDevice();
  }

  private readonly handleVisibility = ({
    visible,
    reclaim,
  }: WindowPresentation): void => {
    if (visible && (this.pendingRecoveryReason || this.recovering)) {
      if (this.pendingRecoveryReason)
        void this.recoverDevice(this.pendingRecoveryReason);
      return;
    }
    if (!visible) this.cancelScheduledFrame();
    for (const surface of this.surfaces) {
      surface.handleVisibilityChange(visible, reclaim);
    }
    if (visible) {
      this.pacer.reset();
      this.requestFrame();
    } else if (reclaim) {
      this.canvasPool.reclaimIdle();
      for (const entry of this.atlases.values()) {
        if (entry.references === 0) entry.atlas.suspend();
      }
    }
  };

  private readonly handleWindowFocus = (focused: boolean): void => {
    if (this.windowFocused === focused) return;
    this.windowFocused = focused;
    for (const surface of this.surfaces) surface.handleWindowFocus?.(focused);
    this.cancelScheduledFrame();
    this.requestFrame();
  };

  private requestFrame(): void {
    if (
      this.disposed ||
      this.animationFrame !== null ||
      this.frameTimer !== null ||
      this.recovering ||
      this.pendingRecoveryReason ||
      this.inFlightFrames >= MAX_IN_FLIGHT_FRAMES ||
      this.fatalError ||
      this.dirtySurfaces.size === 0 ||
      !terminalWindowPresentation().visible
    ) {
      return;
    }
    const delay = this.pacer.delay(
      this.dirtySurfaces,
      this.windowFocused,
      performance.now(),
    );
    if (delay > 1) {
      this.frameTimer = setTimeout(() => {
        this.frameTimer = null;
        this.requestFrame();
      }, delay);
      return;
    }
    this.animationFrame = requestAnimationFrame((frameAt) =>
      this.flushFrame(frameAt),
    );
  }

  private flushFrame(frameAt = performance.now()): void {
    this.animationFrame = null;
    if (
      this.disposed ||
      this.recovering ||
      this.pendingRecoveryReason ||
      this.inFlightFrames >= MAX_IN_FLIGHT_FRAMES ||
      !terminalWindowPresentation().visible ||
      this.dirtySurfaces.size === 0
    )
      return;
    const batch = this.dirtySurfaces;
    this.dirtySurfaces = this.renderSurfaces;
    this.renderSurfaces = batch;
    try {
      const resources = this.resources();
      const frame: { encoder: GPUCommandEncoder | null } = { encoder: null };
      const getEncoder = () =>
        (frame.encoder ??= resources.device.createCommandEncoder({
          label: "Terax terminal window frame",
        }));
      let rendered = false;
      // Flushes happen before any surface encodes, so no draw in this frame
      // can read indices that a later flush would invalidate.
      this.applyAtlasFlushes();
      const budget = createRasterBudget(RASTER_BUDGET_MS);

      for (const surface of batch) {
        if (!this.surfaces.has(surface)) continue;
        if (!this.pacer.due(surface, this.windowFocused, frameAt)) {
          this.dirtySurfaces.add(surface);
          continue;
        }
        try {
          if (surface.renderFrame(getEncoder, resources, budget)) {
            this.pacer.presented(surface, frameAt);
            rendered = true;
          }
        } catch (error) {
          surface.handleRuntimeError(toError(error));
        }
      }

      let completion: Promise<unknown> | null = null;
      if (frame.encoder && rendered) {
        resources.device.queue.submit([frame.encoder.finish()]);
        this.inFlightFrames += 1;
        this.peakInFlightFrames = Math.max(
          this.peakInFlightFrames,
          this.inFlightFrames,
        );
        const generation = this.generation;
        completion = resources.device.queue.onSubmittedWorkDone();
        void completion.then(
          () => {
            if (this.disposed || generation !== this.generation) return;
            this.inFlightFrames = Math.max(0, this.inFlightFrames - 1);
            this.requestFrame();
          },
          (error: unknown) => {
            if (
              this.disposed ||
              generation !== this.generation ||
              this.fatalError
            )
              return;
            void this.recoverDevice(toError(error).message);
          },
        );
        this.submittedFrames += 1;
      }
      // Anything an atlas replaced this frame may still be named by commands
      // just submitted; without a submission nothing can reference it.
      for (const entry of this.atlases.values()) {
        entry.atlas.releaseRetired(completion);
      }
    } catch (error) {
      this.disable(toError(error));
    }
    batch.clear();
    if (this.atlasReapDeferred) {
      this.atlasReapDeferred = false;
      this.scheduleAtlasReap();
    }
    this.requestFrame();
  }

  private applyAtlasFlushes(): void {
    const now = performance.now();
    for (const entry of this.atlases.values()) {
      if (!entry.flushRequested || !entry.atlas.active) continue;
      if (now < entry.lastFlush + ATLAS_FLUSH_COOLDOWN_MS) continue;
      entry.flushRequested = false;
      entry.lastFlush = now;
      entry.atlas.flush();
      for (const surface of entry.users) this.dirtySurfaces.add(surface);
    }
  }

  private hasFocusedSurface(): boolean {
    for (const surface of this.surfaces) {
      if (surface.isFocused()) return true;
    }
    return false;
  }

  private cancelScheduledFrame(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    if (this.frameTimer !== null) clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  private async initializeDevice(): Promise<void> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      throw new Error("WebGPU is unavailable in this webview");
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "low-power",
    });
    this.assertLive();
    if (!adapter) throw new Error("No compatible WebGPU adapter was found");
    const device = await adapter.requestDevice({
      label: "Terax shared terminal renderer",
    });
    if (this.disposed || this.fatalError) {
      device.destroy();
      this.assertLive();
      this.assertHealthy();
    }
    device.addEventListener("uncapturederror", (event) => {
      if (this.disposed || this.device !== device) return;
      this.disable(
        new Error(`WebGPU validation error: ${event.error.message}`),
      );
    });

    this.device = device;
    this.inFlightFrames = 0;
    this.generation += 1;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    let initialized = false;
    const generation = this.generation;
    void device.lost.then((info) => {
      if (
        !this.disposed &&
        !this.fatalError &&
        generation === this.generation
      ) {
        const reason = info.message || String(info.reason);
        if (!initialized || this.recovering) {
          this.disable(
            new Error(
              `WebGPU device was lost during initialization: ${reason}`,
            ),
          );
        } else void this.recoverDevice(reason);
      }
    });
    await this.createSharedResources(device, this.format);
    this.assertLive();
    this.assertHealthy();
    initialized = true;
  }

  private async createSharedResources(
    device: GPUDevice,
    format: GPUTextureFormat,
  ): Promise<void> {
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility,
      buffer: { type: "read-only-storage" },
    });
    const atlasTexture = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" },
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: "Terax terminal bindings",
      entries: [
        { binding: 0, visibility, buffer: { type: "uniform" } },
        storage(1),
        storage(2),
        storage(3),
        storage(4),
        atlasTexture(5),
        atlasTexture(6),
      ],
    });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const backgroundModule = device.createShaderModule({
      label: "Terax terminal background shader",
      code: BACKGROUND_SHADER,
    });
    const glyphModule = device.createShaderModule({
      label: "Terax terminal glyph shader",
      code: GLYPH_SHADER,
    });
    const [backgroundPipeline, glyphPipeline] = await Promise.all([
      device.createRenderPipelineAsync({
        label: "Terax terminal background pipeline",
        layout,
        vertex: { module: backgroundModule, entryPoint: "vertex_main" },
        fragment: {
          module: backgroundModule,
          entryPoint: "fragment_main",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      }),
      device.createRenderPipelineAsync({
        label: "Terax terminal glyph pipeline",
        layout,
        vertex: { module: glyphModule, entryPoint: "vertex_main" },
        fragment: {
          module: glyphModule,
          entryPoint: "fragment_main",
          targets: [
            {
              format,
              blend: {
                color: {
                  srcFactor: "src-alpha",
                  dstFactor: "one-minus-src-alpha",
                },
                alpha: {
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      }),
    ]);
    this.assertLive();
    this.assertHealthy();
    this.backgroundPipeline = backgroundPipeline;
    this.glyphPipeline = glyphPipeline;
    this.emptyStorage = device.createBuffer({
      label: "Terax terminal empty storage",
      size: 16,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  private recoverDevice(reason: string): Promise<void> {
    if (this.disposed || this.fatalError) return Promise.resolve();
    if (this.recovering) return this.recovering;
    this.cancelScheduledFrame();
    if (!this.pendingRecoveryReason) {
      this.pendingRecoveryReason = reason;
      for (const surface of this.surfaces)
        surface.handleVisibilityChange(false, true);
      for (const entry of this.atlases.values()) entry.atlas.suspend();
      this.releaseDevice();
    }
    if (!terminalWindowPresentation().visible) return Promise.resolve();
    this.pendingRecoveryReason = null;
    this.recovering = (async () => {
      try {
        await this.initializeDevice();
        this.deviceRecoveries += 1;
        const state = terminalWindowPresentation();
        for (const surface of this.surfaces) {
          surface.handleVisibilityChange(state.visible, state.reclaim);
          this.dirtySurfaces.add(surface);
        }
      } catch (error) {
        if (!this.disposed)
          this.disable(
            new Error(
              `WebGPU recovery failed after ${reason}: ${toError(error).message}`,
            ),
          );
      } finally {
        this.recovering = null;
        this.requestFrame();
      }
    })();
    return this.recovering;
  }

  private evictUnusedAtlas(): void {
    if (this.atlases.size < MAX_ATLAS_COUNT) return;
    let oldest: AtlasEntry | null = null;
    for (const entry of this.atlases.values()) {
      if (entry.references > 0 || entry.atlas.hasRetired) continue;
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
    }
    if (!oldest) return;
    oldest.atlas.dispose();
    this.atlases.delete(oldest.key);
  }

  private scheduleAtlasReap(): void {
    if (this.atlasReapTimer !== null) clearTimeout(this.atlasReapTimer);
    this.atlasReapTimer = null;
    if (this.disposed) return;

    const unused = [...this.atlases.values()]
      .filter((entry) => entry.references === 0)
      .sort((left, right) => right.lastUsed - left.lastUsed);
    for (const entry of unused.slice(MAX_WARM_UNUSED_ATLASES)) {
      if (entry.atlas.hasRetired) {
        this.atlasReapDeferred = true;
        continue;
      }
      entry.atlas.dispose();
      this.atlases.delete(entry.key);
    }

    const warm = unused[0];
    if (!warm || !this.atlases.has(warm.key)) return;
    if (warm.atlas.hasRetired) {
      this.atlasReapDeferred = true;
      return;
    }
    const remaining = Math.max(
      1,
      Math.ceil(ATLAS_IDLE_TTL_MS - (performance.now() - warm.lastUsed)),
    );
    this.atlasReapTimer = setTimeout(() => {
      this.atlasReapTimer = null;
      this.reapIdleAtlas();
    }, remaining);
  }

  private reapIdleAtlas(): void {
    if (this.disposed) return;
    const now = performance.now();
    for (const entry of this.atlases.values()) {
      if (entry.references === 0 && now - entry.lastUsed >= ATLAS_IDLE_TTL_MS) {
        if (entry.atlas.hasRetired) {
          this.atlasReapDeferred = true;
          continue;
        }
        entry.atlas.dispose();
        this.atlases.delete(entry.key);
      }
    }
    this.scheduleAtlasReap();
  }

  private disable(error: Error): void {
    if (this.disposed || this.fatalError) return;
    this.fatalError = error;
    this.cancelScheduledFrame();
    this.dirtySurfaces.clear();
    this.renderSurfaces.clear();
    for (const surface of [...this.surfaces]) {
      surface.handleRuntimeError(error);
    }
    if (this.atlasReapTimer !== null) clearTimeout(this.atlasReapTimer);
    this.atlasReapTimer = null;
    for (const entry of this.atlases.values()) entry.atlas.dispose();
    this.atlases.clear();
    this.releaseDevice();
  }

  private releaseDevice(): void {
    this.canvasPool.clear();
    this.generation += 1;
    this.inFlightFrames = 0;
    this.device?.destroy();
    this.device = null;
    this.backgroundPipeline = null;
    this.glyphPipeline = null;
    this.bindGroupLayout = null;
    this.emptyStorage = null;
  }

  private assertHealthy(): void {
    if (this.fatalError) {
      throw new Error(
        `WebGPU terminal runtime is disabled: ${this.fatalError.message}`,
      );
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("WebGPU terminal runtime is disposed");
  }
}

let sharedRuntime: WebGpuTerminalRuntime | null = null;
let sharedRuntimePromise: Promise<WebGpuTerminalRuntime> | null = null;

export function getWebGpuTerminalRuntime(): Promise<WebGpuTerminalRuntime> {
  sharedRuntimePromise ??= WebGpuTerminalRuntime.create()
    .then((runtime) => {
      sharedRuntime = runtime;
      return runtime;
    })
    .catch((error) => {
      sharedRuntime = null;
      sharedRuntimePromise = null;
      throw error;
    });
  return sharedRuntimePromise;
}

export function webGpuTerminalRuntimeDiagnostics(): WebGpuRuntimeStats | null {
  return sharedRuntime?.diagnostics() ?? null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void sharedRuntimePromise
      ?.then((runtime) => runtime.dispose())
      .catch(() => undefined);
    sharedRuntime = null;
    sharedRuntimePromise = null;
  });
}

function fontAtlasKey(metrics: TerminalFontMetrics): string {
  const font = metrics.font;
  return [
    font.family,
    font.size,
    font.weight,
    font.lineHeight,
    font.letterSpacing,
    metrics.scale,
    metrics.deviceCellWidth,
    metrics.deviceCellHeight,
    metrics.deviceBaseline,
  ].join("|");
}

/** A per-frame wall-clock allowance for glyph rasterization. */
export function createRasterBudget(limitMs: number): RasterBudget {
  const start = performance.now();
  return {
    exhausted: (allowanceMs = limitMs) =>
      performance.now() - start >= allowanceMs,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

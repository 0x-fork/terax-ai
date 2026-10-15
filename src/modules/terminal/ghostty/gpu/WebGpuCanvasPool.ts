import { CanvasBackingStore } from "@/modules/terminal/ghostty/gpu/CanvasBackingStore";

/**
 * WebKit (macOS 26) keeps the swapchain of a WebGPU canvas that was presented and then destroyed,
 * unconfigured or dropped in the WebContent process for good: about 30 MiB for a 2000x1300
 * canvas (three buffers), whatever the teardown order and whatever the garbage collector does.
 * Keeping the same element configured and sized costs nothing, so a presented canvas is never
 * destroyed while the runtime lives. Occlusion, sleep, hidden tabs, font and ratio changes and a
 * replaced GPU device all leave the element in place (the device case reconfigures it).
 *
 * Shrinking is different from destroying: WebKit frees the replaced swapchain lazily, so a
 * 1x1-and-back round trip costs a transient +2.3 MiB (measured, settles back), not 30 MiB for
 * good. An idle canvas therefore keeps its size for `parkAfterMs` (tab switches reuse it with no
 * reallocation at all) and is then parked at 1x1, still configured, so a pool that grew by one
 * canvas for a moment (a pane that shows before its predecessor hides) does not keep a
 * window-sized swapchain for nothing.
 */

type Configuration = {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly generation: number;
};

/** The backing size (device pixels) a lease expects to need, to choose the canvas that fits. */
export type PreferredCanvasSize = {
  readonly width: number;
  readonly height: number;
};

type Target = {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly backingStore: CanvasBackingStore;
  /** Generation of the device this context is currently configured for. */
  generation: number;
  valid: boolean;
  /** Order of release; the highest is the most recently used canvas. */
  releasedAt: number;
  /** When the canvas went idle, for parking. */
  idleSince: number;
  parked: boolean;
};

export type WebGpuCanvasLease = {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly backingStore: CanvasBackingStore;
  readonly generation: number;
  present(): void;
  /** Points the leased canvas at a replacement device without replacing the element. */
  reconfigure(configuration: Configuration): void;
  release(): void;
};

export type WebGpuCanvasPoolOptions = {
  /** Idle time after which a canvas is shrunk to 1x1; Infinity keeps idle canvases at size. */
  readonly parkAfterMs?: number;
};

export type WebGpuCanvasPoolStats = {
  readonly active: number;
  readonly idle: number;
  readonly parked: number;
  readonly colorBytes: number;
  readonly created: number;
  readonly reused: number;
  readonly reconfigured: number;
  readonly destroyed: number;
  readonly parks: number;
};

export const DEFAULT_CANVAS_PARK_AFTER_MS = 10_000;
/** Canvases below this much color storage are not worth a resize round trip. */
const MIN_PARK_COLOR_BYTES = 2 * 1024 * 1024;

/** Cost added to a candidate that needs a new swapchain, so any exact fit wins. */
const REALLOCATION_PENALTY = 1e12;

/**
 * Canvases are created only when none is idle, so the pool never holds more than the peak number
 * of simultaneously leased canvases, and idle ones keep their configuration and backing size:
 * the next visible pane takes the one that already fits and nothing is reallocated.
 */
export class WebGpuCanvasPool {
  private readonly active = new Set<Target>();
  private idle: Target[] = [];
  private sequence = 0;
  private created = 0;
  private reused = 0;
  private reconfigured = 0;
  private destroyed = 0;
  private parks = 0;
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly parkAfterMs: number;

  constructor(options: WebGpuCanvasPoolOptions = {}) {
    this.parkAfterMs = options.parkAfterMs ?? DEFAULT_CANVAS_PARK_AFTER_MS;
  }

  acquire(
    configuration: Configuration,
    preferred?: PreferredCanvasSize,
  ): WebGpuCanvasLease {
    let target = this.takeIdle(preferred);
    if (target) {
      try {
        this.configureForGeneration(target, configuration);
      } catch (error) {
        // Still the same healthy element; a later device may accept it.
        this.idle.push(target);
        throw error;
      }
      this.reused += 1;
    } else {
      target = this.create(configuration);
    }
    target.parked = false;
    this.active.add(target);
    target.canvas.style.visibility = "hidden";
    let released = false;
    const owned = target;
    return {
      canvas: owned.canvas,
      context: owned.context,
      backingStore: owned.backingStore,
      get generation() {
        return owned.generation;
      },
      present: () => {
        if (!released && owned.valid) owned.canvas.style.visibility = "visible";
      },
      reconfigure: (next) => {
        if (released || !owned.valid) return;
        this.configureForGeneration(owned, next);
      },
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(owned);
        if (!owned.valid) return;
        owned.canvas.style.visibility = "hidden";
        owned.canvas.remove();
        owned.releasedAt = ++this.sequence;
        owned.idleSince = performance.now();
        this.idle.push(owned);
        this.armParkTimer();
      },
    };
  }

  /**
   * Final teardown, when the runtime itself is going away for good. Not a pressure valve: the
   * runtime never calls it while it can still present.
   */
  dispose(): void {
    this.cancelParkTimer();
    for (const target of [...this.idle, ...this.active]) this.destroy(target);
    this.idle = [];
    this.active.clear();
  }

  diagnostics(): WebGpuCanvasPoolStats {
    let colorBytes = 0;
    for (const target of this.idle) colorBytes += this.colorBytes(target);
    for (const target of this.active) colorBytes += this.colorBytes(target);
    return {
      active: this.active.size,
      idle: this.idle.length,
      parked: this.idle.filter((target) => target.parked).length,
      colorBytes,
      created: this.created,
      reused: this.reused,
      reconfigured: this.reconfigured,
      destroyed: this.destroyed,
      parks: this.parks,
    };
  }

  /** The idle canvas that needs the least work for the preferred size, else the newest. */
  private takeIdle(preferred?: PreferredCanvasSize): Target | undefined {
    if (this.idle.length === 0) return undefined;
    let best = this.idle.length - 1;
    if (preferred) {
      let bestCost = Number.POSITIVE_INFINITY;
      // Newest first: among equal fits the warmest canvas wins.
      for (let index = this.idle.length - 1; index >= 0; index--) {
        const cost = this.cost(this.idle[index], preferred);
        if (cost < bestCost) {
          bestCost = cost;
          best = index;
        }
      }
    }
    return this.idle.splice(best, 1)[0];
  }

  private cost(target: Target, preferred: PreferredCanvasSize): number {
    const surplus = target.backingStore.surplusFor(
      preferred.width,
      preferred.height,
    );
    if (surplus !== null) return surplus;
    // A parked canvas holds no swapchain, so growing it frees nothing else: take it before
    // resizing one that still holds a window-sized swapchain.
    if (target.parked) return REALLOCATION_PENALTY;
    const size = target.backingStore.size;
    return (
      REALLOCATION_PENALTY +
      Math.abs(size.width * size.height - preferred.width * preferred.height)
    );
  }

  private create(configuration: Configuration): Target {
    const canvas = document.createElement("canvas");
    canvas.className = "block";
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas context is unavailable");
    try {
      context.configure({
        device: configuration.device,
        format: configuration.format,
        alphaMode: "opaque",
      });
    } catch (error) {
      // Never presented, so nothing is retained by dropping it.
      context.unconfigure();
      canvas.width = 1;
      canvas.height = 1;
      throw error;
    }
    this.created += 1;
    return {
      canvas,
      context,
      backingStore: new CanvasBackingStore(canvas),
      generation: configuration.generation,
      valid: true,
      releasedAt: 0,
      idleSince: 0,
      parked: false,
    };
  }

  private configureForGeneration(
    target: Target,
    configuration: Configuration,
  ): void {
    if (target.generation === configuration.generation) return;
    target.context.configure({
      device: configuration.device,
      format: configuration.format,
      alphaMode: "opaque",
    });
    target.generation = configuration.generation;
    this.reconfigured += 1;
  }

  private armParkTimer(): void {
    if (this.parkTimer !== null || !Number.isFinite(this.parkAfterMs)) return;
    const next = this.idle.find(
      (target) => !target.parked && this.parkable(target),
    );
    if (!next) return;
    this.parkTimer = setTimeout(
      () => {
        this.parkTimer = null;
        this.parkIdle();
        this.armParkTimer();
      },
      Math.max(
        1,
        Math.ceil(next.idleSince + this.parkAfterMs - performance.now()),
      ),
    );
  }

  private parkIdle(): void {
    const now = performance.now();
    for (const target of this.idle) {
      if (target.parked || !this.parkable(target)) continue;
      if (now - target.idleSince < this.parkAfterMs) continue;
      target.backingStore.release();
      target.parked = true;
      this.parks += 1;
    }
  }

  private parkable(target: Target): boolean {
    return this.colorBytes(target) >= MIN_PARK_COLOR_BYTES;
  }

  private cancelParkTimer(): void {
    if (this.parkTimer !== null) clearTimeout(this.parkTimer);
    this.parkTimer = null;
  }

  private destroy(target: Target): void {
    target.valid = false;
    this.destroyed += 1;
    target.context.unconfigure();
    target.backingStore.release();
    target.canvas.remove();
  }

  private colorBytes(target: Target): number {
    return target.canvas.width * target.canvas.height * 4;
  }
}

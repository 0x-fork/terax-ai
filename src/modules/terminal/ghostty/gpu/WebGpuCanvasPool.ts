import { CanvasBackingStore } from "@/modules/terminal/ghostty/gpu/CanvasBackingStore";

const IDLE_TARGET_MS = 2_000;
const MAX_IDLE_COLOR_BYTES = 32 * 1024 * 1024;
const MAX_IDLE_TARGETS = 8;

type Configuration = {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly generation: number;
};

type Target = {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly backingStore: CanvasBackingStore;
  readonly generation: number;
  valid: boolean;
  releasedAt: number;
};

export type WebGpuCanvasLease = Omit<Target, "valid" | "releasedAt"> & {
  present(): void;
  release(reclaim?: boolean): void;
};

export class WebGpuCanvasPool {
  private readonly active = new Set<Target>();
  private idle: Target[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  acquire(configuration: Configuration): WebGpuCanvasLease {
    this.reapExpired();
    let target = this.idle.pop();
    this.armTimer();
    if (target && target.generation !== configuration.generation) {
      this.destroy(target);
      target = undefined;
    }
    target ??= this.create(configuration);
    this.active.add(target);
    target.canvas.style.visibility = "hidden";
    let released = false;
    const owned = target;
    return {
      canvas: owned.canvas,
      context: owned.context,
      backingStore: owned.backingStore,
      generation: owned.generation,
      present: () => {
        if (!released && owned.valid) owned.canvas.style.visibility = "visible";
      },
      release: (reclaim = false) => {
        if (released) return;
        released = true;
        this.active.delete(owned);
        if (!owned.valid) return;
        owned.canvas.style.visibility = "hidden";
        owned.canvas.remove();
        if (
          reclaim ||
          owned.canvas.width * owned.canvas.height * 4 > MAX_IDLE_COLOR_BYTES
        ) {
          this.destroy(owned);
          return;
        }
        owned.releasedAt = performance.now();
        this.idle.push(owned);
        let bytes = this.idle.reduce(
          (total, entry) => total + this.colorBytes(entry),
          0,
        );
        while (
          this.idle.length > MAX_IDLE_TARGETS ||
          bytes > MAX_IDLE_COLOR_BYTES
        ) {
          const oldest = this.idle.shift();
          if (!oldest) break;
          bytes -= this.colorBytes(oldest);
          this.destroy(oldest);
        }
        this.armTimer();
      },
    };
  }

  reclaimIdle(): void {
    this.cancelTimer();
    for (const target of this.idle) this.destroy(target);
    this.idle = [];
  }

  clear(): void {
    this.reclaimIdle();
    for (const target of this.active) this.destroy(target);
    this.active.clear();
  }

  diagnostics() {
    let colorBytes = this.idle.reduce(
      (total, target) => total + this.colorBytes(target),
      0,
    );
    for (const target of this.active) colorBytes += this.colorBytes(target);
    return {
      active: this.active.size,
      idle: this.idle.length,
      colorBytes,
    };
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
      return {
        canvas,
        context,
        backingStore: new CanvasBackingStore(canvas),
        generation: configuration.generation,
        valid: true,
        releasedAt: 0,
      };
    } catch (error) {
      context.unconfigure();
      canvas.width = 1;
      canvas.height = 1;
      throw error;
    }
  }

  private destroy(target: Target): void {
    target.valid = false;
    target.context.unconfigure();
    target.backingStore.release();
    target.canvas.remove();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private reapExpired(): void {
    const now = performance.now();
    this.idle = this.idle.filter((target) => {
      if (now - target.releasedAt < IDLE_TARGET_MS) return true;
      this.destroy(target);
      return false;
    });
  }

  private armTimer(): void {
    this.cancelTimer();
    const oldest = this.idle[0];
    if (!oldest) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.reapExpired();
        this.armTimer();
      },
      Math.max(
        1,
        Math.ceil(oldest.releasedAt + IDLE_TARGET_MS - performance.now()),
      ),
    );
  }

  private colorBytes(target: Target): number {
    return target.canvas.width * target.canvas.height * 4;
  }
}

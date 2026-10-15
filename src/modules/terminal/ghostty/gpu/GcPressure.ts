/**
 * Makes JavaScriptCore see the native cost of the WebGPU wrappers a presented frame creates.
 *
 * Every window frame creates a canvas texture, its view, a command encoder, a render pass and a
 * command buffer wrapper. WebKit pins about 13 KiB of malloc per frame behind them until the
 * wrappers are garbage collected, and JavaScriptCore does not account for that memory: the
 * JavaScript heap stays tiny, so no collection runs for minutes (about 20 MiB a minute for a
 * visible streaming agent; a forced collection returns all of it). Allocating, and at once
 * dropping, an `ArrayBuffer` per frame makes the engine's allocation heuristics see it, so
 * young-generation collections run steadily and finalize the dead wrappers.
 *
 * The buffers are small, so this never provokes a full collection (the earlier probe of four
 * 64 MiB buffers every 30 s cost about 0.5 core-seconds per firing). The weight is ten times the
 * native cost because that is what it takes: with the app lab (`--instrument`, a visible
 * streaming agent, 120 s, about 25 frames a second) the unfinalized canvas textures at the end
 * were 2,626 with no mirroring, 939 at 5x, 195 at 10x and 42 at 20x, WebKit malloc grew by
 * 36, 10, 2.5 MiB and not at all, and WebContent's instructions per second did not move.
 */

/** WebKit malloc pinned per presented window frame (measured with the app lab, `--instrument`). */
export const NATIVE_BYTES_PER_FRAME = 12_900;
/** How much of it, in multiples, the collector is told about (see above). */
export const GC_MIRROR_FACTOR = 10;
/** Bytes accumulated before one buffer is allocated. */
export const GC_MIRROR_BATCH_BYTES = 64 * 1024;

export type GcPressureOptions = {
  readonly bytesPerFrame?: number;
  readonly batchBytes?: number;
  /** Replaced in tests; the default allocates an ArrayBuffer. */
  readonly allocate?: (bytes: number) => unknown;
};

export type GcPressureStats = {
  readonly enabled: boolean;
  readonly frames: number;
  readonly allocations: number;
  readonly allocatedBytes: number;
  readonly bytesPerFrame: number;
  readonly batchBytes: number;
};

export class GcPressureMirror {
  private readonly bytesPerFrame: number;
  private readonly batchBytes: number;
  private readonly allocate: (bytes: number) => unknown;
  private pending = 0;
  private frames = 0;
  private allocations = 0;
  private allocatedBytes = 0;

  constructor(options: GcPressureOptions = {}) {
    this.bytesPerFrame = Math.max(
      0,
      options.bytesPerFrame ?? NATIVE_BYTES_PER_FRAME * GC_MIRROR_FACTOR,
    );
    this.batchBytes = Math.max(1, options.batchBytes ?? GC_MIRROR_BATCH_BYTES);
    this.allocate = options.allocate ?? ((bytes) => new ArrayBuffer(bytes));
  }

  /** A window frame was submitted; allocates a dropped buffer once enough cost has built up. */
  noteFrame(frames = 1): void {
    this.frames += frames;
    this.pending += this.bytesPerFrame * frames;
    if (this.pending < this.batchBytes) return;
    // One buffer for everything owed; the remainder is below one frame's worth.
    const bytes = Math.floor(this.pending);
    this.pending -= bytes;
    this.allocations += 1;
    this.allocatedBytes += bytes;
    this.allocate(bytes);
  }

  diagnostics(): GcPressureStats {
    return {
      enabled: this.bytesPerFrame > 0,
      frames: this.frames,
      allocations: this.allocations,
      allocatedBytes: this.allocatedBytes,
      bytesPerFrame: this.bytesPerFrame,
      batchBytes: this.batchBytes,
    };
  }
}

/**
 * `localStorage["terax:terminal-gc-mirror"]`: `off`, or `<bytesPerFrame>[:<batchBytes>]`, for
 * experiments; unset means the defaults above.
 */
const GC_MIRROR_STORAGE_KEY = "terax:terminal-gc-mirror";
export function gcPressureOptionsFromStorage(): GcPressureOptions {
  try {
    const value =
      typeof window === "undefined"
        ? null
        : (window.localStorage?.getItem(GC_MIRROR_STORAGE_KEY) ?? null);
    if (value === null) return {};
    if (value === "off") return { bytesPerFrame: 0 };
    const [perFrame, batch] = value.split(":").map(Number);
    return {
      bytesPerFrame:
        Number.isFinite(perFrame) && perFrame >= 0 ? perFrame : undefined,
      batchBytes: Number.isFinite(batch) && batch > 0 ? batch : undefined,
    };
  } catch {
    return {};
  }
}

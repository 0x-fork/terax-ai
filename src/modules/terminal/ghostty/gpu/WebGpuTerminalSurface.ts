import { terminalWindowFocused } from "@/modules/terminal/ghostty/renderScheduling";
import { bindTerminalInteraction } from "@/modules/terminal/ghostty/input/terminalInteraction";
import { TerminalScrollbarSync } from "@/modules/terminal/ghostty/gpu/terminalScrollbar";
import { terminalWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import type { TerminalSurface } from "@/modules/terminal/backend/contracts";
import {
  subscribeTerminalResizeInteraction,
  terminalResizeInteractionActive,
} from "@/modules/terminal/lib/terminalResizeInteraction";
import type { Rgb } from "../core/packedCells";
import type {
  GhosttyGpuFrame,
  GhosttyTerminalModelApi,
} from "../GhosttyTerminalModel";
import { GhosttySearchController } from "../search/GhosttySearchController";
import { TerminalSelectionController } from "../selection/TerminalSelectionController";
import type { WebGpuCanvasLease } from "@/modules/terminal/ghostty/gpu/WebGpuCanvasPool";
import { DevicePixelRatioMonitor } from "./DevicePixelRatioMonitor";
import { TerminalGlyphMap, type RasterBudget } from "./GlyphMap";
import { ScreenUniform } from "./ScreenUniform";
import { SCREEN_UNIFORM_BYTES } from "./shaders";
import { fitTerminalViewport, snapOffsetCss } from "./TerminalFit";
import {
  TerminalFitQueue,
  type TerminalFitBounds,
  type TerminalFitQueueDiagnostics,
} from "./TerminalFitQueue";
import {
  cursorRect,
  decorationMetrics,
  leftOverhangPadding,
  NO_SELECTION,
  selectionUniform,
} from "./terminalGeometry";
import {
  devicePixelScale,
  metricsEqual,
  metricsForScale,
  rgbToCss,
  type TerminalFontMetrics,
  type TerminalGpuTheme,
} from "./terminalVisuals";
import {
  detectPlatform,
  textContrastFor,
  type TextContrast,
} from "./textContrast";
import {
  CELL_RECORD_BYTES,
  compactWebGpuCellCapacity,
  MAX_WEBGPU_SURFACE_CELLS,
  nextWebGpuCellCapacity,
  packSearchMask,
} from "./WebGpuCellBuffer";
import {
  createRasterBudget,
  FIRST_FRAME_RASTER_BUDGET_MS,
  type GlyphAtlasLease,
  getWebGpuTerminalRuntime,
  RASTER_BUDGET_MS,
  type WebGpuRuntimeSurface,
  type WebGpuSharedResources,
  type WebGpuTerminalRuntime,
} from "./WebGpuTerminalRuntime";

const CURSOR_BLINK_MS = 600;
const TEXT_BLINK_MS = 600;
const TEXT_CONTRAST_STORAGE_KEY = "terax:terminal-text-contrast";

export type WebGpuTerminalSurfaceOptions = {
  readonly model: GhosttyTerminalModelApi;
  readonly metrics: TerminalFontMetrics;
  readonly theme: TerminalGpuTheme;
  readonly cursorBlink: boolean;
  readonly cursorStyle: "block" | "underline" | "bar";
  readonly onResize: (cols: number, rows: number) => void;
  readonly onError: (error: Error) => void;
  readonly onFirstFrame?: () => void;
  readonly onFrame?: () => void;
  readonly onRequestFocus?: () => void;
  readonly onOpenLink?: (uri: string) => void;
};

export type WebGpuTerminalSurfaceStats = {
  readonly frames: number;
  readonly backingStoreResizes: number;
  readonly cellCompactions: number;
  readonly cellCapacity: number;
  readonly bufferBytes: number;
  readonly cpuBufferBytes: number;
  readonly gpuBufferBytes: number;
  readonly canvasColorBytes: number;
  readonly estimatedSwapchainBytes: number;
  readonly cols: number;
  readonly rows: number;
  readonly scale: number;
  readonly deviceCellWidth: number;
  readonly deviceCellHeight: number;
  readonly visible: boolean;
  readonly documentSuspended: boolean;
  readonly focused: boolean;
  readonly uploads: number;
  readonly uploadedBytes: number;
  readonly pendingGlyphs: number;
  readonly fit: TerminalFitQueueDiagnostics;
};

export class WebGpuTerminalSurface
  implements TerminalSurface, WebGpuRuntimeSurface
{
  readonly backend = "ghostty-webgpu" as const;

  private target: WebGpuCanvasLease | null = null;
  private readonly input = document.createElement("textarea");
  private readonly root = document.createElement("div");
  private readonly scrollbar = document.createElement("div");
  private readonly scrollbarContent = document.createElement("div");
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribeDamage: () => void;
  private readonly unsubscribeResizeInteraction: () => void;
  private readonly unsubscribeInteraction: () => void;
  private readonly selection: TerminalSelectionController;
  private readonly search: GhosttySearchController;
  private readonly pixelRatioMonitor: DevicePixelRatioMonitor;
  private readonly fitQueue = new TerminalFitQueue();
  private atlasLease: GlyphAtlasLease | null = null;
  private glyphMap = new TerminalGlyphMap();
  private atlasBlocked = false;
  private uniformBuffer: GPUBuffer | null = null;
  private cellsBuffer: GPUBuffer | null = null;
  private glyphMapBuffer: GPUBuffer | null = null;
  private searchBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupDirty = true;
  private readonly screen = new ScreenUniform();
  private searchScratch = new Uint8Array(0);
  private searchRevision = -1;
  private forcePresent = true;
  private needsResync = true;
  private blinkingCells = 0;
  private theme: TerminalGpuTheme;
  private metrics: TerminalFontMetrics;
  private contrast: TextContrast;
  private cellCapacity = 0;
  private host: HTMLElement | null = null;
  private visible = true;
  private readonly scrollbarSync = new TerminalScrollbarSync();
  private scrollbarViewportHeight = 0;
  private focused = false;
  private documentSuspended = !terminalWindowPresentation().visible;
  private runtimeRegistered = false;
  private resizeInteractionActive = terminalResizeInteractionActive();
  private compactAfterResize = false;
  private nativeCursorVisible = false;
  private windowFocused = terminalWindowFocused();
  private cursorVisible = true;
  private cursorEnabled = true;
  private cursorBlinking: boolean;
  private cursorTimer: number | null = null;
  private textBlinkVisible = true;
  private textBlinkTimer: number | null = null;
  private forceFullRedraw = true;
  private runtimeGeneration = 0;
  private frameCount = 0;
  private backingStoreResizeCount = 0;
  private cellCompactionCount = 0;
  private uploadCount = 0;
  private uploadedBytes = 0;
  private contentRevision: number;
  private hoveredCell = -1;
  private hoveredLink: string | null = null;
  private mouseDownLink: string | null = null;
  private applyingFit = false;
  private disposed = false;
  private appliedTransform = "";
  private snapOrigin: { left: number; top: number } | null = null;
  /** Last backing size this pane fitted to; lets the pool hand back a canvas that already has it. */
  private lastBackingSize: { width: number; height: number } | null = null;

  private constructor(
    private readonly runtime: WebGpuTerminalRuntime,
    private readonly options: WebGpuTerminalSurfaceOptions,
  ) {
    this.metrics = metricsForScale(options.metrics, devicePixelScale());
    this.contrast = currentTextContrast(this.metrics.scale);
    this.pixelRatioMonitor = new DevicePixelRatioMonitor(() =>
      this.resizeToHost(),
    );
    this.cursorBlinking = options.cursorBlink;
    this.theme = options.theme;
    options.model.setCursorOptions(options.cursorStyle, options.cursorBlink);
    this.contentRevision = options.model.revision();
    this.root.className = "absolute inset-0 overflow-hidden";
    this.root.style.userSelect = "none";
    this.updateRootBackground();
    this.root.setAttribute("data-terax-ghostty-surface", "webgpu");
    this.root.setAttribute("data-terax-terminal-surface", "");
    this.input.setAttribute("aria-label", "Terminal input");
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.style.cssText =
      "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;resize:none;pointer-events:none;";
    this.scrollbar.setAttribute("aria-label", "Terminal scrollback");
    this.scrollbar.setAttribute("role", "scrollbar");
    this.scrollbar.style.cssText =
      "position:absolute;inset:0 0 0 auto;z-index:10;width:11px;overflow-x:hidden;overflow-y:scroll;overscroll-behavior:contain;visibility:hidden;";
    this.scrollbarContent.style.cssText = "width:1px;height:1px;";
    this.scrollbar.append(this.scrollbarContent);
    this.root.append(this.input, this.scrollbar);

    this.unsubscribeInteraction = bindTerminalInteraction(
      this.root,
      this.handleInteraction,
    );
    this.selection = new TerminalSelectionController({
      model: options.model,
      target: this.root,
      cellSize: () => this.cellSize(),
      shouldIgnoreTarget: (target) =>
        target instanceof Node && this.scrollbar.contains(target),
      onChange: () => {
        if (this.applyingFit) return;
        this.runtime.schedule(this);
      },
    });
    this.search = new GhosttySearchController(options.model, () => {
      if (this.applyingFit) return;
      this.runtime.schedule(this);
    });

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) this.queueFit(this.boundsFromEntry(entry));
    });
    this.unsubscribeDamage = options.model.subscribeDamage(() => {
      if (!this.visible || this.documentSuspended || !this.host) return;
      this.cursorVisible = true;
      this.textBlinkVisible = true;
      this.search.invalidate();
      if (!this.applyingFit) this.runtime.schedule(this);
      this.armCursorBlink();
    });
    this.unsubscribeResizeInteraction = subscribeTerminalResizeInteraction(
      (active) => {
        this.resizeInteractionActive = active;
        if (active) return;
        this.compactAfterResize = true;
        this.queueFit();
      },
    );
    this.root.addEventListener("pointerdown", this.handlePointerDown);
    this.root.addEventListener("mousemove", this.handleLinkMouseMove);
    this.root.addEventListener("mousedown", this.handleLinkMouseDown);
    this.root.addEventListener("mouseup", this.handleLinkMouseUp);
    this.root.addEventListener("mouseleave", this.handleLinkMouseLeave);
    this.scrollbar.addEventListener("scroll", this.handleScroll);
  }

  static async create(
    options: WebGpuTerminalSurfaceOptions,
  ): Promise<WebGpuTerminalSurface> {
    const runtime = await getWebGpuTerminalRuntime();
    return new WebGpuTerminalSurface(runtime, options);
  }

  attach(container: HTMLElement): void {
    this.assertLive();
    if (this.host === container) return;
    if (this.host) this.detach();

    this.host = container;
    container.appendChild(this.root);
    observeHost(this.resizeObserver, container);
    window.addEventListener?.("resize", this.handleWindowResize);
    this.pixelRatioMonitor.start();
    this.scrollbarSync.forget();
    if (this.visible) {
      this.activateGpuResources();
      if (!this.documentSuspended) this.resizeToHost();
    }
    this.updateScrollbar();
    this.forceFullRedraw = true;
    if (this.visible) this.runtime.schedule(this);
  }

  detach(): void {
    if (!this.host) return;
    this.resizeObserver.disconnect();
    window.removeEventListener?.("resize", this.handleWindowResize);
    this.fitQueue.clear();
    this.pixelRatioMonitor.stop();
    this.clearCursorTimer();
    this.clearTextBlinkTimer();
    this.deactivateGpuResources();
    this.root.remove();
    this.host = null;
  }

  focus(): void {
    if (!this.host || !this.visible) return;
    this.input.focus({ preventScroll: true });
  }

  handleWindowFocus(focused: boolean): void {
    this.windowFocused = focused;
    const wasVisible = this.cursorVisible;
    const textWasVisible = this.textBlinkVisible;
    this.cursorVisible = true;
    this.armCursorBlink();
    this.syncTextBlink();
    if ((!wasVisible && this.nativeCursorVisible) || !textWasVisible)
      this.runtime.schedule(this);
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.cursorVisible = true;
    if (focused) this.armCursorBlink();
    else this.clearCursorTimer();
    this.runtime.schedule(this);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.scrollbarSync.invalidate();
    this.root.style.visibility = visible ? "visible" : "hidden";
    if (visible) {
      if (!this.documentSuspended) this.search.resume();
      try {
        if (this.host && !this.uniformBuffer) {
          this.activateGpuResources();
          if (!this.documentSuspended) this.resizeToHost();
        }
      } catch (error) {
        this.options.onError(toError(error));
        return;
      }
      this.forceFullRedraw = true;
      this.runtime.schedule(this);
      this.armCursorBlink();
    } else {
      this.clearCursorTimer();
      this.clearTextBlinkTimer();
      this.textBlinkVisible = true;
      this.search.suspend();
      this.selection.suspend();
      this.deactivateGpuResources();
      this.options.model.releasePresentationResources();
    }
  }

  setCursorOptions(blink: boolean, style: "block" | "underline" | "bar"): void {
    this.options.model.setCursorOptions(style, blink);
    this.cursorBlinking = blink;
    this.cursorVisible = true;
    this.armCursorBlink();
    this.runtime.schedule(this);
  }

  setTheme(theme: TerminalGpuTheme): void {
    this.theme = theme;
    this.updateRootBackground();
    this.forceFullRedraw = true;
    this.runtime.schedule(this);
  }

  setFontMetrics(metrics: TerminalFontMetrics): void {
    const next = metricsForScale(metrics, devicePixelScale());
    if (metricsEqual(this.metrics, next)) return;
    this.metrics = next;
    if (this.documentSuspended) {
      // Paused: the canvas stays configured and sized. The buffers and the atlas lease are tied to
      // the old metrics, so they are rebuilt when presentation resumes.
      this.releaseGpuResources();
      return;
    }
    if (this.host && this.uniformBuffer) {
      this.handleRuntimeReset(this.runtime.resources());
      this.resizeToHost();
      this.forceFullRedraw = true;
      this.runtime.schedule(this);
    }
    this.updateScrollbar();
  }

  /** CSS-pixel cell size (device cell / ratio); hit-testing and overlays use it. */
  cellSize(): { readonly width: number; readonly height: number } {
    return { width: this.metrics.cellWidth, height: this.metrics.cellHeight };
  }

  setCursorEnabled(enabled: boolean): void {
    if (this.cursorEnabled === enabled) return;
    this.cursorEnabled = enabled;
    this.cursorVisible = true;
    this.armCursorBlink();
    this.runtime.schedule(this);
  }

  getSelection(): string | null {
    this.selection.reconcile();
    return this.selection.text();
  }

  searchController(): GhosttySearchController {
    return this.search;
  }

  inputElement(): HTMLTextAreaElement {
    return this.input;
  }

  eventTarget(): HTMLElement {
    return this.root;
  }

  requestFrame(): void {
    this.runtime.schedule(this);
  }

  isFocused(): boolean {
    return this.focused;
  }

  renderFrame(
    getEncoder: () => GPUCommandEncoder,
    resources: WebGpuSharedResources,
    budget: RasterBudget = createRasterBudget(RASTER_BUDGET_MS),
  ): boolean {
    if (
      this.disposed ||
      !this.visible ||
      this.documentSuspended ||
      !this.target ||
      !this.cellsBuffer ||
      !this.uniformBuffer ||
      !this.atlasLease
    ) {
      return false;
    }
    if (resources.generation !== this.runtimeGeneration) {
      this.handleRuntimeReset(resources);
      // The replacement canvas has no staged size yet.
      this.resizeToHost(undefined, false);
    }
    this.applyQueuedFit();
    const model = this.options.model;
    if (model.deferPresentation()) return false;
    const revision = model.revision();
    if (revision !== this.contentRevision) {
      this.contentRevision = revision;
      if (this.hoveredCell >= 0) this.clearHoveredLink();
      this.mouseDownLink = null;
    }
    this.selection.reconcile();
    this.search.refreshOverlay();
    this.updateScrollbar();
    if (this.target.backingStore.commit()) {
      this.backingStoreResizeCount += 1;
      this.forceFullRedraw = true;
    }
    const lease = this.atlasLease;
    const device = resources.device;
    if (!lease || !this.cellsBuffer) return false;

    // The frame's cell view borrows WASM memory: upload it and scan it before
    // any other call into the model.
    const atlasStale = lease.atlas.epoch !== this.glyphMap.atlasEpoch;
    const resync = this.needsResync || atlasStale;
    const frame = model.consumeGpuFrame({ resync });
    this.needsResync = false;
    const expectedCells = frame.rows * frame.cols;
    if (expectedCells > MAX_WEBGPU_SURFACE_CELLS) {
      throw new Error(
        `Terminal surface exceeds ${MAX_WEBGPU_SURFACE_CELLS} visible cells`,
      );
    }
    const bufferReplaced = this.ensureCellCapacity(expectedCells, device);
    const cellsUploaded = this.uploadCells(
      frame,
      bufferReplaced || resync,
      device,
    );
    this.blinkingCells = frame.blinkingCells;
    const glyphsChanged = this.updateGlyphs(
      frame,
      atlasStale,
      resync,
      budget,
      device,
    );

    const cursor = model.cursor();
    const viewportOrigin = model.viewportOriginLine();
    this.syncTextBlink();
    const searchChanged = this.updateSearchMask(device);
    const uniformChanged = this.updateScreenUniform(
      frame,
      cursor,
      viewportOrigin,
      device,
    );
    const bindingsChanged = this.updateBindGroup(resources);

    const redraw =
      frame.damage.kind !== "none" ||
      cellsUploaded ||
      glyphsChanged ||
      searchChanged ||
      uniformChanged ||
      bindingsChanged ||
      this.forcePresent ||
      this.forceFullRedraw;
    if (!redraw || !this.bindGroup) {
      this.options.onFrame?.();
      return false;
    }

    const viewportWidth = Math.min(
      frame.cols * this.metrics.deviceCellWidth,
      this.target.canvas.width,
    );
    const viewportHeight = Math.min(
      frame.rows * this.metrics.deviceCellHeight,
      this.target.canvas.height,
    );
    const encoder = getEncoder();
    const pass = encoder.beginRenderPass({
      label: "Terax terminal surface pass",
      colorAttachments: [
        {
          view: this.target.context.getCurrentTexture().createView(),
          clearValue: rgbClear(this.theme.background),
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setViewport(0, 0, viewportWidth, viewportHeight, 0, 1);
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(resources.backgroundPipeline);
    pass.draw(3);
    pass.setPipeline(resources.glyphPipeline);
    pass.draw(6, expectedCells);
    pass.end();
    this.target.present();

    this.forceFullRedraw = false;
    this.forcePresent = false;
    this.frameCount += 1;
    // Glyphs left over by the raster budget finish on a follow-up frame; a
    // full atlas waits for the runtime's flush instead of spinning.
    if (this.glyphMap.pending > 0 && !this.atlasBlocked) {
      this.runtime.schedule(this);
    }
    if (this.frameCount === 1) this.options.onFirstFrame?.();
    this.options.onFrame?.();
    return true;
  }

  handleRuntimeReset(resources: WebGpuSharedResources): void {
    if (!this.host || this.disposed || this.documentSuspended) return;
    this.releaseGpuResources();
    this.initializeGpuResources(resources);
    this.forceFullRedraw = true;
  }

  handleRuntimeError(error: Error): void {
    this.options.onError(error);
  }

  /**
   * Window occlusion, sleep and a lost GPU device all stop here. Pausing cancels timers and
   * rendering and releases nothing: the canvas keeps its configuration and size, because
   * destroying or shrinking a presented WebGPU canvas makes WebKit retain its swapchain.
   */
  handleVisibilityChange(visible: boolean): void {
    if (!visible) {
      this.documentSuspended = true;
      this.clearCursorTimer();
      this.clearTextBlinkTimer();
      this.search.suspend();
      this.selection.suspend();
      return;
    }
    if (!this.documentSuspended) return;
    this.documentSuspended = false;
    this.cursorVisible = true;
    this.textBlinkVisible = true;
    if (this.visible && this.host) {
      try {
        if (!this.uniformBuffer)
          this.initializeGpuResources(this.runtime.resources());
        this.resizeToHost();
      } catch (error) {
        this.options.onError(toError(error));
        return;
      }
    }
    this.forcePresent = true;
    if (this.visible) this.search.resume();
    this.armCursorBlink();
    this.syncTextBlink();
    this.runtime.schedule(this);
  }

  /**
   * The GPU device is gone: buffers and the atlas lease belong to it and are dropped now, the
   * canvas is kept and pointed at the replacement device when presentation resumes.
   */
  handleDeviceLoss(): void {
    this.handleVisibilityChange(false);
    this.releaseGpuResources();
  }

  diagnostics(): WebGpuTerminalSurfaceStats {
    const retainedBufferBytes =
      (this.cellsBuffer?.size ?? 0) +
      (this.uniformBuffer?.size ?? 0) +
      (this.glyphMapBuffer?.size ?? 0) +
      (this.searchBuffer?.size ?? 0);
    const canvasColorBytes = this.target
      ? this.target.canvas.width * this.target.canvas.height * 4
      : 0;
    return {
      frames: this.frameCount,
      backingStoreResizes: this.backingStoreResizeCount,
      cellCompactions: this.cellCompactionCount,
      cellCapacity: this.cellCapacity,
      bufferBytes: retainedBufferBytes,
      cpuBufferBytes:
        this.screen.data.byteLength +
        this.glyphMap.byteSize +
        this.searchScratch.byteLength,
      gpuBufferBytes: retainedBufferBytes,
      canvasColorBytes,
      estimatedSwapchainBytes: canvasColorBytes * 3,
      cols: this.options.model.cols,
      rows: this.options.model.rows,
      scale: this.metrics.scale,
      deviceCellWidth: this.metrics.deviceCellWidth,
      deviceCellHeight: this.metrics.deviceCellHeight,
      visible: this.visible,
      documentSuspended: this.documentSuspended,
      focused: this.focused,
      uploads: this.uploadCount,
      uploadedBytes: this.uploadedBytes,
      pendingGlyphs: this.glyphMap.pending,
      fit: this.fitQueue.diagnostics(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.unsubscribeDamage();
    this.unsubscribeResizeInteraction();
    this.search.dispose();
    this.selection.dispose();
    this.scrollbarSync.dispose();
    this.unsubscribeInteraction();
    this.root.removeEventListener("pointerdown", this.handlePointerDown);
    this.root.removeEventListener("mousemove", this.handleLinkMouseMove);
    this.root.removeEventListener("mousedown", this.handleLinkMouseDown);
    this.root.removeEventListener("mouseup", this.handleLinkMouseUp);
    this.root.removeEventListener("mouseleave", this.handleLinkMouseLeave);
    this.scrollbar.removeEventListener("scroll", this.handleScroll);
  }

  private readonly handlePointerDown = (): void => {
    if (this.options.onRequestFocus) this.options.onRequestFocus();
    else this.focus();
  };

  private readonly handleLinkMouseMove = (event: MouseEvent): void => {
    this.updateHoveredLink(event);
  };

  private readonly handleLinkMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.updateHoveredLink(event);
    this.mouseDownLink = this.hoveredLink;
  };

  private readonly handleLinkMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.updateHoveredLink(event);
    const uri = this.hoveredLink;
    const activate = uri !== null && uri === this.mouseDownLink;
    this.mouseDownLink = null;
    if (!activate) return;
    event.preventDefault();
    this.options.onOpenLink?.(uri);
  };

  private readonly handleLinkMouseLeave = (): void => {
    this.mouseDownLink = null;
    this.clearHoveredLink();
  };

  private readonly handleInteraction = (): void => {
    if (!this.host || !this.visible || this.documentSuspended) return;
    this.runtime.interact(this);
  };

  private readonly handleWindowResize = (): void => {
    this.queueFit();
  };

  // The only place that reads scrollTop: scroll events are rare and the value
  // is the user's, not ours.
  private readonly handleScroll = (): void => {
    if (!this.host || !this.visible || this.documentSuspended) return;
    const scrollTop = this.scrollbar.scrollTop;
    if (scrollTop === this.scrollbarSync.writtenScrollTop) return;
    this.scrollbarSync.invalidate();
    this.scrollbarSync.observe(scrollTop);
    const { history, offset } = this.options.model.scrollPosition();
    const line = Math.round(scrollTop / this.metrics.cellHeight);
    if (history - line !== offset) {
      this.handleInteraction();
      this.options.model.scrollTo(history - line);
    }
  };

  private updateHoveredLink(event: MouseEvent): void {
    if (
      !this.host ||
      this.scrollbar.contains(event.target as Node) ||
      (this.options.model.modes().mouseTracking && !event.shiftKey)
    ) {
      this.clearHoveredLink();
      return;
    }
    const rect = this.root.getBoundingClientRect();
    const column = Math.floor(
      (event.clientX - rect.left) / this.metrics.cellWidth,
    );
    const row = Math.floor(
      (event.clientY - rect.top) / this.metrics.cellHeight,
    );
    if (
      column < 0 ||
      column >= this.options.model.cols ||
      row < 0 ||
      row >= this.options.model.rows
    ) {
      this.clearHoveredLink();
      return;
    }
    const cell = row * this.options.model.cols + column;
    if (cell === this.hoveredCell) return;
    this.hoveredCell = cell;
    this.hoveredLink = this.options.model.hyperlinkAtViewportCell(row, column);
    this.root.style.cursor = this.hoveredLink ? "pointer" : "text";
  }

  private clearHoveredLink(): void {
    this.hoveredCell = -1;
    this.hoveredLink = null;
    this.root.style.cursor = "text";
  }

  private initializeGpuResources(resources: WebGpuSharedResources): void {
    if (!this.host) return;
    try {
      // Same element, new device: reconfiguring it keeps the swapchain WebKit already holds.
      if (this.target && this.target.generation !== resources.generation)
        this.target.reconfigure(resources);
      if (!this.target) {
        this.target = this.runtime.acquireCanvas(this.lastBackingSize);
        this.target.canvas.style.transform = "";
        this.appliedTransform = "";
        this.root.append(this.target.canvas);
      }
      this.metrics = metricsForScale(this.metrics, devicePixelScale());
      this.contrast = currentTextContrast(this.metrics.scale);
      this.atlasLease = this.runtime.acquireGlyphAtlas(this.metrics, this);
      this.glyphMap = new TerminalGlyphMap();
      this.atlasBlocked = false;
      this.needsResync = true;
      this.forceFullRedraw = true;
      this.screen.invalidate();
      this.uniformBuffer = resources.device.createBuffer({
        label: "Terax terminal surface uniform",
        size: SCREEN_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.glyphMapBuffer = this.createGlyphMapBuffer(
        resources.device,
        this.glyphMap.capacity,
      );
      this.ensureCellCapacity(
        this.options.model.cols * this.options.model.rows,
        resources.device,
      );
      this.bindGroupDirty = true;
      this.runtimeGeneration = resources.generation;
    } catch (error) {
      this.releaseGpuResources();
      this.releaseCanvas();
      throw error;
    }
  }

  private activateGpuResources(): void {
    if (!this.host) return;
    if (!this.runtimeRegistered) {
      this.runtime.register(this);
      this.runtimeRegistered = true;
    }
    if (this.documentSuspended || this.uniformBuffer) return;
    try {
      this.initializeGpuResources(this.runtime.resources());
    } catch (error) {
      this.runtime.unregister(this);
      this.runtimeRegistered = false;
      this.releaseGpuResources();
      this.releaseCanvas();
      throw error;
    }
  }

  private deactivateGpuResources(): void {
    if (this.runtimeRegistered) {
      this.runtime.unregister(this);
      this.runtimeRegistered = false;
    }
    this.releaseGpuResources();
    this.releaseCanvas();
  }

  /** Back to the pool, still configured and sized for the next visible pane. */
  private releaseCanvas(): void {
    this.target?.release();
    this.target = null;
  }

  private releaseGpuResources(): void {
    this.cellsBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.glyphMapBuffer?.destroy();
    this.searchBuffer?.destroy();
    this.cellsBuffer = null;
    this.uniformBuffer = null;
    this.glyphMapBuffer = null;
    this.searchBuffer = null;
    this.bindGroup = null;
    this.bindGroupDirty = true;
    this.searchRevision = -1;
    this.searchScratch = new Uint8Array(0);
    this.atlasLease?.release();
    this.atlasLease = null;
    this.glyphMap = new TerminalGlyphMap();
    this.cellCapacity = 0;
    this.blinkingCells = 0;
    this.forceFullRedraw = true;
    this.needsResync = true;
  }

  private queueFit(bounds?: TerminalFitBounds): void {
    if (!this.host) return;
    this.fitQueue.request(bounds);
    this.runtime.schedule(this);
  }

  private boundsFromEntry(entry: ResizeObserverEntry): TerminalFitBounds {
    const device = entry.devicePixelContentBoxSize?.[0];
    // Layout is clean inside a ResizeObserver callback, so this read is free.
    const origin = this.root.getBoundingClientRect();
    return {
      width: entry.contentRect.width,
      height: entry.contentRect.height,
      device: device
        ? { width: device.inlineSize, height: device.blockSize }
        : undefined,
      left: origin.left,
      top: origin.top,
    };
  }

  private measureHost(): TerminalFitBounds {
    const rect = this.host?.getBoundingClientRect() ?? {
      width: 0,
      height: 0,
    };
    const origin = this.root.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      left: origin.left,
      top: origin.top,
    };
  }

  private applyQueuedFit(): void {
    if (!this.host) return;
    const bounds = this.fitQueue.take(() => this.measureHost());
    if (bounds) this.resizeToHost(bounds, false);
    if (this.compactAfterResize && !this.resizeInteractionActive) {
      this.compactAfterResize = false;
      this.options.model.compactPresentationResources();
      this.compactCellCapacity();
      this.forceFullRedraw = true;
    }
  }

  private resizeToHost(
    measuredBounds?: TerminalFitBounds,
    scheduleRender = true,
  ): void {
    if (
      !this.host ||
      !this.target ||
      !this.visible ||
      this.documentSuspended ||
      !this.uniformBuffer
    )
      return;
    this.fitQueue.clear();
    const bounds = measuredBounds ?? this.measureHost();
    const scale = devicePixelScale();
    this.scrollbarSync.invalidate();
    this.scrollbarViewportHeight = Math.round(bounds.height);
    if (scale !== this.metrics.scale) {
      // New ratio: re-measure the font, then rebuild atlas and buffers.
      this.metrics = metricsForScale(this.metrics, scale);
      this.handleRuntimeReset(this.runtime.resources());
    }
    const fit = fitTerminalViewport(
      bounds.width,
      bounds.height,
      this.metrics,
      bounds.device,
    );
    if (!fit || !this.target) return;
    const { cols, rows, pixelWidth, pixelHeight } = fit;
    if (cols * rows > MAX_WEBGPU_SURFACE_CELLS) {
      this.options.onError(
        new Error(
          `Terminal surface exceeds ${MAX_WEBGPU_SURFACE_CELLS} visible cells`,
        ),
      );
      return;
    }

    const changed =
      cols !== this.options.model.cols || rows !== this.options.model.rows;
    if (changed) {
      this.applyingFit = true;
      try {
        this.options.model.resize(cols, rows);
      } finally {
        this.applyingFit = false;
      }
    }
    if (changed) this.selection.reconcile();
    this.ensureCellCapacity(cols * rows, this.runtime.resources().device);

    const backingStoreChanged = this.target.backingStore.stage(
      pixelWidth,
      pixelHeight,
      this.metrics.scale,
    );
    this.lastBackingSize = { width: pixelWidth, height: pixelHeight };
    const snapped = this.applySnap(bounds);
    if (changed || backingStoreChanged) {
      this.options.model.setPixelSize(pixelWidth, pixelHeight);
    }
    if (changed) this.options.onResize(cols, rows);
    if (changed || backingStoreChanged || snapped) this.forceFullRedraw = true;
    this.updateScrollbar();
    if (scheduleRender && (changed || backingStoreChanged)) {
      this.runtime.schedule(this);
    }
  }

  /**
   * Moves the canvas onto the device pixel grid. The origin comes from the
   * observer callback or a measurement, never from a per-frame read.
   */
  private applySnap(bounds: TerminalFitBounds): boolean {
    if (!this.target) return false;
    if (bounds.left !== undefined && bounds.top !== undefined) {
      this.snapOrigin = { left: bounds.left, top: bounds.top };
    }
    const origin = this.snapOrigin;
    if (!origin) return false;
    const offset = snapOffsetCss(origin.left, origin.top, this.metrics.scale);
    const transform =
      offset.x === 0 && offset.y === 0
        ? ""
        : `translate(${offset.x}px, ${offset.y}px)`;
    if (transform === this.appliedTransform) return false;
    this.target.canvas.style.transform = transform;
    this.appliedTransform = transform;
    return true;
  }

  private updateScrollbar(): void {
    if (!this.host || !this.visible || this.documentSuspended) return;
    this.scrollbarSync.sync(
      this.scrollbarViewportHeight,
      this.scrollbar,
      this.scrollbarContent,
      this.options.model,
      this.metrics.cellHeight,
    );
  }

  /** Grows the cell buffer; true if it was replaced (every row must upload). */
  private ensureCellCapacity(cellCount: number, device: GPUDevice): boolean {
    if (cellCount <= this.cellCapacity && this.cellsBuffer) return false;
    const capacity = nextWebGpuCellCapacity(this.cellCapacity, cellCount);
    this.replaceCellBuffer(capacity, device);
    return true;
  }

  private compactCellCapacity(): void {
    if (!this.cellsBuffer || !this.host || this.documentSuspended) return;
    const required = this.options.model.cols * this.options.model.rows;
    const capacity = compactWebGpuCellCapacity(this.cellCapacity, required);
    if (capacity === null) return;
    this.replaceCellBuffer(capacity, this.runtime.resources().device);
    this.cellCompactionCount += 1;
    this.forceFullRedraw = true;
    this.needsResync = true;
  }

  private replaceCellBuffer(capacity: number, device: GPUDevice): void {
    this.cellsBuffer?.destroy();
    this.cellCapacity = capacity;
    this.cellsBuffer = device.createBuffer({
      label: "Terax terminal cell records",
      size: capacity * CELL_RECORD_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.bindGroupDirty = true;
  }

  private createGlyphMapBuffer(device: GPUDevice, entries: number): GPUBuffer {
    return device.createBuffer({
      label: "Terax terminal glyph map",
      size: entries * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private uploadCells(
    frame: GhosttyGpuFrame,
    everything: boolean,
    device: GPUDevice,
  ): boolean {
    const buffer = this.cellsBuffer;
    if (!buffer) return false;
    const rowBytes = frame.cols * CELL_RECORD_BYTES;
    const ranges = everything
      ? [{ start: 0, end: frame.rows - 1 }]
      : frame.dirtyRanges;
    for (const range of ranges) {
      const offset = range.start * rowBytes;
      const length = (range.end - range.start + 1) * rowBytes;
      device.queue.writeBuffer(buffer, offset, frame.cells, offset, length);
      this.uploadCount += 1;
      this.uploadedBytes += length;
    }
    return ranges.length > 0;
  }

  /**
   * Maintains `glyph_map`: epoch resets, new ids, recovery after an atlas
   * flush, and rasterization within the frame budget. Returns true if the map
   * changed in a way that needs a redraw.
   */
  private updateGlyphs(
    frame: GhosttyGpuFrame,
    atlasStale: boolean,
    resync: boolean,
    budget: RasterBudget,
    device: GPUDevice,
  ): boolean {
    const lease = this.atlasLease;
    if (!lease) return false;
    const atlas = lease.atlas;
    const map = this.glyphMap;
    const grew = map.ensureCapacity(frame.glyphCount);
    if (frame.epoch !== map.zigEpoch) {
      map.resetForEpoch(frame.epoch);
      map.adoptAtlasEpoch(atlas.epoch);
    } else if (atlasStale) {
      map.invalidateAtlas(atlas.epoch);
    }
    map.add(frame.newGlyphs);
    if (map.recovering) {
      map.scanCells(
        frame.cells,
        frame.cols,
        resync ? [{ start: 0, end: frame.rows - 1 }] : frame.dirtyRanges,
      );
    }

    map.shedBacklog(frame.cells, frame.cols, frame.rows);
    const allowance =
      this.frameCount === 0 || resync
        ? FIRST_FRAME_RASTER_BUDGET_MS
        : undefined;
    const result = map.process(atlas, budget, allowance);
    atlas.commit();
    this.atlasBlocked = result.full;
    if (result.full) lease.requestFlush();

    if (grew || this.glyphMapBuffer === null) {
      this.glyphMapBuffer?.destroy();
      this.glyphMapBuffer = this.createGlyphMapBuffer(device, map.capacity);
      map.markAllDirty();
      this.bindGroupDirty = true;
    }
    const dirty = map.takeDirty();
    if (dirty && this.glyphMapBuffer) {
      const count = Math.min(dirty.end, map.capacity - 1) - dirty.start + 1;
      device.queue.writeBuffer(
        this.glyphMapBuffer,
        dirty.start * 4,
        map.entries,
        dirty.start,
        count,
      );
      this.uploadCount += 1;
      this.uploadedBytes += count * 4;
    }
    return dirty !== null || result.resolved > 0;
  }

  /** Uploads the highlight mask only when it changes; frees it when empty. */
  private updateSearchMask(device: GPUDevice): boolean {
    const revision = this.search.maskRevision;
    if (revision === this.searchRevision) return false;
    this.searchRevision = revision;
    const mask = this.search.viewportMaskBytes();
    if (!mask) {
      if (!this.searchBuffer) return false;
      this.searchBuffer.destroy();
      this.searchBuffer = null;
      this.searchScratch = new Uint8Array(0);
      this.bindGroupDirty = true;
      return true;
    }
    const packed = packSearchMask(mask, this.searchScratch);
    if (packed.buffer !== this.searchScratch.buffer) {
      this.searchScratch = new Uint8Array(packed.buffer as ArrayBuffer);
    }
    if (!this.searchBuffer || this.searchBuffer.size !== packed.byteLength) {
      this.searchBuffer?.destroy();
      this.searchBuffer = device.createBuffer({
        label: "Terax terminal search mask",
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroupDirty = true;
    }
    device.queue.writeBuffer(this.searchBuffer, 0, packed);
    this.uploadCount += 1;
    this.uploadedBytes += packed.byteLength;
    return true;
  }

  private updateBindGroup(resources: WebGpuSharedResources): boolean {
    const lease = this.atlasLease;
    if (
      !lease ||
      !this.uniformBuffer ||
      !this.cellsBuffer ||
      !this.glyphMapBuffer
    )
      return false;
    const atlas = lease.atlas;
    if (
      !this.bindGroupDirty &&
      this.bindGroup &&
      atlas.generation === this.boundAtlasGeneration
    )
      return false;
    this.bindGroup = resources.device.createBindGroup({
      label: "Terax terminal surface bindings",
      layout: resources.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cellsBuffer } },
        { binding: 2, resource: { buffer: this.glyphMapBuffer } },
        { binding: 3, resource: { buffer: atlas.tableBuffer } },
        {
          binding: 4,
          resource: { buffer: this.searchBuffer ?? resources.emptyStorage },
        },
        { binding: 5, resource: atlas.coverageTextureView },
        { binding: 6, resource: atlas.colorTextureView },
      ],
    });
    this.boundAtlasGeneration = atlas.generation;
    this.bindGroupDirty = false;
    return true;
  }

  private boundAtlasGeneration = 0;

  private updateScreenUniform(
    frame: GhosttyGpuFrame,
    cursor: ReturnType<GhosttyTerminalModelApi["cursor"]>,
    viewportOriginLine: number,
    device: GPUDevice,
  ): boolean {
    if (!this.uniformBuffer) return false;
    this.nativeCursorVisible =
      cursor.visible &&
      cursor.x >= 0 &&
      cursor.x < frame.cols &&
      cursor.y >= 0 &&
      cursor.y < frame.rows;
    if (cursor.blinking !== this.cursorBlinking) {
      this.cursorBlinking = cursor.blinking;
      this.cursorVisible = true;
    }
    this.armCursorBlink();
    const showCursor =
      this.cursorEnabled && this.cursorVisible && this.nativeCursorVisible;
    const bounds = this.selection.normalizedBounds();
    const theme = this.theme;
    this.screen.pack({
      cols: frame.cols,
      rows: frame.rows,
      cellWidth: this.metrics.deviceCellWidth,
      cellHeight: this.metrics.deviceCellHeight,
      textBlinkVisible: this.textBlinkVisible,
      searchActive: this.searchBuffer !== null,
      cursor: showCursor
        ? cursorRect(cursor, cursor.style, this.metrics)
        : null,
      cursorColor: theme.cursor,
      background: theme.background,
      selection: bounds
        ? selectionUniform(bounds, viewportOriginLine, frame.rows)
        : NO_SELECTION,
      selectionColor: theme.selection.color,
      selectionAlpha: theme.selection.alpha,
      decoration: decorationMetrics(this.metrics),
      leftOverhangPadding: leftOverhangPadding(
        this.metrics.font.letterSpacing,
        this.metrics.scale,
      ),
      contrast: this.contrast,
    });
    if (!this.screen.changed()) return false;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.screen.data);
    this.screen.markUploaded();
    this.uploadCount += 1;
    this.uploadedBytes += SCREEN_UNIFORM_BYTES;
    return true;
  }

  private armCursorBlink(): void {
    if (
      !this.cursorEnabled ||
      !this.nativeCursorVisible ||
      !this.windowFocused ||
      this.documentSuspended ||
      !this.cursorBlinking ||
      !this.focused ||
      !this.visible ||
      !this.host ||
      !terminalWindowPresentation().visible
    ) {
      this.clearCursorTimer();
      return;
    }
    if (this.cursorTimer !== null) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.cursorVisible = !this.cursorVisible;
      this.runtime.schedule(this);
      this.armCursorBlink();
    }, CURSOR_BLINK_MS);
  }

  private clearCursorTimer(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
  }

  private syncTextBlink(): void {
    if (
      this.blinkingCells === 0 ||
      !this.windowFocused ||
      this.documentSuspended ||
      !this.visible ||
      !this.host ||
      !terminalWindowPresentation().visible
    ) {
      this.clearTextBlinkTimer();
      this.textBlinkVisible = true;
      return;
    }
    if (this.textBlinkTimer !== null) return;
    this.textBlinkTimer = window.setTimeout(() => {
      this.textBlinkTimer = null;
      this.textBlinkVisible = !this.textBlinkVisible;
      this.runtime.schedule(this);
      this.syncTextBlink();
    }, TEXT_BLINK_MS);
  }

  private clearTextBlinkTimer(): void {
    if (this.textBlinkTimer !== null) window.clearTimeout(this.textBlinkTimer);
    this.textBlinkTimer = null;
  }

  private updateRootBackground(): void {
    this.root.style.backgroundColor = rgbToCss(this.theme.background);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("WebGPU terminal surface is disposed");
  }
}

function currentTextContrast(scale: number): TextContrast {
  let override: string | null = null;
  try {
    override = window.localStorage?.getItem(TEXT_CONTRAST_STORAGE_KEY) ?? null;
  } catch {
    override = null;
  }
  return textContrastFor({
    platform: detectPlatform(
      typeof navigator === "undefined" ? "" : navigator.userAgent,
    ),
    scale,
    override,
  });
}

/** Asks for the exact device-pixel box where the engine supports it. */
function observeHost(observer: ResizeObserver, host: HTMLElement): void {
  try {
    observer.observe(host, { box: "device-pixel-content-box" });
  } catch {
    observer.observe(host);
  }
}

function rgbClear(color: Rgb): GPUColor {
  return {
    r: color[0] / 255,
    g: color[1] / 255,
    b: color[2] / 255,
    a: 1,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

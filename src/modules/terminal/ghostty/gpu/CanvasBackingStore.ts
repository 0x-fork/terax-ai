type CanvasTarget = {
  width: number;
  height: number;
  readonly style: {
    width: string;
    height: string;
  };
};

export class CanvasBackingStore {
  private presented = false;
  private targetWidth: number;
  private targetHeight: number;
  private targetCssWidth: string;
  private targetCssHeight: string;

  constructor(private readonly canvas: CanvasTarget) {
    this.targetWidth = canvas.width;
    this.targetHeight = canvas.height;
    this.targetCssWidth = canvas.style.width;
    this.targetCssHeight = canvas.style.height;
  }

  get pending(): boolean {
    return (
      this.canvas.width !== this.targetWidth ||
      this.canvas.height !== this.targetHeight ||
      this.canvas.style.width !== this.targetCssWidth ||
      this.canvas.style.height !== this.targetCssHeight
    );
  }

  stage(
    pixelWidth: number,
    pixelHeight: number,
    cssWidth: number,
    cssHeight: number,
  ): boolean {
    const requiredWidth = positivePixelSize(pixelWidth);
    const requiredHeight = positivePixelSize(pixelHeight);
    const nextTargetWidth = this.presented
      ? reusableDimension(this.targetWidth, requiredWidth)
      : requiredWidth;
    const nextTargetHeight = this.presented
      ? reusableDimension(this.targetHeight, requiredHeight)
      : requiredHeight;
    const targetCssWidth = `${(positiveCssSize(cssWidth) * nextTargetWidth) / requiredWidth}px`;
    const targetCssHeight = `${(positiveCssSize(cssHeight) * nextTargetHeight) / requiredHeight}px`;
    const changed =
      this.targetWidth !== nextTargetWidth ||
      this.targetHeight !== nextTargetHeight ||
      this.targetCssWidth !== targetCssWidth ||
      this.targetCssHeight !== targetCssHeight;
    this.targetWidth = nextTargetWidth;
    this.targetHeight = nextTargetHeight;
    this.targetCssWidth = targetCssWidth;
    this.targetCssHeight = targetCssHeight;
    return changed;
  }

  commit(): boolean {
    if (!this.pending) return false;
    this.presented = true;
    if (this.canvas.style.width !== this.targetCssWidth) {
      this.canvas.style.width = this.targetCssWidth;
    }
    if (this.canvas.style.height !== this.targetCssHeight) {
      this.canvas.style.height = this.targetCssHeight;
    }
    if (this.canvas.width !== this.targetWidth) {
      this.canvas.width = this.targetWidth;
    }
    if (this.canvas.height !== this.targetHeight) {
      this.canvas.height = this.targetHeight;
    }
    return true;
  }

  release(): void {
    this.presented = false;
    if (this.canvas.width !== 1) this.canvas.width = 1;
    if (this.canvas.height !== 1) this.canvas.height = 1;
  }
}

// Nearby sizes reuse storage instead of accumulating retired WebKit presentation buffers.
function reusableDimension(current: number, required: number): number {
  const alignment = required < 256 ? 32 : 128;
  if (required <= current && current - required < alignment * 2) return current;
  return Math.ceil(required / alignment) * alignment;
}

function positivePixelSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

function positiveCssSize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

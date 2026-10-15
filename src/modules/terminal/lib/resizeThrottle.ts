/**
 * How often a terminal's grid (and, with it, the shell's SIGWINCH) may change while its host is
 * being dragged. Shells that redraw their prompt on SIGWINCH (zsh, fish) need the model and the
 * PTY to resize together: Ghostty clears the prompt on every model resize and relies on the
 * redraw. 100 ms is ten redraws a second: a prompt blanks for about one IPC round trip (a few
 * milliseconds) per interval rather than staying blank, full-screen programs get at most ten
 * relayouts a second instead of one per cell of pointer movement, and a drag of any speed
 * costs ten reflows a second (about 1 ms each).
 */
export const TERMINAL_RESIZE_INTERVAL_MS = 100;

type Timers = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

/**
 * Leading + periodic + trailing gate for grid changes. The first change after a quiet period
 * applies at once, changes arriving sooner than `intervalMs` after the previous one are held
 * (only the newest matters, the caller re-measures), and `onDue` fires when the next one may
 * apply, so the final size of a drag always lands within one interval of the last movement.
 */
export class ResizeThrottle {
  private lastAppliedAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;

  constructor(
    private readonly onDue: () => void,
    private readonly intervalMs = TERMINAL_RESIZE_INTERVAL_MS,
    private readonly now: () => number = () => performance.now(),
    private readonly timers: Timers = globalThis,
  ) {}

  get waiting(): boolean {
    return this.timer !== null;
  }

  /** True if the change may apply now (and is recorded as applied); otherwise `onDue` is armed. */
  request(): boolean {
    const wait = this.lastAppliedAt + this.intervalMs - this.now();
    if (wait <= 0) {
      this.applied();
      return true;
    }
    if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.onDue();
      }, wait);
    }
    return false;
  }

  /** Records a change applied outside `request` (immediate fits) and drops any held one. */
  applied(): void {
    this.lastAppliedAt = this.now();
    this.cancel();
  }

  /** Forgets the held change without applying it. */
  cancel(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

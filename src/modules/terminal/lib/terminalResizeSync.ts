import { ResizeThrottle } from "./resizeThrottle";

/** The terminal grid a surface keeps in step with its host. */
export type ResizeModel = {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
};

export type ResizeOutcome =
  /** The grid already has these dimensions. */
  | "unchanged"
  /** The model resized and the PTY was told, in the same call. */
  | "applied"
  /** Held back by the throttle: neither the model nor the PTY changed; `onDue` will fire. */
  | "deferred";

export type TerminalResizeSyncOptions = {
  readonly model: ResizeModel;
  /** Tells the PTY (SIGWINCH). Called right after the model resized, never separately. */
  readonly notify: (cols: number, rows: number) => void;
  /** A held change may apply now: the owner re-fits against the host again. */
  readonly onDue: () => void;
  readonly intervalMs?: number;
  readonly now?: () => number;
};

/**
 * Keeps the model's grid and the PTY's window size identical at all times.
 *
 * Ghostty clears the prompt when the model resizes and expects a shell that redraws on
 * SIGWINCH to put it back (OSC 133 `redraw`). Resizing the model on every pointer step while
 * the PTY heard about it 250 ms after the last step left prompts blank for the whole drag.
 * Both now change in one synchronous call, and the call is rate limited while a drag keeps
 * producing new sizes. Between applications the surface keeps showing the last grid; the
 * host clips or pads it.
 */
export class TerminalResizeSync {
  private readonly throttle: ResizeThrottle;

  constructor(private readonly options: TerminalResizeSyncOptions) {
    this.throttle = new ResizeThrottle(
      options.onDue,
      options.intervalMs,
      options.now,
    );
  }

  /** True while a change is held for the next interval. */
  get waiting(): boolean {
    return this.throttle.waiting;
  }

  /**
   * Resizes the grid to `cols` x `rows`. `throttled` fits come from a host that is changing
   * size; everything else (a font or ratio change, the first fit, a pane becoming visible, the
   * end of a drag) applies immediately.
   */
  request(cols: number, rows: number, throttled: boolean): ResizeOutcome {
    const { model } = this.options;
    if (cols === model.cols && rows === model.rows) {
      // A held change that the host has since undone is moot.
      this.throttle.cancel();
      return "unchanged";
    }
    if (throttled) {
      if (!this.throttle.request()) return "deferred";
    } else {
      this.throttle.applied();
    }
    model.resize(cols, rows);
    this.options.notify(cols, rows);
    return "applied";
  }

  cancel(): void {
    this.throttle.cancel();
  }
}

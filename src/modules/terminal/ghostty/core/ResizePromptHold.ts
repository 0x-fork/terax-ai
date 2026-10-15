import type { GhosttyTerminalEvent } from "@terax/ghostty-core/protocol";

/**
 * How long a pane keeps showing its previous frame after a resize cleared the prompt, waiting
 * for the shell's redraw. A shell answers SIGWINCH in a few milliseconds; a slow prompt (git
 * status in the prompt) can take longer, and then the blank prompt is shown rather than a
 * stale frame for longer than this.
 */
export const RESIZE_PROMPT_HOLD_MS = 70;

/**
 * Ghostty clears a redrawable prompt (OSC 133 `A` with `redraw` left on, which zsh, fish and
 * bash do) whenever the grid changes and relies on the shell to print it again on SIGWINCH.
 * Between the model resize and the redraw bytes the model really does show no prompt, so a
 * frame presented in that window flashes it blank. While a drag resizes the grid every 100 ms
 * that was a flash per interval.
 *
 * This holds presentation (the surface keeps drawing its previous frame, see
 * `deferPresentation`) from a resize that happens at a prompt until the shell's redraw ends
 * (`prompt-end`), the user's input or a command starts, or `deadlineMs` passes. Parsing is
 * never delayed. It only engages at a shell prompt (tracked from the OSC 133 events) outside
 * the alternate screen, so applications that redraw on their own are untouched.
 */
export class ResizePromptHold {
  private atPrompt = false;
  private holding = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly release: () => void,
    private readonly deadlineMs = RESIZE_PROMPT_HOLD_MS,
  ) {}

  get suppressed(): boolean {
    return this.holding;
  }

  /** The cursor is at a shell prompt that Ghostty clears on resize. */
  get promptVisible(): boolean {
    return this.atPrompt;
  }

  /** The model's grid just changed size. */
  resized(alternateScreen: boolean): void {
    if (this.holding || !this.atPrompt || alternateScreen) return;
    this.holding = true;
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      this.finish();
    }, this.deadlineMs);
  }

  observe(event: GhosttyTerminalEvent): void {
    switch (event.type) {
      case "prompt-start":
        // The redraw begins (or a new prompt): the prompt is not complete until its end.
        this.atPrompt = false;
        return;
      case "prompt-end":
        this.atPrompt = true;
        this.finish();
        return;
      case "end-of-input":
      case "end-of-command":
      case "screen-cleared":
        this.atPrompt = false;
        this.finish();
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.holding = false;
    this.atPrompt = false;
  }

  private finish(): void {
    this.clearTimer();
    if (!this.holding) return;
    this.holding = false;
    this.release();
  }

  private clearTimer(): void {
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
  }
}

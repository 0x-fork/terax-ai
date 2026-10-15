import { readFile } from "node:fs/promises";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RESIZE_PROMPT_HOLD_MS } from "./core/ResizePromptHold";
import { TERMINAL_RESIZE_INTERVAL_MS } from "@/modules/terminal/lib/resizeThrottle";
import { TerminalResizeSync } from "@/modules/terminal/lib/terminalResizeSync";
import { AdaptedGhosttyTerminalModel } from "./AdaptedGhosttyTerminalModel";

const encoder = new TextEncoder();
const PROMPT = "user@host ~ % ";
// What zsh with Terax's OSC 133 integration prints for a prompt: A starts it, B ends it.
const PROMPT_BYTES = `\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`;
// What it prints again on SIGWINCH (redraw defaults to on, so Ghostty cleared the old one).
const REDRAW_BYTES = `\r\x1b[0J${PROMPT_BYTES}`;

let core: TeraxGhostty;

beforeAll(async () => {
  const file = await readFile(
    new URL(
      "../../../../packages/ghostty-core/adapted/ghostty-vt.wasm",
      import.meta.url,
    ),
  );
  core = await TeraxGhostty.loadBytes(Uint8Array.from(file).buffer);
});

afterEach(() => vi.useRealTimers());

function terminalAtPrompt(cols = 60, rows = 10) {
  const model = new AdaptedGhosttyTerminalModel(core, {
    backend: "ghostty-webgpu",
    cols,
    rows,
  });
  const write = (text: string) => model.write(encoder.encode(text));
  write("build output line 1\r\nbuild output line 2\r\n");
  write(PROMPT_BYTES);
  return { model, write, screen: () => model.readText(rows) };
}

describe("prompt visibility while resizing (real Ghostty core)", () => {
  it("Ghostty clears a redrawable prompt when the model resizes", () => {
    const { model, screen } = terminalAtPrompt();
    try {
      expect(screen()).toContain(PROMPT.trim());

      model.resize(50, 10);

      expect(screen()).toContain("build output line 2");
      expect(screen()).not.toContain(PROMPT.trim());
    } finally {
      model.dispose();
    }
  });

  it("model resize, then PTY resize, then the shell's redraw restores the prompt", () => {
    const { model, write, screen } = terminalAtPrompt();
    try {
      const pty: Array<[number, number]> = [];
      const sync = new TerminalResizeSync({
        model,
        // The PTY is told in the same call; the shell answers SIGWINCH with its redraw.
        notify: (cols, rows) => {
          pty.push([cols, rows]);
          shellOutput.push(REDRAW_BYTES);
        },
        onDue: () => {},
      });
      const shellOutput: string[] = [];

      expect(sync.request(50, 10, false)).toBe("applied");
      expect(pty).toEqual([[50, 10]]);
      expect(screen()).not.toContain(PROMPT.trim());

      for (const bytes of shellOutput.splice(0)) write(bytes);

      expect(screen()).toContain(PROMPT.trim());
      expect(model.cols).toBe(50);
    } finally {
      model.dispose();
    }
  });

  it("keeps the prompt on screen between throttled resizes and restores it after each", () => {
    vi.useFakeTimers();
    const { model, write, screen } = terminalAtPrompt(80, 10);
    try {
      const shellOutput: string[] = [];
      const pty: Array<[number, number]> = [];
      const sync = new TerminalResizeSync({
        model,
        notify: (cols, rows) => {
          pty.push([cols, rows]);
          shellOutput.push(REDRAW_BYTES);
        },
        onDue: () => {},
        now: () => Date.now(),
      });
      const promptBlankMs: number[] = [];
      let blankSince: number | null = null;
      const observe = () => {
        const visible = screen().includes(PROMPT.trim());
        if (!visible && blankSince === null) blankSince = Date.now();
        if (visible && blankSince !== null) {
          promptBlankMs.push(Date.now() - blankSince);
          blankSince = null;
        }
      };

      // A one-second drag, a new width every 16 ms; the shell answers 5 ms after SIGWINCH.
      for (let elapsed = 0, cols = 80; elapsed < 1000; elapsed += 16, cols--) {
        const outcome = sync.request(cols, 10, true);
        observe();
        if (outcome === "applied") {
          vi.advanceTimersByTime(5);
          for (const bytes of shellOutput.splice(0)) write(bytes);
          observe();
          vi.advanceTimersByTime(11);
        } else {
          // Deferred: the model was not touched, so the prompt cannot have changed.
          expect(screen()).toContain(PROMPT.trim());
          vi.advanceTimersByTime(16);
        }
      }

      expect(pty.length).toBeGreaterThanOrEqual(9);
      expect(pty.length).toBeLessThanOrEqual(11);
      // Every PTY size is a size the model has (or had) at the same moment.
      expect(pty[pty.length - 1]).toEqual([model.cols, model.rows]);
      // The prompt is blank only for the shell's answer time, never for a whole interval.
      expect(promptBlankMs.length).toBe(pty.length);
      for (const blank of promptBlankMs) {
        expect(blank).toBeLessThan(TERMINAL_RESIZE_INTERVAL_MS / 10);
      }
      expect(screen()).toContain(PROMPT.trim());
    } finally {
      model.dispose();
    }
  });

  it("is the old behaviour when the PTY only hears about the drag at the end", () => {
    const { model, screen } = terminalAtPrompt(80, 10);
    try {
      // Model resizes on every step, no SIGWINCH until release: the prompt stays blank.
      for (let cols = 79; cols > 60; cols--) model.resize(cols, 10);
      expect(screen()).not.toContain(PROMPT.trim());
    } finally {
      model.dispose();
    }
  });
});

describe("holding presentation while the shell redraws the prompt (real Ghostty core)", () => {
  /**
   * What a renderer frame would show: nothing while presentation is held (it keeps the frame it
   * drew before), otherwise the model's screen right now.
   */
  function presented(
    model: AdaptedGhosttyTerminalModel,
    rows: number,
    last: string,
  ): string {
    return model.presentationSuppressed() ? last : model.readText(rows);
  }

  it("holds the previous frame from the model resize until the redraw arrives", () => {
    const { model, write, screen } = terminalAtPrompt();
    try {
      expect(model.presentationSuppressed()).toBe(false);
      const damage = vi.fn();
      model.subscribeDamage(damage);

      model.resize(50, 10);
      // Ghostty cleared the prompt, but nothing may present that state.
      expect(screen()).not.toContain(PROMPT.trim());
      expect(model.presentationSuppressed()).toBe(true);
      expect(model.deferPresentation()).toBe(true);
      expect(damage).not.toHaveBeenCalled();

      write(REDRAW_BYTES);
      expect(screen()).toContain(PROMPT.trim());
      expect(model.presentationSuppressed()).toBe(false);
      // The renderer is told to draw the restored prompt, once.
      expect(damage).toHaveBeenCalledTimes(1);
      expect(model.deferPresentation()).toBe(false);
    } finally {
      model.dispose();
    }
  });

  it("presents after the deadline when the shell does not answer", () => {
    vi.useFakeTimers();
    const { model, screen } = terminalAtPrompt();
    try {
      const damage = vi.fn();
      model.subscribeDamage(damage);
      model.resize(50, 10);
      vi.advanceTimersByTime(RESIZE_PROMPT_HOLD_MS - 1);
      expect(model.presentationSuppressed()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(model.presentationSuppressed()).toBe(false);
      expect(damage).toHaveBeenCalledTimes(1);
      expect(screen()).not.toContain(PROMPT.trim());
    } finally {
      model.dispose();
    }
  });

  it("never presents a blank prompt during a one second drag that the shell answers", () => {
    vi.useFakeTimers();
    const rows = 10;
    const { model, write, screen } = terminalAtPrompt(80, rows);
    try {
      const shellOutput: string[] = [];
      const sync = new TerminalResizeSync({
        model,
        notify: () => shellOutput.push(REDRAW_BYTES),
        onDue: () => {},
        now: () => Date.now(),
      });
      let shown = screen();
      let blankFrames = 0;
      let heldFrames = 0;
      const frame = () => {
        if (model.presentationSuppressed()) heldFrames += 1;
        shown = presented(model, rows, shown);
        if (!shown.includes(PROMPT.trim())) blankFrames += 1;
      };
      for (let elapsed = 0, cols = 80; elapsed < 1000; elapsed += 4, cols--) {
        const outcome = sync.request(Math.max(20, cols), rows, true);
        frame();
        if (outcome === "applied") {
          // The shell answers 8 ms after SIGWINCH; frames keep coming every 4 ms meanwhile.
          vi.advanceTimersByTime(4);
          frame();
          vi.advanceTimersByTime(4);
          for (const bytes of shellOutput.splice(0)) write(bytes);
          frame();
          elapsed += 4;
        } else {
          vi.advanceTimersByTime(4);
          frame();
        }
      }
      expect(blankFrames).toBe(0);
      // The hold was actually exercised.
      expect(heldFrames).toBeGreaterThanOrEqual(5);
      expect(screen()).toContain(PROMPT.trim());
    } finally {
      model.dispose();
    }
  });

  it("does not hold while a command is running or in the alternate screen", () => {
    const { model, write } = terminalAtPrompt();
    try {
      // The user ran a command: OSC 133 C.
      write("\x1b]133;C\x07running...\r\n");
      model.resize(50, 10);
      expect(model.presentationSuppressed()).toBe(false);
      // Finish it and come back to a prompt, then enter the alternate screen.
      write(`\x1b]133;D;0\x07${PROMPT_BYTES}`);
      write("\x1b[?1049h");
      model.resize(40, 10);
      expect(model.presentationSuppressed()).toBe(false);
    } finally {
      model.dispose();
    }
  });

  it("does not hold when the size did not change", () => {
    const { model } = terminalAtPrompt(60, 10);
    try {
      model.resize(60, 10);
      expect(model.presentationSuppressed()).toBe(false);
    } finally {
      model.dispose();
    }
  });
});

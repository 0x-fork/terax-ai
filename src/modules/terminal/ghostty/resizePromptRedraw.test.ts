import { readFile } from "node:fs/promises";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

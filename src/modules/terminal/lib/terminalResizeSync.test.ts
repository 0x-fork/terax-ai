import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_RESIZE_INTERVAL_MS } from "./resizeThrottle";
import { TerminalResizeSync } from "./terminalResizeSync";

afterEach(() => vi.useRealTimers());

function harness() {
  vi.useFakeTimers();
  const log: string[] = [];
  const model = {
    cols: 80,
    rows: 24,
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      log.push(`model ${cols}x${rows}`);
    },
  };
  const pty: { cols: number; rows: number }[] = [];
  const onDue = vi.fn();
  const sync = new TerminalResizeSync({
    model,
    notify: (cols, rows) => {
      pty.push({ cols, rows });
      log.push(`pty ${cols}x${rows}`);
    },
    onDue,
    now: () => Date.now(),
  });
  return { sync, model, pty, log, onDue };
}

describe("TerminalResizeSync", () => {
  it("resizes the model and tells the PTY in one call, model first", () => {
    const { sync, log } = harness();
    expect(sync.request(100, 30, false)).toBe("applied");
    expect(log).toEqual(["model 100x30", "pty 100x30"]);
  });

  it("does nothing for dimensions the grid already has", () => {
    const { sync, log } = harness();
    expect(sync.request(80, 24, true)).toBe("unchanged");
    expect(log).toEqual([]);
  });

  it("holds both the model and the PTY while a drag keeps producing sizes", () => {
    const { sync, model, pty, log, onDue } = harness();
    expect(sync.request(90, 24, true)).toBe("applied");

    for (let step = 1; step <= 5; step++) {
      vi.advanceTimersByTime(16);
      expect(sync.request(90 + step, 24, true)).toBe("deferred");
      // Model and PTY always agree, and neither moves ahead of the other.
      expect(model.cols).toBe(90);
      expect(pty[pty.length - 1]).toEqual({ cols: 90, rows: 24 });
    }
    expect(log).toHaveLength(2);

    vi.advanceTimersByTime(TERMINAL_RESIZE_INTERVAL_MS - 80);
    expect(onDue).toHaveBeenCalledOnce();
    expect(sync.request(95, 24, true)).toBe("applied");
    expect(model.cols).toBe(95);
    expect(pty[pty.length - 1]).toEqual({ cols: 95, rows: 24 });
  });

  it("applies unthrottled requests at once even inside the interval", () => {
    const { sync, pty } = harness();
    sync.request(90, 24, true);
    vi.advanceTimersByTime(10);
    expect(sync.request(120, 40, false)).toBe("applied");
    expect(pty[pty.length - 1]).toEqual({ cols: 120, rows: 40 });
  });

  it("forgets a held size once the host returns to the current grid", () => {
    const { sync, onDue } = harness();
    sync.request(90, 24, true);
    vi.advanceTimersByTime(10);
    expect(sync.request(100, 24, true)).toBe("deferred");
    expect(sync.waiting).toBe(true);

    expect(sync.request(90, 24, true)).toBe("unchanged");
    expect(sync.waiting).toBe(false);
    vi.runAllTimers();
    expect(onDue).not.toHaveBeenCalled();
  });
});

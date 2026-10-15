import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeThrottle, TERMINAL_RESIZE_INTERVAL_MS } from "./resizeThrottle";

afterEach(() => vi.useRealTimers());

function harness() {
  vi.useFakeTimers();
  const onDue = vi.fn();
  const throttle = new ResizeThrottle(onDue, TERMINAL_RESIZE_INTERVAL_MS, () =>
    Date.now(),
  );
  return { throttle, onDue };
}

describe("ResizeThrottle", () => {
  it("applies the first change at once", () => {
    const { throttle, onDue } = harness();
    expect(throttle.request()).toBe(true);
    expect(throttle.waiting).toBe(false);
    vi.runAllTimers();
    expect(onDue).not.toHaveBeenCalled();
  });

  it("holds changes inside the interval and wakes the owner when one may apply", () => {
    const { throttle, onDue } = harness();
    expect(throttle.request()).toBe(true);

    vi.advanceTimersByTime(30);
    expect(throttle.request()).toBe(false);
    vi.advanceTimersByTime(30);
    expect(throttle.request()).toBe(false);
    expect(throttle.waiting).toBe(true);

    vi.advanceTimersByTime(TERMINAL_RESIZE_INTERVAL_MS - 60 - 1);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledOnce();
    expect(throttle.waiting).toBe(false);
    expect(throttle.request()).toBe(true);
  });

  it("applies at most once per interval during a continuous drag, with leading and trailing edges", () => {
    const { throttle, onDue } = harness();
    const applied: number[] = [];
    const start = Date.now();
    const step = () => {
      if (throttle.request()) applied.push(Date.now() - start);
    };
    onDue.mockImplementation(step);

    // A pointer reporting a new size every 16 ms for one second.
    for (let elapsed = 0; elapsed < 1000; elapsed += 16) {
      step();
      vi.advanceTimersByTime(16);
    }
    // The drag stops; the held size still lands within one interval.
    vi.advanceTimersByTime(TERMINAL_RESIZE_INTERVAL_MS);

    expect(applied[0]).toBe(0);
    for (let index = 1; index < applied.length; index++) {
      expect(applied[index] - applied[index - 1]).toBeGreaterThanOrEqual(
        TERMINAL_RESIZE_INTERVAL_MS,
      );
      expect(applied[index] - applied[index - 1]).toBeLessThanOrEqual(
        TERMINAL_RESIZE_INTERVAL_MS + 16,
      );
    }
    expect(applied.length).toBeGreaterThanOrEqual(10);
    expect(applied.length).toBeLessThanOrEqual(11);
    expect(throttle.waiting).toBe(false);
  });

  it("lands the final size within one interval after the last movement", () => {
    const { throttle, onDue } = harness();
    throttle.request();
    vi.advanceTimersByTime(10);
    expect(throttle.request()).toBe(false);

    vi.advanceTimersByTime(TERMINAL_RESIZE_INTERVAL_MS - 10);
    expect(onDue).toHaveBeenCalledOnce();
    expect(throttle.request()).toBe(true);
  });

  it("goes back to applying at once after a quiet interval", () => {
    const { throttle } = harness();
    throttle.request();
    vi.advanceTimersByTime(TERMINAL_RESIZE_INTERVAL_MS * 3);
    expect(throttle.request()).toBe(true);
  });

  it("treats an immediate application as the latest one and drops a held change", () => {
    const { throttle, onDue } = harness();
    throttle.request();
    vi.advanceTimersByTime(20);
    expect(throttle.request()).toBe(false);

    throttle.applied();
    expect(throttle.waiting).toBe(false);
    vi.runAllTimers();
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(throttle.request()).toBe(false);
  });

  it("cancel forgets a held change", () => {
    const { throttle, onDue } = harness();
    throttle.request();
    expect(throttle.request()).toBe(false);
    throttle.cancel();
    vi.runAllTimers();
    expect(onDue).not.toHaveBeenCalled();
  });
});

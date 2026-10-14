import { describe, expect, it, vi } from "vitest";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import {
  type ScrollbarClock,
  TerminalScrollbarSync,
} from "@/modules/terminal/ghostty/gpu/terminalScrollbar";

class FakeClock implements ScrollbarClock {
  time = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delay: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.time + delay, run: callback });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
    }
    this.time = end;
  }
}

function harness() {
  const reads = vi.fn();
  const writes = vi.fn();
  const attributeReads = vi.fn();
  const attributeWrites = vi.fn();
  let scrollTop = 0;
  const attributes = new Map<string, string>();
  const scrollbar = {
    style: { visibility: "" },
    get scrollTop() {
      reads();
      return scrollTop;
    },
    set scrollTop(value: number) {
      writes(value);
      scrollTop = value;
    },
    getAttribute: (name: string) => {
      attributeReads(name);
      return attributes.get(name);
    },
    setAttribute: (name: string, value: string) => {
      attributeWrites(name, value);
      attributes.set(name, value);
    },
  };
  const heightWrites = vi.fn();
  const content = {
    style: {
      get height() {
        throw new Error("content height must not be read");
      },
      set height(value: string) {
        heightWrites(value);
      },
    },
  };
  const scroll = { history: 10, offset: 7 };
  const alternate = { value: false };
  const model = {
    scrollPosition: () => scroll,
    modes: () => ({ alternateScreen: alternate.value }),
  } as unknown as GhosttyTerminalModelApi;
  const clock = new FakeClock();
  const sync = new TerminalScrollbarSync(clock);
  return {
    sync,
    clock,
    scroll,
    alternate,
    reads,
    writes,
    attributeReads,
    attributeWrites,
    heightWrites,
    attributes,
    scrollbar,
    run: (viewport = 100, cell = 20) =>
      sync.sync(
        viewport,
        scrollbar as unknown as HTMLElement,
        content as unknown as HTMLElement,
        model,
        cell,
      ),
  };
}

describe("TerminalScrollbarSync", () => {
  it("never reads the DOM while syncing, including while history grows", () => {
    const h = harness();
    h.scroll.offset = 0;
    h.run();
    for (let frame = 0; frame < 500; frame += 1) {
      h.scroll.history += 1;
      h.clock.advance(16);
      h.run();
    }
    expect(h.reads).not.toHaveBeenCalled();
    expect(h.attributeReads).not.toHaveBeenCalled();
  });

  it("writes the target scroll position once for unchanged state", () => {
    const h = harness();
    expect(h.run()).toBe(60);
    expect(h.writes).toHaveBeenCalledExactlyOnceWith(60);
    expect(h.heightWrites).toHaveBeenCalledExactlyOnceWith("300px");
    h.writes.mockClear();
    h.heightWrites.mockClear();
    for (let frame = 0; frame < 100; frame += 1) expect(h.run()).toBe(60);
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.heightWrites).not.toHaveBeenCalled();
    expect(h.sync.writtenScrollTop).toBe(60);
  });

  it("preserves a fractional position the user produced", () => {
    const h = harness();
    h.run();
    h.sync.invalidate();
    h.sync.observe(60.4);
    h.writes.mockClear();
    expect(h.run()).toBe(60.4);
    expect(h.writes).not.toHaveBeenCalled();
    h.scroll.offset = 6;
    expect(h.run()).toBe(80);
    expect(h.writes).toHaveBeenCalledExactlyOnceWith(80);
  });

  it("keeps the DOM position on invalidation but rewrites it after the element is re-attached", () => {
    const h = harness();
    h.run();
    h.writes.mockClear();
    h.sync.invalidate();
    h.run();
    expect(h.writes).not.toHaveBeenCalled();
    h.sync.forget();
    h.run();
    expect(h.writes).toHaveBeenCalledExactlyOnceWith(60);
    h.run(120);
    expect(h.heightWrites).toHaveBeenLastCalledWith("320px");
  });

  it("throttles bottom-pinned growth to ten position writes a second and flushes the last value", () => {
    const h = harness();
    h.scroll.offset = 0;
    h.run();
    h.writes.mockClear();
    for (let frame = 0; frame < 60; frame += 1) {
      h.scroll.history += 1;
      h.clock.advance(16);
      h.run();
    }
    // 60 frames over ~960 ms.
    expect(h.writes.mock.calls.length).toBeLessThanOrEqual(11);
    expect(h.writes.mock.calls.length).toBeGreaterThanOrEqual(8);
    h.clock.advance(200);
    expect(h.sync.writtenScrollTop).toBe(h.scroll.history * 20);
    expect(h.writes).toHaveBeenLastCalledWith(h.scroll.history * 20);
  });

  it("applies jumps and user scrolling immediately", () => {
    const h = harness();
    h.scroll.offset = 0;
    h.run();
    h.scroll.history += 1;
    h.run();
    h.writes.mockClear();
    h.scroll.offset = 5;
    h.run();
    expect(h.writes).toHaveBeenCalledOnce();
  });

  it("hides the scrollbar on the alternate screen and when there is no history", () => {
    const h = harness();
    h.run();
    expect(h.scrollbar.style.visibility).toBe("visible");
    h.alternate.value = true;
    expect(h.run()).toBeNull();
    expect(h.scrollbar.style.visibility).toBe("hidden");
    h.alternate.value = false;
    h.scroll.history = 0;
    h.scroll.offset = 0;
    expect(h.run()).toBeNull();
    expect(h.scrollbar.style.visibility).toBe("hidden");
  });

  it("updates accessibility values at most four times a second", () => {
    const h = harness();
    h.scroll.offset = 0;
    h.run();
    expect(h.attributes.get("aria-valuemax")).toBe("10");
    h.attributeWrites.mockClear();
    for (let frame = 0; frame < 120; frame += 1) {
      h.scroll.history += 1;
      h.clock.advance(16);
      h.run();
    }
    // About 1.9 s of growth.
    expect(h.attributeWrites.mock.calls.length).toBeLessThanOrEqual(2 * 8);
    h.clock.advance(300);
    expect(h.attributes.get("aria-valuemax")).toBe(String(h.scroll.history));
    expect(h.attributes.get("aria-valuenow")).toBe(String(h.scroll.history));
    expect(h.attributes.get("aria-valuemin")).toBe("0");
  });

  it("leaves no timer behind after dispose", () => {
    const h = harness();
    h.scroll.offset = 0;
    h.run();
    h.scroll.history += 1;
    h.run();
    expect(h.clock.pending).toBeGreaterThan(0);
    h.sync.dispose();
    expect(h.clock.pending).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GESTURE_GAP_MS,
  noteTerminalHostResize,
  resetTerminalResizeGestureForTest,
  setNativeLiveResize,
} from "./terminalResizeGesture";
import {
  beginTerminalResizeInteraction,
  endTerminalResizeInteraction,
  subscribeTerminalResizeInteraction,
  terminalResizeInteractionActive,
} from "./terminalResizeInteraction";

beforeEach(() => {
  vi.useFakeTimers();
  resetTerminalResizeGestureForTest(() => Date.now());
});

afterEach(() => {
  resetTerminalResizeGestureForTest();
  vi.useRealTimers();
});

describe("terminalResizeGesture", () => {
  it("does not treat one layout change as a gesture", () => {
    const surface = {};
    noteTerminalHostResize(surface);
    expect(terminalResizeInteractionActive()).toBe(false);
    vi.advanceTimersByTime(GESTURE_GAP_MS * 4);
    noteTerminalHostResize(surface);
    expect(terminalResizeInteractionActive()).toBe(false);
  });

  it("does not treat several surfaces laying out once each as a gesture", () => {
    for (let index = 0; index < 8; index++) noteTerminalHostResize({});
    expect(terminalResizeInteractionActive()).toBe(false);
  });

  it("leaves the end of a pointer drag to the pointer: no quiet gap is added after release", () => {
    const token = {};
    const surface = {};
    beginTerminalResizeInteraction(token);
    for (let step = 0; step < 20; step++) {
      noteTerminalHostResize(surface);
      vi.advanceTimersByTime(16);
    }
    endTerminalResizeInteraction(token);
    expect(terminalResizeInteractionActive()).toBe(false);
  });

  it("does not mistake the layout that lands right after a release for a new gesture", () => {
    const token = {};
    const surface = {};
    beginTerminalResizeInteraction(token);
    noteTerminalHostResize(surface);
    vi.advanceTimersByTime(16);
    endTerminalResizeInteraction(token);
    // The frame after the release delivers the last size change of the same drag.
    vi.advanceTimersByTime(16);
    noteTerminalHostResize(surface);
    vi.advanceTimersByTime(16);
    noteTerminalHostResize(surface);
    expect(terminalResizeInteractionActive()).toBe(false);
    // Later on, a real burst is still recognised.
    vi.advanceTimersByTime(GESTURE_GAP_MS * 2);
    noteTerminalHostResize(surface);
    vi.advanceTimersByTime(16);
    noteTerminalHostResize(surface);
    expect(terminalResizeInteractionActive()).toBe(true);
  });

  it("starts on the second quick change of one surface and ends after a quiet gap", () => {
    const listener = vi.fn();
    const stop = subscribeTerminalResizeInteraction(listener);
    const surface = {};

    noteTerminalHostResize(surface);
    vi.advanceTimersByTime(16);
    noteTerminalHostResize(surface);
    expect(listener).toHaveBeenLastCalledWith(true);

    for (let step = 0; step < 40; step++) {
      vi.advanceTimersByTime(16);
      noteTerminalHostResize(surface);
    }
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(GESTURE_GAP_MS - 1);
    expect(terminalResizeInteractionActive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(terminalResizeInteractionActive()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    stop();
  });

  it("follows the native live-resize signal exactly", () => {
    const listener = vi.fn();
    const stop = subscribeTerminalResizeInteraction(listener);

    setNativeLiveResize(true);
    setNativeLiveResize(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // The gesture outlasts any quiet gap while the native signal says it is going.
    vi.advanceTimersByTime(GESTURE_GAP_MS * 10);
    expect(terminalResizeInteractionActive()).toBe(true);

    setNativeLiveResize(false);
    expect(terminalResizeInteractionActive()).toBe(false);
    stop();
  });

  it("keeps a native gesture alive past the interaction watchdog while the host keeps changing", () => {
    const surface = {};
    setNativeLiveResize(true);
    for (let second = 0; second < 40; second++) {
      vi.advanceTimersByTime(1000);
      noteTerminalHostResize(surface);
    }
    expect(terminalResizeInteractionActive()).toBe(true);
    setNativeLiveResize(false);
    expect(terminalResizeInteractionActive()).toBe(false);
  });
});

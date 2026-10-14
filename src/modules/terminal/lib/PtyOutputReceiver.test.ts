import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyOutputReceiver } from "@/modules/terminal/lib/PtyOutputReceiver";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function schedule(callback: () => void): () => void {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

describe("PTY output delivery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("yields bulk parsing without granting partial-chunk credit or blocking another terminal", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const input = Uint8Array.from(
      { length: 128 * 1024 },
      (_, index) => index % 251,
    );
    const parsed: Uint8Array[] = [];
    const ack = vi.fn().mockResolvedValue(undefined);
    const receiver = new PtyOutputReceiver(
      (bytes) => {
        parsed.push(bytes);
        now += 3;
      },
      ack,
      vi.fn(),
      schedule,
    );
    receiver.start();
    receiver.receive(input);
    expect(parsed).toHaveLength(2);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    const otherParse = vi.fn();
    const other = new PtyOutputReceiver(
      otherParse,
      vi.fn().mockResolvedValue(undefined),
      vi.fn(),
    );
    other.start();
    other.receive(Uint8Array.of(9));
    expect(otherParse).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(parsed.every((bytes) => bytes.length <= 32 * 1024)).toBe(true);
    expect(Buffer.concat(parsed)).toEqual(Buffer.from(input));
    expect(ack.mock.calls).toEqual([[input.length]]);
    expect(receiver.diagnostics().parseYields).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    receiver.dispose();
    other.dispose();
  });

  it("cancels a yielded parser on close without acknowledging its unfinished chunk", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const parse = vi.fn(() => {
      now += 5;
    });
    const ack = vi.fn();
    const receiver = new PtyOutputReceiver(parse, ack, vi.fn(), schedule);
    receiver.start();
    receiver.receive(new Uint8Array(128 * 1024));
    receiver.dispose();
    await vi.runAllTimersAsync();
    expect(parse).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports scheduler failure without granting credit for unfinished output", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn();
    const status = vi.fn();
    const receiver = new PtyOutputReceiver(
      () => {
        now += 5;
      },
      ack,
      status,
      () => {
        throw new Error("Task scheduling unavailable");
      },
    );
    receiver.start();
    receiver.receive(new Uint8Array(128 * 1024));
    await vi.runAllTimersAsync();
    expect(status).toHaveBeenLastCalledWith("failed");
    expect(ack).not.toHaveBeenCalled();
    receiver.dispose();
  });

  it("coalesces synchronous parsing into cumulative credit without an idle timer", async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const receiver = new PtyOutputReceiver(vi.fn(), ack, vi.fn());
    receiver.start();
    receiver.receive(Uint8Array.of(1, 2));
    receiver.receive(Uint8Array.of(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(ack.mock.calls).toEqual([[3]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(receiver.diagnostics().confirmedBytes).toBe(3);
  });

  it("retries lost acknowledgements with retained cumulative credit", async () => {
    const ack = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection failed"))
      .mockResolvedValue(undefined);
    const status = vi.fn();
    const receiver = new PtyOutputReceiver(vi.fn(), ack, status);
    receiver.start();
    receiver.receive(Uint8Array.of(1, 2));
    await vi.advanceTimersByTimeAsync(0);
    receiver.receive(Uint8Array.of(3));
    await vi.advanceTimersByTimeAsync(50);
    expect(ack.mock.calls).toEqual([[2], [3]]);
    expect(status.mock.calls).toEqual([["retrying"], ["running"]]);
    expect(receiver.diagnostics().confirmedBytes).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes asynchronous parsing and never acknowledges an unparsed prefix", async () => {
    const first = deferred();
    const second = deferred();
    const parse = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ack = vi.fn().mockResolvedValue(undefined);
    const receiver = new PtyOutputReceiver(parse, ack, vi.fn());
    receiver.start();
    receiver.receive(Uint8Array.of(1));
    receiver.receive(Uint8Array.of(2, 3));
    expect(parse).toHaveBeenCalledTimes(1);
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(ack).not.toHaveBeenCalled();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(receiver.diagnostics().confirmedBytes).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds hung IPC calls, reports the stall, and recovers from late replies", async () => {
    const first = deferred();
    const second = deferred();
    const ack = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined);
    const status = vi.fn();
    const receiver = new PtyOutputReceiver(vi.fn(), ack, status);
    receiver.start();
    receiver.receive(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(0);
    receiver.receive(Uint8Array.of(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ack.mock.calls).toEqual([[1], [2]]);
    expect(status).toHaveBeenLastCalledWith("stalled");
    expect(receiver.diagnostics().ackRequests).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    first.reject(new Error("late stale failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(receiver.diagnostics().confirmedBytes).toBe(2);
    expect(status).toHaveBeenLastCalledWith("running");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes persistent rejection observable while keeping retries bounded", async () => {
    const ack = vi.fn().mockRejectedValue(new Error("offline"));
    const status = vi.fn();
    const receiver = new PtyOutputReceiver(vi.fn(), ack, status);
    receiver.start();
    receiver.receive(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ack.mock.calls.length).toBeLessThan(30);
    expect(status).toHaveBeenLastCalledWith("stalled");
    expect(receiver.diagnostics().processedBytes).toBe(1);
    expect(receiver.diagnostics().confirmedBytes).toBe(0);
    ack.mockResolvedValue(undefined);
    receiver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith("running");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "does not return credit after parser failure (async=%s)",
    async (async) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const ack = vi.fn();
      const status = vi.fn();
      const receiver = new PtyOutputReceiver(
        () => {
          const error = new Error("parser failed");
          if (async) return Promise.reject(error);
          throw error;
        },
        ack,
        status,
      );
      receiver.start();
      receiver.receive(Uint8Array.of(1));
      receiver.receive(Uint8Array.of(2));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ack).not.toHaveBeenCalled();
      expect(status).toHaveBeenLastCalledWith("failed");
      expect(vi.getTimerCount()).toBe(0);
      receiver.dispose();
      log.mockRestore();
    },
  );

  it("cleans up pending parsing and retries on close", async () => {
    const parsed = deferred();
    const ack = vi.fn();
    const status = vi.fn();
    const receiver = new PtyOutputReceiver(() => parsed.promise, ack, status);
    receiver.start();
    receiver.receive(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(status).toHaveBeenLastCalledWith("stalled");
    receiver.dispose();
    parsed.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(receiver.diagnostics().pendingChunks).toBe(0);
  });
});

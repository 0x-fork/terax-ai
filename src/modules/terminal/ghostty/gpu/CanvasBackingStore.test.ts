import { describe, expect, it } from "vitest";
import { CanvasBackingStore } from "./CanvasBackingStore";

function fakeCanvas(width: number, height: number) {
  return { width, height, style: { width: "", height: "" } };
}

describe("CanvasBackingStore", () => {
  it("releases hidden canvas storage while retaining the exact next presentation size", () => {
    const canvas = fakeCanvas(300, 150);
    const backing = new CanvasBackingStore(canvas);
    backing.stage(3840, 2160, 2);
    backing.commit();
    backing.release();
    expect(canvas).toMatchObject({
      width: 1,
      height: 1,
      style: { width: "1920px", height: "1080px" },
    });
    expect(backing.pending).toBe(true);
    backing.stage(2560, 1440, 2);
    backing.commit();
    expect(canvas).toMatchObject({ width: 2560, height: 1440 });
    expect(backing.pending).toBe(false);
  });

  it("keeps presented pixels intact until the render transaction commits", () => {
    const canvas = fakeCanvas(300, 150);
    const backing = new CanvasBackingStore(canvas);

    expect(backing.stage(900, 540, 2)).toBe(true);

    expect(canvas).toMatchObject({
      width: 300,
      height: 150,
      style: { width: "", height: "" },
    });
    expect(backing.pending).toBe(true);

    expect(backing.commit()).toBe(true);
    expect(canvas).toMatchObject({
      width: 900,
      height: 540,
      style: { width: "450px", height: "270px" },
    });
    expect(backing.pending).toBe(false);
  });

  it("coalesces resize steps before touching the intrinsic canvas", () => {
    const canvas = fakeCanvas(300, 150);
    const backing = new CanvasBackingStore(canvas);

    backing.stage(600, 300, 2);
    backing.stage(800, 400, 2);
    backing.stage(700, 350, 2);

    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    backing.commit();
    expect(canvas.width).toBe(700);
    expect(canvas.height).toBe(350);
  });

  it("does not clear an already correctly sized backing store", () => {
    let intrinsicWrites = 0;
    let width = 640;
    let height = 480;
    const canvas = {
      get width() {
        return width;
      },
      set width(value: number) {
        intrinsicWrites += 1;
        width = value;
      },
      get height() {
        return height;
      },
      set height(value: number) {
        intrinsicWrites += 1;
        height = value;
      },
      style: { width: "640px", height: "480px" },
    };
    const backing = new CanvasBackingStore(canvas);
    expect(backing.stage(640, 480, 1)).toBe(false);
    expect(backing.commit()).toBe(false);
    expect(intrinsicWrites).toBe(0);
  });

  it("always styles the canvas at exactly backing size over the ratio", () => {
    for (const scale of [1, 1.25, 1.5, 1.75, 2, 2.25, 3]) {
      const canvas = fakeCanvas(300, 150);
      const backing = new CanvasBackingStore(canvas);
      // First presentation: exact, no surplus.
      backing.stage(1111, 777, scale);
      backing.commit();
      expect(canvas.width).toBe(1111);
      expect(Number.parseFloat(canvas.style.width) * scale).toBeCloseTo(
        canvas.width,
        6,
      );
      // After presenting, nearby sizes reuse the surplus but stay 1:1.
      backing.stage(1100, 770, scale);
      backing.commit();
      expect(Number.parseFloat(canvas.style.width) * scale).toBeCloseTo(
        canvas.width,
        6,
      );
      expect(Number.parseFloat(canvas.style.height) * scale).toBeCloseTo(
        canvas.height,
        6,
      );
    }
  });

  it("reallocates the swapchain only every few device pixels during a drag resize", () => {
    const canvas = fakeCanvas(300, 150);
    const backing = new CanvasBackingStore(canvas);
    backing.stage(1000, 600, 1.5);
    backing.commit();
    let allocations = 0;
    let previousWidth = canvas.width;
    for (let width = 1000; width <= 1400; width += 3) {
      backing.stage(width, 600, 1.5);
      backing.commit();
      if (canvas.width !== previousWidth) allocations += 1;
      previousWidth = canvas.width;
      expect(canvas.width).toBeGreaterThanOrEqual(width);
    }
    const steps = Math.floor(400 / 3) + 1;
    expect(allocations).toBeLessThan(steps / 10);
  });
});

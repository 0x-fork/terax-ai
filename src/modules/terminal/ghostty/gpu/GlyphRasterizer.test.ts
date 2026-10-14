import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLYPH_STYLE_BOLD,
  GLYPH_STYLE_ITALIC,
  GlyphRasterizer,
} from "./GlyphRasterizer";
import { deriveFontMetrics } from "./terminalVisuals";

const METRICS = deriveFontMetrics(
  {
    family: '"JetBrains Mono", monospace',
    size: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    weight: "400",
  },
  1.5,
  { advance: 12.6, ascent: 16, descent: 5 },
);

function stub(color = false) {
  const fonts: string[] = [];
  const clears: number[][] = [];
  let font = "";
  const texts: string[] = [];
  const context = {
    textAlign: "",
    textBaseline: "",
    fillStyle: "",
    get font() {
      return font;
    },
    set font(value: string) {
      fonts.push(value);
      font = value;
    },
    clearRect: (...args: number[]) => clears.push(args),
    fillText: (text: string) => texts.push(text),
    measureText: () => ({
      actualBoundingBoxLeft: 1,
      actualBoundingBoxRight: 9,
      actualBoundingBoxAscent: 12,
      actualBoundingBoxDescent: 4,
    }),
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < data.length; index += 4) {
        data[index] = color ? 30 : 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = (index / 4) % 256;
      }
      return { data };
    },
  };
  let created = 0;
  vi.stubGlobal("document", {
    createElement: () => {
      created += 1;
      return { width: 0, height: 0, getContext: () => context };
    },
  });
  return { fonts, clears, created: () => created, texts };
}

describe("GlyphRasterizer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures and positions glyphs in device pixels at the cell baseline", () => {
    stub();
    const glyph = new GlyphRasterizer(METRICS).rasterize("a", 0);
    expect(glyph.width).toBe(1 + 9 + 4);
    expect(glyph.height).toBe(12 + 4 + 4);
    expect(glyph.bearingX).toBe(-1 - 2);
    expect(glyph.bearingY).toBe(METRICS.deviceBaseline - 12 - 2);
    expect(glyph.intrinsicColor).toBe(false);
    expect(glyph.pixels).toHaveLength(glyph.width * glyph.height);
    expect(glyph.pixels[5]).toBe(5);
  });

  it("returns RGBA for intrinsic-colour glyphs", () => {
    stub(true);
    const glyph = new GlyphRasterizer(METRICS).rasterize("x", 0);
    expect(glyph.intrinsicColor).toBe(true);
    expect(glyph.pixels).toHaveLength(glyph.width * glyph.height * 4);
  });

  it("assigns context.font only when the style changes, at size times ratio", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    rasterizer.rasterize("a", 0);
    rasterizer.rasterize("b", 0);
    rasterizer.rasterize("c", 0);
    expect(s.fonts).toHaveLength(1);
    expect(s.fonts[0]).toContain("21px");
    rasterizer.rasterize("d", GLYPH_STYLE_BOLD);
    rasterizer.rasterize("e", GLYPH_STYLE_BOLD | GLYPH_STYLE_ITALIC);
    rasterizer.rasterize("f", 0);
    expect(s.fonts).toHaveLength(4);
    expect(s.fonts[1]).toMatch(/^700 /);
    expect(s.fonts[2]).toMatch(/^italic 700 /);
  });

  it("clears only the area the previous glyph touched", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    rasterizer.rasterize("a", 0);
    rasterizer.rasterize("b", 0);
    expect(s.clears[0]).toEqual([0, 0, 256, 256]);
    expect(s.clears[1][2]).toBeLessThan(40);
    expect(s.clears[1][3]).toBeLessThan(40);
  });

  it("allocates its canvas lazily and releases it on dispose", () => {
    const s = stub();
    const rasterizer = new GlyphRasterizer(METRICS);
    expect(s.created()).toBe(0);
    expect(rasterizer.cpuBytes).toBe(0);
    rasterizer.rasterize("a", 0);
    expect(s.created()).toBe(1);
    expect(rasterizer.cpuBytes).toBeGreaterThan(0);
    rasterizer.dispose();
    expect(rasterizer.cpuBytes).toBe(0);
    rasterizer.rasterize("a", 0);
    expect(s.created()).toBe(2);
  });
});

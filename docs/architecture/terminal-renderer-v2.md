# Terminal renderer v2: native cell stream, pixel-exact grid

Status: implemented on `perf/resource-efficiency` for WebGPU: the Zig and
TypeScript bridge, and the GPU side in `src/modules/terminal/ghostty/gpu/`. The
WebGL fallback keeps the structure-of-arrays path and gains integer device cells.
Platform coverage is macOS only; see "As built" for what was and was not checked.

## Why

The v1 WebGPU path copies every dirty cell three times per frame: Ghostty's
`RenderState` copies page cells into row data. The bridge then copies them into
eleven structure-of-arrays buffers. Finally, JavaScript reads about twelve
accessors per cell and writes a 64-byte instance that includes blank cells.

Agent TUIs (Ink, Claude Code, Codex) rewrite their whole dynamic region on every
spinner tick. Ghostty marks all those rows dirty even when their content is
identical. So the per-cell JavaScript work runs on every tick, and the
row-compare only suppresses the upload afterwards.

Cell geometry is computed in CSS pixels multiplied by the device pixel ratio.
At fractional ratios (Windows 125%/150%) glyph quads land on fractional device
pixels and are sampled with a linear filter. The canvas itself is also not
aligned to the device pixel grid, so the compositor resamples it. That is the
Windows text blur.

## Design

### Cell record (Zig → GPU, 16 bytes per cell)

```
word 0: glyph_id (bits 0..23) | attrs (bits 24..31)
word 1: foreground RGBA8 (faint is encoded in alpha; inverse already applied)
word 2: background RGBA8 (inverse already applied)
word 3: underline RGBA8
attrs: underline style (3 bits) | strikethrough | overline | blink | wide-lead | reserved
```

- `glyph_id == 0` means nothing is drawn: space, empty, invisible, spacer tail,
  or Kitty placeholder.
- The bridge writes records for dirty rows straight into one persistent,
  capacity-managed WASM buffer of `rows * cols` records.
- A row is reported dirty only if at least one of its words actually changed.
  Each word is compared before it is stored. Redundant TUI rewrites therefore
  cost one native compare and nothing in JavaScript.
- JavaScript uploads dirty row ranges with
  `queue.writeBuffer(gpuBuffer, offset, wasm.memory.buffer, ptr + offset, len)`.
  There is no per-cell JavaScript.
- Glyph ids are interned in Zig. The key is the codepoint, or the grapheme
  sequence, plus bold and italic, producing dense ids starting at 1.
- Each `render_update` appends newly interned ids to a "new glyphs" list
  (id, style bits, UTF-32 text), which JavaScript drains.
- The intern table is bounded. When it passes its cap, the bridge starts a new
  epoch: it clears the table, forces full damage, and reports the epoch change
  so JavaScript resets its id-to-atlas mappings.
- The bridge reports how many blinking cells are in the viewport, so the text
  blink timer is armed only when needed.
- The structure-of-arrays render format stays available behind a per-terminal
  format flag, used only by the WebGL fallback. In GPU mode, structure-of-arrays
  buffers are not written.
- Hyperlink ids keep their own per-cell array, written only for dirty rows,
  because hover lookups need them.

### GPU side

- **Storage buffers.**
  - `cells`: the 16-byte records.
  - `glyph_map`: one u32 per Zig glyph id, giving an atlas glyph index or a
    "pending" sentinel.
  - `glyph_table`: one entry per atlas glyph holding the atlas rect (u16x4),
    bearing offset (i16x2), size (u16x2) and flags (color/coverage).
  - `search_mask`: present only while a search or block search is active.
- **Uniforms.** Cell size in integer device pixels, cols/rows, cursor, blink
  state, selection range (viewport start line/col, end line/col, rectangular
  flag, color and alpha), decoration metrics, text contrast parameters.
- **Background and decoration pass.** A single fullscreen triangle. The
  fragment shader derives the cell from the pixel and applies, in order:
  background, then search mask, then selection blend, then cursor, then
  decorations.
- **Glyph pass.** One instanced draw over `cols * rows` instances. Instances
  with no glyph, or a pending glyph, emit degenerate triangles.
  - The quad sits at the cell origin plus the glyph bearing, all in integer
    device pixels.
  - The shader reads texels 1:1 with `textureLoad`, so no filtering is
    involved.
  - The v1 left-overhang clip against a different background reads the
    previous cell's record.

### Pixel-exact geometry

- Fonts are measured at `size * dpr`. The integer device cell size is
  `ceil(advance + letterSpacing)` by `ceil(lineHeight)` in device pixels.
- The CSS cell size is the device size divided by `dpr` (fractional is fine).
  Hit testing, fit, selection and IME positioning use the CSS cell size;
  rendering uses device pixels only.
- The backing store is exactly `cols * cellW` by `rows * cellH` device pixels,
  and the CSS size is backing divided by `dpr`.
- The canvas origin is snapped to the device pixel grid by translating by the
  negative fractional device offset of the host origin. The offset is
  recomputed on resize, DPR change and layout moves.
- `devicePixelContentBoxSize` is used where available; otherwise the size is
  derived from rounding.
- Text contrast correction applies only to grayscale antialiasing at low or
  fractional DPR (Windows, non-Retina Linux). It uses a DirectWrite-style
  enhanced-contrast curve whose strength depends on text luminance. macOS
  Retina output stays bit-identical to v1 unless measured otherwise.

### Glyph atlas

- The atlas is shared per (font, DPR). The coverage texture starts at 1024² and
  grows to 2048², then 4096² within device limits, before any eviction.
- Eviction is epoch-based LRU. When eviction happens, every mapping that
  referenced evicted glyphs is reset to pending, and visible glyphs
  re-rasterize.
- Rasterization is budgeted at about 2 ms per frame, across all surfaces.
  Glyphs beyond the budget stay pending and are drawn on the next frame, which
  avoids first-CJK/emoji stalls.
- The font string is cached; `context.font` is set only when the style
  changes.

### Unchanged invariants

- Persistent models, hidden-pane presentation release, damage-driven
  scheduling, synchronized-output deferral, and the at-most-two in-flight
  frames limit.
- A frame whose cells, uniforms and atlas are unchanged does not acquire a
  texture or draw.

## Bridge API as implemented

Zig: `packages/ghostty-core/adapted/wasm/src/terax.zig`. TypeScript:
`packages/ghostty-core/lib/adapted/` (`TeraxGhosttyTerminal`, `gpuCells.ts`) and
`GhosttyTerminalModelApi.consumeGpuFrame()`. The tests are
`AdaptedGhosttyGpu.test.ts` (bridge) and `AdaptedGhosttyGpuModel.test.ts` (model).

### Format selection

`restty_set_render_format(handle, 0 | 1)`: 0 is the structure-of-arrays format
(default, WebGL fallback and legacy readers), 1 is the GPU format. Switching
frees the other format's buffers and forces full damage; the model does this
implicitly: `consumeGpuFrame()` selects GPU, while `renderCells()`, `viewport()`
and `consumeDamage()` select SoA. A surface should stay on one format. Queries
that need no cell arrays (`cursor`, `hyperlinkAtViewportCell`, `grapheme`,
`readCellLine`, `wordRangeAt`, `selectionText`) work in either format without
switching.

In the GPU format no SoA cell arrays exist. Still written and valid for every
row: per-cell hyperlink ids (`linkIds`, with the link tables), `rowWrapped`,
`dirtyRows`, cursor. Everything text-reading that used SoA (word/line
selection, block search, plain-URL hover) now uses `restty_line_cells_*`
(`TeraxGhosttyTerminal.readLines`), which decodes buffer lines straight from
the page list in either format without scrolling the viewport.

### Cell records

One `rows * cols` row-major buffer of 16-byte records, four little-endian u32
words (`restty_gpu_cells_ptr`, stride `restty_gpu_cell_stride() == 16`):

| word | bits | meaning |
| --- | --- | --- |
| 0 | 0..23 | glyph id; 0 draws nothing (blank, invisible, spacer tail, Kitty placeholder) |
| 0 | 24..26 | underline style: 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed |
| 0 | 27 / 28 / 29 | strikethrough / overline / blink (the glyph blinks, decorations do not) |
| 0 | 30 / 31 | wide lead / reserved (0) |
| 1 | RGBA8 | foreground, inverse applied; alpha 255, or 128 when faint |
| 2 | RGBA8 | background, inverse applied; alpha 255 |
| 3 | RGBA8 | underline color; falls back to the displayed foreground |

RGBA words hold the bytes `[r, g, b, a]` in memory order, which is exactly what
WGSL `unpack4x8unorm(word)` reads (`.x == r`). A spacer tail has glyph 0 and
repeats its lead's three color words and decoration bits, so the lead's
background and underline cover both cells as in the SoA renderer. A spacer head
(wide character wrapped to the next row) is an empty default cell. The colors
come from the same Ghostty style resolution as the SoA arrays; the unit tests
check every cell against the SoA arrays with the `buildRows` rules (inverse
swap, faint, invisible, underline fallback) over randomized terminal output.

### Exact dirtiness

Each natively dirty row is re-encoded and compared word by word with the stored
record before it is overwritten; the row is reported only if a word changed.
`fullDamage` (all rows reported) is set only when stored records are stale: the
first frame, a resize, a released or compacted buffer, a new glyph epoch.
Other native full damage (scrolling, palette change) re-encodes every row but
still reports only rows whose bytes changed. `restty_row_dirty_ptr` is the
`rows`-byte flag array, `restty_gpu_any_dirty` the summary.

### Glyph ids

`(codepoint or grapheme sequence) x (bold, italic)` interns to a dense id from
1, exactly the key `GlyphAtlas.glyph(codepoint, grapheme, flags)` caches on
(codepoint 0 and 32 never draw). Graphemes are interned by content. Ids are
per terminal handle, not per WASM instance: the JavaScript atlas already
deduplicates by text, so this loses no rasterization reuse, a destroyed or
hidden terminal frees its table immediately, and an epoch reset in one
terminal never disturbs another. The same ids work unchanged if each terminal
later gets its own instance.

The table holds at most 16,384 glyphs (64 KiB for the renderer's `glyph_map`)
and 256 Ki stream words. When full, the update starts a new epoch (ids
cleared, viewport re-encoded, `epoch` incremented, full damage). The renderer
resets its id map and receives the complete new table. A viewport with more
distinct glyphs than the cap leaves the excess cells at glyph 0 (counted in
`glyphOverflow`) instead of looping. Release and an oversized table at
compaction (more than 2,048 glyphs) also start a new epoch.

Glyph records are `[id][style][codepoint_count][codepoints...]` u32 words, in a
single append-only stream. The pending window (`restty_gpu_new_glyphs_*`) is
everything interned since `restty_gpu_glyphs_ack`; unacknowledged glyphs
accumulate across updates, so a renderer that skips a frame loses nothing.
`restty_gpu_glyphs_*` returns the whole stream for resynchronization. Style
bit 0 is bold, bit 1 is italic.

### Consumer loop

```ts
if (model.deferPresentation()) return;           // synchronized output
const frame = model.consumeGpuFrame({ resync });  // resync: new/re-leased surface
if (frame.epoch !== epoch) { glyphMap.reset(); epoch = frame.epoch; }
for (const glyph of frame.newGlyphs) glyphMap.add(glyph.id, glyph.text, glyph.style);
for (const { start, end } of frame.dirtyRanges) {
  const offset = start * cols * 16;
  queue.writeBuffer(cellBuffer, offset, frame.cells, offset, (end - start + 1) * cols * 16);
}
if (frame.damage.kind === "none") return;         // nothing to draw
armBlinkTimer(frame.blinkingCells > 0);
```

`frame.cells` is a view into `frame.memory.buffer` and is valid until the next
call into the model that can allocate. `dirtyRanges` holds only record changes;
`damage` also covers selection, block-search and cursor-option overlays, which
never touch the records.

## As built

### Data path

`WebGpuTerminalSurface.renderFrame` calls `deferPresentation()` and
`consumeGpuFrame({ resync })`, uploads `dirtyRanges` with
`queue.writeBuffer(cells, offset, frame.cells, offset, length)` and scans the same
view for evicted glyphs before any other model call, then updates `glyph_map`,
the search mask and the uniform. It redraws when `frame.damage` is not none or
any uniform, mask, map or binding changed, and otherwise acquires no texture.
`resync` is sent for a new or re-leased surface, a replaced cell buffer, and
after an atlas flush. The surface never calls `renderCells`, `consumeDamage` or
`viewport`, so the model stays in the GPU format; failover to WebGL flips it to
the structure-of-arrays format and back without resetting the terminal.

### Shaders

One bind group serves both passes: uniform, `cells` (`array<vec4u>`), `glyph_map`,
`glyph_table` (four words per glyph: rect x and y, width and height, bearing,
flags: bit 0 colour glyph, bit 1 exact coverage with no contrast), `search_mask` (a four-byte stand-in when inactive) and the two atlas
textures. The background pass is one fullscreen triangle. A wide character's
trailing half takes selection and search state from its lead, as before.
The glyph pass is one instanced draw over `cols * rows`; glyph 0, a pending or
evicted glyph, and a blink-hidden glyph collapse to a degenerate triangle. The
left-overhang clip compares displayed backgrounds, including search and
selection, exactly as the old per-cell loop did. The uniform is 176 bytes; a
test checks the WGSL struct offsets against the TypeScript packer.
Sampling uses `textureLoad`. The previous glyph shader called `textureSample`
inside non-uniform control flow, which current Chromium (152) rejects at shader
creation, so the old path would have fallen back to WebGL there.

### Geometry

Fonts are measured at `size * ratio`. Device cell size is
`ceil(advance + letterSpacing * ratio)` by
`max(ceil(ascent + descent) + 2, ceil(size * ratio * lineHeight))`. At ratio 2
this differs from the old `2 * ceil(css cell)` by up to one device pixel per
cell, so column and row counts can change by a cell or two; glyph rendering at
identical geometry is unchanged. Underline, strikethrough and overline strokes
are `max(1, round(ratio))` device pixels and the bar and underline cursors
`max(2, round(ratio))`; at ratio 2 they equal the old values. The canvas is
translated by the rounded device offset of the container, computed in the
`ResizeObserver` callback (where layout is clean), on a ratio change and on
window resize, never per frame. Layout moves that neither resize the container
nor fire a window resize keep the previous offset until the next of those events.
`devicePixelContentBoxSize` supplies the exact fit when the engine reports it.

`CanvasBackingStore` keeps its nearby-size reuse, now defined so it cannot scale
text: the CSS size is always `backing / ratio`, drawing uses a viewport of exactly
`cols * cellW` by `rows * cellH`, and the surplus (up to 255 device pixels per
axis after a shrink, aligned to 128) is cleared to the background and clipped by the container.
A test drags a pane across 400 device pixels in 3 pixel steps and requires fewer
than a tenth as many swapchain reallocations as steps.

### Canvas lifecycle

WebKit (macOS 26.6.2, WebKit 21624.5.1.11.3) keeps the swapchain of a WebGPU
canvas that was presented and then destroyed, in the WebContent process, for good:
three buffers, 30 MiB for a 2000x1300 canvas ("owned unmapped (graphics)" in
`vmmap`, GPU process flat, unaffected by forced garbage collection). Window
occlusion longer than the old two-second reclaim delay destroyed every canvas, so
each Space switch, minimize or `orderOut` added 30 MiB. `scripts/renderer-profile`
reproduced it without any Terax code (`--workload canvas`, 15-20 cycles of
occlude, tear down, restore):

| Teardown on occlusion (raw WebGPU canvas) | MiB per cycle |
| --- | --- |
| unconfigure + 1x1 + remove + drop (the old pool reclaim); also with `texture.destroy()`, remove only, unconfigure only | +29.8 to +30.9 |
| keep the element, unconfigure | +1.5, stays |
| keep the element, shrink to 1x1 and back | +2.3 while cycling, back to baseline once quiet |
| keep the element, hide it (`hide-keep`) | -0.0 |
| keep the element, remove it from the DOM and re-append (`detach-keep`) | -0.0 |
| keep the element, give it a new GPU device each cycle (`reconfigure`) | -0.4 |
| 8 backing-store resizes per cycle with frames running (`resize-live`) | -0.3, transient peaks of one swapchain, all returned once quiet |
| raw WebGL2 canvas: lose context, 1x1, remove, drop (`webgl-destroy`) | +1.0, sawtooth: garbage collection returns it, settles below baseline |
| raw WebGL2 canvas: hide only (`webgl-keep`) | +0.2 |

So a presented WebGPU canvas is never destroyed (`WebGpuCanvasPool`):

- Occlusion, sleep and a hidden window only pause. Nothing is released: canvases
  keep their configuration and size, and cell buffers, glyph maps and atlas
  textures stay resident (together a few MiB; WASM linear memory never shrinks,
  so returning the native presentation buffers on occlusion gained nothing).
- A hidden pane returns its canvas to the pool configured and sized. The pool
  creates a canvas only when none is idle, so it never holds more than the peak
  number of simultaneously leased canvases. A returning pane passes the backing
  size it last fitted (`lastBackingSize`) and gets the idle canvas whose backing
  store already serves it (`CanvasBackingStore.surplusFor`, smallest surplus
  first), else a parked canvas, else the closest area. A tab switch reallocates
  nothing.
- An idle canvas keeps its size for ten seconds (`terax:terminal-canvas-park-ms`,
  `off` to disable) and is then parked at 1x1, still configured; canvases under
  2 MiB of color are never parked. The rule exists because tab switches are not
  ordered: React runs effects in tree order, so switching to a tab earlier in the
  tree shows its panes before the outgoing tab releases its own, and the pool
  holds one more canvas than the visible set until they are parked.
- A lost or replaced GPU device keeps every element: `lease.reconfigure` (leased)
  or reconfiguration on `acquire` (idle) calls `configure()` on the same canvas
  with the new device. Surfaces drop their buffers and atlas lease on
  `handleDeviceLoss`, nothing else.
- Only `WebGpuTerminalRuntime.dispose()` (HMR, or a fatal error that switches the
  session to WebGL) destroys canvases; the WebGPU runtime never presents again.

The WebGL fallback is unaffected: its canvases are garbage collected, so its
two-second occlusion reclaim stays.

### Glyph atlas

Pixels are written with `queue.writeTexture` and no CPU copy is retained, so a
hidden atlas holds no pixels and the first surface to return re-rasterizes what it
shows. Growth creates the larger texture, copies the old one on the GPU in its
own submission, and destroys the old texture only after the frame that may name
it completes. When the largest atlas (or the device limit) is full the owner
flushes between frames, never mid-frame, at most every 250 ms. Every surface then
resyncs, marks its mappings evicted, rescans its visible cells and
re-rasterizes only those; other glyphs return when they next appear in a changed
row. This is epoch eviction with the visible set as recency, not a per-glyph LRU,
because tracking per-glyph use would need per-cell JavaScript. When more than 256
glyphs wait, only the ones the viewport shows stay queued, so scrolled-away output
cannot delay the current screen. Rasterization stops after about 2 ms per frame
across surfaces (8 ms for a surface's first frame so text appears whole).
The isolated per-surface atlas and its fallback are gone.

### Procedural glyphs

Fonts draw box-drawing characters with side bearings and rounded metrics, so
borders show gaps between rows and columns and shades turn into dither. These
ranges are therefore drawn from the cell instead of the font, as Ghostty, kitty,
Alacritty and Windows Terminal do: Box Drawing (U+2500..257F), Block Elements
(U+2580..259F), braille (U+2800..28FF), powerline separators (U+E0B0..E0BF,
E0D2, E0D4), the corner triangles of Geometric Shapes (U+25E2..25E5, 25F8..25FA,
25FF), and from Symbols for Legacy Computing the sextants, smooth mosaics,
one-eighth bars, half shades, diagonal fills, quarter circles (U+1FB00..1FBEF
minus the unassigned and unsupported) and the octants (U+1CD00..1CDE5). A
sequence that merely starts with one of them (a combining mark, a variation
selector) still goes to the font.

`gpu/BuiltinGlyphs.ts` and `gpu/builtin/` are pure: a code point and a
whole-pixel cell give a coverage mask of exactly `deviceCellWidth` by
`deviceCellHeight` bytes, with no canvas or DOM. `GlyphRasterizer` returns it as
a glyph with zero bearing, so the quad covers the cell, and `WebGlGlyphAtlas`
copies the same bytes into its coverage atlas; both renderers therefore draw the
same pixels. Bold and italic never change these glyphs, so the atlas keys them
with style 0 and the four styles share one entry. The table entry carries
`GLYPH_ENTRY_FLAG_EXACT` (bit 1 of the flags word), and the shader skips the text
contrast curve for it: that curve is meant for font antialiasing and would
reshape shades and arcs at ratios below 2.

Geometry is Ghostty's (`src/font/sprite/draw`, MIT), ported rather than
approximated. The light line is `max(1, ceil(0.05 * font px))` device pixels, the
bundled font's underline weight (the canvas cannot report a font's own), heavy is
twice that and a double line is two light lines around a light gap. Strokes are
whole-pixel rectangles at `floor((cell - weight) / 2)`, so the two halves of a
line meet exactly across cell boundaries whether the cell is odd or even, and the
junction rules lengthen or trim the arms where weights differ so a joint has no
notch. Dashes (2, 3, 4) leave half a gap at each end horizontally and a full gap
at the bottom vertically, with leftover pixels spread over the dashes. Block
fractions round from the far edge (`size - round((1 - f) * size)`), so two
halves of an odd cell share the middle pixel line instead of leaving a seam.
Shades are coverage 64, 128 and 192. Braille picks dot size, spacing and margins
from the cell so the eight dots are equal whole squares inside it. Only diagonals,
arcs (cubic Bezier, control points a quarter radius from the centre), triangles,
circles and the rounded separators are anti-aliased, by exact polygon area
coverage; the open ends of an arc are pinned to the same pixels as `─` and `│`.
The mask code draws on a cell-sized buffer and clips to it, so nothing spills into
a neighbour.

Against Ghostty's own reference images (its `sprite face render all sprites`
test data at 18x36, 12x24, 11x21 and 9x17 cells with 4, 3, 2 and 1 pixel lines),
all 885 glyphs this module draws were compared pixel by pixel: 746 are
bit-identical at every size and the 139 anti-aliased ones differ by at most 29 of
255 on edge pixels (its rasterizer quantizes coverage; this one is exact).

### Text contrast

`DWrite_EnhanceContrast` scaled by foreground lightness, then a blend toward
`DWrite_ApplyAlphaCorrection` with the 1.8 gamma ratios from Windows Terminal's
`dwrite_helpers.hlsl`, both uniform controlled. Defaults are 0.5 and 0.5 on
Windows, Linux and any ratio below 2, and zero elsewhere (macOS Retina is
unchanged). The Windows values were chosen from the reference implementation and
have not been looked at on Windows; `localStorage["terax:terminal-text-contrast"]`
(`off`, `on` or a strength) exists to tune them without a build.

### Scrollbar

`TerminalScrollbarSync` keeps the last written `scrollTop` in JavaScript and
reads the DOM only in the scroll handler. Writing `scrollTop` forces a layout, so
growth under a bottom-pinned view moves the thumb at most every 100 ms, and ARIA
values change at most every 250 ms; invalidation keeps the known position,
re-attachment forgets it.

### Verification

`scripts/terminal-visual` renders a fixed pattern (ASCII, box drawing, bold and
italic, all underline styles, strikethrough, overline, faint, blink, inverse,
wide CJK, emoji, combining marks, selection, search, cursor styles) through any
source tree and reads the presented canvas back as exact RGBA.

| Check (macOS, Chromium 152, ratio 2 unless noted) | Result |
| --- | --- |
| v1 and v2 at identical cell geometry: full pattern, rectangular selection, search mask, bar and underline cursors, letter spacing | every difference is at most 3 of 255 on glyph edges (v1 quantizes UVs to 16 bits); backgrounds, decorations, selection and cursor are identical |
| Same text at two columns at ratio 1.25 and 1.5 (mean absolute difference) | v1 6.8 and 11.2; v2 0 and 0 |
| Atlas capped at 1024, 10 pages of 1,900 distinct glyphs, flush mid-run | final frame pixel-identical to a fresh run |
| Atlas grown 1024 to 2048 to 4096, then flushed | final frame pixel-identical to a fresh run |
| Live ratio changes 1.25, 1.5, 1.75, 2.25, 1 | font re-measured, grid and canvas re-fit each time, no errors |
| WebGPU to WebGL to WebGPU on one model | format flips `gpu`, `soa`, `gpu`; content intact |
| Procedural glyphs (`pattern=sprites`: nested and table borders, input box, progress bars, braille spinners, powerline prompt) at ratios 1, 1.25, 1.5, 1.75, 2 and 3, JetBrains Mono and Menlo, letter spacing and line height, cells from 7x14 to 27x54, WebGPU and WebGL (15 captures, `sprites-checks.json`) | every cell holding a procedural glyph or a space matches the frame the generator predicts: 1,534 cells each, no pixel off by more than 0.5 of 255; of 784 cell boundaries shared by two line characters none is broken |
| Same pattern drawn from the font (revision before this change) | 208 of 784 boundaries broken at ratio 2, 154 at ratio 1.25; sextants and powerline separators are missing-glyph boxes, shades are dither |
| WebGPU against WebGL, ratio 2, whole pattern | 3,092,904 pixels, 0 different |
| Shader flag removed (ratio 1.25, text contrast on) | 13,942 pixels off by up to 20: the contrast curve reshapes arcs and shades, which is why `GLYPH_ENTRY_FLAG_EXACT` exists |

The images are in `terminal-renderer-v2-evidence/`: `ratio2-v1.png` and
`ratio2-v2.png` (full pattern), `ratio2-diff-x8.png` (their difference, amplified
eight times), `ratio2-underlines-*` (all underline styles), and
`ratio1.25-*-crop-x6.png` (the same text at ratio 1.25, six times enlarged).
`sprites-dpr2.png`, `sprites-dpr1.25.png` and `sprites-webgl-dpr1.25.png` show
the procedural glyph pattern, `sprites-before-dpr2.png` the same pattern from the
font, `sprites-*-dpr1.25-crop-x5.png` enlarge a heavy table corner before and
after, `sprites-*-dpr2-crop-x4.png` the italic copy of the bottom boxes (the font
slants and breaks them; the procedural glyphs ignore the style), and
`sprites-checks.json` holds the numbers for every capture, computed by
`scripts/terminal-visual/spriteCheck.ts` (see its README).

Main-thread time per tick (model write plus `renderFrame` plus submit; 400 ticks
after warm-up, batched because `performance.now()` is 0.1 ms resolution):

| Workload | 3,885 cells v1 | v2 | 12,027 cells v1 | v2 |
| --- | --- | --- | --- | --- |
| Ink-like repaint, one character changes | 0.98 ms | 0.14 ms | 2.51 ms | 0.36 ms |
| Identical full repaint | 3.64 ms | 0.15 ms | | |
| Scrolling output | 0.93 ms | 0.16 ms | | |

### Not verified

Windows and Linux were not run: DirectWrite-like contrast, the
`devicePixelContentBoxSize` path against real fractional ratios, WebView2 and
WebKitGTK behaviour, whether compositors already snap the canvas, and the
procedural glyphs there (their code is platform independent and covered by unit
tests, but nothing was looked at). The light line weight assumes the bundled
font's 5% underline thickness for every font, so a font with a much thinner or
thicker underline gets lines of the same weight. Not drawn procedurally, and
left to the font: Ghostty's branch glyphs (U+F5D0..F60D), separated quadrants and
circle pieces (U+1CC00..1CEBF except the octants), the stylised powerline
extras, and geometric shapes beyond the corner triangles. Real
fractional display ratios were checked only through readback of the canvas
(the page cannot emulate a display ratio), not through a physical display.

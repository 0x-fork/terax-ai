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
flags), `search_mask` (a four-byte stand-in when inactive) and the two atlas
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

The images are in `terminal-renderer-v2-evidence/`: `ratio2-v1.png` and
`ratio2-v2.png` (full pattern), `ratio2-diff-x8.png` (their difference, amplified
eight times), `ratio2-underlines-*` (all underline styles), and
`ratio1.25-*-crop-x6.png` (the same text at ratio 1.25, six times enlarged).

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
WebKitGTK behaviour, and whether compositors already snap the canvas. Real
fractional display ratios were checked only through readback of the canvas
(the page cannot emulate a display ratio), not through a physical display.

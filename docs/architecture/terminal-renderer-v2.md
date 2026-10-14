# Terminal renderer v2: native cell stream, pixel-exact grid

Status: in implementation on `perf/resource-efficiency`.

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

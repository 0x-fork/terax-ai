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
- A pane draws into a rectangle of the shared window canvas whose size is whole
  device pixels (at least `cols * cellW` by `rows * cellH`; the rest is background);
  the canvas CSS size is its backing divided by `dpr`.
- The canvas origin is snapped to the device pixel grid by translating by the
  negative fractional device offset of the terminal area's origin, and every pane
  rectangle is rounded edge by edge relative to that origin. The offset is
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

`WebGpuTerminalSurface.prepareFrame` calls `deferPresentation()` and
`consumeGpuFrame({ resync })`, uploads `dirtyRanges` with
`queue.writeBuffer(cells, offset, frame.cells, offset, length)` and scans the same
view for evicted glyphs before any other model call, then updates `glyph_map`,
the search mask and the uniform. It reports a change when `frame.damage` is not none or
any uniform, mask, map or binding changed; the window canvas then draws every visible
pane (`encode`), and when no pane and nothing else changed it acquires no texture.
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

`CanvasBackingStore` (now owned by the window canvas) keeps its nearby-size reuse,
defined so it cannot scale text: the CSS size is always `backing / ratio`, panes draw
through exact viewports, and the surplus (up to 255 device pixels per axis after a
shrink, aligned to 128) is clipped by the area. A test drags an area across 400
device pixels in 3 pixel steps and requires fewer than a tenth as many swapchain
reallocations as steps. During a resize gesture the store is stricter still; see
"Resizing".

### Window canvas

One canvas per terminal area (`WebGpuWindowCanvas`, for the `[data-terminal-area]` layer
`TerminalStack` renders behind its tab layers, zoom-exempt like the panes) replaces the canvas
each pane owned. The only other window (settings) has no terminal, and a window is one JS
context, so multiple windows need nothing.

- **Frame.** `flushFrame` applies each window's layout (commit the backing store, recompute
  pane rectangles from what the observers measured; no DOM read), lets every due pane (and any
  pane that moved) `prepareFrame` (uploads, uniform; returns whether its pixels changed), then
  draws each window for which `windowFrameNeeded` holds (a pane changed, the canvas was
  reallocated, a pane moved or the window was marked dirty, and something is drawable): one
  pass clears the canvas (textures are not preserved) and each pane sets `setViewport` and
  `setScissorRect` to its rectangle and encodes its two draws. An unchanged window acquires no
  texture and creates no encoder.
- **Shader.** NDC comes from the uniform's `viewport_size` (the pane rectangle) and the
  fragment stage subtracts `origin` from window-relative coordinates; the background pass paints
  the theme background over the whole rectangle, so slack needs no DOM background.
- **Rectangles** (`PaneRects.ts`): `round(left * ratio) - round(area.left * ratio)` per edge, so
  neighbours never overlap and the gap is the divider's; clamped to the canvas (WebGPU rejects
  viewports outside the target) and the canvas to `maxTextureDimension2D`. Surfaces report their
  host from their resize observer and explicit measurements, the canvas observes the area;
  nothing is read per frame. A moved pane that fires no observer would misalign the canvas, so
  while frames are produced the layout is re-read at most once a second.
- **Pane DOM** is transparent once the canvas showed the pane's first frame (lifted after the
  GPU finished it); before that, and after a tab switch back, it paints the theme background.
- **Held presentation** (DEC 2026, prompt redraw): the pane keeps drawing its previous cells;
  only its uniform follows a moved rectangle.
- **Failover** stays per pane (WebGL canvases are per pane): an error against one pane falls
  that pane back; a device error or failed recovery disables the runtime, which falls every pane
  back and destroys the window canvas.

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

So a presented WebGPU canvas is never destroyed (`WebGpuWindowCanvas`):

- Occlusion, sleep and a hidden window only pause. Nothing is released: the canvas
  keeps its configuration and size, and cell buffers, glyph maps and atlas textures
  stay resident (together a few MiB; WASM linear memory never shrinks, so returning
  the native presentation buffers on occlusion gained nothing).
- A pane that becomes hidden leaves the canvas (its buffers and atlas lease are
  released as before); the next visible pane joins it. A tab switch, a split, a
  closed pane and a divider drag change only which viewports are drawn: zero
  reallocations, zero reconfigurations. When the last pane has been gone for 250 ms the canvas is
  hidden (a switch must not toggle it) and keeps its size. The runtime counts every swapchain allocation
  (`canvases.backingStoreResizes`).
- The previous design (a pool with one canvas per visible pane, closest-size reuse
  and 1x1 parking after ten seconds) reallocated a presented canvas whenever tabs
  of different pane geometry alternated (four tabs including a split pair: 246 to
  726 MiB in 40 switches until a forced collection). It is gone.
- A lost or replaced GPU device keeps the element: the runtime calls `configure()`
  on the same canvas with the new device.
- A terminal area that is gone (a remounted stack) hands its canvas to the next area.
- Only `WebGpuTerminalRuntime.dispose()` (HMR, or a fatal error that switches every
  session to WebGL) destroys the canvas; the WebGPU runtime never presents again.

Measured with the app lab (real app, release build, M4, total footprint in MiB; before is `ee836e1`
for tabs/occlusion and `561d820` for resize, CPU medians of three on `561d820`):

| Scenario | Before | After |
| --- | --- | --- |
| `tabs --variant saps` 40 switches, end +30 s (WebContent) | 726 (663) | 218 (160); after forced GC 208 |
| `tabs` shell + agent, end +30 s | 283 | 200 |
| backing-store allocations over 40 switches (saps) | 46 | 2 (the first two, at startup) |
| `agents-steady` 120 s, unfinalized canvas textures / WebKit malloc growth | 2,626 / +36 MiB (no mirroring) | 195 / +2.5 MiB |
| `agents-steady` CPU (app of one core, instructions/s, WebContent %) | 23.3 %, 0.38 G, 10.3 | 23.4 %, 0.38 G, 10.4 |
| `idle` CPU (3 runs) | 2.9 % | 3.0 % |
| `resize` 6 gestures: allocations / peak / settled / +30 s | 10 / 756 / 420 / 407 | 11 (2 at startup) / 796 / 309 / 205 |

Known cost: the renderer lab's `default` workload (100 tab switches 30 ms apart) peaks at 429
MiB after the switches against 209 on `561d820`, and returns to 214 within seconds (pane DOM
now overlaps the canvas, so each pane switch builds a layer that waits for a collection);
real switching (`tabs`, one switch every 3 s) stays flat.

The resize peak is WebKit's page-layer behaviour (see "Resizing"); the extra 40 MiB is the
window canvas growing once to the gesture bound. Visual: `scripts/terminal-visual` reads the
window canvas back; a single pane is byte-identical to the per-pane canvas revision at ratios 2
and 1.25, and 2x2 splits (exact and fractional pane sizes, ratios 2 and 1.25, fractional origin)
equal a single pane of the same size pixel for pixel, with the divider gaps the clear colour.

The WebGL fallback is unaffected: its canvases (one per pane) are garbage collected,
so its two-second occlusion reclaim stays.

### Resizing

Two problems shared one cause: the surface followed the pointer step for step.

**Prompts.** Ghostty's `Screen.resize` clears a redrawable prompt (OSC 133 `A`/`B` with
`redraw` left at its default, which zsh and fish rely on) whenever the grid changes, and
expects the shell to print it again on SIGWINCH. Terax resized the model on every drag step
and delivered the PTY resize 256 ms after the last step, so a prompt was blank for the
whole drag. Upstream Ghostty reached the same conclusion from the other side
(`termio: synchronize pty and terminal resizing`, #14706: take the terminal lock before
resizing the pty so the shell's redraw is never parsed against the old dimensions).
`TerminalResizeSync` (`lib/terminalResizeSync.ts`) now changes the model and the PTY in one
synchronous call, model first, and the surface asks it for every grid change that comes from
the host changing size. `ResizeThrottle` lets the first change through at once, then at
most one per 100 ms, and always lands the newest within an interval of the last movement
(`onDue` re-fits against the host). The interval is 100 ms because a shell needs a few
milliseconds to answer SIGWINCH, so the prompt is blank for a few milliseconds in every
hundred instead of for the drag, and a full-screen program gets at most ten relayouts a
second instead of one per cell of pointer travel (a reflow itself costs about 1 ms). The
old PTY debounce is gone: a size the PTY has not heard about is never applied to the model
(`PtyResizeDelivery` only skips repeats and does not record a size when no PTY exists yet).
Between applications nothing changes: not the model, not the PTY, and the pane keeps drawing
its last grid inside its already updated rectangle (clipped by the scissor when it shrank,
background where it grew). Font and ratio changes, the first fit, a pane becoming visible and
the end of a gesture are not throttled; hidden panes still fit when they are shown.
`resizePromptRedraw.test.ts` runs this against the real WASM core: a zsh-like prompt is
cleared by the model resize and restored by the redraw bytes that follow the PTY resize.

**Prompt flash.** Even a few milliseconds of blank prompt every 100 ms is a visible flicker,
so a resize at a shell prompt also holds presentation (`core/ResizePromptHold.ts`). The model
tracks the OSC 133 events (`prompt-end` sets "at a prompt"; `prompt-start`, `end-of-input`,
`end-of-command` and `screen-cleared` clear it). A grid change at a prompt, outside the
alternate screen, makes `presentationSuppressed()` true, which is what `deferPresentation()`
already reports for synchronized updates: the surface skips the frame and the pane keeps
drawing its previous cells (its uniform still follows a moved rectangle). It ends at the
redraw's `prompt-end`, at the user's input or a command, or after 70 ms
(`RESIZE_PROMPT_HOLD_MS`) when the shell does not answer, and then presents once. Parsing is
never delayed. The real-core test replays a one second drag with a frame every 4 ms against a
shell that answers 8 ms after SIGWINCH: no presented frame is blank, and frames were held.

**Memory.** A resizing canvas allocates a replacement swapchain for every backing-store
change, and WebKit keeps the retired ones until the live resize ends (three buffers each,
30 MiB for a 2000x1300 canvas). The lab's window drag (`--workload resize`, 80 drags of
about 120 steps) made 609 backing-store reallocations (about 8 per drag; 54 over the three
cycles of one run) with a canvas per pane. A resize gesture, as the window canvas sees it, is
one of the following (everything below applies to the window canvas, the only WebGPU canvas
that can resize; panes inside it only change rectangles):

- a pane divider drag (`terminalResizeInteraction`): it never changes the terminal area, so
  the canvas does not move at all; the gesture only keeps the panes' cell buffers from
  compacting until it ends,
- the native macOS live resize: `window_presentation.rs` observes
  `NSWindowWillStartLiveResizeNotification`/`NSWindowDidEndLiveResizeNotification` next to
  the occlusion notifications and publishes `liveResize` in the same
  `terax:window-presentation` snapshot; `windowPresentation.ts` forwards it to
  `setNativeLiveResize`,
- everywhere else (Windows, Linux, animated layouts): the area (or, for the WebGL canvas, a
  surface's host) changing size twice less than 150 ms apart (`lib/terminalResizeGesture.ts`),
  until 150 ms pass without a change. Several panes laying out once each, as on a tab
  switch, is not a burst.

While a gesture runs `CanvasBackingStore.stage` never shrinks. When the area outgrows the
backing it allocates once, on both axes, to `gestureBackingBound`: if the window's inner size
changed since the gesture began (the window is being dragged), the area plus the screen room
the window has left; otherwise (an animated sidebar) the window, because it did not grow;
capped by `maxTextureDimension2D`. The CSS size stays exactly `backing / ratio` and every
pane's viewport exactly its rectangle, so nothing is scaled; the rest is background, clipped
by the area layer. The surfaces land their held grids when the gesture ends and the next
`stage` without a gesture compacts the backing to the usual nearby size, so a window drag
costs at most one growth plus one compaction, however many panes the window shows. The WebGL
canvases (one per pane, rarely used) use the same store and throttle.

Measured with `scripts/renderer-profile` (`--workload resize --cycles 3`: one 1000x650 window,
one visible pane and one hidden, 3000 lines of scrollback each, output streaming, three
shrink drags and three grow drags of 120 steps of 4 pt every 16 ms, macOS 26, M4; three runs
each, `docs/architecture/resource-evidence-2026-10-15/resize-*.json`). Footprint is the sum of
the host and its WebKit processes at the end of each drag; "peak" is the largest of the six.

| | HEAD | after (native signal) | after (burst heuristic only) | control: empty page, no WebGPU |
| --- | --- | --- | --- | --- |
| peak total MiB (runs) | 949 (884, 949, 979) | 607 (607, 613, 595) | 658 (664, 658, 593) | 436 |
| peak WebContent MiB | 778 (718, 778, 807) | 467 (467, 477, 460) | 522 (518, 522, 461) | 320 |
| backing-store resizes per run (6 drags) | 54 | 10 | 10 | |
| per drag, max / mean | 15 / 8.8 | 2 / 1.3 | 2 / 1.3 | |
| total 1.5 s after the last drag | 238 | 243 | 276 | 85 |
| total 30 s after | 233 | 252 | 237 | 77 |
| `--idle-after`: peak total / 30 s after | 940 / 176 | 606 / 238 | | |

The control is the part of the spike Terax cannot influence: with no terminal, no WebGPU and
an empty DOM the same window drag takes the WebContent process from 22 to 320 MiB (total 68
to 436). WebKit's own live resize retains page layer buffers, whatever the page holds. Over
that control plus the steady 120 MiB a pane costs (558), the drag peak was 391 MiB above it
and is now 49 MiB above it: the extra swapchain of the growth bound, which is the point.
Shrinking drags peak at 445-497 MiB (no extra allocation at all) and grow drags at 573-613 (the
bound). The rest of the heuristic-only spread is one drag in two runs that reached 660
instead of 600. The 30 s totals differ by a few MiB because the GPU process compresses or
releases swapchain pages at times it chooses (HEAD's own `--idle-after` runs settle at a median of 176 and up to 222 MiB).

Other workloads, new against the 2026-10-14 reports and same-day HEAD (the new code paths
are idle in them: no gesture, grid and backing counters identical to HEAD): `default` x3
against `v2-default` x3 and same-day HEAD x2: `resized` 243 MiB (v2 241); `switched` and
`repainted` are 247 and 261 against 247 and 248 for HEAD today, so the +40 MiB against
`v2-default` is HEAD's, not this change's. `tabs` (hide-first) 20 cycles: 13% below `v2-tabs`
at the end. `tabs --order show-first` x2 against same-day HEAD x2: pool created 5, reused 100,
backing-store resizes 5 in all four runs; end totals 218 against 211 MiB, growth 0.55 against
-0.07 MiB per cycle (v2: 0.31). `occlusion --cycles 20`: 20 reclamations, growth 0.16 MiB per
cycle (HEAD today 0.07, v2 -0.23). `move`: 4% below v2.

Checked pixel for pixel with `scripts/terminal-visual` (Chromium, window `resize` events and
the native signal driving a 75 step shrink and a 75 step grow of a 1000x640 host; the
browser pane was hidden, so no ResizeObserver callbacks were delivered): at ratio 2 and 1.25,
during the gesture (backing 1998x1260 kept through the shrink, 5528x3255 after the grow) and
after the compaction (1408x1024, 2048x1280), the grid area is byte-identical to a fresh load
at the same size (0 differing bytes) and everything outside it is one background colour.
CSS size times ratio equals the backing size in every state.

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

Main-thread time per tick (model write plus the frame plus submit; measured before the
window canvas existed, when `renderFrame` encoded a pane's own pass; 400 ticks
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

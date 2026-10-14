# Terminal visual harness

Draws a fixed test pattern (ASCII, box drawing, bold and italic, every underline
style, strikethrough, overline, faint, blink, inverse, wide CJK, emoji, combining
marks, selection, search, cursor styles) through the real terminal surface and
the real Ghostty model, and reads the presented canvas back as exact RGBA.
Use it to compare renderer changes pixel for pixel and to check geometry at
display ratios the machine does not have.

```sh
TERAX_VISUAL_OUT=/tmp/visual TERAX_VISUAL_PORT=5199 \
  node_modules/.bin/vite --config scripts/terminal-visual/vite.config.ts
```

Open `http://localhost:5199/?w=1000&h=640&fs=15&select=19,5,21,14&capture=name`.
With `capture`, the page writes `name.rgba` (raw RGBA) and `name.json` (size,
ratio, surface diagnostics) to `TERAX_VISUAL_OUT` and sets its title to
`captured name`. To compare another revision, extract it
(`git archive <rev> src packages package.json tsconfig.json | tar -x -C dir`,
link `node_modules`), start a second server with
`TERAX_VISUAL_SOURCE_ROOT=dir` and another port, and load the same URL.

```sh
node scripts/terminal-visual/compare.mjs diff /tmp/visual a b diff.png
node scripts/terminal-visual/compare.mjs png /tmp/visual a 4 0 0 200 80
node scripts/terminal-visual/compare.mjs crisp /tmp/visual a
```

Query parameters: `dpr` (override the display ratio), `w` `h` `left` `top` (host
box, CSS px), `fs` `ff` `lh` `ls` (font size, family, line height, letter
spacing), `cursor` (`block`, `bar`, `underline`), `blink`, `select` (`row,col,row,col[,1]`
for rectangular), `search`, `pattern=empty`, `pattern=sprites` (see below),
`renderer=webgl` (captures work there too: the harness keeps the WebGL drawing
buffer and reads it with `readPixels`), `maxtex` (cap the
atlas texture size to force eviction), `stress=1|2` (page through thousands of
glyphs first; 2 waits for each page), `bench=spinner|rewrite|stream&ticks=N`
(main-thread time per tick, see below), `raf=native`.

Frames are driven by timers by default because a pane that is not on screen
never fires `requestAnimationFrame`. A hidden pane may also throttle timers, so
long runs are slow there. `window.harness` exposes the surface, model,
`capture(name)`, `swapTo("webgl" | "webgpu")` (renderer failover on one model),
`runtime()` (runtime diagnostics) and `window.__setDpr(ratio)` (change the ratio
live).

`bench` drives `renderFrame` directly, without the scheduler, after a warm-up,
and reports milliseconds per tick (model write, frame and submit) in batches
because `performance.now()` is coarse. Both revisions must share one cell
geometry (for example `fs=15` at ratio 2) for the comparison to be fair.

## Procedural glyph pattern

`pattern=sprites` draws box-drawing, block, braille, powerline and legacy
computing characters (nested boxes, a table with every junction, a Claude-Code
style input box, progress bars with eighth blocks, braille spinner frames, a
powerline prompt, bold and italic copies of the same borders, a few text labels)
as colour runs from `spritePattern.ts`. With `capture=name` the page also writes `name.check.json`
from `spriteCheck.ts`:

- `seams`: for every cell boundary where two line characters point at each other,
  the last pixel column (row) of one cell is compared with the first of the next.
  Both must be inked on exactly the same pixels. It needs only the image, so it
  also measures a revision that draws these characters from the font.
- `expected`: every cell holding a procedural glyph or a space is compared with
  the frame the generator predicts (`background + (foreground - background) *
  coverage`). Present only where `gpu/BuiltinGlyphs.ts` exists.

```sh
open "http://localhost:5199/?pattern=sprites&w=1000&h=780&fs=15&dpr=1.25&capture=sprites-dpr1.25"
```

Use `h=780` or more so the pattern is not scrolled. Compare against a revision
that draws these characters from the font by serving it with
`TERAX_VISUAL_SOURCE_ROOT` as described above.

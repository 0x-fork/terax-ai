# App lab: resource benchmark of the real application

`scripts/app-lab` measures the **real** Terax app (full React shell, real PTYs, real
tabs and splits, real window, the release profile users run) instead of the synthetic
renderer in `scripts/renderer-profile`. It exists because the renderer lab did not reproduce
what the user sees every day: memory that jumps on every tab switch and does not come back.
Evidence for the first investigation is in `resource-evidence-2026-10-15/`.

Nothing of it ships. The Rust side is behind the cargo feature `bench`, the frontend behind
`TERAX_BENCH=1` (a Vite `define` that is the literal `false` otherwise, so the driver, its
lazy chunk and every bench-only string are removed before bundling). `src/app/dist-budget.test.ts`
builds the normal frontend and fails if any `bench` chunk or marker string is emitted.

## Running

```sh
# one scenario against this checkout (builds the bench app first; release, private target dir)
python3 scripts/app-lab/run.py --scenario tabs --target-dir /tmp/app-lab-target --report tabs.json

# measure a pristine revision instead of the working tree (HEAD or any rev, plus the overlay)
scripts/app-lab/export-tree.sh /tmp/app-lab-src HEAD
python3 scripts/app-lab/run.py --scenario tabs --source /tmp/app-lab-src --target-dir /tmp/app-lab-target

python3 scripts/app-lab/run.py --compare base.json [base2.json ...] --candidate cand.json
python3 scripts/app-lab/app_report.py report1.json report2.json    # one comparable line per report
```

Build time on an M4 (10 cores): cold release build including every dependency 2 min 14 s;
after a frontend or app change 88 to 90 s (the frontend itself 6 s). `--reuse-build` skips
the build, `--build-only` stops after it, `--app` runs a prebuilt `.app`.

Keep the machine awake and unlocked and do not touch the keyboard: the benchmark window must
stay visible, key and active. The orchestrator holds a display-sleep assertion
(`caffeinate -d -i -u`), refuses to start while another benchmark window (renderer lab, a second
app lab) is running or the session is locked, asks the page to bring the window back and report
a phase again when focus was taken (`qualification.retried`), and marks anything that still is
not a valid sample (`qualification.failures`). Building is fine alongside a run; CPU numbers are
not.

## Scenarios

| `--scenario` | What it does |
| --- | --- |
| `tabs` | shell tab plus agent tab (`--variant`: `sa` default, `saps` = shell, agent, split agent pair, shell, or any string of `s` shell, `b` block-mode shell, `a` agent, `p` split pair); switches `--cycles` (40) times with `--dwell-ms` (3000) dwell; baseline, one sample per switch, +10/+30 s idle |
| `resize` | one agent tab; 3 cycles of 120 live-resize steps (shrink then grow) through the web view's `viewWillStartLiveResize` / `viewDidEndLiveResize` |
| `occlusion` | window ordered out and back 20 times (3 s hidden, 2 s visible) |
| `agents-steady` | 1 visible plus 6 hidden agent tabs for 60 s |
| `idle` | one idle shell for 30 s |

Options that matter: `--window WxH` (default 1280x820 points), `--cwd-shell` / `--cwd-agent`
(different directories make the explorer and git panel follow the switch), `--vibrancy on|off`,
`--sampling light` (cheap counters only between full samples, see below), `--gc [private|alloc]`
(request a full garbage collection after the tail and sample again), `--instrument` (WebGPU, DOM
and IPC call counters with created/finalized wrapper counts), `--no-switch --hold-tab N`
(controls), `--toggle NAME=VALUE` (experiment toggles, below), `--iosurfaces` (every IOSurface
region from `vmmap -v`), `--valve EVERY_S:CHUNKS:MB` (allocation-pressure GC probe), `--probe`
(idle: remove one suspected wakeup source, e.g. `blur`), `--local-storage KEY=VALUE`.

### Experiment toggles

`--toggle NAME=VALUE` sets `localStorage["terax:bench:NAME"]` before the app starts; product code
may read it through `benchFlag` / `benchFlagOn` (`src/bench/flags.ts`, a constant `null` when
`__TERAX_BENCH__` is false). The hooks used for the tab-switch investigation touch files that
change often (`WebGpuTerminalSurface.ts`, `CanvasBackingStore.ts`, `useGhosttyTerminalSession.ts`,
`TerminalStack.tsx`), so they are kept as a patch against `ee836e1`:

```sh
scripts/app-lab/export-tree.sh /tmp/app-lab-exp HEAD
(cd /tmp/app-lab-exp && patch -p1 < scripts/app-lab/experiments/tab-switch-toggles.patch)
python3 scripts/app-lab/run.py --scenario tabs --variant saps --source /tmp/app-lab-exp \
    --target-dir /tmp/app-lab-target-exp --toggle fixed-backing=2560x1700
```

Toggles: `keep-attached` (surface stays in its pane when hidden), `keep-canvas` / `keep-gpu`
(do not release the canvas / buffers, atlas and canvas on hide), `keep-model` (skip
`releasePresentationResources`), `tab-display-none`, `fixed-backing=WxH` (every canvas gets one
backing size, so none is ever resized).

## Isolation

The bundle is `Terax App Lab.app` with the identifier `app.crynta.terax.app-lab`, launched with
its own `HOME` (so the control-server descriptor, shell-integration files and history never touch
the real user's) and `TERAX_BENCH_ISOLATED=1`. The bench binary refuses to start under the product
identifier or without that variable (`modules/bench.rs::guard`, unit tested), and the profile
directories for the lab identifier are removed before and after every run. The user's running app
is never touched. The shells are real login shells with an empty `HOME`; the agent is
`scripts/app-lab/agent-sim.mjs`, an Ink-like program (12-line region erased and rewritten every 80
ms, a spinner, 40 characters of token text every 50 ms, completed lines flushed into scrollback, a
bordered tool block every 7 s, 300 lines of history).

## What is measured

The scenario driver (`src/bench`, mounted by `App.tsx` only when `__TERAX_BENCH__`) uses the app's
own tab actions (`setActiveId`, `newTab`, `newAgentGroupTab`, `splitActivePane`) and
`whenSessionReady` / `writeToSession`. Each phase posts an event to the orchestrator's local HTTP
server (the `scripts/pty-smoke` pattern); the page waits until the orchestrator has sampled.

- Exact processes: host, WebContent, GPU and Networking pids come from the web view itself
  (`_webProcessIdentifier` and friends, `bench_window snapshot`), so attribution is exact even
  with other WebKit apps running. Children of the host (shells, node) are accounted as `PTY-procs`.
- `footprint -j` with categories per process, kept compact: `WebKit malloc`, `IOSurface` (own,
  shared groups, `reclaimable`), owned unmapped graphics, `JS VM Gigacage`, and the rest. `vmmap`
  summary for WebContent and GPU, rusage V6 CPU, energy, wakeups, instructions and cycles per
  process (the lab's `procstats`), a 0.25 to 1 s timeline of the same counters, WindowServer CPU.
- In-app diagnostics per phase: WASM linear memory per instance, canvas pool counters, surface
  backing-store resizes, GPU buffer sizes, presentation state, DOM size. The JS heap cannot be read
  (`performance.memory` does not exist in WebKit).
- Native window control (`bench_window`): stepped live resize, order out/front, miniaturize,
  native sleep, activation, and `_garbageCollectJavaScriptObjectsForTesting` for `--gc`.

Full sampling (`footprint` + `vmmap`) suspends the target for about a second per sample; the
`light` mode keeps only the cheap timeline between full samples every `--full-every` cycles, which
showed the same growth as full sampling.

## Tab-switch investigation (HEAD `ee836e1`)

All numbers are MiB of physical footprint on an Apple M4, macOS 26.6.2, a 1280x820 point window
on a 2048x1152 point display at 100 Hz, the release bench build of `ee836e1`, one run unless a
range is given. Reports are `resource-evidence-2026-10-15/app-baseline-*.json` (the scenarios) and
`app-exp-*.json` (the experiments below). `python3 scripts/app-lab/app_report.py app-exp-*.json`
prints one comparable line per report.

### Baselines

| Scenario | WebContent | GPU | host | total |
| --- | --- | --- | --- | --- |
| `tabs` shell + agent, baseline -> 40 switches +30 s | 156 -> 223 | 31 -> 23 | 36 -> 30 | 229 -> 283 |
| `tabs --variant saps` shell, agent, split pair, shell | 166 -> 663 | 36 -> 24 | 37 -> 31 | 246 -> 726 |
| `resize` 3 cycles of 120 live steps, peak | 136 -> 1175 | 81 -> 156 | 37 | 261 -> 1373 (141 WC again after 10 s) |
| `occlusion` 20 order-out/front cycles | 153 -> 165 | 123 -> 119 | 37 -> 30 | 319 -> 321 |

| CPU scenario (median of 3) | App CPU (of one core) | host / WC / GPU | PTY procs | wakeups/s | instructions |
| --- | --- | --- | --- | --- | --- |
| `agents-steady` 1 visible + 6 hidden agents, 60 s | 24.5 % (21.9 to 25.1) | 9.8 / 10.1 / 4.6 | 4.3 % | 1,058 (host 434) | 0.52 G/s |
| `idle` one shell, 30 s | 2.9 % | 1.4 / 1.1 / 0.4 | 0 | 270 (host 211) | 0.04 G/s |

Power in mW swings with core placement (119, 64, 60 for the three agents runs) while instructions
per second do not, so compare instructions. Switching to a tab whose agent is streaming adds about
95 MiB in the GPU process (the presented swapchain) and 33 MiB in WebContent, and takes them away
again a few seconds after switching back: that is the inherent cost of presenting a canvas, not the
growth.

### Root cause of the growth that does not come back

Two independent mechanisms. Both end in the same state: **dead, native-backed WebGPU objects stay
pinned in the WebContent process until JavaScriptCore garbage-collects their JavaScript wrappers,
and JavaScriptCore does not collect for minutes** (the JS heap stays small and WebKit does not count
the native weight). A forced full collection (`WKProcessPool._garbageCollectJavaScriptObjectsForTesting`,
`--gc`) returns all of it, to or below the starting level. That is consistent with the user's
observation that memory only returns when the display configuration changes (an event that
plausibly makes WebKit collect; not verified here), while the app itself never triggers one.

1. Canvas backing-store resizes (the large one). The canvas pool hands a returning pane the idle
   canvas with the closest size. When tabs have different pane geometry (a split tab and a
   full-size tab) every switch resizes a presented canvas, and each resize leaves the previous
   swapchain buffer (10.4 MiB at this window size) in WebContent's `IOSurface` category.

   | `tabs` run (40 switches, 3 s dwell) | backing-store resizes | WebContent IOSurface (dirty) | WebContent after +30 s | after forced GC |
   | --- | --- | --- | --- | --- |
   | shell + agent (same geometry) | 3 -> 5 | 76 -> 73 | +67 | not run |
   | shell, agent, split pair, shell | 6 -> 46 | 77 -> 474 | +497 (663) | 173 (IOSurface 46) |
   | same, light sampling (exp build, no toggles) | 6 -> 46 | 77 -> 518 | +494 | not run |
   | same, every canvas at one fixed 2560x1700 backing | 2 -> 3 | 116 -> 66 | +41 (247) | not run |

   The slope is 9 to 11 MiB per resize. The window-resize growth of the `resize` scenario (1.17 GiB
   in WebContent, back to 140 MiB about ten seconds after the drag, when a collection happened to
   run) is the same mechanism.

2. Per-frame WebGPU wrappers of a visible streaming agent (the small one). Each presented frame
   creates a canvas texture, a view and a command encoder wrapper; at 24 frames/s and 3 wrappers
   each, 4,473 of them were still unfinalized after 60 cycles (5.8 finalized per cycle). They pin
   about 12.6 KiB of WebKit malloc per frame (about 20 MiB/min), independent of tab switching:

   | 60 cycles, WebContent MiB | start | +30 s | after forced GC |
   | --- | --- | --- | --- |
   | agent stays visible, never switches (WebGPU) | 155 | 224 (+70, malloc 71 -> 129) | 163 |
   | the same with the WebGL renderer | 148 | 168 (+20) | 149 |
   | shell + agent switching (two runs) | 157, 156 | 213, 211 | 143, 143 |
   | two idle shells switching, no frames | 152 | 173 (+21) | 134 |
   | agent hidden for the whole run (no frames) | 155 | 134 (-20) | 131 |

Experiments that did **not** change anything (`tab-switch-toggles.patch`, 60 switches, shell + agent):
keep the surface attached (no DOM re-parenting) +50; keep GPU buffers, atlas and canvas (+50);
skip `releasePresentationResources` +45; `display:none` instead of `visibility:hidden` +55; the first
three together +49, versus +56 and +54 for the unmodified build. The hide/show path of the terminal
surface is not the cause. Window vibrancy on (+9), a 1900x1050 window (+11) and different working
directories per tab (explorer and git panel following the switch, +51) stayed inside the run-to-run
range (+5 to +67 over 40 switches).

A mitigation that works today: every 30 s the page allocates and drops four 64 MiB zero-filled
`ArrayBuffer`s (never touched, so not resident), which makes JavaScriptCore collect. With it the
agent-visible run stays flat (126 MiB, 144 at start) and the split-pair run ends at 147 instead of
663 (a sawtooth up to 280 meanwhile); it costs about 0.5 core-seconds per firing in WebContent.

### Recommended fix

1. Never resize a presented canvas on a tab switch: serve a pane only from an idle canvas whose
   backing already fits (`CanvasBackingStore.surplusFor`) and otherwise create one canvas per size
   class, instead of reallocating the closest one; drop parking, which is a resize too. One fixed
   window-sized backing per canvas also works (experiment above) but costs a window-sized swapchain
   per visible pane.
2. Reduce wrapper churn per frame (fewer `queue.writeBuffer` calls: 1.6 per frame today, one
   coalesced upload; cap streaming agents at a lower visible frame rate) and file the unfinalized
   canvas-texture wrappers with WebKit; the WebGL renderer does not show the growth.
3. Until then, a bounded allocation-pressure valve (above) keeps a long session from drifting.

### Idle wakeups and the focused terminal input

An idle app with one shell and a focused terminal costs 2.9 % of a core and 256 to 276 wakeups/s
(host 211), against 0.17 % and 9 wakeups/s once the focused `<textarea>` is blurred (`--probe blur`,
`app-exp-i2-idle-*.json`). `caret-color: transparent`, `caret-animation: manual`, `readonly`, a
zero-size or clipped textarea, and `content-visibility: hidden` all leave it at 220 to 280 wakeups/s. The page itself
is quiet in that state (no timers, no `requestAnimationFrame`, no animations, no IPC); the host
process wakes for WebKit's `CVDisplayLink` threads (ten created and torn down within 8 s of
sampling at 100 Hz) and the JavaScriptCore `libpas` scavenger. The renderer lab cannot show this: its
terminals never hold focus.

### WebKit malloc attribution (WebContent, fresh launch)

About 60 MiB of `WebKit malloc` at launch (before any terminal), of which two WASM instances
add about 4.6 MiB of linear memory (7 instances in `agents-steady`: 16.7 MiB), the DOM stays under
350 elements, and a forced collection frees about 10 MiB of garbage; the rest is the application
and WebKit itself. `performance.memory` does not exist in WebKit, so the JS heap itself
cannot be read from the page.


## Limits

macOS only, one display (2048x1152 points at 100 Hz here), fresh profile with default
preferences (vibrancy off), no AI panel traffic, a synthetic agent instead of Codex. Footprint
figures vary between runs because garbage collection timing decides when dead native objects
are released; compare medians of repeats and prefer the timeline floor and the after-GC value.

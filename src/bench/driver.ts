import { invoke } from "@tauri-apps/api/core";
import { setWindowVibrancy } from "@/modules/settings/store";
import { whenSessionReady, writeToSession } from "@/modules/terminal";
import {
  readTerminalClipboard,
  writeTerminalClipboard,
} from "@/modules/terminal/lib/terminalClipboard";
import { collectDiagnostics } from "./diagnostics";
import { nativeWindow, reportError, reportPhase } from "./report";
import type { BenchAppApi, BenchConfig, BenchScenario } from "./types";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Result = { ok?: boolean };

const macrotask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });

/**
 * A garbage collection requested from the page itself, with no testing SPI: external-memory
 * pressure (large ArrayBuffers) and object churn reach JavaScriptCore's collection heuristics
 * (the same probe as scripts/renderer-profile `--force-gc alloc`). Shows whether a pressure valve
 * inside the application could stand in for the SPI.
 */
async function allocateGarbage(): Promise<{
  ok: boolean;
  mode: string;
  chunks: number;
  objects: number;
}> {
  let chunks = 0;
  let objects = 0;
  for (let round = 0; round < 6; round++) {
    for (let index = 0; index < 4; index++) {
      const buffer = new Uint8Array(64 * 1024 * 1024);
      buffer[0] = index;
      chunks++;
      await macrotask();
    }
    let churn: object[] | null = Array.from({ length: 400_000 }, (_, i) => ({
      i,
      text: `g${i}`,
    }));
    objects += churn.length;
    churn = null;
    await macrotask();
  }
  return { ok: true, mode: "alloc", chunks, objects };
}

/**
 * Runs one scenario inside the real application, using the app's own tab actions and real PTYs,
 * and reports phase events to the orchestrator (scripts/app-lab/run.py).
 */
class ScenarioRun {
  constructor(
    private readonly reportUrl: string,
    readonly scenario: BenchScenario,
    readonly app: () => BenchAppApi,
  ) {}

  /**
   * Resolves when the orchestrator has sampled the processes for this phase. A sample is only
   * valid evidence with the window key and the app active; when the orchestrator finds focus was
   * taken (by another application, or the user) it asks for the phase again after the window
   * has been brought back.
   */
  async sync(
    phase: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (this.scenario.name !== "occlusion" || !phase.endsWith("-hidden"))
        await this.ensureFront();
      const app = this.app();
      const layers = await this.layerTree(phase);
      const { retry } = await reportPhase(this.reportUrl, phase, {
        ...extra,
        ...(layers ? { layers } : {}),
        attempt,
        refronted: this.refronted,
        diag: collectDiagnostics(app.tabs, app.activeId),
      });
      if (!retry) return;
      this.refronted += 1;
      await this.native({ cmd: "activate" });
      await pause(1000);
    }
  }

  async log(line: string): Promise<void> {
    await fetch(`${this.reportUrl}/log`, { method: "POST", body: line }).catch(
      () => undefined,
    );
  }

  /**
   * The web view's composited layer tree (UI-process mirror of WebKit's layers; see
   * `bench_window layers`). The full list is kept at rest, only the counts elsewhere.
   */
  async layerTree(phase: string): Promise<Record<string, unknown> | null> {
    const full = /^(baseline|setup-complete|measure-start)$/.test(phase);
    const brief = /^(shrink-1|grow-1|resize-settled)$/.test(phase);
    if (!full && !brief) return null;
    try {
      const tree = await this.native({ cmd: "layers" });
      // The document must never scroll (a drag-time overflow strip is not interactive).
      const root = document.scrollingElement;
      const page = {
        scroll: [window.scrollX, window.scrollY],
        scrollSize: [root?.scrollWidth ?? 0, root?.scrollHeight ?? 0],
        viewport: [window.innerWidth, window.innerHeight],
        liveResize: document.documentElement.hasAttribute("data-live-resize"),
      };
      if (full) return { ...tree, page };
      const { layers: _list, ...counts } = tree;
      return { ...counts, page };
    } catch {
      return null;
    }
  }

  async waitFor(
    condition: () => boolean,
    what: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const start = performance.now();
    while (!condition()) {
      if (performance.now() - start > timeoutMs)
        throw new Error(`timed out waiting for ${what}`);
      await pause(50);
    }
  }

  /** The restore/boot flow finished and a terminal tab exists. */
  async booted(): Promise<{ tabId: number; leafId: number }> {
    await this.waitFor(
      () =>
        this.app().booted && this.app().tabs.some((t) => t.kind === "terminal"),
      "app boot",
      60_000,
    );
    const tab = this.app().tabs.find((t) => t.kind === "terminal");
    if (tab?.kind !== "terminal") throw new Error("no terminal tab after boot");
    if (this.scenario.prefs?.windowVibrancy !== undefined) {
      await setWindowVibrancy(this.scenario.prefs.windowVibrancy);
      await pause(1500);
    }
    await this.frontWindow();
    await this.sessionReady(tab.activeLeafId);
    return { tabId: tab.id, leafId: tab.activeLeafId };
  }

  async sessionReady(leafId: number): Promise<void> {
    // Waits for the session to exist and its shell to start; throws on timeout.
    await whenSessionReady(leafId, 30_000);
  }

  /** Types the agent command into a real shell and waits until it is drawing. */
  async startAgent(leafId: number, extraArgs = ""): Promise<void> {
    await this.sessionReady(leafId);
    const command = `${this.scenario.agentCommand} ${extraArgs}`.trim();
    if (!writeToSession(leafId, `${command}\r`))
      throw new Error(`terminal ${leafId} refused the agent command`);
    await this.waitFor(
      () => (this.app().readBuffer(leafId, 60) ?? "").includes("Thinking"),
      `agent output in terminal ${leafId}`,
    );
  }

  async newAgentTab(
    title: string,
    extraArgs = "",
  ): Promise<{ tabId: number; leafId: number }> {
    const { tabId, leafIds } = this.app().newAgentGroupTab(
      this.scenario.cwds?.agent,
      title,
      1,
    );
    await this.waitFor(
      () => this.app().tabs.some((t) => t.id === tabId),
      "new tab",
    );
    await this.startAgent(leafIds[0], extraArgs);
    return { tabId, leafId: leafIds[0] };
  }

  async newShellTab(
    blocks = false,
  ): Promise<{ tabId: number; leafId: number }> {
    const cwd = this.scenario.cwds?.shell;
    const tabId = blocks ? this.app().newBlockTab(cwd) : this.app().newTab(cwd);
    await this.waitFor(
      () => this.app().tabs.some((t) => t.id === tabId),
      "new tab",
    );
    const tab = this.app().tabs.find((t) => t.id === tabId);
    if (tab?.kind !== "terminal") throw new Error("new tab is not a terminal");
    await this.sessionReady(tab.activeLeafId);
    return { tabId, leafId: tab.activeLeafId };
  }

  select(tabId: number): void {
    this.app().setActiveId(tabId);
  }

  async native(
    action: Record<string, unknown>,
  ): Promise<Result & Record<string, unknown>> {
    return nativeWindow<Result & Record<string, unknown>>(action);
  }

  /** Brings the window to the front at the scenario's size and waits until it is key and active. */
  async frontWindow(): Promise<void> {
    const size = this.scenario.window;
    if (size)
      await this.native({
        cmd: "setSize",
        width: size.width,
        height: size.height,
      });
    const front = await this.native({ cmd: "activate" });
    if (!front.ok)
      throw new Error("benchmark window could not become key and active");
  }

  /**
   * Another application (or the user) may take activation between samples; a sample is only
   * valid evidence with the window key and the app active, so ask for it back first.
   */
  async ensureFront(): Promise<void> {
    const state = await this.native({ cmd: "snapshot" });
    if (state.appActive && state.key && state.occlusionVisible) return;
    this.refronted += 1;
    await this.native({ cmd: "activate" });
    await pause(300);
  }

  refronted = 0;

  /**
   * With `scenario.gc`, asks WebKit for a full garbage collection (WKProcessPool testing SPI) and
   * samples again: what is still held afterwards is not JavaScript garbage.
   */
  async collectGarbage(): Promise<void> {
    const mode = this.scenario.gc;
    if (!mode) return;
    const gc =
      mode === "alloc"
        ? await allocateGarbage()
        : await this.native({ cmd: "gc" });
    await pause(2000);
    await this.sync("post-gc+2s", { gc });
    await pause(8000);
    await this.sync("post-gc+10s");
  }

  /**
   * Mitigation probe: every `everyS` seconds the page allocates and drops `chunks` zero-filled
   * ArrayBuffers of `chunkMb` MiB (never touched, so not resident) to push JavaScriptCore into a
   * full collection, which releases the native objects pinned by dead WebGPU wrappers. Not a
   * product feature; it shows whether an in-app valve could replace the testing SPI.
   */
  startValve(): void {
    const valve = this.scenario.valve;
    if (!valve) return;
    const run = async () => {
      for (let index = 0; index < valve.chunks; index++) {
        const buffer = new Uint8Array(valve.chunkMb * 1024 * 1024);
        buffer[0] = index;
        await macrotask();
      }
    };
    setInterval(() => void run(), valve.everyS * 1000);
  }

  /** Idle settle samples shared by the cycling scenarios. */
  async settle(): Promise<void> {
    await pause(10_000);
    await this.sync("end+10s");
    await pause(20_000);
    await this.sync("end+30s");
    await this.collectGarbage();
  }
}

/**
 * Tab layout as a string, one letter per tab: s = idle shell, b = idle shell in command-block mode
 * (its pane is shorter: the command bar takes the bottom), a = agent, p = a tab split into two
 * agent panes. "sa" (alias "2"): shell + agent; "saps" (alias "4"): shell, agent, split pair, shell.
 */
function tabKinds(variant: string | undefined): string {
  if (!variant || variant === "2") return "sa";
  if (variant === "4") return "saps";
  if (!/^[sbap]+$/.test(variant))
    throw new Error(`unknown tabs variant ${variant}`);
  return variant;
}

async function tabsScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const kinds = tabKinds(scenario.variant);
  const cycles = scenario.cycles ?? 40;
  const dwellMs = scenario.dwellMs ?? 3000;
  const first = await run.booted();
  run.startValve();
  const order = [first.tabId];
  const leaves: number[][] = [[first.leafId]];
  if (kinds[0] === "a" || kinds[0] === "p") await run.startAgent(first.leafId);
  for (let index = 1; index < kinds.length; index++) {
    const kind = kinds[index];
    if (kind === "s" || kind === "b") {
      const tab = await run.newShellTab(kind === "b");
      order.push(tab.tabId);
      leaves.push([tab.leafId]);
    } else {
      const tab = await run.newAgentTab(
        kind === "p" ? "agent pair" : "agent",
        `--seed ${index + 1}`,
      );
      const group = [tab.leafId];
      if (kind === "p") {
        run.select(tab.tabId);
        await pause(500);
        const second = run.app().splitActivePane(tab.tabId, "row");
        if (second === null) throw new Error("split refused");
        await run.startAgent(second, `--seed ${index + 11}`);
        group.push(second);
      }
      order.push(tab.tabId);
      leaves.push(group);
    }
  }
  // The tab shown at baseline (and for the whole run with `noSwitch`): index into the tab order.
  const home = order[scenario.holdTab ?? 0] ?? first.tabId;
  run.select(home);
  await pause(5000);
  await run.sync("setup", { variant: kinds, cycles, dwellMs, order, leaves });
  await pause(2000);
  await run.sync("baseline", { cycle: 0, tab: home });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const target = order[((scenario.holdTab ?? 0) + cycle) % order.length];
    const switchedAt = Date.now();
    // Control run (`noSwitch`): identical timing, samples and workload but the tab never changes.
    if (!scenario.noSwitch) run.select(target);
    await pause(dwellMs);
    await run.sync(`switch-${cycle}`, {
      cycle,
      step: "visible",
      tab: target,
      switchedAt,
    });
  }
  await run.sync("cycles-complete");
  await run.settle();
}

async function resizeScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const cycles = scenario.cycles ?? 3;
  const steps = scenario.steps ?? 120;
  const stepPoints = scenario.stepPoints ?? 4;
  const intervalMs = scenario.stepIntervalMs ?? 16;
  const live = scenario.live ?? true;
  const first = await run.booted();
  await run.startAgent(first.leafId, "--history 3000");
  await pause(3000);
  await run.sync("setup", { cycles, steps, stepPoints, intervalMs, live });
  await pause(2000);
  await run.sync("baseline", { cycle: 0 });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const shrink = await run.native({
      cmd: "resizeSteps",
      dw: -stepPoints,
      dh: -stepPoints / 2,
      count: steps,
      intervalMs,
      live,
      layersMid: cycle === 1,
    });
    await run.sync(`shrink-${cycle}`, {
      cycle,
      step: "shrink",
      resize: shrink,
    });
    const grow = await run.native({
      cmd: "resizeSteps",
      dw: stepPoints,
      dh: stepPoints / 2,
      count: steps,
      intervalMs,
      live,
    });
    await run.sync(`grow-${cycle}`, { cycle, step: "grow", resize: grow });
  }
  await pause(1500);
  await run.sync("resize-settled");
  await run.settle();
}

async function occlusionScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const cycles = scenario.cycles ?? 20;
  const hiddenMs = scenario.hiddenMs ?? 3000;
  const visibleMs = scenario.visibleMs ?? 2000;
  const first = await run.booted();
  await run.startAgent(first.leafId);
  await pause(3000);
  await run.sync("setup", { cycles, hiddenMs, visibleMs });
  await pause(2000);
  await run.sync("baseline", { cycle: 0 });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const hide = await run.native({ cmd: "hide", mode: "orderout" });
    await run.native({ cmd: "sleep", ms: hiddenMs });
    await run.sync(`cycle-${cycle}-hidden`, { cycle, step: "hidden", hide });
    const show = await run.native({ cmd: "show", mode: "orderout" });
    await pause(visibleMs);
    await run.sync(`cycle-${cycle}-visible`, { cycle, step: "visible", show });
  }
  await run.sync("cycles-complete");
  await run.settle();
}

async function agentsSteadyScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const durationS = scenario.durationS ?? 60;
  const warmupS = scenario.warmupS ?? 5;
  const hidden = scenario.hiddenAgents ?? 6;
  const first = await run.booted();
  await run.startAgent(first.leafId);
  for (let i = 0; i < hidden; i++)
    await run.newAgentTab(`agent ${i + 2}`, `--seed ${i + 2}`);
  run.select(first.tabId);
  await pause(warmupS * 1000);
  await run.sync("setup-complete", { hiddenAgents: hidden });
  await run.sync("measure-start", { durationS });
  const start = performance.now();
  await pause(durationS * 1000);
  await run.sync("measure-end", { elapsedMs: performance.now() - start });
  await run.collectGarbage();
}

/** Idle-wakeup probes: take away one suspected source of page-driven display refreshes. */
const IDLE_PROBE_CSS: Record<string, string> = {
  selection:
    "textarea[aria-label='Terminal input']::selection { background: transparent !important; color: transparent !important; }",
  "caret-transparent":
    "textarea, input { caret-color: transparent !important; }",
  "caret-animation-manual":
    "textarea, input { caret-animation: manual !important; }",
  "zero-size":
    "textarea[aria-label='Terminal input'] { width: 0 !important; height: 0 !important; padding: 0 !important; border: 0 !important; }",
  clip: "textarea[aria-label='Terminal input'] { clip-path: inset(50%) !important; }",
  "display-contents":
    "textarea[aria-label='Terminal input'] { contain: strict !important; content-visibility: hidden !important; }",
};

function applyIdleProbe(probe: string | undefined): void {
  if (probe === "blur") (document.activeElement as HTMLElement | null)?.blur();
  if (probe === "selection") {
    const el = document.activeElement;
    if (el instanceof HTMLTextAreaElement) {
      el.value = "\u00a0";
      el.setSelectionRange(0, 1);
    }
  }
  if (probe === "selection-nofocus-div") {
    const div = document.createElement("div");
    div.tabIndex = -1;
    document.body.append(div);
    div.focus({ preventScroll: true });
  }
  if (probe === "readonly") {
    for (const input of document.querySelectorAll<HTMLTextAreaElement>(
      "textarea",
    ))
      input.readOnly = true;
  }
  const css = probe ? IDLE_PROBE_CSS[probe] : undefined;
  if (css) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
}

async function idleScenario(run: ScenarioRun): Promise<void> {
  const durationS = run.scenario.durationS ?? 30;
  const warmupS = run.scenario.warmupS ?? 5;
  await run.booted();
  applyIdleProbe(run.scenario.probe);
  await pause(warmupS * 1000);
  await run.sync("setup-complete");
  await run.sync("measure-start", { durationS });
  const start = performance.now();
  await pause(durationS * 1000);
  await run.sync("measure-end", { elapsedMs: performance.now() - start });
  await run.collectGarbage();
}

const CMD = 1 << 20;
const OPT = 1 << 19;
const CTRL = 1 << 18;
const SHIFT = 1 << 17;

type KeyStroke = {
  chars: string;
  code: number;
  flags?: number;
  ignoring?: string;
};

const INPUT_READER =
  'python3 -u -c \'import os,tty;tty.setraw(0);print("READY",end="\\r\\n");[print("RX:"+os.read(0,256).hex(),end="\\r\\n") for _ in iter(int,1)]\'';

const hex = (text: string) =>
  Array.from(new TextEncoder().encode(text), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Real WKWebView input: native key events (`sendEvent:`, through the system input context) and
 * the input method's `NSTextInputClient` calls, with a raw-mode reader in the PTY printing the
 * bytes it receives. Results go to the orchestrator's page.log as `[input-check]` lines.
 */
async function inputScenario(run: ScenarioRun): Promise<void> {
  const { leafId } = await run.booted();
  const textarea = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Terminal input']",
    );
  const armed = () => {
    const el = textarea();
    return (
      el !== null &&
      el.value === "\u00a0" &&
      el.selectionStart === 0 &&
      el.selectionEnd === 1 &&
      document.activeElement === el
    );
  };
  const results: string[] = [];
  const report = async (line: string) => {
    results.push(line);
    await run.log(`[input-check] ${line}`);
  };
  textarea()?.focus();
  writeToSession(leafId, `${INPUT_READER}\r`);
  await run.waitFor(
    () => (run.app().readBuffer(leafId, 100) ?? "").includes("READY"),
    "input reader",
  );
  let seen = 0;
  const received = () =>
    (run.app().readBuffer(leafId, 300) ?? "")
      .split("\n")
      .map((line) => /RX:([0-9a-f]+)/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
  const key = async (stroke: KeyStroke, repeat = false) => {
    for (const up of [false, true]) {
      await run.native({
        cmd: "key",
        chars: stroke.chars,
        charsIgnoringModifiers: stroke.ignoring ?? stroke.chars,
        keyCode: stroke.code,
        flags: stroke.flags ?? 0,
        up,
        repeat: repeat && !up,
      });
      await pause(15);
    }
  };
  const text = async (op: string, value = "") => {
    await run.native({ cmd: "text", op, text: value });
  };
  const check = async (
    name: string,
    expected: string,
    action: () => Promise<void>,
  ) => {
    await action();
    await pause(400);
    const all = received();
    const got = all.slice(seen).join("");
    seen = all.length;
    const ok = got === expected;
    await report(
      `${ok ? "PASS" : "FAIL"} ${name}: got ${got || "-"} want ${expected} armed=${armed()}`,
    );
  };
  const A = { chars: "a", code: 0 };
  await key(A);
  await pause(300);
  seen = received().length;
  await report(`warm-up key delivered=${seen}`);
  await check("plain a", "61", () => key(A));
  await check("shift+z", "5a", () =>
    key({ chars: "Z", ignoring: "z", code: 6, flags: SHIFT }),
  );
  await check("return", "0d", () => key({ chars: "\r", code: 36 }));
  await check("backspace", "7f", () => key({ chars: "\u007f", code: 51 }));
  await check("tab", "09", () => key({ chars: "\t", code: 48 }));
  await check("left arrow", "1b5b44", () =>
    key({ chars: "\uf702", code: 123, flags: 1 << 23 }),
  );
  await check("ctrl+c", "03", () =>
    key({ chars: "\u0003", ignoring: "c", code: 8, flags: CTRL }),
  );
  await check("option+a (å)", "c3a5", () =>
    key({ chars: "å", ignoring: "a", code: 0, flags: OPT }),
  );
  await check("repeat x5", "6262626262", async () => {
    for (let index = 0; index < 5; index++)
      await key({ chars: "b", code: 11 }, index > 0);
  });
  // Synthetic NSEvents do not reach the keyboard layout's dead-key state, so the dead key is
  // driven the way the system delivers it: marked "´" (compositionstart), then "é" committed.
  await check("dead key option+e, e (marked + commit)", "c3a9", async () => {
    await text("setMarked", "\u00b4");
    await pause(100);
    await report(
      `dead-key mid-composition value=${JSON.stringify(textarea()?.value)}`,
    );
    await text("insert", "\u00e9");
  });
  await check("IME marked + commit", "e697a5e69cac", async () => {
    await text("setMarked", "に");
    await pause(100);
    const first = textarea()?.value;
    await text("setMarked", "にほ");
    await pause(100);
    const second = textarea()?.value;
    await report(
      `ime mid-composition values=${JSON.stringify([first, second])}`,
    );
    await text("insert", "日本");
  });
  await check("IME commit then key", "e38182" + "61", async () => {
    await text("setMarked", "あ");
    await pause(50);
    await text("insert", "あ");
    await pause(100);
    await key(A);
  });
  await check("emoji insertText", hex("😀"), () => text("insert", "😀"));
  const saved = await readTerminalClipboard();
  await writeTerminalClipboard("pasted-text");
  await check("cmd+v paste", hex("pasted-text"), () =>
    key({ chars: "v", code: 9, flags: CMD }),
  );
  await writeTerminalClipboard("SENTINEL");
  await key({ chars: "c", code: 8, flags: CMD });
  await pause(300);
  const afterCopy = await readTerminalClipboard();
  await report(
    `${afterCopy === "SENTINEL" ? "PASS" : "FAIL"} cmd+c without selection leaves clipboard: ${JSON.stringify(afterCopy)}`,
  );
  await check("cmd+a then x", "78", async () => {
    await key({ chars: "a", code: 0, flags: CMD });
    await key({ chars: "x", code: 7 });
  });
  await writeTerminalClipboard(saved);
  const first = run.app().activeId;
  await check("tab switch away and back, then a", "61", async () => {
    const second = await run.newShellTab();
    await pause(500);
    run.select(second.tabId);
    await pause(500);
    run.select(first);
    await pause(800);
    await key(A);
  });
  await check("window ordered out and back, then a", "61", async () => {
    await run.native({ cmd: "hide", mode: "orderout" });
    await pause(1500);
    await run.native({ cmd: "show", mode: "orderout" });
    await pause(1000);
    await key(A);
  });
  await report(`final armed=${armed()}`);
  await report(
    `summary ${results.filter((line) => line.startsWith("FAIL")).length} failures of ${results.filter((line) => /^(PASS|FAIL)/.test(line)).length}`,
  );
}

const SCENARIOS: Record<
  BenchScenario["name"],
  (run: ScenarioRun) => Promise<void>
> = {
  tabs: tabsScenario,
  resize: resizeScenario,
  occlusion: occlusionScenario,
  "agents-steady": agentsSteadyScenario,
  idle: idleScenario,
  input: inputScenario,
};

let started = false;

/** Starts the configured scenario once the application has mounted; no-op without one. */
export async function startBenchDriver(app: () => BenchAppApi): Promise<void> {
  if (started) return;
  const config = (window as unknown as { __teraxBenchConfig?: BenchConfig })
    .__teraxBenchConfig;
  if (!config?.scenario || !config.reportUrl) return;
  started = true;
  const run = new ScenarioRun(config.reportUrl, config.scenario, app);
  try {
    await pause(1500);
    await run.sync("blank", { identifier: config.identifier });
    await SCENARIOS[config.scenario.name](run);
    await run.sync("done");
  } catch (error) {
    console.error("[bench] scenario failed:", error);
    await reportError(config.reportUrl, error);
  } finally {
    await invoke("bench_exit").catch(() => undefined);
  }
}

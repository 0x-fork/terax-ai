import { invoke } from "@tauri-apps/api/core";
import {
  openPty,
  ptyTransportDiagnostics,
} from "@/modules/terminal/lib/pty-bridge";
import { setLeafPresentation } from "@/modules/terminal/lib/ptyPresentation";
import type { Driver } from "./scenarios";

const realFetch = window.fetch.bind(window);
const wire = { polls: 0, acks: 0, responses: 0, ipcInvokes: 0 };
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : String(input);
  if (url.includes("terax-pty")) {
    if (url.endsWith("/poll")) wire.polls++;
    else wire.acks++;
  } else if (url.startsWith("ipc://") || url.includes("ipc.localhost")) {
    wire.ipcInvokes++;
  }
  return realFetch(input, init);
}) as typeof window.fetch;

export const driver: Driver = {
  name: "multiplexed pull stream (terax-pty)",
  openPty,
  setPresentation: setLeafPresentation,
  // A poll and its response are one round trip; ack-only requests are extra.
  streamOps: () => wire.polls + wire.acks,
  breakdown: () => ({ ...wire }),
  native: () => invoke("pty_diagnostics"),
  jsHub: () => ptyTransportDiagnostics().hub,
  realFetch,
};

import { createProxyFetch } from "@/modules/ai/lib/proxyFetch";
import {
  saveMessages,
  loadMessages,
  deleteSessionData,
  flushSessionWrites,
} from "@/modules/ai/lib/sessions";
import { getCurrentWindow } from "@tauri-apps/api/window";
const original = fetch;
const nativeFetch = createProxyFetch({ allowPrivateNetwork: true });
declare const __TERAX_IPC_BASE_URL__: string;
const base = __TERAX_IPC_BASE_URL__;
async function run() {
  const output: Record<string, boolean> = {};
  const payload = "raw body λ 日本語\n".repeat(10000);
  const response = await nativeFetch(base + "/echo", {
    method: "POST",
    body: payload,
  });
  output.rawBody = (await response.text()) === payload;
  const bulk = await nativeFetch(base + "/bulk");
  await new Promise((r) => setTimeout(r, 300));
  const content = await bulk.text();
  output.boundedConsumer =
    content.length === 1024 * 1024 &&
    content.startsWith("ABCD") &&
    content.endsWith("ABCD");
  const controller = new AbortController();
  const slow = await nativeFetch(base + "/slow", { signal: controller.signal });
  if (!slow.body) throw new Error("Missing streaming response");
  const reader = slow.body.getReader();
  await reader.read();
  controller.abort();
  try {
    await reader.read();
    output.abort = false;
  } catch (e) {
    output.abort = e instanceof DOMException && e.name === "AbortError";
  }
  await saveMessages("ipc-smoke", [
    {
      id: "one",
      role: "user",
      parts: [{ type: "text", text: "isolated storage check" }],
    },
  ]);
  output.stored = (await loadMessages("ipc-smoke"))?.[0]?.id === "one";
  await deleteSessionData("ipc-smoke");
  await flushSessionWrites();
  output.deleted = (await loadMessages("ipc-smoke")) === null;
  document.querySelector("#result")!.textContent = JSON.stringify(
    output,
    null,
    2,
  );
  await new Promise((r) => setTimeout(r, 200));
  await original(base + "/report", {
    method: "POST",
    body: JSON.stringify(output),
  });
  await getCurrentWindow().close();
}
run().catch(async (error) => {
  document.querySelector("#result")!.textContent = String(error);
  await original(base + "/report", {
    method: "POST",
    body: JSON.stringify({ error: String(error), stack: error.stack }),
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@ai-sdk/react";

const storage = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const files = new Map<string, unknown>();
  const invoke = vi.fn(
    async (
      command: string,
      args: { id: string; messages?: unknown; migrate?: boolean },
    ) => {
      if (command === "ai_session_save") {
        if (!args.migrate || !files.has(args.id))
          files.set(args.id, args.messages);
      }
      if (command === "ai_session_load") return files.get(args.id) ?? null;
      if (command === "ai_session_delete") files.delete(args.id);
    },
  );
  const entries = vi.fn(async () => [...data.entries()]);
  const save = vi.fn(async () => {});
  class LazyStore {
    get = vi.fn(async (key: string) => data.get(key));
    set = vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    });
    delete = vi.fn(async (key: string) => {
      data.delete(key);
    });
    keys = vi.fn(async () => [...data.keys()]);
    entries = entries;
    save = save;
  }
  return { data, files, invoke, entries, save, LazyStore };
});
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: storage.LazyStore }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: storage.invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));
async function reload() {
  vi.resetModules();
  return import("@/modules/ai/lib/sessions");
}

beforeEach(() => {
  storage.data.clear();
  storage.files.clear();
  storage.invoke.mockClear();
  storage.entries.mockClear();
  storage.save.mockClear();
});
const message = (id: string) =>
  [{ id, role: "user", parts: [] }] as UIMessage[];

describe("session persistence", () => {
  it("reads metadata without enumerating all conversation values", async () => {
    const mod = await reload();
    await expect(mod.loadAll()).resolves.toEqual({
      sessions: [],
      activeId: null,
    });
    const sessions = [{ id: "s-1", title: "T", createdAt: 1, updatedAt: 2 }];
    storage.data.set("sessions", sessions);
    storage.data.set("activeId", "s-1");
    storage.files.set("s-1", message("retained on disk"));
    await expect(mod.loadAll()).resolves.toEqual({ sessions, activeId: "s-1" });
    expect(storage.entries).not.toHaveBeenCalled();
    expect(storage.invoke).not.toHaveBeenCalled();
  });

  it("migrates legacy messages before removing their keys and preserves a newer file on retry", async () => {
    storage.data.set("messages:s-1", message("legacy"));
    storage.data.set("messages:s-2", message("other"));
    storage.files.set("s-1", message("newer"));
    const mod = await reload();
    await mod.loadAll();
    expect(storage.files.get("s-1")).toEqual(message("newer"));
    expect(storage.files.get("s-2")).toEqual(message("other"));
    expect([...storage.data.keys()]).toEqual([]);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.entries).not.toHaveBeenCalled();
    await mod.loadAll();
    expect(storage.invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps a legacy record when migration fails and retries safely", async () => {
    storage.data.set("messages:s-1", message("legacy"));
    storage.invoke.mockRejectedValueOnce(new Error("disk full"));
    const mod = await reload();
    await expect(mod.loadAll()).rejects.toThrow("disk full");
    expect(storage.data.has("messages:s-1")).toBe(true);
    await mod.loadAll();
    expect(storage.files.get("s-1")).toEqual(message("legacy"));
    expect(storage.data.has("messages:s-1")).toBe(false);
  });

  it("writes metadata independently and flushes both metadata and message writes", async () => {
    const mod = await reload();
    const sessions = [{ id: "s-9", title: "X", createdAt: 0, updatedAt: 0 }];
    void mod.saveSessionsList(sessions);
    void mod.saveActiveId("s-9");
    void mod.saveMessages("s-9", message("saved"));
    await mod.flushSessionWrites();
    expect(storage.data.get("sessions")).toEqual(sessions);
    expect(storage.data.get("activeId")).toBe("s-9");
    expect(storage.files.get("s-9")).toEqual(message("saved"));
    expect(storage.data.has("messages:s-9")).toBe(false);
  });

  it("serializes saves and deletion so an older write cannot resurrect a deleted session", async () => {
    const mod = await reload();
    await mod.loadAll();
    let release!: () => void;
    storage.invoke.mockImplementationOnce(async (_command, args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      storage.files.set(args.id, args.messages);
    });
    const writing = mod.saveMessages("s-1", message("old"));
    const deleting = mod.deleteSessionData("s-1");
    await vi.waitFor(() => expect(storage.invoke).toHaveBeenCalledOnce());
    release();
    await Promise.all([writing, deleting]);
    expect(storage.files.has("s-1")).toBe(false);
    expect(storage.invoke.mock.calls.map(([command]) => command)).toEqual([
      "ai_session_save",
      "ai_session_delete",
    ]);
    await expect(mod.loadMessages("s-1")).resolves.toBeNull();
  });

  it("retries a failed latest save before closing without replaying a superseded failure", async () => {
    const mod = await reload();
    await mod.loadAll();
    storage.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(mod.saveMessages("s-1", message("retry"))).rejects.toThrow(
      "disk full",
    );
    await mod.flushSessionWrites();
    expect(storage.files.get("s-1")).toEqual(message("retry"));

    storage.invoke.mockRejectedValueOnce(new Error("temporary failure"));
    const old = mod.saveMessages("s-1", message("old"));
    const latest = mod.saveMessages("s-1", message("latest"));
    await expect(old).rejects.toThrow("temporary failure");
    await latest;
    await mod.flushSessionWrites();
    expect(storage.files.get("s-1")).toEqual(message("latest"));
  });
});

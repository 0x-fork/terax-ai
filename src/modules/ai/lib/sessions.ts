import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { toast } from "sonner";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const STORE_PATH = "terax-ai-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

let migration: Promise<void> | null = null;
const operations = new Map<string, Promise<unknown>>();
const notices = new Set<string>();
const writes = new Map<
  string,
  { operation: () => Promise<void>; failed: boolean }
>();

function migrateMessages(): Promise<void> {
  migration ??= (async () => {
    const keys = await store.keys();
    const legacy = keys.filter((key) => key.startsWith("messages:"));
    for (const key of legacy) {
      const messages = await store.get<UIMessage[]>(key);
      if (messages !== undefined && messages !== null) {
        await invoke("ai_session_save", {
          id: key.slice(9),
          messages,
          migrate: true,
        });
      }
      await store.delete(key);
    }
    if (legacy.length > 0) await store.save();
  })().catch((error) => {
    migration = null;
    throw error;
  });
  return migration;
}

function serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operations.set(id, next);
  void next
    .finally(() => {
      if (operations.get(id) === next) operations.delete(id);
    })
    .catch(() => {});
  return next;
}

function write(id: string, operation: () => Promise<void>): Promise<void> {
  const ticket = { operation, failed: false };
  writes.set(id, ticket);
  const pending = serial(id, operation);
  void pending.then(
    () => {
      if (writes.get(id) !== ticket) return;
      writes.delete(id);
      if (notices.delete(id)) toast.dismiss(`conversation-save:${id}`);
    },
    (error) => {
      if (writes.get(id) !== ticket) return;
      ticket.failed = true;
      notices.add(id);
      toast.error("Could not save conversation", {
        id: `conversation-save:${id}`,
        duration: Number.POSITIVE_INFINITY,
        description: String(error),
        action: {
          label: "Retry",
          onClick: () => {
            const latest = writes.get(id);
            if (latest?.failed)
              void write(id, latest.operation).catch(() => {});
          },
        },
      });
    },
  );
  return pending;
}

export async function loadAll(): Promise<LoadedSessions> {
  await migrateMessages();
  const [sessions, activeId] = await Promise.all([
    store.get<SessionMeta[]>(KEY_SESSIONS),
    store.get<string>(KEY_ACTIVE),
  ]);
  return { sessions: sessions ?? [], activeId: activeId ?? null };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  await migrateMessages();
  return serial(id, () =>
    invoke<UIMessage[] | null>("ai_session_load", { id }),
  );
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await serial("$metadata", () => store.set(KEY_SESSIONS, sessions));
}

export async function saveActiveId(id: string | null): Promise<void> {
  await serial("$metadata", () => store.set(KEY_ACTIVE, id));
}

export function saveMessages(id: string, messages: UIMessage[]): Promise<void> {
  return write(id, async () => {
    await migrateMessages();
    await invoke("ai_session_save", { id, messages });
  });
}

export function deleteSessionData(id: string): Promise<void> {
  return write(id, async () => {
    await migrateMessages();
    await invoke("ai_session_delete", { id });
  });
}

export async function flushSessionWrites(): Promise<void> {
  for (const [id, ticket] of [...writes]) {
    if (ticket.failed) void write(id, ticket.operation).catch(() => {});
  }
  while (operations.size > 0) await Promise.all([...operations.values()]);
  await store.save();
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}

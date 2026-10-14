# PTY transport v2: one multiplexed pull stream per window

Status: in implementation on `perf/resource-efficiency`.

## Why

v1 gives each PTY its own `tauri::ipc::Channel` plus a flusher thread. In
Tauri 2.11 (`ipc/channel.rs`), each send is delivered one of two ways:

- **Under 1 KiB:** `webview.eval("new Uint8Array([27,91,...])")`. The payload
  is a JSON number array that has to be compiled as a script.
- **1 KiB or more:** `webview.eval(...)` followed by a second
  `plugin:__TAURI_CHANNEL__|fetch` round trip.

Each delivered chunk is then acknowledged by a separate synchronous
`pty_ack_output` invoke. Synchronous commands run on the macOS main thread, and
the two-message credit window forces one acknowledgement per chunk. That means
about three cross-process hops and three main-thread tasks per chunk per
terminal, and hidden tabs pay the same as the visible one. Ten agent tabs at
10–30 Hz come to hundreds of main-thread round trips per second.

## Design

### Pull stream

- An asynchronous custom URI scheme, `terax-pty`, registered with
  `register_asynchronous_uri_scheme_protocol`. The frontend keeps exactly one
  outstanding `POST poll` request per webview. The URL is built with
  `convertFileSrc`-style platform rules: `terax-pty://localhost/poll`, or
  `http://terax-pty.localhost/poll` on Windows. CSP `connect-src` is updated.
- **Request body:** acknowledgements as repeated
  `[u32 pty_id][u64 cumulative_parsed_bytes]`, little-endian, plus the
  webview's stream generation.
- **Response:** sent when at least one PTY's output is due, as repeated frames
  of `[u32 pty_id][u8 kind][u32 len][payload]`:
  - `kind = data`: raw bytes.
  - `kind = exit`: `i32` code.
  - `kind = failed`: UTF-8 reason.
  A response carries many PTYs and many chunks. Its size is capped (for
  example 1 MiB), and anything left over goes in the next poll.
- **Acknowledgements while a poll is held.** An ack-only `POST ack` is sent
  only when a poll is outstanding and some PTY's unacknowledged bytes exceed
  half its window, which only happens during floods. The hub applies it,
  wakes, and answers immediately.

### Hub

There is one hub thread per process, keyed by webview label. It holds the
outstanding responder per webview and replaces every per-PTY flusher thread.

Readers push into their PTY queue (existing bounded `OutputQueue`) and notify
the hub. The hub picks a coalescing deadline per PTY from its presentation
class:

| Class | Deadline |
|---|---|
| Focused visible | 4 ms interactive, 16 ms sustained (current logic) |
| Visible | 16 ms |
| Hidden pane or tab | 100 ms |
| Window occluded or asleep | 250 ms |

A pending queue of 64 KiB or more is always due immediately. The frontend
reports classes with `pty_set_presentation(ids, class)` (async), and only on
change. Occlusion is applied natively without a round trip. The hub responds
when any due PTY has data, and includes every PTY that has pending data whose
deadline is at most one interactive tick away. That aligns wakeups across
terminals.

### Credit

- Credit is counted per PTY in bytes: in-flight at most 1 MiB, pending plus
  in-flight at most 2 MiB (existing bound).
- Acknowledgements are cumulative parsed offsets, validated against delivered
  chunk boundaries. Duplicates and retries cannot add credit (existing
  invariant).
- A PTY whose in-flight bytes are at the limit is skipped by the hub until
  acknowledgements arrive.

### Exit and failure

- Exit ordering is preserved. The `exit` frame follows every data frame for
  that PTY, and is sent only after the reader drains and all data is
  acknowledged (existing semantics, including the 30 s post-exit
  acknowledgement deadline and the 2 MiB / 30 s drain bound).
- Reload or window destruction drops the responder and resets the webview's
  generation. PTYs of a destroyed webview are closed as today.
- Parser failure on the frontend stops acknowledgements for that PTY and
  reports it visibly. Other PTYs are unaffected.

### Frontend

- `PtyOutputHub` owns the poll loop and demultiplexes frames to the existing
  `PtyOutputReceiver`s, which keep the 32 KiB / 4 ms sliced parsing.
- Receivers report parsed offsets to the hub, which batches them into the next
  poll or ack request.
- After a response arrives, the next poll is issued immediately, before
  parsing, so delivery latency does not include parse time.
- `pty_open` no longer takes `onData` / `onExit` channels.

## Other per-chunk costs removed

- `agent_detect` and `da_filter` scan with `memchr` and copy runs with
  `extend_from_slice` instead of per-byte pushes.
- The reader checks `closed` with an atomic flag instead of locking the queue
  mutex twice per read.
- `pty_write` no longer uses `spawn_blocking` per keystroke. Each session has a
  writer thread fed by a bounded channel.
- Thread stacks are 128–256 KiB.
- `pty_has_foreground_process` uses `proc_listchildpids` on macOS and
  `/proc/<pid>/task/*/children` on Linux instead of forking `pgrep`.

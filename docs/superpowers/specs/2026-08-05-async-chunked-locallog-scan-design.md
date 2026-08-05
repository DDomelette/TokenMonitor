# Async Chunked Local-Log Scan Design

## Goal

Prevent first-run, cursor-loss, migration, and rotation scans from allocating the entire unread tail or monopolizing Electron's main thread, while preserving exact JSONL parsing and cursor semantics.

## Chosen architecture

`scanFiles()` becomes an asynchronous Promise-based API built on `fs.promises`. Directory traversal, stat, open, and read operations no longer use synchronous filesystem calls. Each file is read in fixed blocks of 64 KiB, and one scan invocation reads at most 4 MiB across all matching files. The scheduler already awaits `provider.readLocalLog()`, so Codex and Kimi can become async without changing scheduling or inflight behavior.

A raw Buffer carry holds bytes after the last complete newline. Complete line prefixes are decoded only after their newline boundary is known, so UTF-8 code points split across read blocks remain intact. The file cursor advances only through the last complete newline successfully handed to the parser. A partial trailing line is discarded from memory at the end of the invocation and re-read from the last committed cursor on the next scan.

After each read block, the scanner awaits `setImmediate`, guaranteeing an event-loop turn even when the filesystem repeatedly resolves from cache. The global byte budget bounds one polling turn; subsequent scheduler polls continue from the persisted cursor.

## Interfaces

- `scanFiles(options) -> Promise<UsageRecord[]>`
- `walkFiles(root, match) -> Promise<string[]>`
- `provider.readLocalLog(ctx, opts) -> Promise<UsageRecord[]>`

Optional test controls:

- `chunkBytes` overrides the 64 KiB block size.
- `maxBytesPerScan` overrides the 4 MiB global budget.
- `yieldToLoop` overrides the default `setImmediate` Promise for deterministic tests.

Invalid values for these controls fall back to production defaults; they are not persisted settings.

## Cursor and failure semantics

- Truncation or an older mtime resets the starting offset to zero, as before.
- A complete valid or invalid line advances the cursor once; parser return value does not affect consumption.
- A partial line never advances the cursor.
- If reading or parsing throws, the current file cursor is committed only through the last previously completed line. The error propagates so scheduler health reporting remains accurate.
- Cursors for files no longer returned by traversal are removed.
- A file larger than the remaining scan budget is resumed in a later invocation.

## Memory and responsiveness bounds

Normal allocation is one read Buffer of at most 64 KiB plus the current incomplete line. The scanner never allocates `stat.size - offset`. Total newly read bytes per invocation are at most 4 MiB. Extremely large individual JSONL lines may still require memory proportional to that one line; imposing a line-size rejection policy is outside this issue.

## Testing

Regression tests will verify:

- no allocation or read request exceeds the configured chunk size;
- a large file is consumed across multiple scans under a small byte budget;
- UTF-8 characters and JSON records split across chunks parse exactly once;
- partial lines do not advance the cursor and complete correctly later;
- an event-loop callback runs before a multi-block scan finishes;
- provider reads and scheduler polling await asynchronous scans;
- truncation, rotation, invalid-line consumption, diagnostics, retention, and daily aggregation remain unchanged.

## Non-goals

This change does not add worker threads, parallel file reads, filesystem watchers, persisted scan budgets, line-size limits, or changes to usage-record schemas.

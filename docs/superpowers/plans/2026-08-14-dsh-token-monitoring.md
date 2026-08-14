# DSH Token 消耗监测接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepSeek Harness(DSH)把每次模型请求的 token usage 写入 `$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl`,并让 DeepSeek Monitor 把它作为第 4 个平台(`dsh`)并入每日聚合、费用与 Token 速度卡。

**Architecture:** DSH 侧新增独立 cordis 包 `@deepseek-ai/dsh-usage-telemetry`(订阅 `session/event`,仅取 `assistant/message` 的最终 usage,未压缩 JSONL 按天轮转,默认开启、settings.yaml 可关);Monitor 侧新增 `providers/dsh` ProviderAdapter,复用 `core/locallog.js` 游标扫描管线把遥测行并入 `usageDaily` 与新增的 `usageDailyCost`,并把 `'dsh'` 加入 token-speed-tracker 的 PROVIDER_IDS。渲染层面板不在此计划内(Kimi 负责)。

**Tech Stack:** DSH:TypeScript ESM + cordis Service + vitest;Monitor:Electron 主进程 CommonJS + node:test。

**Spec:** `docs/superpowers/specs/2026-08-14-dsh-token-monitoring-design.md`(本计划按其逐节落地;执行者须先读 spec)

## Global Constraints

- 仓库路径:DSH = `D:\Deepseek_Harness`(pnpm 工作区,`packages/*/*` 自动纳入);Monitor = `D:\Deepseek_Monitor`(npm)。除 Task 头部注明外,所有命令在对应仓库根执行。
- DSH 行格式 v1 冻结:键序 `v,time,sessionId,cwd?,model?,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens`;所有 token 字段为非负整数;`cwd`/`model` 可省略。
- 遥测根目录:`$DSH_HOME/telemetry`(经 `resolveDshHome`,默认 `~/.dsh`;`DSH_HOME` 环境变量生效),文件名 `usage-YYYY-MM-DD.jsonl`(本地日期)。
- 遥测行不含任何 prompt/工具文本;写入必须 fail-soft(不抛进 `session/event` 事件路径——cordis emit 是 stop-on-throw)。
- DSH 不动任何现有包;bundle 注册仅加 web-app 的 `cordis.patch.yml`。
- Monitor 不新增依赖;渲染层(`renderer/`)一行不改(前后端边界,spec 4.6);`npm test` 必须全绿。
- 费用口径(Monitor `pricing.js`):单价表存 ¥/1000 tokens(与现有 `PRICING` 同单位);`cost = input×input + output×output + cacheRead×cacheHit + cacheWrite×input`;UsageRecord 映射中 `inputTokens = input + cacheWrite`、`cachedTokens = cacheRead`。
- 两个仓库分别提交;commit 信息按任务给出。

## File Structure

**DSH(`D:\Deepseek_Harness`,全部新建):**

| 文件 | 职责 |
| --- | --- |
| `packages/telemetry/usage-telemetry/package.json` | 包元数据(`@deepseek-ai/dsh-usage-telemetry`,仿 `session-projection-cache`) |
| `packages/telemetry/usage-telemetry/tsconfig.json` | 项目引用构建配置 |
| `packages/telemetry/usage-telemetry/src/schema.ts` | 行 schema v1(zod)+ 序列化 |
| `packages/telemetry/usage-telemetry/src/writer.ts` | 追加写 + 按天轮转 + ENOENT 自愈 |
| `packages/telemetry/usage-telemetry/src/index.ts` | `UsageTelemetry` cordis Service:订阅/退订、模型跟踪、行组装、fail-soft |
| `packages/telemetry/usage-telemetry/tests/schema.spec.ts` | schema 单测 |
| `packages/telemetry/usage-telemetry/tests/writer.spec.ts` | writer 单测 |
| `packages/telemetry/usage-telemetry/tests/usage-telemetry.spec.ts` | 服务集成测试 |
| `packages/bundle/web-app/cordis.patch.yml` | 注册插件行(修改) |
| `tsconfig.host.json` | 加入项目引用(修改) |

**Monitor(`D:\Deepseek_Monitor`):**

| 文件 | 职责 |
| --- | --- |
| `src/main/pricing.js` | 增加 DSH 单价表 + `calcDshCost`(修改) |
| `src/main/providers/dsh/telemetrylog.js` | 行解析、指纹、根目录解析、扫描批、usageDaily/usageDailyCost 合并(新建) |
| `src/main/providers/dsh/index.js` | ProviderAdapter(新建) |
| `src/main/index.js` | 注册 dsh provider(修改) |
| `src/main/core/token-speed-tracker.js` | PROVIDER_IDS 加 `'dsh'`(修改) |
| `src/main/core/history-sync.js` | `rescanLocalLogs` 同步清理/还原 `usageDailyCost`(修改) |
| `src/main/core/settings-reset.js` | RESET_KEEP_KEYS 加 `usageDailyCost`、`localLogCursors.dsh`(修改) |
| `src/main/ipc.js` | `sync:history` 增加 dsh 分支(修改) |
| `test/dsh-pricing.test.js`、`test/dsh-telemetrylog.test.js`、`test/dsh-provider-scheduler.test.js`、`test/dsh-history-rescan.test.js`、`test/dsh-token-speed.test.js` | 测试(新建) |
| `README.md` | 数据来源表加 DSH 行(修改) |

---

## Task 1: DSH 包脚手架(可编译的空包)

**Files:**
- Create: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\package.json`
- Create: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\tsconfig.json`
- Create: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\src\index.ts`
- Modify: `D:\Deepseek_Harness\tsconfig.host.json`

**Interfaces:**
- Consumes: 无。
- Produces: 包名 `@deepseek-ai/dsh-usage-telemetry`(Task 5 的 cordis.yml 用);`src/index.ts` 最终导出 `UsageTelemetry`(Task 4)。

- [ ] **Step 1: 创建 package.json**

内容(仿 `packages/session/session-projection-cache/package.json`,deps 只保留本包会 import 的):

```json
{
  "name": "@deepseek-ai/dsh-usage-telemetry",
  "description": "Usage telemetry: appends one JSONL row per completed model request to $DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl for external consumption monitoring",
  "version": "0.1.0-rc.5",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/telemetry/usage-telemetry"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-home-paths": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-home-paths": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

内容(引用本包 import 的所有目标,仿 session-projection-cache):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../../vendor/cosmokit"
    },
    {
      "path": "../../../vendor/cordis"
    },
    {
      "path": "../../../vendor/schemastery"
    },
    {
      "path": "../../core/session"
    },
    {
      "path": "../../llm/llm"
    },
    {
      "path": "../../util/home-paths"
    },
    {
      "path": "../../settings/settings"
    }
  ]
}
```

- [ ] **Step 3: 创建占位 src/index.ts**

```ts
/** Placeholder replaced in Task 4. */
export {}
```

- [ ] **Step 4: tsconfig.host.json 加入项目引用**

在 `D:\Deepseek_Harness\tsconfig.host.json` 第 163 行(精确原文 `    { "path": "./packages/session/session-telemetry-otel" },`)之后插入一行:

```json
    { "path": "./packages/telemetry/usage-telemetry" },
```

- [ ] **Step 5: 安装并编译验证**

Run(DSH 根目录):

```
pnpm install
pnpm exec tsc -b packages/telemetry/usage-telemetry
```

Expected: `pnpm install` 无错误;`tsc -b` 退出码 0,生成 `packages/telemetry/usage-telemetry/lib/`。

- [ ] **Step 6: 提交(DSH 仓库)**

```bash
git add packages/telemetry/usage-telemetry tsconfig.host.json pnpm-lock.yaml
git commit -m "chore(usage-telemetry): scaffold package and build reference"
```

---

## Task 2: 行 schema v1(`schema.ts`)

**Files:**
- Create: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\src\schema.ts`
- Test: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\tests\schema.spec.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `USAGE_ROW_VERSION`(number,恒 1)、`usageRowSchema`(zod)、`UsageRow`(类型)、`serializeRow(row: UsageRow): string`。Task 3/4 使用。

- [ ] **Step 1: 写失败测试 `tests/schema.spec.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { serializeRow, usageRowSchema, USAGE_ROW_VERSION } from '../src/schema.ts'

describe('usage row schema v1', () => {
  it('serializes a full row with the frozen key order', () => {
    const line = serializeRow({
      v: USAGE_ROW_VERSION,
      time: 1786641087069,
      sessionId: 'session-1',
      cwd: 'D:\\Deepseek_Monitor',
      model: 'deepseek-v4-pro',
      inputTokens: 1404,
      outputTokens: 1089,
      cacheReadTokens: 46592,
      cacheWriteTokens: 0,
    })
    expect(line).toBe('{"v":1,"time":1786641087069,"sessionId":"session-1","cwd":"D:\\\\Deepseek_Monitor","model":"deepseek-v4-pro","inputTokens":1404,"outputTokens":1089,"cacheReadTokens":46592,"cacheWriteTokens":0}')
  })

  it('omits optional cwd/model keys entirely', () => {
    const line = serializeRow({
      v: USAGE_ROW_VERSION,
      time: 1,
      sessionId: 's',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(line).toBe('{"v":1,"time":1,"sessionId":"s","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}')
  })

  it('rejects unknown keys and negative/float tokens', () => {
    expect(() => usageRowSchema.parse({ v: 1, time: 1, sessionId: 's', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, extra: true })).toThrow()
    expect(() => usageRowSchema.parse({ v: 1, time: 1, sessionId: 's', inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toThrow()
    expect(() => usageRowSchema.parse({ v: 1, time: 1, sessionId: 's', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0.5 })).toThrow()
  })

  it('rejects versions other than 1', () => {
    expect(() => usageRowSchema.parse({ v: 2, time: 1, sessionId: 's', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run(DSH 根目录):`pnpm exec vitest run packages/telemetry/usage-telemetry`

Expected: FAIL — `Cannot find module '../src/schema.ts'`。

- [ ] **Step 3: 实现 `src/schema.ts`**

```ts
/**
 * Frozen v1 row schema for the usage telemetry JSONL ($DSH_HOME/telemetry/).
 * Consumers (DeepSeek Monitor) drop any row whose `v` they do not know.
 */

import { z } from 'zod'

/** Row schema version, frozen at 1. */
export const USAGE_ROW_VERSION = 1

export const usageRowSchema = z.object({
  v: z.literal(1),
  time: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

export type UsageRow = z.infer<typeof usageRowSchema>

/** Serialize one row; JSON.stringify preserves insertion order (the frozen key order). */
export function serializeRow(row: UsageRow): string {
  return JSON.stringify(usageRowSchema.parse(row))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run packages/telemetry/usage-telemetry`

Expected: PASS(4 tests)。

- [ ] **Step 5: 提交(DSH)**

```bash
git add packages/telemetry/usage-telemetry
git commit -m "feat(usage-telemetry): frozen v1 row schema"
```

---

## Task 3: 文件写入器(`writer.ts`)

**Files:**
- Create: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\src\writer.ts`
- Test: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\tests\writer.spec.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `UsageWriterOptions { root: string; now?: () => Date }`、`UsageWriter { write(line: string): Promise<void> }`、`createUsageWriter(options): UsageWriter`。Task 4 使用。

- [ ] **Step 1: 写失败测试 `tests/writer.spec.ts`**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageWriter } from '../src/writer.ts'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usage-telemetry-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('usage writer', () => {
  it('creates the directory and appends lines to usage-YYYY-MM-DD.jsonl', async () => {
    const root = join(await tempRoot(), 'telemetry')
    const writer = createUsageWriter({ root, now: () => new Date(2026, 7, 14, 12, 0, 0) })
    await writer.write('{"v":1}')
    await writer.write('{"v":1}')
    const files = await readdir(root)
    expect(files).toEqual(['usage-2026-08-14.jsonl'])
    const content = await readFile(join(root, 'usage-2026-08-14.jsonl'), 'utf8')
    expect(content).toBe('{"v":1}\n{"v":1}\n')
  })

  it('rotates to a new file when the local day changes', async () => {
    const root = join(await tempRoot(), 'telemetry')
    let day = 14
    const writer = createUsageWriter({ root, now: () => new Date(2026, 7, day, 23, 59, 0) })
    await writer.write('{"day":14}')
    day = 15
    await writer.write('{"day":15}')
    const files = await readdir(root)
    expect(files.sort()).toEqual(['usage-2026-08-14.jsonl', 'usage-2026-08-15.jsonl'])
    expect(await readFile(join(root, 'usage-2026-08-15.jsonl'), 'utf8')).toBe('{"day":15}\n')
  })

  it('self-heals a missing directory (ENOENT) on the first write', async () => {
    const base = await tempRoot()
    const root = join(base, 'deep', 'telemetry')
    const writer = createUsageWriter({ root, now: () => new Date(2026, 7, 14) })
    await writer.write('{"v":1}')
    const content = await readFile(join(root, 'usage-2026-08-14.jsonl'), 'utf8')
    expect(content).toBe('{"v":1}\n')
  })

  it('rejects a write when the parent path is not a directory (caller contains)', async () => {
    const root = await tempRoot()
    // A FILE sitting where the telemetry dir belongs: mkdir cannot fix it.
    const writer = createUsageWriter({ root, now: () => new Date(2026, 7, 14) })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'usage-2026-08-14.jsonl'), 'blocker')
    const blockerDir = root
    // Root itself is fine; make root's parent a file via a child path trick:
    // point the writer at <root>/file-child/telemetry where file-child is a file.
    await writeFile(join(blockerDir, 'file-child'), 'x')
    const bad = createUsageWriter({ root: join(blockerDir, 'file-child', 'telemetry'), now: () => new Date(2026, 7, 14) })
    await expect(bad.write('{"v":1}')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run packages/telemetry/usage-telemetry`

Expected: FAIL — `Cannot find module '../src/writer.ts'`。

- [ ] **Step 3: 实现 `src/writer.ts`**

```ts
/**
 * Append-only writer for the usage telemetry JSONL. The file name carries the
 * local date, so rotation is a pure function of `now()`: each write recomputes
 * the target path and appendFile reopens it (no cached fd to reset). A first
 * write into a missing directory retries once after mkdir -p (ENOENT self-heal).
 * Callers own failure policy; every error propagates to the caller.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface UsageWriterOptions {
  /** Absolute telemetry root (usually $DSH_HOME/telemetry). */
  root: string
  /** Injectable clock; defaults to the wall clock. */
  now?: () => Date
}

export interface UsageWriter {
  /** Append one line (trailing newline added). Rejects on unrecoverable errors. */
  write(line: string): Promise<void>
}

export function createUsageWriter(options: UsageWriterOptions): UsageWriter {
  const now = options.now ?? (() => new Date())

  function dayStamp(): string {
    const d = now()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${month}-${day}`
  }

  function fileFor(): string {
    return join(options.root, `usage-${dayStamp()}.jsonl`)
  }

  return {
    async write(line: string): Promise<void> {
      const file = fileFor()
      try {
        await appendFile(file, line + '\n', 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(options.root, { recursive: true })
        await appendFile(file, line + '\n', 'utf8')
      }
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run packages/telemetry/usage-telemetry`

Expected: PASS(4 new + 4 schema = 8)。

- [ ] **Step 5: 提交(DSH)**

```bash
git add packages/telemetry/usage-telemetry
git commit -m "feat(usage-telemetry): daily-rotating append-only writer"
```

---

## Task 4: UsageTelemetry 服务(`index.ts`)

**Files:**
- Modify: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\src\index.ts`(替换占位)
- Test: `D:\Deepseek_Harness\packages\telemetry\usage-telemetry\tests\usage-telemetry.spec.ts`

**Interfaces:**
- Consumes: `USAGE_ROW_VERSION`/`serializeRow`(Task 2)、`createUsageWriter`(Task 3)、cordis `ctx.on`(返回 disposer `() => boolean`)、`ctx.inject(['settings'], cb)`、`sctx.settings.register(ns, schema, { base })` 返回 `{ get(), watch(cb) }`。
- Produces: `UsageTelemetryConfig { enabled: boolean }`、`export class UsageTelemetry extends Service`(static `Config` 用 schemastery z)。Task 5 注册。

- [ ] **Step 1: 写失败测试 `tests/usage-telemetry.spec.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import UsageTelemetry from '../src/index.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-home-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

function fakeSession(id: string, cwd?: string): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, ...(cwd === undefined ? {} : { cwd }) },
    events: [],
  } as unknown as Session
}

function headerEvent(session: Session, model: string, seq: number): SessionEvent {
  return { type: 'request/header', seq, time: 1000, data: { header: { version: 0, createdAt: 0, config: { provider: 'p', model } }, reason: 'initial' } } as SessionEvent
}

function usageEvent(session: Session, seq: number, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): SessionEvent {
  return { type: 'assistant/message', seq, time: 2000, data: { turn: 1, step: 1, usage } } as SessionEvent
}

async function telemetryRoot(): Promise<string> {
  return join(home, 'telemetry')
}

async function readRows(): Promise<string[]> {
  const root = await telemetryRoot()
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(root).catch(() => [] as string[])
  const lines: string[] = []
  for (const file of files) {
    lines.push(...(await readFile(join(root, file), 'utf8')).trim().split('\n').filter(Boolean))
  }
  return lines
}

describe('UsageTelemetry service', () => {
  it('writes one row per assistant/message with usage, with model from the latest request/header', async () => {
    const ctx = new Context()
    await ctx.plugin(UsageTelemetry, { enabled: true })
    const session = fakeSession('session-1', 'D:\\Deepseek_Monitor')
    ctx.emit('session/event', session, headerEvent(session, 'deepseek-v4-pro', 0))
    ctx.emit('session/event', session, usageEvent(session, 1, { inputTokens: 1404, outputTokens: 1089, cacheReadTokens: 46592, cacheWriteTokens: 0 }))
    // Give the fire-and-forget append a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    const parsed = JSON.parse(rows[0]!)
    expect(parsed).toEqual({
      v: 1, time: 2000, sessionId: 'session-1', cwd: 'D:\\Deepseek_Monitor', model: 'deepseek-v4-pro',
      inputTokens: 1404, outputTokens: 1089, cacheReadTokens: 46592, cacheWriteTokens: 0,
    })
  })

  it('ignores usage chunks and messages without usage, and omits model when no header was seen', async () => {
    const ctx = new Context()
    await ctx.plugin(UsageTelemetry, { enabled: true })
    const session = fakeSession('session-2')
    ctx.emit('session/event', session, { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 9 } } } } as SessionEvent)
    ctx.emit('session/event', session, { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1 } } as SessionEvent)
    ctx.emit('session/event', session, usageEvent(session, 2, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    const parsed = JSON.parse(rows[0]!)
    expect(parsed.model).toBeUndefined()
    expect(parsed.inputTokens).toBe(10)
    expect(parsed.cacheWriteTokens).toBe(1)
  })

  it('does not subscribe or write when disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(UsageTelemetry, { enabled: false })
    const session = fakeSession('session-3')
    ctx.emit('session/event', session, usageEvent(session, 0, { inputTokens: 1, outputTokens: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(readRows()).resolves.toEqual([])
  })

  it('contains write failures: a broken telemetry path never throws into the event path', async () => {
    const ctx = new Context()
    await ctx.plugin(UsageTelemetry, { enabled: true })
    // A FILE occupying the telemetry path: appendFile fails with ENOTDIR/EEXIST-family errors.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(home, 'telemetry'), 'blocker')
    const session = fakeSession('session-4')
    expect(() => {
      ctx.emit('session/event', session, usageEvent(session, 0, { inputTokens: 1, outputTokens: 1 }))
    }).not.toThrow()
  })

  it('a mounted settings scope can disable a previously enabled service', async () => {
    const ctx = new Context()
    let current = { enabled: true }
    const scope = {
      get: () => current,
      watch: (cb: () => void) => { watchCallback = cb },
    }
    let watchCallback: () => void = () => {}
    ctx.provide('settings', {
      register: () => scope,
    })
    await ctx.plugin(UsageTelemetry, { enabled: true })
    // Still enabled through the base value: a write lands.
    const session = fakeSession('session-5')
    ctx.emit('session/event', session, usageEvent(session, 0, { inputTokens: 1, outputTokens: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await readRows()).toHaveLength(1)
    // Flip through settings and confirm the subscription drops off.
    current = { enabled: false }
    watchCallback()
    ctx.emit('session/event', session, usageEvent(session, 1, { inputTokens: 2, outputTokens: 2 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await readRows()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run packages/telemetry/usage-telemetry`

Expected: FAIL — `src/index.ts` 只有 `export {}`,无 `UsageTelemetry` 导出。

- [ ] **Step 3: 实现 `src/index.ts`**

```ts
/**
 * Usage telemetry service: appends one JSONL row per completed model request
 * (assistant/message with usage) to $DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl.
 * Standalone cordis Service (NOT a SessionTelemetryBackend — that slot is
 * occupied by the OTel backend in the shipped bundles and allows exactly one
 * implementation). Enabled by default; the optional settings service may
 * override via the `usage-telemetry` namespace (`enabled: false`).
 *
 * @module @deepseek-ai/dsh-usage-telemetry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: merges `settings` onto the cordis Context interface.
import type {} from '@deepseek-ai/dsh-settings'
import { createUsageWriter, type UsageWriter } from './writer.ts'
import { serializeRow, USAGE_ROW_VERSION, type UsageRow } from './schema.ts'

export interface UsageTelemetryConfig {
  enabled: boolean
}

export const UsageTelemetryConfig: z<UsageTelemetryConfig> = z.object({
  enabled: z.boolean().required(),
})

export class UsageTelemetry extends Service {
  static Config = UsageTelemetryConfig

  private enabled: boolean
  private readonly writer: UsageWriter
  private readonly lastModel = new WeakMap<Session, string | undefined>()
  private disposeSubscription: (() => boolean) | null = null

  private readonly onSessionEvent = (session: Session, event: SessionEvent): void => {
    this.contain(() => this.handle(session, event))
  }

  constructor(ctx: Context, config: UsageTelemetryConfig) {
    super(ctx, 'usageTelemetry')
    this.enabled = config.enabled
    this.writer = createUsageWriter({ root: join(resolveDshHome(), 'telemetry') })
  }

  protected [Service.init](): void {
    this.syncSubscription()
    // Optional settings override: `usage-telemetry:\n  enabled: false` in
    // settings.yaml disables the emitter. Absent a settings provider the
    // composition config stays authoritative.
    this.ctx.inject(['settings'], (sctx) => {
      const scope = sctx.settings.register('usage-telemetry', UsageTelemetryConfig, {
        base: { enabled: this.enabled },
      })
      this.enabled = scope.get().enabled
      this.syncSubscription()
      scope.watch(() => {
        this.enabled = scope.get().enabled
        this.syncSubscription()
      })
    })
  }

  /** Subscribe exactly while enabled (spec: a disabled emitter costs nothing). */
  private syncSubscription(): void {
    if (this.enabled && this.disposeSubscription === null) {
      this.disposeSubscription = this.ctx.on('session/event', this.onSessionEvent)
    } else if (!this.enabled && this.disposeSubscription !== null) {
      this.disposeSubscription()
      this.disposeSubscription = null
    }
  }

  private handle(session: Session, event: SessionEvent): void {
    if (event.type === 'request/header') {
      this.lastModel.set(session, event.data.header.config.model)
      return
    }
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return

    const usage: TokenUsage = event.data.usage
    const cwd = session.header.cwd
    const model = this.lastModel.get(session)
    const row: UsageRow = {
      v: USAGE_ROW_VERSION,
      time: event.time,
      sessionId: String(session.id),
      ...(cwd === undefined ? {} : { cwd }),
      ...(model === undefined || model.length === 0 ? {} : { model }),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    void this.writer.write(serializeRow(row)).catch((error: unknown) => {
      this.ctx.logger.warn(`usage telemetry: write failed: ${String(error)}`)
    })
  }

  /** cordis emit is stop-on-throw: nothing here may escape into the event path. */
  private contain(step: () => void): void {
    try {
      step()
    } catch (error) {
      this.ctx.logger.warn(`usage telemetry: capture step failed: ${String(error)}`)
    }
  }
}

export default UsageTelemetry
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run packages/telemetry/usage-telemetry`

Expected: PASS(8 + 5 = 13 tests)。若 `settings` 注入测试因 cordis `ctx.provide`/`ctx.inject` 时序失败,把 `ctx.provide('settings', ...)` 移到 `ctx.plugin(...)` 之前并重跑(两者都在 await 之前即完成,属预期时序)。

- [ ] **Step 5: 类型与构建**

Run: `pnpm exec tsc -b packages/telemetry/usage-telemetry`

Expected: 退出码 0。

- [ ] **Step 6: 提交(DSH)**

```bash
git add packages/telemetry/usage-telemetry
git commit -m "feat(usage-telemetry): cordis service emitting per-request usage rows"
```

---

## Task 5: bundle 注册与配置校验

**Files:**
- Modify: `D:\Deepseek_Harness\packages\bundle\web-app\cordis.patch.yml`

**Interfaces:**
- Consumes: 包名 `@deepseek-ai/dsh-usage-telemetry`(Task 1)、Config `{ enabled: boolean }`(Task 4)。
- Produces: 运行中的 DSH(web-app 形态)在重启后开始写遥测文件。

- [ ] **Step 1: 在 cordis.patch.yml 的 insert 列表注册插件**

在 `session-projection-cache` 行(精确原文如下)之后插入新行:

```yaml
    - id: session-projection-cache
      name: '@deepseek-ai/dsh-session-projection-cache'
      config:
        writeEveryEvents: 200
        writeIntervalMs: 5000

    - id: usage-telemetry
      name: '@deepseek-ai/dsh-usage-telemetry'
      config:
        enabled: true
```

(即把上述 5 行文本整体替换为 5 行原文 + 空行 + 4 行新内容;其余不动。)

- [ ] **Step 2: 配置校验**

Run(DSH 根目录):

```
pnpm verify-cordis-config
pnpm exec vitest run packages/telemetry/usage-telemetry
```

Expected: 两个命令均退出 0。`verify-cordis-config` 失败时报出具体 yaml 行号,修复后重跑。

- [ ] **Step 3: 提交(DSH)**

```bash
git add packages/bundle/web-app/cordis.patch.yml
git commit -m "feat(web-app): mount usage telemetry (enabled by default)"
```

---

## Task 6: Monitor 费用表(`pricing.js`)

**Files:**
- Modify: `D:\Deepseek_Monitor\src\main\pricing.js`
- Test: `D:\Deepseek_Monitor\test\dsh-pricing.test.js`

**Interfaces:**
- Consumes: 现有 `PRICING`/`calcCost`(不改其行为)。
- Produces: `DSH_PRICING`、`getDshModelPrice(model)`、`calcDshCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)`。Task 7/8 使用。

- [ ] **Step 1: 写失败测试 `test/dsh-pricing.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { getDshModelPrice, calcDshCost, DSH_PRICING } = require('../src/main/pricing');

test('calcDshCost prices the four raw telemetry buckets', () => {
  // deepseek-v4-pro: input 0.001, output 0.004, cacheHit 0.0001 per 1000 tokens.
  const cost = calcDshCost('deepseek-v4-pro', 1000, 2000, 3000, 100);
  assert.equal(cost, 1 * 0.001 + 2 * 0.004 + 3 * 0.0001 + 0.1 * 0.001);
});

test('calcDshCost bills cache writes at the input price', () => {
  const cost = calcDshCost('deepseek-v4-pro', 0, 0, 0, 1000);
  assert.equal(cost, 0.001);
});

test('getDshModelPrice resolves prefix matches and the default row', () => {
  assert.equal(getDshModelPrice('deepseek-v4-pro-20260101').cacheHit, DSH_PRICING['deepseek-v4-pro'].cacheHit);
  assert.equal(getDshModelPrice('some-future-model'), DSH_PRICING.default);
  assert.equal(getDshModelPrice(''), DSH_PRICING.default);
  assert.equal(getDshModelPrice(null), DSH_PRICING.default);
});

test('existing PRICING and calcCost are untouched', () => {
  const { calcCost, getModelPrice } = require('../src/main/pricing');
  assert.equal(calcCost('deepseek-v4-pro', 1000, 2000, 3000), 1 * 0.001 + 2 * 0.004 + 3 * 0.0001);
  assert.equal(getModelPrice('deepseek-reasoner'), require('../src/main/pricing').PRICING['deepseek-reasoner']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run(Monitor 根目录):`node --test test/dsh-pricing.test.js`

Expected: FAIL — `getDshModelPrice is not a function`(module.exports 尚无该导出)。

- [ ] **Step 3: 实现 pricing.js 扩展**

在 `pricing.js` 的 `PRICING` 之后追加 `DSH_PRICING`(单价 ¥/1000 tokens,与 `PRICING` 同口径;初始值即 DeepSeek 官方当前价,实现时对照 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 复核;2026-08-17 峰谷价生效后如需区分峰谷,后续再扩展表列):

```js
// DSH 遥测四桶计价(¥/1000 tokens,与 PRICING 同单位)。
// cost = input×input + output×output + cacheRead×cacheHit + cacheWrite×input。
const DSH_PRICING = {
  'deepseek-v4-pro': { input: 0.001, output: 0.004, cacheHit: 0.0001 },
  'deepseek-v4-flash': { input: 0.0005, output: 0.002, cacheHit: 0.00005 },
  'deepseek-reasoner': { input: 0.001, output: 0.004, cacheHit: 0.0001 },
  default: { input: 0.001, output: 0.004, cacheHit: 0.0001 }
};

function getDshModelPrice(model) {
  if (!model) return DSH_PRICING.default;
  if (DSH_PRICING[model]) return DSH_PRICING[model];
  const name = String(model);
  if (name.startsWith('deepseek-v4-pro')) return DSH_PRICING['deepseek-v4-pro'];
  if (name.startsWith('deepseek-v4-flash')) return DSH_PRICING['deepseek-v4-flash'];
  if (name.includes('reasoner')) return DSH_PRICING['deepseek-reasoner'];
  return DSH_PRICING.default;
}

function calcDshCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  const price = getDshModelPrice(model);
  return (inputTokens / 1000) * price.input
    + (outputTokens / 1000) * price.output
    + (cacheReadTokens / 1000) * price.cacheHit
    + (cacheWriteTokens / 1000) * price.input;
}
```

并把 module.exports 改为:

```js
module.exports = { PRICING, getModelPrice, calcCost, DSH_PRICING, getDshModelPrice, calcDshCost };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/dsh-pricing.test.js`

Expected: PASS(4 tests)。

- [ ] **Step 5: 提交(Monitor)**

```bash
git add src/main/pricing.js test/dsh-pricing.test.js
git commit -m "feat(dsh): model pricing table and four-bucket cost calculator"
```

---

## Task 7: 遥测行解析与根目录解析(`telemetrylog.js` 第一部分)

**Files:**
- Create: `D:\Deepseek_Monitor\src\main\providers\dsh\telemetrylog.js`
- Test: `D:\Deepseek_Monitor\test\dsh-telemetrylog.test.js`

**Interfaces:**
- Consumes: `normalizeTimestampMs`/`incrementDiagnostic`/`localDayStr`(来自 `src/main/core/locallog.js`)、`calcDshCost`(Task 6)。
- Produces: `MATCH`(/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/)、`DEFAULT_ROOT`(函数)、`resolveTelemetryRoot(store, env)`、`parseTelemetryLine(line, diagnostics, nowMs)` 返回 `{ ts, model, usage: { input, cached, output, total }, cost, eventFingerprint }` 或 null。Task 8/9 使用。

- [ ] **Step 1: 写失败测试 `test/dsh-telemetrylog.test.js`(本任务先只测解析与根目录,Task 8 追加扫描测试)**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const {
  parseTelemetryLine,
  resolveTelemetryRoot,
  DEFAULT_ROOT,
  MATCH
} = require('../src/main/providers/dsh/telemetrylog');

const LINE = JSON.stringify({
  v: 1, time: 1786641087069, sessionId: 'session-1', cwd: 'D:\\Deepseek_Monitor',
  model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000,
  cacheReadTokens: 3000, cacheWriteTokens: 100
});

test('parseTelemetryLine maps the four buckets into the UsageRecord shape', () => {
  const diagnostics = {};
  const rec = parseTelemetryLine(LINE, diagnostics, Date.now());
  assert.ok(rec);
  assert.equal(rec.ts, 1786641087069);
  assert.equal(rec.model, 'deepseek-v4-pro');
  assert.deepEqual(rec.usage, { input: 1100, cached: 3000, output: 2000, total: 6100 });
  assert.ok(typeof rec.cost === 'number' && rec.cost > 0);
  assert.match(rec.eventFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('parseTelemetryLine rejects malformed rows with diagnostics', () => {
  const diagnostics = {};
  assert.equal(parseTelemetryLine('not json', diagnostics, Date.now()), null);
  assert.equal(diagnostics.malformedLine, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 2, time: 1, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.unknownRowVersion, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ time: 1, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.missingRowVersion, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 1, time: 'yesterday', sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.invalidTimestamp, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: -1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.invalidTokenCount, 1);
});

test('parseTelemetryLine defaults a missing model to unknown and zeroes missing cache buckets', () => {
  const rec = parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: 5, outputTokens: 6 }), {}, Date.now());
  assert.ok(rec);
  assert.equal(rec.model, 'unknown');
  assert.deepEqual(rec.usage, { input: 5, cached: 0, output: 6, total: 11 });
});

test('resolveTelemetryRoot precedence: setting > DSH_HOME env > ~/.dsh/telemetry', () => {
  assert.equal(resolveTelemetryRoot(null, {}), path.join(os.homedir(), '.dsh', 'telemetry'));
  assert.equal(resolveTelemetryRoot(null, { DSH_HOME: 'D:\\dsh-home' }), path.join('D:\\dsh-home', 'telemetry'));
  const store = { get: (key) => key === 'providers.dsh.telemetryRoot' ? 'D:\\custom' : undefined };
  assert.equal(resolveTelemetryRoot(store, { DSH_HOME: 'D:\\dsh-home' }), 'D:\\custom');
  assert.equal(resolveTelemetryRoot({ get: () => ' ' }, { DSH_HOME: ' ' }), DEFAULT_ROOT());
});

test('MATCH accepts only usage-YYYY-MM-DD.jsonl names', () => {
  assert.ok(MATCH.test('usage-2026-08-14.jsonl'));
  assert.ok(!MATCH.test('usage-2026-08-14.jsonl.tmp'));
  assert.ok(!MATCH.test('usage.jsonl'));
  assert.ok(!MATCH.test('usage-2026-13-99.jsonl'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-telemetrylog.test.js`

Expected: FAIL — `Cannot find module '../src/main/providers/dsh/telemetrylog'`。

- [ ] **Step 3: 实现 `src/main/providers/dsh/telemetrylog.js`(解析 + 根目录部分;`readLocalLog` 留到 Task 8)**

```js
// DSH usage 遥测文件解析 + 根目录解析。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const {
  normalizeTimestampMs,
  incrementDiagnostic,
  localDayStr
} = require('../../core/locallog');
const { calcDshCost } = require('../../pricing');

const fsp = fs.promises;

// $DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.dsh', 'telemetry');
const MATCH = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.dsh';

// 遥测根目录优先级:设置项 providers.dsh.telemetryRoot > DSH_HOME 环境变量 > ~/.dsh/telemetry。
function resolveTelemetryRoot(store, env) {
  const custom = store && typeof store.get === 'function' ? store.get('providers.dsh.telemetryRoot') : undefined;
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  const dshHome = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dshHome) return path.join(dshHome, 'telemetry');
  return DEFAULT_ROOT();
}

// 解析一行遥测 JSON。任何非法行返回 null 并计诊断;绝不伪造时间戳。
function parseTelemetryLine(line, diagnostics, nowMs) {
  if (!line) return null;
  let data;
  try {
    data = JSON.parse(line);
  } catch (e) {
    incrementDiagnostic(diagnostics, 'malformedLine');
    return null;
  }
  if (!data || typeof data !== 'object') {
    incrementDiagnostic(diagnostics, 'malformedLine');
    return null;
  }
  if (data.v === undefined) {
    incrementDiagnostic(diagnostics, 'missingRowVersion');
    return null;
  }
  if (data.v !== 1) {
    incrementDiagnostic(diagnostics, 'unknownRowVersion');
    return null;
  }
  const ts = normalizeTimestampMs(data.time, nowMs);
  if (ts === null) {
    incrementDiagnostic(diagnostics, 'invalidTimestamp');
    return null;
  }
  const input = Number(data.inputTokens);
  const output = Number(data.outputTokens);
  const cacheRead = Number(data.cacheReadTokens) || 0;
  const cacheWrite = Number(data.cacheWriteTokens) || 0;
  const buckets = [input, output, cacheRead, cacheWrite];
  if (!buckets.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    incrementDiagnostic(diagnostics, 'invalidTokenCount');
    return null;
  }
  const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : 'unknown';
  const record = {
    ts: ts,
    model: model,
    // UsageRecord 映射:input 含 cacheWrite(按输入计费),cached = cacheRead。
    usage: {
      input: input + cacheWrite,
      cached: cacheRead,
      output: output,
      total: input + cacheWrite + cacheRead + output
    },
    // 费用按原始四桶计算(与 UsageRecord 映射独立,不重复计费)。
    cost: calcDshCost(model, input, output, cacheRead, cacheWrite)
  };
  record.eventFingerprint = 'sha256:' + crypto.createHash('sha256')
    .update([
      new Date(ts).toISOString(),
      input,
      output,
      cacheRead,
      cacheWrite
    ].join('\0'), 'utf8')
    .digest('hex');
  return record;
}

module.exports = {
  parseTelemetryLine,
  resolveTelemetryRoot,
  DEFAULT_ROOT,
  MATCH,
  CURSOR_KEY,
  localDayStr
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/dsh-telemetrylog.test.js`

Expected: PASS(5 tests)。

- [ ] **Step 5: 提交(Monitor)**

```bash
git add src/main/providers/dsh/telemetrylog.js test/dsh-telemetrylog.test.js
git commit -m "feat(dsh): telemetry line parsing and root resolution"
```

---

## Task 8: 扫描与聚合(`readLocalLog` + `usageDailyCost`)

**Files:**
- Modify: `D:\Deepseek_Monitor\src\main\providers\dsh\telemetrylog.js`(追加扫描/合并)
- Test: `D:\Deepseek_Monitor\test\dsh-telemetrylog.test.js`(追加扫描测试)

**Interfaces:**
- Consumes: `scanCandidateBatch`/`rollupDaily`/`walkFiles`(core/locallog.js)、`filterUsageDaily`(core/usage-retention.js)、Task 7 的解析函数。
- Produces: `readLocalLog(ctx, opts)` 返回 `{ records, complete, bytesRead }`;副作用:合并 `usageDaily` 与 `usageDailyCost`(键 `'dsh:YYYY-MM-DD'`),游标存 `localLogCursors.dsh`,三者单快照原子提交(仿 codex `commitUuidScanState`)。

- [ ] **Step 1: 在 `test/dsh-telemetrylog.test.js` 追加失败测试(文件末尾 append 新代码)**

```js
/* ======== readLocalLog 扫描与聚合 ======== */
const fs = require('node:fs');

function makeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  function getPath(object, key) {
    return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
  }
  function setPath(object, key, value) {
    const parts = key.split('.');
    let current = object;
    while (parts.length > 1) {
      const part = parts.shift();
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part];
    }
    current[parts[0]] = value;
  }
  return {
    get(key) { return getPath(data, key); },
    set(key, value) { setPath(data, key, value); }
  };
}

function writeRows(root, dayFile, rows) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, dayFile), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('readLocalLog merges usageDaily and usageDailyCost from the day file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  writeRows(root, 'usage-2026-08-14.jsonl', [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 100 },
    { v: 1, time: Date.UTC(2026, 7, 14, 3, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ]);
  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) });

  assert.equal(batch.records.length, 2);
  assert.equal(batch.complete, true);
  const daily = store.get('usageDaily');
  const row = daily['dsh:2026-08-14'];
  assert.equal(row.input, 1100 + 500);
  assert.equal(row.cached, 3000);
  assert.equal(row.output, 2000);
  assert.equal(row.total, 6100 + 500);
  assert.ok(store.get('usageDailyCost')['dsh:2026-08-14'] > 0);
});

test('readLocalLog rescans incrementally: failed commit restores data and the re-read merges exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  writeRows(root, dayFile, [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ]);
  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const now = Date.UTC(2026, 7, 14, 4, 0, 0);

  await readLocalLog({ store }, { nowMs: now });
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 100);

  // 追加一行;随后一次游标提交失败的扫描必须既不落数据也不落游标(原子回滚)。
  fs.appendFileSync(path.join(root, dayFile), JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 30, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) + '\n');

  const failing = makeStore({
    usageDaily: store.get('usageDaily'),
    usageDailyCost: store.get('usageDailyCost'),
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const realSet = failing.set.bind(failing);
  failing.set = function (key, value) {
    if (key === 'localLogCursors.dsh') throw new Error('cursor commit failed');
    realSet(key, value);
  };
  await assert.rejects(readLocalLog({ store: failing }, { nowMs: now }), /cursor commit failed/);
  assert.equal(failing.get('usageDaily')['dsh:2026-08-14'].input, 100);

  // 正常 store 重扫:重读被回滚的那一行,恰好合并一次,不双计。
  const batch = await readLocalLog({ store }, { nowMs: now });
  assert.equal(batch.records.length, 1);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 300);
  // 再扫一轮:无新行。
  const batch3 = await readLocalLog({ store }, { nowMs: now });
  assert.equal(batch3.records.length, 0);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 300);
});

test('scanTelemetryBatch skips a re-read line via cursor.lastEventFingerprint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  const row = { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
  writeRows(root, dayFile, [row]);
  const filePath = path.join(root, dayFile);
  // 模拟"行已发射但游标未前进"的崩溃残留:offset 0 + 该行指纹。
  const { parseTelemetryLine } = require('../src/main/providers/dsh/telemetrylog');
  const fingerprint = parseTelemetryLine(JSON.stringify(row), {}, Date.now()).eventFingerprint;
  const store = makeStore({
    localLogCursors: { dsh: { [filePath]: { offset: 0, mtimeMs: fs.statSync(filePath).mtimeMs, lastEventFingerprint: fingerprint } } },
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const diagnostics = {};
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0), diagnostics });
  assert.equal(batch.records.length, 0);
  assert.equal(diagnostics.duplicateEvent, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-telemetrylog.test.js`

Expected: FAIL — `readLocalLog is not a function`。

- [ ] **Step 3: 在 `telemetrylog.js` 追加扫描与合并实现**

在文件末尾(`module.exports` 之前)追加:

```js
function cloneStoreValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// 快照式原子提交:usageDaily、usageDailyCost 与游标同属一份持久单元
// (仿 codex commitUuidScanState;electron-store 的 store 快照替换失败时退化为逐键提交)。
function commitTelemetryScanState(store, usageDaily, usageDailyCost, cursors) {
  const snapshot = store && store.store;
  if (snapshot && typeof snapshot === 'object') {
    const copy = cloneStoreValue(snapshot);
    copy.usageDaily = usageDaily;
    copy.usageDailyCost = usageDailyCost;
    copy.localLogCursors = Object.assign(
      copy.localLogCursors && typeof copy.localLogCursors === 'object' ? copy.localLogCursors : {},
      { dsh: cursors }
    );
    store.store = copy;
    return;
  }
  const previousDaily = cloneStoreValue(store.get('usageDaily')) || {};
  const previousCost = cloneStoreValue(store.get('usageDailyCost')) || {};
  try {
    store.set('usageDaily', usageDaily);
    store.set('usageDailyCost', usageDailyCost);
    store.set(CURSOR_KEY, cursors);
  } catch (error) {
    try {
      store.set('usageDaily', previousDaily);
      store.set('usageDailyCost', previousCost);
    } catch (_) { /* 保留原始提交失败 */ }
    throw error;
  }
}

// 扫描单根目录下的 usage-*.jsonl:稳定身份 = 完整路径;onRecord 内做事件指纹去重
// (游标提交失败重扫时,已提交行之前的最后一条会被重读,指纹相同即跳过)。
async function scanTelemetryBatch({ store, root, parseLine, diagnostics, nowMs, chunkBytes, maxBytesPerScan, yieldToLoop, seenFingerprints }) {
  const cursors = cloneStoreValue((store && store.get(CURSOR_KEY)) || {});
  const files = await walkFiles(root, MATCH);
  const candidates = files.map((filePath) => ({
    identity: filePath,
    filePath: filePath,
    cursor: cursors[filePath] || { offset: 0, mtimeMs: 0 }
  }));

  const result = await scanCandidateBatch({
    candidates,
    parseLine,
    onRecord({ record, cursor, records }) {
      if (record && record.eventFingerprint) {
        const fingerprint = record.eventFingerprint;
        let emit = true;
        if (seenFingerprints) {
          if (seenFingerprints.has(fingerprint)) {
            incrementDiagnostic(diagnostics, 'duplicateEvent');
            emit = false;
          } else {
            seenFingerprints.add(fingerprint);
          }
        } else if (cursor.lastEventFingerprint === fingerprint) {
          incrementDiagnostic(diagnostics, 'duplicateEvent');
          emit = false;
        }
        if (emit) records.push(Object.assign({ provider: 'dsh' }, record));
        cursor.lastEventFingerprint = fingerprint;
      }
      return cursor;
    },
    resetCursor(cursor, stat) {
      return { offset: 0, mtimeMs: stat.mtimeMs, lastEventFingerprint: null };
    },
    setCursor(candidate, cursor) {
      cursors[candidate.identity] = cursor;
    },
    diagnostics,
    nowMs,
    chunkBytes,
    maxBytesPerScan,
    yieldToLoop
  });

  for (const identity of Object.keys(cursors)) {
    if (!files.includes(identity)) delete cursors[identity];
  }
  return Object.assign({}, result, { cursors });
}

// 异步增量扫描遥测文件:返回 ScanBatch({ records, complete, bytesRead });
// 并按日聚合增量合并进 store 键 'usageDaily' 与 'usageDailyCost'(仅 dsh 前缀)。
async function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const diagnostics = opts && opts.diagnostics;
  const requestedNowMs = opts && opts.nowMs;
  const parsedNowMs = Number(requestedNowMs);
  const nowMs = requestedNowMs !== null
    && requestedNowMs !== undefined
    && Number.isFinite(parsedNowMs)
    ? parsedNowMs
    : Date.now();
  const root = resolveTelemetryRoot(store, process.env);
  const batch = await scanTelemetryBatch({
    store,
    root,
    parseLine: parseTelemetryLine,
    diagnostics,
    nowMs,
    chunkBytes: opts && opts.chunkBytes,
    maxBytesPerScan: opts && opts.maxBytesPerScan,
    yieldToLoop: opts && opts.yieldToLoop,
    seenFingerprints: opts && opts.seenFingerprints
  });
  const records = batch.records;
  let usageDaily = cloneStoreValue((store && store.get('usageDaily')) || {});
  let usageDailyCost = cloneStoreValue((store && store.get('usageDailyCost')) || {});
  if (records.length && store) {
    const { filterUsageDaily } = require('../../core/usage-retention');
    const rolled = rollupDaily(records, diagnostics, nowMs);
    const daily = opts && opts.retainAll
      ? rolled
      : filterUsageDaily(rolled, store.get('data.historyDays'), nowMs);
    Object.keys(daily).forEach((key) => {
      const prev = usageDaily[key] || { input: 0, cached: 0, output: 0, total: 0 };
      const add = daily[key];
      usageDaily[key] = {
        input: prev.input + add.input,
        cached: prev.cached + add.cached,
        output: prev.output + add.output,
        total: prev.total + add.total
      };
    });

    const costRolled = {};
    records.forEach((rec) => {
      const day = localDayStr(rec.ts);
      const key = 'dsh:' + day;
      costRolled[key] = Number(costRolled[key] || 0) + Number(rec.cost || 0);
    });
    const costDaily = opts && opts.retainAll
      ? costRolled
      : filterUsageDaily(costRolled, store.get('data.historyDays'), nowMs);
    Object.keys(costDaily).forEach((key) => {
      usageDailyCost[key] = Number(usageDailyCost[key] || 0) + Number(costDaily[key]);
    });
    commitTelemetryScanState(store, usageDaily, usageDailyCost, batch.cursors || {});
  } else if (store) {
    commitTelemetryScanState(store, usageDaily, usageDailyCost, batch.cursors || {});
  }
  return batch;
}
```

并把 `module.exports` 改为包含 `readLocalLog`:

```js
module.exports = {
  parseTelemetryLine,
  resolveTelemetryRoot,
  readLocalLog,
  scanTelemetryBatch,
  DEFAULT_ROOT,
  MATCH,
  CURSOR_KEY,
  localDayStr
};
```

同时在文件顶部 require 补上 `scanCandidateBatch`、`rollupDaily`、`walkFiles`(把 `const { normalizeTimestampMs, incrementDiagnostic, localDayStr } = require('../../core/locallog');` 改为 `const { scanCandidateBatch, rollupDaily, walkFiles, normalizeTimestampMs, incrementDiagnostic, localDayStr } = require('../../core/locallog');`)。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/dsh-telemetrylog.test.js`

Expected: PASS(共 8 个:Task 7 的 5 个 + 本任务 3 个)。失败时按断言定位——核心不变量是"游标提交失败原子回滚,重扫只合并一次,指纹去重跳过残留行"。

- [ ] **Step 5: 提交(Monitor)**

```bash
git add src/main/providers/dsh/telemetrylog.js test/dsh-telemetrylog.test.js
git commit -m "feat(dsh): incremental telemetry scan merging usageDaily and usageDailyCost"
```

---

## Task 9: ProviderAdapter 注册与调度接入

**Files:**
- Create: `D:\Deepseek_Monitor\src\main\providers\dsh\index.js`
- Modify: `D:\Deepseek_Monitor\src\main\index.js`(注册行)
- Modify: `D:\Deepseek_Monitor\src\main\core\settings-reset.js`(RESET_KEEP_KEYS)
- Test: `D:\Deepseek_Monitor\test\dsh-provider-scheduler.test.js`

**Interfaces:**
- Consumes: `readLocalLog`/`resolveTelemetryRoot`/`DEFAULT_ROOT`(Task 7/8)、registry/scheduler 的既有契约(provider 需 `id`/`displayName`/`capabilities`/`authStatus`/`localLogRoot({store})`/`readLocalLog(ctx, opts)`)。
- Produces: 可注册的 dsh ProviderAdapter;`registry.get('dsh')` 可用;调度器 `poll('dsh', 'localLog')` 工作。

- [ ] **Step 1: 写失败测试 `test/dsh-provider-scheduler.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dshProvider = require('../src/main/providers/dsh');
const { startScheduler } = require('../src/main/core/scheduler');

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}
function setPath(object, key, value) {
  const parts = key.split('.');
  let current = object;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}
function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    get(key) { return getPath(data, key); },
    set(key, value) { setPath(data, key, value); }
  };
}
function makeRegistry(providers) {
  return { list: () => providers.slice(), get: (id) => providers.find((p) => p.id === id) };
}

test('dsh adapter exposes the localLog contract', () => {
  assert.equal(dshProvider.id, 'dsh');
  assert.equal(dshProvider.displayName, 'DeepSeek Harness');
  assert.deepEqual(dshProvider.capabilities, { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false });
  assert.equal(dshProvider.authStatus({}), 'ok');
  assert.equal(typeof dshProvider.readLocalLog, 'function');
  const root = dshProvider.localLogRoot({ store: makeStore() });
  assert.ok(path.isAbsolute(root) && root.endsWith(path.join('.dsh', 'telemetry')));
});

test('scheduler polls dsh localLog and the merged daily lands in the store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-'));
  fs.writeFileSync(path.join(root, 'usage-2026-08-14.jsonl'),
    JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }) + '\n');

  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([dshProvider]),
    store,
    broadcast(channel, payload) { broadcasts.push({ channel, payload }); },
    intervals: false
  });
  try {
    await scheduler.poll('dsh', 'localLog');
    const daily = store.get('usageDaily');
    assert.equal(daily['dsh:2026-08-14'].input, 100);
    assert.equal(daily['dsh:2026-08-14'].output, 200);
    assert.ok(store.get('usageDailyCost')['dsh:2026-08-14'] > 0);
    assert.ok(broadcasts.some((b) => b.channel === 'providers:changed'));
  } finally {
    scheduler.stop();
  }
});

test('RESET_KEEP_KEYS preserves dsh aggregates and cursors across a settings reset', () => {
  const { RESET_KEEP_KEYS } = require('../src/main/core/settings-reset');
  assert.ok(RESET_KEEP_KEYS.includes('usageDailyCost'));
  assert.ok(RESET_KEEP_KEYS.includes('localLogCursors.dsh'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-provider-scheduler.test.js`

Expected: FAIL — `Cannot find module '../src/main/providers/dsh'`。

- [ ] **Step 3: 创建 `src/main/providers/dsh/index.js`**

```js
// DSH Provider 适配器(localLog 通道:DSH usage 遥测文件)。
const { readLocalLog, resolveTelemetryRoot } = require('./telemetrylog');

module.exports = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  authStatus() {
    // 本地遥测文件无需凭证。
    return 'ok';
  },

  localLogRoot(ctx) {
    return resolveTelemetryRoot(ctx && ctx.store, process.env);
  },

  readLocalLog
};
```

- [ ] **Step 4: `src/main/index.js` 注册 provider**

`src/main/index.js` 第 10 行为 `const kimiProvider = require('./providers/kimi');`。在其后插入:

```js
const dshProvider = require('./providers/dsh');
```

并在 `app.whenReady().then(() => {` 块内 `registry.register(kimiProvider);`(第 849 行)之后加入:

```js
  registry.register(dshProvider);
```

- [ ] **Step 5: `settings-reset.js` 扩展 RESET_KEEP_KEYS**

把:

```js
  'localLogCursors.codex',
  'localLogCursors.kimi',
```

改为:

```js
  'localLogCursors.codex',
  'localLogCursors.kimi',
  // DSH 遥测:汇总、费用与游标是同一份持久单元,必须与 usageDaily 一起保留。
  'usageDailyCost',
  'localLogCursors.dsh',
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```
node --test test/dsh-provider-scheduler.test.js
node --test test/scheduler.test.js test/scheduler-locallog-broadcast.test.js test/providers-registry.test.js
```

Expected: 全部 PASS(既有 scheduler/registry 测试无回归)。

- [ ] **Step 7: 提交(Monitor)**

```bash
git add src/main/providers/dsh/index.js src/main/index.js src/main/core/settings-reset.js test/dsh-provider-scheduler.test.js
git commit -m "feat(dsh): provider adapter registered into scheduler and registry"
```

---

## Task 10: Token 速度卡接入 `'dsh'`

**Files:**
- Modify: `D:\Deepseek_Monitor\src\main\core\token-speed-tracker.js`
- Test: `D:\Deepseek_Monitor\test\dsh-token-speed.test.js`

**Interfaces:**
- Consumes: 现有 `createTokenSpeedTracker`/`PROVIDER_IDS` 导出。
- Produces: `PROVIDER_IDS === ['deepseek','codex','kimi','dsh']`;dsh 状态走与其它平台相同的采样/窗口逻辑(数据由 `token-speed-runtime.js` 从 `usageDaily['dsh:'+day].total` 喂入,无需改动 runtime)。

- [ ] **Step 1: 写失败测试 `test/dsh-token-speed.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTokenSpeedTracker, PROVIDER_IDS } = require('../src/main/core/token-speed-tracker');

test('PROVIDER_IDS includes dsh', () => {
  assert.deepEqual(PROVIDER_IDS, ['deepseek', 'codex', 'kimi', 'dsh']);
});

test('dsh observes, samples, and computes window metrics like other providers', () => {
  let now = 1000000;
  const tracker = createTokenSpeedTracker({ now: () => now });
  tracker.observe({ providerId: 'dsh', dayKey: '2026-08-14', totalTokens: 0 });
  tracker.sample();
  now += 60000;
  tracker.observe({ providerId: 'dsh', dayKey: '2026-08-14', totalTokens: 600 });
  tracker.sample();

  const snapshot = tracker.getSnapshot({ providerFilter: 'dsh', intervalSeconds: 60, at: now });
  assert.equal(snapshot.providerFilter, 'dsh');
  const dsh = snapshot.providers.find((p) => p.providerId === 'dsh');
  assert.ok(dsh);
  assert.equal(dsh.status, 'ok');
  assert.equal(dsh.deltaTokens, 600);
  assert.equal(dsh.tokensPerMinute, 600);
});

test('unknown provider ids still throw', () => {
  const tracker = createTokenSpeedTracker({ now: () => 0 });
  assert.throws(() => tracker.observe({ providerId: 'nope', totalTokens: 1 }), /Unknown token speed provider/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-token-speed.test.js`

Expected: FAIL — 第一个断言失败(`PROVIDER_IDS` 仍为 3 项)。

- [ ] **Step 3: 修改 `token-speed-tracker.js` 第 8 行**

把:

```js
const PROVIDER_IDS = Object.freeze(['deepseek', 'codex', 'kimi']);
```

改为:

```js
const PROVIDER_IDS = Object.freeze(['deepseek', 'codex', 'kimi', 'dsh']);
```

- [ ] **Step 4: 运行测试并修复既有断言**

Run:

```
node --test test/dsh-token-speed.test.js
node --test test/token-speed-tracker.test.js test/token-speed-runtime.test.js test/token-speed-integration.test.js test/token-speed-card-static.test.js
```

Expected: dsh 新测试 PASS;既有 token-speed 测试中任何对 PROVIDER_IDS 长度/快照 provider 列表的硬编码断言(如期待 3 个 provider)会 FAIL——把这类断言更新为含 `'dsh'` 的新期望(逐处确认语义,不得直接放宽断言)。渲染层 `renderer/src/lib/token-speed-chart.js` 的 PROVIDER_META 属 Kimi 前端范围,**不改**。

- [ ] **Step 5: 提交(Monitor)**

```bash
git add src/main/core/token-speed-tracker.js test/dsh-token-speed.test.js test/token-speed-tracker.test.js test/token-speed-runtime.test.js test/token-speed-integration.test.js test/token-speed-card-static.test.js
git commit -m "feat(dsh): include dsh in token speed tracking"
```

(仅提交实际被改动的既有测试文件;未改动的不 add。)

---

## Task 11: 历史同步接入(`sync:history` + `rescanLocalLogs`)

**Files:**
- Modify: `D:\Deepseek_Monitor\src\main\core\history-sync.js`(rescanLocalLogs 同步维护 usageDailyCost)
- Modify: `D:\Deepseek_Monitor\src\main\ipc.js`(sync:history 增加 dsh 分支)
- Test: `D:\Deepseek_Monitor\test\dsh-history-rescan.test.js`

**Interfaces:**
- Consumes: `rescanLocalLogs(options)`(history-sync.js)、`setupIPC` 依赖注入形态(ipc.js)。
- Produces: `sync:history` 返回 `summary.dsh = { daysRebuilt, earliestDate, ... }`;重扫时 usageDailyCost 与 usageDaily 同生命周期(备份/清空/还原/重建)。

- [ ] **Step 1: 写失败测试 `test/dsh-history-rescan.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rescanLocalLogs } = require('../src/main/core/history-sync');
const dshProvider = require('../src/main/providers/dsh');

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    get(key) {
      if (key === 'usageDaily') return data.usageDaily;
      if (key === 'usageDailyCost') return data.usageDailyCost;
      if (key === 'localLogCursors.dsh') return data.localLogCursors_dsh;
      if (key === 'data.historyDays') return data.historyDays;
      if (key === 'providers.dsh.telemetryRoot') return data.root;
      return undefined;
    },
    set(key, value) {
      if (key === 'usageDaily') data.usageDaily = JSON.parse(JSON.stringify(value));
      else if (key === 'usageDailyCost') data.usageDailyCost = JSON.parse(JSON.stringify(value));
      else if (key === 'localLogCursors.dsh') data.localLogCursors_dsh = JSON.parse(JSON.stringify(value));
      else data[key] = value;
    },
    delete(key) { delete data[key]; }
  };
}

test('rescanLocalLogs clears and rebuilds dsh usageDaily AND usageDailyCost transactionally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rescan-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  fs.writeFileSync(path.join(root, dayFile),
    [
      JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 3, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    ].join('\n') + '\n');

  const store = makeStore({
    usageDaily: { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } },
    usageDailyCost: { 'dsh:2026-08-13': 0.004 },
    root,
    historyDays: 30
  });

  const result = await rescanLocalLogs({
    providerId: 'dsh',
    readLocalLog: () => dshProvider.readLocalLog({ store }, { retainAll: true, nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) }),
    readStore: (k) => store.get(k),
    writeStore: (k, v) => store.set(k, v),
    deleteStore: (k) => store.delete(k)
  });

  assert.equal(result.daysRebuilt, 2);
  const daily = store.get('usageDaily');
  assert.equal(daily['dsh:2026-08-14'].input, 1500);
  const cost = store.get('usageDailyCost');
  assert.ok(cost['dsh:2026-08-14'] > 0);
});

test('rescanLocalLogs restores usageDailyCost when the scan fails', async () => {
  const store = makeStore({
    usageDaily: { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } },
    usageDailyCost: { 'dsh:2026-08-13': 0.004 },
    root: path.join(os.tmpdir(), 'no-such-dsh-telemetry-dir-' + Date.now()),
    historyDays: 30
  });
  await assert.rejects(rescanLocalLogs({
    providerId: 'dsh',
    readLocalLog: async () => { throw new Error('boom'); },
    readStore: (k) => store.get(k),
    writeStore: (k, v) => store.set(k, v),
    deleteStore: (k) => store.delete(k)
  }), /boom/);
  assert.deepEqual(store.get('usageDailyCost'), { 'dsh:2026-08-13': 0.004 });
  assert.deepEqual(store.get('usageDaily'), { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-history-rescan.test.js`

Expected: FAIL — 重扫后 `usageDailyCost` 仍是旧值(第 1 个测试的 cost 断言失败),因为 `rescanLocalLogs` 尚不维护该键。

- [ ] **Step 3: 修改 `history-sync.js` 的 `rescanLocalLogs`**

在 `const backupCursor = cloneValue(readStore(cursorKey));` 之后插入:

```js
  const usageDailyCost = readStore('usageDailyCost') || {};
  const backupCostRows = {};
  Object.keys(usageDailyCost).forEach((k) => {
    if (k.indexOf(prefix) === 0) backupCostRows[k] = cloneValue(usageDailyCost[k]);
  });
```

把清空段(`writeStore('usageDaily', clearedDaily); writeStore(cursorKey, {});`)改为:

```js
    writeStore('usageDaily', clearedDaily);
    const clearedCost = cloneValue(usageDailyCost);
    Object.keys(clearedCost).forEach((k) => {
      if (k.indexOf(prefix) === 0) delete clearedCost[k];
    });
    writeStore('usageDailyCost', clearedCost);
    writeStore(cursorKey, {});
```

把 catch 还原段(在 `writeStore('usageDaily', current);` 之后)改为:

```js
    const currentCost = cloneValue(readStore('usageDailyCost') || {});
    Object.keys(currentCost).forEach((k) => {
      if (k.indexOf(prefix) === 0) delete currentCost[k];
    });
    Object.keys(backupCostRows).forEach((k) => {
      currentCost[k] = backupCostRows[k];
    });
    writeStore('usageDailyCost', currentCost);
```

(读 `readStore('usageDailyCost')` 对 codex/kimi 的既有测试返回 undefined → `|| {}`,行为不变。)

- [ ] **Step 4: 修改 `ipc.js` 的 `sync:history`**

在 kimi 分支(`summary.kimi = ...` else 块)之后、`// 历史保留提示` 注释之前插入:

```js
    const dshProvider = deps.registry.get('dsh');
    if (dshProvider && typeof dshProvider.readLocalLog === 'function') {
      summary.dsh = await runLocalLogExclusive('dsh', () => rescanLocalLogs({
        providerId: 'dsh',
        readLocalLog: () => dshProvider.readLocalLog({ store: deps.store }, { retainAll: true }),
        readStore,
        writeStore,
        deleteStore,
        onProgress: sendProgress
      }));
    } else {
      summary.dsh = { daysRebuilt: 0, earliestDate: null, skipped: true };
    }
```

并把 earliest 计算行:

```js
    const earliest = [summary.deepseek, summary.codex, summary.kimi]
```

改为:

```js
    const earliest = [summary.deepseek, summary.codex, summary.kimi, summary.dsh]
```

(`rescanLocalLogs` 已在 ipc.js 第 12 行 require:`const { syncDeepSeekHistory, rescanLocalLogs } = require('./core/history-sync');`,无需新增。)

- [ ] **Step 5: 运行测试确认通过**

Run:

```
node --test test/dsh-history-rescan.test.js
node --test test/history-sync.test.js test/history-sync-ipc.test.js test/local-log-rescan-integration.test.js test/locallog-retain-all.test.js
```

Expected: 全部 PASS(既有 history-sync 相关测试无回归)。

- [ ] **Step 6: 提交(Monitor)**

```bash
git add src/main/core/history-sync.js src/main/ipc.js test/dsh-history-rescan.test.js
git commit -m "feat(dsh): manual history rescan keeps dsh cost data transactional"
```

---

## Task 12: 文档与全量回归

**Files:**
- Modify: `D:\Deepseek_Monitor\README.md`
- (无代码改动)

- [ ] **Step 1: README 数据来源表加 DSH 行**

在 `## 数据来源` 表格的 Kimi 行之后加:

```markdown
| DeepSeek Harness | 本地遥测文件(`~/.dsh/telemetry/usage-YYYY-MM-DD.jsonl`,由 DSH 的 usage-telemetry 组件按请求追加) |
```

- [ ] **Step 2: Monitor 全量测试**

Run: `npm test`

Expected: 全部 PASS;任何既有测试因 `'dsh'` 出现而失败(如 provider 枚举、settings 快照、诊断聚合),按语义更新期望(不得放宽)。若有渲染层静态测试依赖 provider 列表(属 Kimi 范围),确认其只读行为不受主进程改动影响;若其直接 import 主进程常量,则同步更新该常量的期望。

- [ ] **Step 3: DSH 侧复验**

Run(DSH 根目录):

```
pnpm exec vitest run packages/telemetry/usage-telemetry
pnpm exec tsc -b packages/telemetry/usage-telemetry
pnpm verify-cordis-config
```

Expected: 全部退出 0。

- [ ] **Step 4: 提交(Monitor)**

```bash
git add README.md
git commit -m "docs: add DeepSeek Harness row to data sources"
```

---

## Self-Review Notes(已完成,供执行者参考)

- Spec 覆盖:spec 1-8 节分别落在 Task 1-12;spec 3.3 行格式由 Task 2 冻结;spec 3.5 开关由 Task 4 的 settings 注入测试覆盖;spec 4.4 费用口径在 Task 6/7;spec 4.5 在 Task 10;spec 4.6 前后端边界在 Global Constraints(渲染层不改);spec 5 错误处理逐项落在 Task 2/4/7/8 的测试;spec 6 测试清单一一对应各 Task 的 Step 1。
- 类型一致性:`parseTelemetryLine` 返回 `{ ts, model, usage: { input, cached, output, total }, cost, eventFingerprint }`,Task 8 的 `scanTelemetryBatch` 消费 `record.eventFingerprint`/`record.cost` 与 `rollupDaily` 的 `rec.ts`/`rec.usage`/`rec.provider` 字段,名称全程一致;`commitTelemetryScanState(store, usageDaily, usageDailyCost, cursors)` 三处调用签名一致;`readLocalLog(ctx, opts)` 返回值形状 `{ records, complete, bytesRead }` 满足 scheduler(`batch.records`)与 history-sync(`batch.complete`)双消费方。
- 已知偏差(有意为之,已向用户说明):DSH writer 用 `appendFile` 每行重开文件而非缓存句柄——轮转语义等价、无句柄失效状态。
- 修订(费用消费通道,与原记录不符):原记录称"`usageDailyCost` 经 `sanitizeSettings` 白名单外放行,渲染层可读"——与实现事实不符:`settings-security.js` 的 `sanitizeSettings` 是"整库深拷贝 + 仅删 3 个密钥路径"的黑名单,不存在白名单;`usageDailyCost` 混入 `get:settings`/`settings:loaded` 载荷只是深拷贝副作用,且当时无任何渲染方消费该键。修复后费用走 `get:dashboard` 的 `dsh` 分支(`src/main/core/dsh-dashboard.js` 聚合 `usageDaily`/`usageDailyCost` 的 `dsh:` 前缀日行 → `buildCurvePoints` → `curveCost`),渲染层 cost-line 用 `renderer/src/lib/curve-merge.js` 的 `mergeCurves` 合并 deepseek 与 dsh 两条费用曲线展示。
- 修订(settings 载荷瘦身,已实现):`sanitizeSettings` 现显式剥离 `usageDaily`/`usageDailyCost` 大数据键(用量/费用聚合只经专用 IPC `get:heatmap`/`get:dashboard` 提供给渲染层),不再随 `get:settings`/`settings:loaded` 每 60s 整库广播;测试 `test/settings-security.test.js` 覆盖"剥离两键 + 原对象不被修改"。

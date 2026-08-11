# 悬浮层统一动作模板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把主窗口悬浮层(tooltip/下拉菜单)的定位规则收敛到 `renderer/src/lib/floating-layer.js`,修复 Token 消耗速度卡片 tooltip 顶出窗口被裁的 bug,并用静态测试防止新模块漏接。

**Architecture:** 新增纯函数库(无 React/ECharts 依赖)提供三原语:`clampToWindow` / `resolveVerticalFlip` / `echartsWindowPosition`;四个消费方(ChartWidget、token-speed-chart、TokenHeatmap、CustomSelect)改为引用,各自交互节奏(延迟/淡出/动画)不变。分支 `feat/floating-layer`,每 Task 一提交,最后 PR。

**Tech Stack:** React(vite,renderer/)、ECharts、node:test(CJS 测试,test/ 目录)

## Global Constraints

- 测试风格:`node --test`,CJS(`require`/`node:assert/strict`),测试文件放 `test/`
- 浏览器全局:测试内注入 `globalThis.window = { innerWidth, innerHeight }`,用 `t.after()` 清理
- renderer 改动后必须通过 `npm run build:renderer` 验证构建
- 不统一各模块的显示延迟/淡出/动画时序;不动悬浮层样式与内容;不动 `src/renderer` 旧 CJS 页面
- 提交信息遵循项目现有风格(type(scope): 中文描述)
- spec:`docs/superpowers/specs/2026-08-11-floating-layer-design.md`(spec 中 `resolveVerticalFlip` 的选项签名在本计划中扩展为 `{ gap = 6, margin = 8, prefer = 'below' }`,原因见 Task 1 注释)

---

### Task 1: `renderer/src/lib/floating-layer.js` 纯函数库

**Files:**
- Create: `renderer/src/lib/floating-layer.js`
- Test: `test/floating-layer.test.js`

**Interfaces:**
- Produces:
  - `clampToWindow(x, y, width, height, margin = 8) -> { x, y }`
  - `resolveVerticalFlip(anchorRect, contentHeight, { gap = 6, margin = 8, prefer = 'below' } = {}) -> { below, top }`
    - `anchorRect` 只需 `top`/`bottom` 数值字段;`prefer: 'below'`(CustomSelect/ECharts 风格:下方够就放下面,或上方不够也放下面);`prefer: 'above'`(热力图风格:默认放上面,上方放不下且下方够才放下面)
    - 返回 `top`:below 时 `anchorRect.bottom + gap`;否则 `anchorRect.top - gap - contentHeight`
  - `echartsWindowPosition(dom) -> (pos, params, tipEl, rect, size) => [x, y]`(echarts tooltip position 回调;`dom` 可为 null)

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

function stubWindow(t, innerWidth, innerHeight) {
  const prev = globalThis.window;
  globalThis.window = { innerWidth, innerHeight };
  t.after(() => {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  });
}

const {
  clampToWindow,
  resolveVerticalFlip,
  echartsWindowPosition
} = require('../renderer/src/lib/floating-layer.js');

test('clampToWindow clamps all four edges with default margin', (t) => {
  stubWindow(t, 420, 680);
  assert.deepEqual(clampToWindow(-50, -50, 100, 60), { x: 8, y: 8 });
  assert.deepEqual(clampToWindow(400, 660, 100, 60), { x: 312, y: 612 });
  assert.deepEqual(clampToWindow(100, 100, 100, 60), { x: 100, y: 100 });
});

test('clampToWindow falls back to margin when layer exceeds viewport', (t) => {
  stubWindow(t, 200, 200);
  assert.deepEqual(clampToWindow(50, 50, 400, 400), { x: 8, y: 8 });
});

test('resolveVerticalFlip prefers below when space allows', (t) => {
  stubWindow(t, 420, 680);
  const flip = resolveVerticalFlip({ top: 100, bottom: 130 }, 120);
  assert.equal(flip.below, true);
  assert.equal(flip.top, 136);
});

test('resolveVerticalFlip flips up when below does not fit', (t) => {
  stubWindow(t, 420, 680);
  const flip = resolveVerticalFlip({ top: 600, bottom: 630 }, 120);
  assert.equal(flip.below, false);
  assert.equal(flip.top, 600 - 6 - 120);
});

test('resolveVerticalFlip with prefer above stays above unless only below fits', (t) => {
  stubWindow(t, 420, 680);
  // 上方充足:保持 above(热力图默认行为)
  assert.equal(resolveVerticalFlip({ top: 300, bottom: 330 }, 140, { prefer: 'above' }).below, false);
  // 靠近顶部,上方不够而下方够:below
  assert.equal(resolveVerticalFlip({ top: 60, bottom: 90 }, 140, { prefer: 'above' }).below, true);
});

test('echartsWindowPosition converts container coords and clamps into window', (t) => {
  stubWindow(t, 420, 680);
  const dom = { getBoundingClientRect: () => ({ left: 20, top: 40 }) };
  const position = echartsWindowPosition(dom);
  const size = { contentSize: [150, 80] };
  // 容器内 (10, 10) → 页面 (20+10+14, 40+10+14) = (44, 64) → 返回容器坐标 (24, 24)
  assert.deepEqual(position([10, 10], null, null, null, size), [24, 24]);
  // 贴近右下:先翻到 -cw-14 / -ch-14,仍越界则钳到窗口内
  const [x, y] = position([390, 640], null, null, null, size);
  assert.equal(20 + x + 150 <= 420 - 8, true);
  assert.equal(40 + y + 80 <= 680 - 8, true);
  assert.equal(20 + x >= 8, true);
  assert.equal(40 + y >= 8, true);
});

test('echartsWindowPosition tolerates null dom', (t) => {
  stubWindow(t, 420, 680);
  const position = echartsWindowPosition(null);
  const size = { contentSize: [150, 80] };
  assert.deepEqual(position([10, 10], null, null, null, size), [24, 24]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/floating-layer.test.js`
Expected: FAIL,`Cannot find module '../renderer/src/lib/floating-layer.js'`

- [ ] **Step 3: 实现**

```js
// 悬浮层统一定位原语(纯函数,无 React/ECharts 依赖):
// clampToWindow 钳制进窗口;resolveVerticalFlip 统一上/下展开判定;
// echartsWindowPosition 是 echarts tooltip position 回调(挂 body 时用)。
// 背景:token-speed 卡片 tooltip 未钳制顶出窗口被裁;各模块自写钳制/翻转,规则漂移。

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function clampToWindow(x, y, width, height, margin = 8) {
  const vp = viewport();
  return {
    x: Math.max(margin, Math.min(vp.width - width - margin, x)),
    y: Math.max(margin, Math.min(vp.height - height - margin, y))
  };
}

// prefer 'below'(默认):下方够就放下面,或上方不够也放下面(CustomSelect/ECharts 风格)
// prefer 'above':默认放上面,上方放不下且下方够才放下面(热力图风格)
function resolveVerticalFlip(anchorRect, contentHeight, options = {}) {
  const gap = options.gap === undefined ? 6 : options.gap;
  const margin = options.margin === undefined ? 8 : options.margin;
  const prefer = options.prefer || 'below';
  const vp = viewport();
  const aboveFits = anchorRect.top - gap - contentHeight >= margin;
  const belowFits = vp.height - anchorRect.bottom - gap - contentHeight >= margin;
  const below = prefer === 'above' ? (!aboveFits && belowFits) : (belowFits || !aboveFits);
  return {
    below,
    top: below ? anchorRect.bottom + gap : anchorRect.top - gap - contentHeight
  };
}

// pos 是图表容器坐标:换算成页面坐标钳制后再减回容器偏移
// (echarts appendToBody 时会再做一次容器→页面换算)。被遮挡时先向反侧翻,再钳制。
function echartsWindowPosition(dom) {
  return (pos, params, tipEl, rect, size) => {
    const chartRect = dom ? dom.getBoundingClientRect() : { left: 0, top: 0 };
    const cw = size.contentSize[0];
    const ch = size.contentSize[1];
    const vp = viewport();
    let px = chartRect.left + pos[0] + 14;
    let py = chartRect.top + pos[1] + 14;
    if (px + cw > vp.width - 8) px = chartRect.left + pos[0] - cw - 14;
    if (py + ch > vp.height - 8) py = chartRect.top + pos[1] - ch - 14;
    const clamped = clampToWindow(px, py, cw, ch);
    return [clamped.x - chartRect.left, clamped.y - chartRect.top];
  };
}

export { clampToWindow, resolveVerticalFlip, echartsWindowPosition };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/floating-layer.test.js`
Expected: 6 pass

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/floating-layer.js test/floating-layer.test.js
git commit -m "feat(renderer): 悬浮层统一定位原语 floating-layer.js"
```

---

### Task 2: token-speed-chart 接入钳制(bug 修复)

**Files:**
- Modify: `renderer/src/lib/token-speed-chart.js:133-141`(tooltip 段)
- Modify: `renderer/src/components/TokenSpeedCard.jsx:53-59`(options 传 dom)
- Test: `test/floating-layer-static.test.js`(本 Task 先建 token-speed 专用断言,Task 6 扩成通用守卫)

**Interfaces:**
- Consumes: Task 1 的 `echartsWindowPosition(dom)`
- Produces: `buildTokenSpeedOption(snapshot, options)` 的 `options.dom`(可为 undefined,回调内部容忍 null)

- [ ] **Step 1: 写失败测试(静态断言)**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('token-speed tooltip appends to body and clamps position into the window', () => {
  const source = read('renderer/src/lib/token-speed-chart.js');
  const tooltip = source.match(/tooltip:\s*\{[\s\S]*?\n    \},/);
  assert.ok(tooltip, 'tooltip config block should exist');
  assert.match(tooltip[0], /appendToBody: true/);
  assert.match(tooltip[0], /position: echartsWindowPosition\(/);
});

test('token speed card passes its chart dom for position clamping', () => {
  const source = read('renderer/src/components/TokenSpeedCard.jsx');
  assert.match(source, /dom: chartRef\.current/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/floating-layer-static.test.js`
Expected: FAIL(tooltip 段无 `position:`)

- [ ] **Step 3: 实现**

`renderer/src/lib/token-speed-chart.js` 顶部 import 区加:

```js
import { echartsWindowPosition } from './floating-layer.js';
```

tooltip 段(133-141 行)加 position:

```js
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      position: echartsWindowPosition(options.dom),
      axisPointer: { type: 'line', lineStyle: { color: isDark ? '#6B7280' : '#9CA3AF' } },
      backgroundColor: isDark ? 'rgba(30,32,38,0.96)' : 'rgba(255,255,255,0.97)',
      borderColor: isDark ? '#3A3C45' : '#E5E7EB',
      textStyle: { color: isDark ? '#E5E7EB' : '#1A1A2E', fontSize: 11 },
      formatter: tooltipFormatter
    },
```

`renderer/src/components/TokenSpeedCard.jsx` 的 `buildTokenSpeedOption` options(53-59 行)加一行:

```js
  }), [snapshot]);
```

改为前(options 对象内):

```js
  }, {
    isDark: document.body.classList.contains('dark'),
    compact: !!chartRef.current && chartRef.current.clientWidth < 220,
    dom: chartRef.current
  }), [snapshot]);
```

- [ ] **Step 4: 跑测试 + 构建确认**

Run: `node --test test/floating-layer-static.test.js`
Expected: 2 pass
Run: `npm run build:renderer`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/token-speed-chart.js renderer/src/components/TokenSpeedCard.jsx test/floating-layer-static.test.js
git commit -m "fix(renderer): Token 消耗速度 tooltip 钳制在窗口内"
```

---

### Task 3: ChartWidget 迁移到共享库(删本地实现)

**Files:**
- Modify: `renderer/src/components/ChartWidget.jsx:166-181`(删 `windowClampedPosition` 定义,改 import + re-export)
- Test: `test/floating-layer-static.test.js`(追加断言)

**Interfaces:**
- Consumes: Task 1 的 `echartsWindowPosition`
- Produces: `ChartWidget.jsx` 继续 `export { windowClampedPosition }`(别名 re-export),`ProviderBar.jsx` 的 `import { ..., windowClampedPosition } from './ChartWidget.jsx'` 不变

- [ ] **Step 1: 追加失败测试**

`test/floating-layer-static.test.js` 末尾追加:

```js
test('ChartWidget re-exports the shared windowClampedPosition from floating-layer', () => {
  const source = read('renderer/src/components/ChartWidget.jsx');
  assert.match(source, /import \{ echartsWindowPosition as windowClampedPosition \} from '\.\.\/lib\/floating-layer\.js'/);
  assert.match(source, /export \{ windowClampedPosition \}/);
  assert.doesNotMatch(source, /export function windowClampedPosition/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/floating-layer-static.test.js`
Expected: 新用例 FAIL(现为本地定义)

- [ ] **Step 3: 实现**

`ChartWidget.jsx` 顶部 import 区加:

```js
import { echartsWindowPosition as windowClampedPosition } from '../lib/floating-layer.js';
```

删除 166-181 行的注释与 `export function windowClampedPosition(dom) { ... }` 整个定义,替换为(放在 `formatToken` 之后原位置):

```js
// 悬浮层定位原语已收敛到 lib/floating-layer.js;保留 re-export 兼容 ProviderBar 的 import。
export { windowClampedPosition };
```

- [ ] **Step 4: 跑测试 + 构建确认**

Run: `node --test test/floating-layer-static.test.js`
Expected: 3 pass
Run: `npm run build:renderer`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/ChartWidget.jsx test/floating-layer-static.test.js
git commit -m "refactor(renderer): ChartWidget 悬浮定位改用共享 floating-layer"
```

---

### Task 4: TokenHeatmap 接入共享钳制/翻转

**Files:**
- Modify: `renderer/src/components/TokenHeatmap.jsx:130-194`(clampTipX、below 判定、useLayoutEffect 二次校正)
- Test: `test/floating-layer-static.test.js`(追加断言)

**Interfaces:**
- Consumes: Task 1 的 `clampToWindow` / `resolveVerticalFlip`
- Produces: 无新接口;交互行为不变(延迟/淡出/二次校正保留,`below` 默认仍偏 above)

- [ ] **Step 1: 追加失败测试**

`test/floating-layer-static.test.js` 末尾追加:

```js
test('heatmap tooltip uses shared clamp and flip primitives', () => {
  const source = read('renderer/src/components/TokenHeatmap.jsx');
  assert.match(source, /import \{ clampToWindow, resolveVerticalFlip \} from '\.\.\/lib\/floating-layer\.js'/);
  assert.doesNotMatch(source, /clampTipX = \(x\) => Math\.max/);
  assert.doesNotMatch(source, /r\.top < 140/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/floating-layer-static.test.js`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

顶部 import 区加:

```js
import { clampToWindow, resolveVerticalFlip } from '../lib/floating-layer.js';
```

`clampTipX` 定义(132 行)替换为:

```js
  // 初始位置用估计半宽钳制,渲染后由 useLayoutEffect 按实测宽度二次校正(向窗口中间靠拢)
  const ESTIMATED_TIP_HALF = 104;
  const clampTipX = (x) => clampToWindow(x - ESTIMATED_TIP_HALF, 0, ESTIMATED_TIP_HALF * 2, 1).x + ESTIMATED_TIP_HALF;
```

`showTip` 里的 below 判定(150 行)替换为:

```js
    // 浮层估计高约 140:上方放不下且下方够才向下展开(prefer above,保持原有默认朝向)
    const below = resolveVerticalFlip(r, 140, { prefer: 'above' }).below;
```

useLayoutEffect 二次校正(188-194 行)替换为:

```js
  // 实测浮层宽度:内容(缓存明细)会把浮层撑到 260px+,估计值钳不紧,
  // 这里按 offsetWidth 把中心点夹回窗口内,与 echarts confine 行为一致
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const half = el.offsetWidth / 2 + 8;
    const x = clampToWindow(tip.x - half, 0, half * 2, 1).x + half;
    if (Math.abs(x - tip.x) > 0.5) el.style.left = x + 'px';
  }, [tip]);
```

- [ ] **Step 4: 跑测试 + 构建确认**

Run: `node --test test/floating-layer-static.test.js`
Expected: 4 pass
Run: `npm run build:renderer`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/TokenHeatmap.jsx test/floating-layer-static.test.js
git commit -m "refactor(renderer): 热力图 tooltip 钳制/翻转接入 floating-layer"
```

---

### Task 5: CustomSelect 接入共享翻转判定

**Files:**
- Modify: `renderer/src/components/CustomSelect.jsx:39-54`(`toggle()` 位置估算)
- Test: `test/floating-layer-static.test.js`(追加断言)

**Interfaces:**
- Consumes: Task 1 的 `resolveVerticalFlip`
- Produces: 无新接口;`menuPos` 形状不变(`{ left, width, top, bottom, below }`)

- [ ] **Step 1: 追加失败测试**

`test/floating-layer-static.test.js` 末尾追加:

```js
test('custom select menu uses shared flip decision', () => {
  const source = read('renderer/src/components/CustomSelect.jsx');
  assert.match(source, /import \{ resolveVerticalFlip \} from '\.\.\/lib\/floating-layer\.js'/);
  assert.match(source, /resolveVerticalFlip\(rect, menuHeight/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/floating-layer-static.test.js`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

顶部 import 区加:

```js
import { resolveVerticalFlip } from '../lib/floating-layer.js';
```

`toggle()`(39-54 行)替换为:

```js
  function toggle() {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const menuHeight = options.length * 26 + 10;
      // 窗口内下方空间不足且上方更宽敞时向上展开(判定收敛到 floating-layer)
      const below = resolveVerticalFlip(rect, menuHeight, { gap: 4, margin: 0 }).below;
      setMenuPos({
        left: rect.left,
        width: Math.max(rect.width, 88),
        top: below ? rect.bottom + 4 : null,
        bottom: below ? null : window.innerHeight - rect.top + 4,
        below: below
      });
    }
    setOpen(!open);
  }
```

注:与原判定等价(gap=4/margin=0 时 `belowFits || !aboveFits` 即原表达式),`top`/`bottom` CSS 锚定方式不变。

- [ ] **Step 4: 跑测试 + 构建确认**

Run: `node --test test/floating-layer-static.test.js`
Expected: 5 pass
Run: `npm run build:renderer`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/CustomSelect.jsx test/floating-layer-static.test.js
git commit -m "refactor(renderer): CustomSelect 展开方向判定接入 floating-layer"
```

---

### Task 6: ECharts 悬浮层通用静态守卫

**Files:**
- Test: `test/floating-layer-static.test.js`(追加通用守卫用例)

**Interfaces:**
- Consumes: 无
- Produces: 守卫规则——`renderer/src/**/*.{js,jsx}` 内含 `tooltip:` 的文件,每个 tooltip 配置都必须有 `appendToBody: true` 与位置钳制回调

- [ ] **Step 1: 写守卫测试(直接通过,起防回归作用)**

`test/floating-layer-static.test.js` 末尾追加:

```js
test('every ECharts tooltip in renderer appends to body and clamps position', () => {
  const glob = ['renderer/src/components', 'renderer/src/lib'];
  const files = [];
  for (const dir of glob) {
    for (const name of fs.readdirSync(path.resolve(__dirname, '..', dir))) {
      if (/\.(js|jsx)$/.test(name)) files.push(dir + '/' + name);
    }
  }
  for (const file of files) {
    const source = read(file);
    const tooltips = source.match(/\btooltip:\s*\{/g) || [];
    if (tooltips.length === 0) continue;
    const appends = source.match(/appendToBody: true/g) || [];
    const positions = source.match(/position: (echartsWindowPosition|windowClampedPosition)\(/g) || [];
    assert.equal(appends.length, tooltips.length, file + ': every tooltip needs appendToBody: true');
    assert.equal(positions.length, tooltips.length, file + ': every tooltip needs a window-clamped position callback');
  }
});
```

- [ ] **Step 2: 跑测试确认通过(并验证守卫有效)**

Run: `node --test test/floating-layer-static.test.js`
Expected: 6 pass
有效性验证:临时把 `token-speed-chart.js` 的 `position:` 行注释掉,该用例应变红;恢复后变绿(验证后即恢复,不留改动)

- [ ] **Step 3: Commit**

```bash
git add test/floating-layer-static.test.js
git commit -m "test(renderer): ECharts 悬浮层 appendToBody+窗口钳制静态守卫"
```

---

### Task 7: 全量验证 + PR

**Files:**
- 无新增;验收与交付

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全量 pass / 0 fail

- [ ] **Step 2: renderer 构建**

Run: `npm run build:renderer`
Expected: 构建成功

- [ ] **Step 3: 手动冒烟(开发态)**

```bash
npm start
```

- 悬停 Token 消耗速度卡片上沿数据点:tooltip 完整显示在窗口内(本次 bug 修复验证)
- 热力图首行格子 hover:tooltip 向下展开;中部格子 hover:仍在上方
- 卡片上的 CustomSelect 靠近窗口底部时向上展开

- [ ] **Step 4: PR + CI + 合并**

```bash
git push -u origin feat/floating-layer
gh pr create --title "fix(renderer): 悬浮层统一动作模板 + Token 速度 tooltip 裁剪修复" --body "<按提交摘要填写>"
sleep 20 && gh pr checks --watch
gh pr merge --rebase
git checkout main && git fetch origin && git reset --hard origin/main
git branch -d feat/floating-layer && git push origin --delete feat/floating-layer
```

Expected: 三项 CI 全绿,main 已同步。

---

## Self-Review 记录

- **Spec 覆盖**:三原语(Task 1)、token-speed 修复(Task 2)、ChartWidget 迁移含 re-export 兼容(Task 3)、热力图(Task 4)、CustomSelect(Task 5)、纯函数单测(Task 1)+ 静态守卫(Task 2-6)+ 全量回归与构建(Task 7)、手动冒烟(Task 7)——全覆盖。spec 明确不做的事项均未安排任务。
- **与 spec 的偏差**:`resolveVerticalFlip` 选项签名由 `{ gap, margin }` 扩展为 `{ gap, margin, prefer }`。原因:热力图现状是"默认上方、顶不下来才向下",与 CustomSelect/ECharts 的"默认下方"相反;`prefer` 让两种朝向共用同一判定,这正是"动作模板"的本意。spec 中"返回 top 供调用方决定锚定"保留,但两个 React 消费方实测只需 `below` 判定(各自沿用现有 CSS 锚定),`top` 由测试覆盖。
- **类型一致性**:`clampToWindow/resolveVerticalFlip/echartsWindowPosition` 在 Task 1 定义,Task 2-5 的消费签名与 import 路径(`./floating-layer.js` / `../lib/floating-layer.js`)一致;`windowClampedPosition` 别名 re-export 与 ProviderBar 现有 import 一致;`options.dom` 在 Task 2 生产/消费一致。
- **占位符**:Task 6 Step 2 的"临时注释验证"是手动验证动作非代码占位;其余步骤代码完整。

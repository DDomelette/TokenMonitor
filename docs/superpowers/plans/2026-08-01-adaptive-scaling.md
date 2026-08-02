# 内容自适应缩放层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepSeek Monitor 窗口缩放时,统计卡数字、组件文字、图表标注随容器宽度连续自适应,消除数字截断。

**Architecture:** 保留 GridStack 布局/断点/预设/zoomFactor 体系不动。DOM 文字用 CSS 容器查询(`container-type` + `cqw` + `clamp()`);每日 TOKEN 图表(ECharts canvas)在现有 `applyDensity()` 链路中按容器宽高计算字号与 grid。

**Tech Stack:** Electron 40(Chromium ≥105,容器查询原生支持)、原生 CSS、`node --test` 静态测试。

**Spec:** `docs/superpowers/specs/2026-08-01-adaptive-scaling-design.md`

## Global Constraints

- 不改 `src/renderer/js/layout/layout-policy.js` 的 640px 断点,不改 `component-registry.js` 预设表
- 不改 Ctrl+滚轮 zoomFactor 体系(`app.js`、`src/main/index.js`)
- 不使用 transform scale 整体缩放,不恢复 `--ui-font-scale` CSS 变量(现有测试明确禁止)
- 所有 `clamp()` 字号下限 ≥9px(正文)/14px(大数字),上限不超过现有最大值(38px)
- 测试约定:`node --test`,静态测试用 `fs.readFileSync` 读源码 + 正则断言(参照 `test/scaling-and-session-static.test.js`)
- 代码风格:渲染进程 JS 用 `var`、IIFE、`window.App`/`window.Charts` 命名空间(无模块系统)
- 每个 Task 完成后 `npm test` 必须全绿再 commit

## File Structure

- `src/renderer/css/layout.css` — 修改:`.grid-stack-item-content` 加容器声明;card 预设的固定字号规则改为 clamp
- `src/renderer/css/components.css` — 修改:`.fee-card-value`、`.fee-card-sub` 基础规则改为 clamp + 兜底裁剪
- `src/renderer/css/main.css` — 修改:`#app` 加 inline-size 容器声明;`.component-title`、`.statusbar` 改为 clamp
- `src/renderer/js/components/model-bar.js` — 修改:`densityOptions()` 非 compact 分支按容器宽高自适应
- `test/adaptive-scaling-static.test.js` — 新建:全部静态断言

---

### Task 1: 容器查询基础设施 + 统计卡大数字自适应

**Files:**
- Modify: `src/renderer/css/layout.css:48-54`(`.grid-stack-item-content` 规则)和 `:91-94`(card 预设 `.fee-card-value` 38px 规则)
- Modify: `src/renderer/css/components.css:25-31`(`.fee-card-value` 基础规则)
- Test: `test/adaptive-scaling-static.test.js`(新建)

**Interfaces:**
- Consumes: 无(纯 CSS + 静态测试)
- Produces: `.grid-stack-item-content` 成为 `container-type: size` 容器,后续 Task 2/3 的所有 `cqw` 单位都相对它解析;`#app` 容器在 Task 2 建立

- [ ] **Step 1: Write the failing test**

新建 `test/adaptive-scaling-static.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const layoutCss = fs.readFileSync(path.join(root, 'src/renderer/css/layout.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'src/renderer/css/components.css'), 'utf8');

test('widget content is a size container so cqw units resolve per widget', () => {
  const rule = layoutCss.match(/\.grid-stack-item-content\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /container-type:\s*size/);
});

test('fee card value in card preset scales with container width, not fixed 38px', () => {
  const rule = layoutCss.match(/\[data-layout-preset="card"\]\s*\.fee-card-value\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[0], /font-size:\s*38px/);
  assert.match(rule[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});

test('base fee card value clamps with cqw and crops overflow gracefully', () => {
  const rule = componentsCss.match(/\.fee-card-value\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
  assert.match(rule[0], /text-overflow:\s*ellipsis/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adaptive-scaling-static.test.js`
Expected: FAIL,3 个测试全部失败(无 container-type、38px 固定、无 clamp)

- [ ] **Step 3: Implement CSS changes**

`src/renderer/css/layout.css`,修改 `.grid-stack-item-content` 规则(第 48-50 行):

```css
.grid-stack-item-content {
  overflow: hidden;
  container-type: size;
}
```

修改 card 预设 `.fee-card-value` 规则(第 91-94 行):

```css
.grid-stack-item[data-layout-preset="card"] .fee-card-value {
  font-size: clamp(14px, 22cqw, 38px);
  line-height: 1.15;
}
```

`src/renderer/css/components.css`,修改 `.fee-card-value` 基础规则(第 25-31 行):

```css
.fee-card-value {
  font-size: clamp(13px, 16cqw, 30px);
  font-weight: 700;
  line-height: 1.2;
  transition: color 300ms ease-out;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

依据:最窄窗口 380px 时单卡容器约 109px,22cqw ≈ 24px,`¥15.23` 约需 86px,减去 padding 后 89px 内容区刚好容纳;上限 38px 保持现有最大观感。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adaptive-scaling-static.test.js`
Expected: PASS 3/3

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 全部通过(包括既有 `scaling-and-session-static`、`layout-controller-static` 等)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/css/layout.css src/renderer/css/components.css test/adaptive-scaling-static.test.js
git commit -m "feat: 统计卡数字按容器宽度自适应(容器查询 + clamp)"
```

---

### Task 2: 副标题/组件标题/状态栏文字自适应

**Files:**
- Modify: `src/renderer/css/components.css:37-42`(`.fee-card-sub`)
- Modify: `src/renderer/css/layout.css:82-89`(card 预设 `.component-title` / `.component-header`)、`:96-101`(card 预设 `.fee-card-sub`)
- Modify: `src/renderer/css/main.css:50-58`(`#app`)、`:202-211`(`.component-title`)、`:172-181`(`.statusbar`)
- Test: `test/adaptive-scaling-static.test.js`(追加)

**Interfaces:**
- Consumes: Task 1 建立的 `.grid-stack-item-content` size 容器(`cqw` 解析依据)
- Produces: `#app` 成为 `container-type: inline-size` 容器,`.statusbar` 的 `cqw` 相对窗口宽度解析

- [ ] **Step 1: Write the failing tests**

在 `test/adaptive-scaling-static.test.js` 追加(文件头部补读 `mainCss`):

```js
const mainCss = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');

test('fee card sub text scales with container width', () => {
  const base = componentsCss.match(/\.fee-card-sub\s*\{[^}]*\}/);
  assert.ok(base);
  assert.match(base[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
  const card = layoutCss.match(/\[data-layout-preset="card"\]\s*\.fee-card-sub\s*\{[^}]*\}/);
  assert.ok(card);
  assert.match(card[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});

test('component titles scale with container width in both base and card preset', () => {
  const base = mainCss.match(/\.component-title\s*\{[^}]*\}/);
  assert.ok(base);
  assert.match(base[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
  const card = layoutCss.match(/\[data-layout-preset="card"\]\s*\.component-title\s*\{[^}]*\}/);
  assert.ok(card);
  assert.match(card[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});

test('app root is an inline-size container and statusbar text scales with window width', () => {
  const app = mainCss.match(/#app\s*\{[^}]*\}/);
  assert.ok(app);
  assert.match(app[0], /container-type:\s*inline-size/);
  const statusbar = mainCss.match(/\.statusbar\s*\{[^}]*\}/);
  assert.ok(statusbar);
  assert.match(statusbar[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adaptive-scaling-static.test.js`
Expected: 新增 3 个 FAIL,Task 1 的 3 个仍 PASS

- [ ] **Step 3: Implement CSS changes**

`src/renderer/css/components.css`,`.fee-card-sub`(第 37-42 行):

```css
.fee-card-sub {
  font-size: clamp(9px, 7.5cqw, 12px);
  color: var(--text-secondary);
  margin-top: 2px;
  line-height: 1.35;
}
```

`src/renderer/css/layout.css`,card 预设 `.component-title`(第 82-85 行):

```css
.grid-stack-item[data-layout-preset="card"] .component-title {
  margin-bottom: 4px;
  font-size: clamp(10px, 9cqw, 13px);
}
```

card 预设 `.fee-card-sub`(第 96-101 行):

```css
.grid-stack-item[data-layout-preset="card"] .fee-card-sub {
  font-size: clamp(9px, 8cqw, 12px);
  line-height: 1.4;
  align-self: flex-start;
  text-align: left;
}
```

`src/renderer/css/main.css`,`#app`(第 50-58 行)追加一行 `container-type: inline-size;`:

```css
#app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-window);
  border-radius: 18px;
  box-shadow: var(--shadow-window), 0 0 0 1px var(--border);
  overflow: hidden;
  container-type: inline-size;
}
```

`.component-title`(第 202-211 行):

```css
.component-title {
  font-size: clamp(10px, 8cqw, 14px);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: 8px;
  cursor: default;
  user-select: none;
}
```

`.statusbar`(第 172-181 行):

```css
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  font-size: clamp(10px, 2.8cqw, 12px);
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adaptive-scaling-static.test.js`
Expected: PASS 6/6

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/renderer/css/components.css src/renderer/css/layout.css src/renderer/css/main.css test/adaptive-scaling-static.test.js
git commit -m "feat: 副标题/组件标题/状态栏文字随容器宽度自适应"
```

---

### Task 3: 每日 TOKEN 图表标注自适应

**Files:**
- Modify: `src/renderer/js/components/model-bar.js:21-57`(`densityOptions()`)
- Test: `test/adaptive-scaling-static.test.js`(追加)

**Interfaces:**
- Consumes: 现有 `applyDensity()` / `resizeDailyChart()` 调用链(`app.js` 的 `scheduleChartResize()` → `ComponentRegistry.getRuntime('model-bar').resize()`),无需改 `app.js`
- Produces: `densityOptions(theme, compact)` 签名不变;非 compact 分支的字号/grid 随 `dailyDom.clientWidth/clientHeight` 变化(参照 `curve-chart.js:16-77` 的既有模式)

背景:曲线图(`curve-chart.js`)已有 `adaptiveAxisOptions()` 按容器宽高 clamp 字号;每日图表(`model-bar.js`)的 `densityOptions()` 非 compact 分支仍是固定 `fontSize: 9`、`grid: { left: 52, ... }`,本任务对齐两者。

- [ ] **Step 1: Write the failing test**

在 `test/adaptive-scaling-static.test.js` 追加(文件头部补读 `modelBar`):

```js
const modelBar = fs.readFileSync(
  path.join(root, 'src/renderer/js/components/model-bar.js'),
  'utf8'
);

test('daily chart density options derive font size from container size', () => {
  const fn = modelBar.match(/function densityOptions\(theme, compact\) \{[\s\S]*?\n  \}/);
  assert.ok(fn);
  assert.match(fn[0], /clientWidth/);
  assert.match(fn[0], /clamp\(/);
  assert.doesNotMatch(fn[0], /fontSize:\s*9/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adaptive-scaling-static.test.js`
Expected: 新增 1 个 FAIL(当前 densityOptions 无 clientWidth/clamp,含 fontSize: 9)

- [ ] **Step 3: Implement adaptive density**

`src/renderer/js/components/model-bar.js`,在 `isCardMode()` 之后(第 19 行之后)新增辅助函数,并改写 `densityOptions()`:

```js
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function densityOptions(theme, compact) {
    if (compact) {
      return {
        grid: { left: 8, right: 8, top: 6, bottom: 6 },
        xAxis: {
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false }
        },
        yAxis: {
          name: '',
          axisLabel: { show: false },
          splitLine: { show: false }
        },
        series: [
          { barMaxWidth: 8 },
          { barMaxWidth: 8 },
          { barMaxWidth: 8 }
        ]
      };
    }

    var width = dailyDom ? dailyDom.clientWidth : 320;
    var height = dailyDom ? dailyDom.clientHeight : 180;
    var axisFontSize = Math.round(clamp(Math.min(width / 38, height / 16), 8, 12));

    return {
      grid: {
        left: Math.round(clamp(width * 0.13, 40, 52)),
        right: Math.round(clamp(width * 0.03, 8, 14)),
        top: Math.round(clamp(height * 0.09, 12, 16)),
        bottom: Math.round(clamp(height * 0.16, 22, 28))
      },
      xAxis: {
        axisLabel: { show: true, color: theme.textColor, fontSize: axisFontSize, rotate: 0, interval: 'auto', hideOverlap: true },
        axisLine: { show: true, lineStyle: { color: theme.axisLineColor } },
        axisTick: { show: false }
      },
      yAxis: {
        name: 'tokens',
        nameTextStyle: { fontSize: axisFontSize },
        axisLabel: { show: true, fontSize: axisFontSize },
        splitLine: { show: true, lineStyle: { color: theme.gridColor } }
      },
      series: [
        { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) },
        { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) },
        { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) }
      ]
    };
  }
```

注意:保持函数外层的 IIFE/`var` 风格;`initDailyChart()` 的初始 setOption 不动(第 73-121 行),因为 `init` 末尾已调用 `applyDensity()` 覆盖;compact 分支逻辑原样保留。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/adaptive-scaling-static.test.js`
Expected: PASS 7/7

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/renderer/js/components/model-bar.js test/adaptive-scaling-static.test.js
git commit -m "feat: 每日 TOKEN 图表坐标标注随容器尺寸自适应"
```

---

### Task 4: 全量回归 + 手动验证

**Files:**
- 无新增修改(仅验证;如发现视觉问题回到对应 Task 微调 clamp 参数)

**Interfaces:**
- Consumes: Task 1-3 的全部产出
- Produces: 无

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: 全部通过,无回归

- [ ] **Step 2: 静态自查 zoom 体系未被破坏**

Run: `node --test test/scaling-and-session-static.test.js`
Expected: PASS(确认未引入 `--ui-font-scale`、未动 zoomFactor 链路)

- [ ] **Step 3: 手动验证(需要图形环境,由用户或执行者在本地运行)**

Run: `npm start`
验证清单:
1. 窗口拖到最窄(380px):三张卡数字完整显示(不截断),字号自动变小但 ≥14px 可读
2. 窗口拉到 800px+:数字变大,上限不超过改动前观感
3. 窗口拉到最宽附近:标题/副标题/状态栏文字不臃肿
4. 每日 TOKEN 图表:窄窗时坐标轴标注清晰不重叠,宽窗时字号变大
5. Ctrl+滚轮缩放仍正常,布局拖拽/吸附仍正常
6. 深浅色主题切换后图表仍正常(`applyDensity` 链路)

- [ ] **Step 4: 如有视觉问题微调后提交**

若手动验证发现 clamp 参数不合适(过小/过大),只调对应规则的 cqw 系数或上下限,然后:

```bash
npm test
git add -u
git commit -m "fix: 微调自适应字号参数"
```

若无需调整,本任务无需 commit。

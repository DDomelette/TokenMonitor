const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatReset } = require('../renderer/src/lib/format.js');

const root = path.resolve(__dirname, '..');
const quotaCard = fs.readFileSync(path.join(root, 'renderer/src/components/QuotaCard.jsx'), 'utf8');
const windowBar = fs.readFileSync(path.join(root, 'renderer/src/components/WindowBar.jsx'), 'utf8');

test('formatReset shows countdown for <24h', () => {
  const now = new Date('2026-08-02T10:00:00').getTime();
  assert.equal(formatReset(new Date(now + 3 * 3600 * 1000 + 12 * 60000), now), '3小时12分后重置');
  assert.equal(formatReset(new Date(now + 30 * 60000), now), '30分钟后重置');
});

test('formatReset shows absolute time for >=24h', () => {
  const now = new Date('2026-08-02T00:00:00').getTime();
  const resetsAt = new Date('2026-08-03T02:08:00').getTime();
  assert.equal(formatReset(resetsAt, now), '8月3日 02:08 重置');
});

test('formatReset handles past and invalid input', () => {
  const now = new Date('2026-08-02T10:00:00').getTime();
  assert.equal(formatReset(now - 1000, now), '已重置');
  assert.equal(formatReset(null, now), '');
  assert.equal(formatReset(undefined, now), '');
});

test('QuotaCard renders windows array and shows no currency for subscription mode', () => {
  assert.match(quotaCard, /windows\.map/);
  assert.match(quotaCard, /billingMode/);
  // subscription 不显示金额:源码中不得硬编码 ¥ / $
  assert.doesNotMatch(quotaCard, /[¥$]/);
});

test('QuotaCard shows an honest retry entry when authStatus is expired', () => {
  assert.match(quotaCard, /authStatus/);
  assert.match(quotaCard, /expired/);
  // 凭证由本机 CLI 维护,应用只读无法代授权:按钮是"立即重试"而非"重新授权",
  // 提示语必须引导用户先去终端运行对应 CLI
  assert.match(quotaCard, /立即重试/);
  assert.match(quotaCard, /请先在终端运行一次/);
  assert.doesNotMatch(quotaCard, /重新授权/);
});

test('QuotaCard keeps last good data with a stale banner when expired but cached', () => {
  // 过期且有缓存数据时:不替换为纯过期卡,正常渲染 windows 并加警示条(数据时间+重试)
  assert.match(quotaCard, /expired && !quotaState/);
  assert.match(quotaCard, /quota-stale-banner/);
  assert.match(quotaCard, /凭证已过期,显示/);
  assert.match(quotaCard, /quotaFetchedAt/);
  // 纯过期卡只在没有缓存数据时出现
  assert.match(quotaCard, /if \(expired && !quotaState\)/);
});

test('WindowBar consumes used/limit/remaining/resetsAt and colors by remaining percent', () => {
  assert.match(windowBar, /used/);
  assert.match(windowBar, /limit/);
  assert.match(windowBar, /remaining/);
  assert.match(windowBar, /resetsAt/);
  // 条长与着色都按剩余占比:>40% 绿 / 20~40% 黄 / ≤20% 红,耗尽时斜纹整条
  assert.match(windowBar, /40/);
  assert.match(windowBar, /20/);
  assert.match(windowBar, /empty/);
});

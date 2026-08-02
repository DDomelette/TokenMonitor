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

test('QuotaCard replaces card with reauthorize button when authStatus is expired', () => {
  assert.match(quotaCard, /authStatus/);
  assert.match(quotaCard, /expired/);
  assert.match(quotaCard, /重新授权/);
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

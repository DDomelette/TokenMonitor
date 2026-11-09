const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRenderer(file) {
  return fs.readFileSync(path.resolve(__dirname, '../renderer/src', file), 'utf8');
}

test('ECharts defers data updates while hovered and applies the latest option after leave', () => {
  const source = readRenderer('hooks/useECharts.js');
  assert.match(source, /dom\.addEventListener\('pointerenter', onPointerEnter\)/);
  assert.match(source, /dom\.addEventListener\('pointerleave', onPointerLeave\)/);
  assert.match(source, /if \(interacting\) \{\s*pendingData = true;\s*return;/);
  assert.match(source, /interacting = false;\s*if \(pendingData\) applyData\(\);/);
  assert.match(source, /dom\.removeEventListener\('pointerenter', onPointerEnter\)/);
  assert.match(source, /dom\.removeEventListener\('pointerleave', onPointerLeave\)/);
});

test('periodically refreshed bar charts do not replay entrance animations', () => {
  for (const file of ['components/ChartWidget.jsx', 'components/ProviderBar.jsx']) {
    const source = readRenderer(file);
    assert.match(source, /animation: false/, file + ' must disable repeated chart animation');
    assert.doesNotMatch(source, /animation: true/, file + ' must not restart entrance animation');
  }
});

test('date-driven charts advance at Beijing midnight even when query data is unchanged', () => {
  const clock = readRenderer('hooks/useBeijingDayKey.js');
  assert.match(clock, /createLocalCalendarClock\(/);
  assert.match(clock, /onChange: \(_, nextKey\) => setDayKey\(nextKey\)/);

  const providerBar = readRenderer('components/ProviderBar.jsx');
  assert.match(providerBar, /const today = useBeijingDayKey\(\)/);
  assert.match(providerBar, /lastDays\(DAYS, today\)/);
  assert.match(providerBar, /\[details, today\]/);

  const chartWidget = readRenderer('components/ChartWidget.jsx');
  assert.match(chartWidget, /const today = useBeijingDayKey\(\)/);
  assert.match(chartWidget, /buildDailyOption\(domRef\.current, dailyData, today\)/);
  assert.match(chartWidget, /\[id, dailyData, curvePoints, today\]/);
});

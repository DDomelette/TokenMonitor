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

test('charts skip entrance animation and keep updates brief and motion-aware', () => {
  const source = readRenderer('components/ChartWidget.jsx');
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /reduced \? \{ animation: false \}/);
  assert.match(source, /animationDuration: 0/, 'must not replay entrance animation on refresh');
  assert.match(source, /animationDurationUpdate: 240/, 'updates should remain brief');
});

test('date-driven charts share the usage query and advance at Beijing midnight', () => {
  const clock = readRenderer('hooks/useBeijingDayKey.js');
  assert.match(clock, /createLocalCalendarClock\(/);
  assert.match(clock, /onChange: \(_, nextKey\) => setDayKey\(nextKey\)/);

  for (const file of ['components/ChartWidget.jsx', 'components/ProviderBar.jsx']) {
    const source = readRenderer(file);
    assert.match(source, /const today = useBeijingDayKey\(\)/, file);
    assert.match(source, /useUsageCharts\(\{ days, today \}\)/, file);
    const dependencies = source.match(/\[([^\]]*today[^\]]*)\]\)/);
    assert.ok(dependencies, file + ' must refresh chart data after the Beijing day changes');
    assert.match(dependencies[1], /\btheme\b/, file + ' must also refresh chart colors after a theme change');
  }
});

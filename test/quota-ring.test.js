const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadRingLogic() {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../renderer/src/lib/quota-ring.mjs'));
  return import(moduleUrl.href);
}

function win(kind, remaining, name = null) {
  return { kind, name, limit: 100, remaining };
}

test('quota segments are sorted by duration and ignore named additional limits', async () => {
  const { quotaSegments } = await loadRingLogic();
  const provider = {
    quota: {
      windows: [
        win('monthly', 84),
        win('weekly', 20, 'GPT-5.3-Codex-Spark'),
        win('weekly', 46),
        win('5h', 72)
      ]
    }
  };

  assert.deepEqual(quotaSegments(provider), [
    { key: '5h', label: '5 小时额度', frac: 0.72 },
    { key: 'weekly', label: '周额度', frac: 0.46 },
    { key: 'monthly', label: '月额度', frac: 0.84 }
  ]);
});

test('quota segments keep one main entry per window kind without mutating input', async () => {
  const { quotaSegments } = await loadRingLogic();
  const windows = [win('weekly', 46), win('weekly', 30), win('5h', 72)];
  const snapshot = JSON.stringify(windows);
  const segments = quotaSegments({ quota: { windows } });

  assert.deepEqual(segments.map((item) => item.key), ['5h', 'weekly']);
  assert.deepEqual(segments.map((item) => item.frac), [0.72, 0.46]);
  assert.equal(JSON.stringify(windows), snapshot);
  assert.deepEqual(quotaSegments(null), []);
});

test('remaining fractions clamp values and keep missing data distinct from zero', async () => {
  const { remainingFraction } = await loadRingLogic();

  assert.equal(remainingFraction(win('weekly', 120)), 1);
  assert.equal(remainingFraction(win('weekly', -10)), 0);
  assert.equal(remainingFraction(win('weekly', 0)), 0);
  assert.equal(remainingFraction(null), null);
  assert.equal(remainingFraction({ limit: 0, remaining: 0 }), null);
  assert.equal(remainingFraction({ limit: 100, remaining: 'invalid' }), null);
});

test('shared ring slots preserve requested layout and gaps', async () => {
  const { RING_SLOTS, ringArcPath } = await loadRingLogic();

  assert.equal(RING_SLOTS.two[0].end - RING_SLOTS.two[0].start, 120);
  assert.equal(RING_SLOTS.two[1].end - RING_SLOTS.two[1].start, 220);
  assert.equal(RING_SLOTS.two[1].start - RING_SLOTS.two[0].end, 10);
  for (const slot of RING_SLOTS.three) assert.equal(slot.end - slot.start, 110);
  assert.equal(RING_SLOTS.three[1].start - RING_SLOTS.three[0].end, 10);
  assert.equal(RING_SLOTS.three[2].start - RING_SLOTS.three[1].end, 10);
  assert.match(ringArcPath(-150, -30), /^M [-\d.]+ [-\d.]+ A 17 17 0 0 1/);
  assert.match(ringArcPath(-20, 200), /A 17 17 0 1 1/);
});

test('all mini providers call the same QuotaRing component', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../renderer/src/components/MiniView.jsx'), 'utf8');

  assert.match(source, /codex: quotaVisual\('codex'\)/);
  assert.match(source, /kimi: quotaVisual\('kimi'\)/);
  assert.match(source, /deepseek: balanceVisual\('deepseek'\)/);
  assert.match(source, /dsh: balanceVisual\('dsh'\)/);
  assert.doesNotMatch(source, /<Ring|function Ring|function Arc|windowByKind/);
});

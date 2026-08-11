// 一次性自检:全量扫描本机 Codex/Kimi 日志并按北京结算日聚合,不写应用 store。
const os = require('os');
const path = require('path');
const fs = require('fs');
const { scanFiles, rollupDaily } = require('../src/main/core/locallog');
const { localDayStr } = require('../src/main/core/beijing-calendar');
const { parseRolloutLine } = require('../src/main/providers/codex/locallog');
const { parseWireLine } = require('../src/main/providers/kimi/locallog');

const MAX_SCAN_PASSES = 10000;
const VERIFY_SCAN_BUDGET_BYTES = 64 * 1024 * 1024;

function createMemoryCursorStore() {
  const values = Object.create(null);
  return {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
}

async function scanAllBatches(options, scan = scanFiles) {
  const records = [];
  let bytesRead = 0;

  for (let passes = 1; passes <= MAX_SCAN_PASSES; passes++) {
    const batch = await scan(options);
    if (batch && Array.isArray(batch.records)) records.push(...batch.records);
    bytesRead += Number(batch && batch.bytesRead) || 0;
    if (batch && batch.complete === true) {
      return { records, complete: true, bytesRead, passes };
    }
  }

  const error = new Error('Verification scan did not complete');
  error.code = 'LOCAL_LOG_RESCAN_INCOMPLETE';
  throw error;
}

async function scanProvider({ root, match, cursorStore, cursorKey, providerId, parseLine }) {
  if (!fs.existsSync(root)) {
    return { records: [], complete: true, bytesRead: 0, passes: 0 };
  }
  return scanAllBatches({
    root,
    match,
    cursorStore,
    cursorKey,
    providerId,
    parseLine,
    maxBytesPerScan: VERIFY_SCAN_BUDGET_BYTES
  });
}

async function main() {
  const cursorStore = createMemoryCursorStore();
  const codexBatch = await scanProvider({
    root: path.join(os.homedir(), '.codex', 'sessions'),
    match: /rollout-.*\.jsonl$/,
    cursorStore,
    cursorKey: 'verify.codex',
    providerId: 'codex',
    parseLine: parseRolloutLine
  });
  const kimiBatch = await scanProvider({
    root: path.join(os.homedir(), '.kimi-code', 'sessions'),
    match: /wire\.jsonl$/,
    cursorStore,
    cursorKey: 'verify.kimi',
    providerId: 'kimi',
    parseLine: parseWireLine
  });

  const today = localDayStr(Date.now());
  const allCodex = rollupDaily(codexBatch.records);
  const allKimi = rollupDaily(kimiBatch.records);
  console.log('codex 今日:', allCodex['codex:' + today]);
  console.log('kimi 今日:', allKimi['kimi:' + today]);
  console.log(
    'codex 记录总数:', codexBatch.records.length, 'passes:', codexBatch.passes,
    'kimi 记录总数:', kimiBatch.records.length, 'passes:', kimiBatch.passes
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createMemoryCursorStore,
  scanAllBatches,
  scanProvider,
  main
};

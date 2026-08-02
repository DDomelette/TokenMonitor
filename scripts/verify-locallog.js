// 一次性自检:对本机 codex/kimi 全量日志跑 rollupDaily,打印今日聚合(不写 store)。
const os = require('os');
const path = require('path');
const fs = require('fs');
const { scanFiles, rollupDaily } = require('../src/main/core/locallog');
const { parseRolloutLine } = require('../src/main/providers/codex/locallog');
const { parseWireLine } = require('../src/main/providers/kimi/locallog');

const cursorStore = { get: () => ({}), set: () => {} }; // 一次性全量扫描
const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
const kimiRoot = path.join(os.homedir(), '.kimi-code', 'sessions');

const codexRecords = fs.existsSync(codexRoot)
  ? scanFiles({ root: codexRoot, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'x', providerId: 'codex', parseLine: parseRolloutLine })
  : [];
const kimiRecords = fs.existsSync(kimiRoot)
  ? scanFiles({ root: kimiRoot, match: /wire\.jsonl$/, cursorStore, cursorKey: 'y', providerId: 'kimi', parseLine: parseWireLine })
  : [];

const today = new Date().toISOString().slice(0, 10);
const allCodex = rollupDaily(codexRecords);
const allKimi = rollupDaily(kimiRecords);
console.log('codex 今日:', allCodex['codex:' + today]);
console.log('kimi 今日:', allKimi['kimi:' + today]);
console.log('codex 记录总数:', codexRecords.length, ' kimi 记录总数:', kimiRecords.length);

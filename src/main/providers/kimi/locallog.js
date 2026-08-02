// Kimi wire.jsonl 行解析 + 本地日志通道读取。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFiles, rollupDaily } = require('../../core/locallog');

// ~/.kimi-code/sessions/**/wire.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.kimi-code', 'sessions');
const MATCH = /wire\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.kimi';

// 解析单行:usage.record 行,input=inputOther,cached=inputCacheRead,output=output,ts 取 data.time(epoch ms)。
function parseWireLine(line) {
  if (!line) return null;
  try {
    const data = JSON.parse(line);
    if (!data || data.type !== 'usage.record' || !data.usage) return null;
    const usage = data.usage;
    return {
      ts: Number(data.time) || null,
      model: data.model || null,
      usage: {
        input: usage.inputOther || 0,
        cached: usage.inputCacheRead || 0,
        output: usage.output || 0
      }
    };
  } catch (e) {
    return null;
  }
}

// 增量扫描本机 kimi 日志,返回新增 UsageRecord[];并按日聚合增量合并进 store 键 'usageDaily'。
// ctx = { store, ... }。root 可通过 store 键 'providers.kimi.localLogRoot' 覆盖(测试用)。
function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const root = (store && store.get('providers.kimi.localLogRoot')) || DEFAULT_ROOT();
  if (!fs.existsSync(root)) return [];
  const records = scanFiles({
    root: root,
    match: MATCH,
    cursorStore: store,
    cursorKey: CURSOR_KEY,
    providerId: 'kimi',
    parseLine: parseWireLine
  });
  if (records.length && store) {
    const daily = rollupDaily(records);
    const usageDaily = store.get('usageDaily') || {};
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
    store.set('usageDaily', usageDaily);
  }
  return records;
}

module.exports = { parseWireLine, readLocalLog, DEFAULT_ROOT, MATCH };

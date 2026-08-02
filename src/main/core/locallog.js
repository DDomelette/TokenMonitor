// localLog 通道核心:增量文件扫描 + 按日聚合(纯函数可测)。
const fs = require('fs');
const path = require('path');

// 本地时区日期键 'YYYY-MM-DD'(与 fetcher 的 localTodayStr 同款逻辑)。
function localTzSec() {
  return -new Date().getTimezoneOffset() * 60;
}

function localDayStr(tsMs) {
  return new Date(tsMs + localTzSec() * 1000).toISOString().slice(0, 10);
}

function walkFiles(root, match) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match.test(entry.name)) out.push(full);
    });
  };
  walk(root);
  return out;
}

// 增量扫描:只读自上次 offset 起的新字节。游标存 { path: { offset, mtimeMs } }(store 键 cursorKey)。
// 文件截断/轮换(stat.size < offset)→ offset 回退 0。末尾无换行的不完整行不消费,等补齐后再读。
// 返回 UsageRecord[] 行记录(带 provider 标记)。
function scanFiles({ root, match, cursorStore, cursorKey, providerId, parseLine }) {
  const records = [];
  if (!root || !fs.existsSync(root)) return records;

  const cursors = cursorStore.get(cursorKey) || {};
  const files = walkFiles(root, match);

  files.forEach((filePath) => {
    const cursor = cursors[filePath] || { offset: 0, mtimeMs: 0 };
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { return; }

    let offset = cursor.offset || 0;
    if (stat.size < offset) offset = 0; // 截断/轮换

    if (stat.size <= offset) {
      cursors[filePath] = { offset: offset, mtimeMs: stat.mtimeMs };
      return;
    }

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    let consumed = text.length;
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) {
        // 整个 chunk 都是不完整行,不消费
        cursors[filePath] = { offset: offset, mtimeMs: stat.mtimeMs };
        return;
      }
      consumed = lastNl + 1;
    }

    text.slice(0, consumed).split('\n').forEach((line) => {
      if (!line) return;
      const rec = parseLine(line);
      if (rec) records.push(Object.assign({ provider: providerId }, rec));
    });

    cursors[filePath] = { offset: offset + consumed, mtimeMs: stat.mtimeMs };
  });

  Object.keys(cursors).forEach((p) => {
    if (!fs.existsSync(p)) delete cursors[p];
  });
  cursorStore.set(cursorKey, cursors);

  return records;
}

// 纯函数:records → { '<provider>:<YYYY-MM-DD>': { input, cached, output, total } }。
// total 缺失时按 input+output 推导。
function rollupDaily(records) {
  const out = {};
  (records || []).forEach((rec) => {
    const ts = Number(rec.ts) || Date.now();
    const day = localDayStr(ts);
    const key = rec.provider + ':' + day;
    const entry = out[key] || { input: 0, cached: 0, output: 0, total: 0 };
    const usage = rec.usage || {};
    entry.input += Number(usage.input) || 0;
    entry.cached += Number(usage.cached) || 0;
    entry.output += Number(usage.output) || 0;
    entry.total += Number(usage.total) || (Number(usage.input) || 0) + (Number(usage.output) || 0);
    out[key] = entry;
  });
  return out;
}

module.exports = { scanFiles, rollupDaily, localDayStr, localTzSec, walkFiles };

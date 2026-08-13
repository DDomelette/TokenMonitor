// 只读本地验收:对本机 Codex 活动/归档目录做一次影子重建(全程不写 store),
// 打印逐日聚合、计数,以及(可选)与一份已解密的只读 store 投影的对比结果。
// 绝不初始化 electron-store、调用 initializeStore、创建恢复备份、写入 store、
// 赋值 store.store 或修改任何源文件;也绝不打印 rollout 内容、UUID 或完整私有路径。
const os = require('os');
const path = require('path');
const fs = require('fs');

const { buildCodexShadow } = require('../src/main/providers/codex/rebuild');
const {
  collectRolloutCandidates,
  DEFAULT_ROOT,
  DEFAULT_ARCHIVE_ROOT
} = require('../src/main/providers/codex/locallog');

const CODEX_PREFIX = 'codex:';

// 可选:读取调用方提供的一份已经解密的纯 JSON store 投影。只做 JSON.parse,
// 不读取 .key、不接受加密 config.json,也不含任何解密逻辑。
function readStoreProjection(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeProjection(projection) {
  return typeof projection === 'string' ? readStoreProjection(projection) : projection;
}

async function verifyCodexArchiveUsage(options = {}) {
  const activeRoot = options.activeRoot || DEFAULT_ROOT();
  const archiveRoot = options.archiveRoot || DEFAULT_ARCHIVE_ROOT();
  const nowMs = options.nowMs || Date.now();

  // 枚举两个根目录的稳定身份联合,统计本轮看到的 rollout 文件数。
  const groups = await collectRolloutCandidates([activeRoot, archiveRoot]);
  const files = groups.length;

  const shadow = await buildCodexShadow({ activeRoot, archiveRoot, nowMs });
  const daily = shadow.usageDaily || {};
  const uniqueEvents = shadow.summary.records;
  const duplicateEvents = shadow.summary.duplicates;

  let comparedStoreDaily = null;
  if (options.storeProjection != null) {
    const projection = normalizeProjection(options.storeProjection);
    const storeDaily = (projection && projection.usageDaily) || {};
    const requestedDate = options.date || null;

    const dates = new Set();
    Object.keys(daily).forEach((key) => {
      if (key.indexOf(CODEX_PREFIX) === 0) dates.add(key.slice(CODEX_PREFIX.length));
    });
    Object.keys(storeDaily).forEach((key) => {
      if (key.indexOf(CODEX_PREFIX) === 0) dates.add(key.slice(CODEX_PREFIX.length));
    });

    const compared = {};
    for (const date of dates) {
      if (requestedDate && date !== requestedDate) continue;
      const shadowKey = CODEX_PREFIX + date;
      const shadowRow = daily[shadowKey] || null;
      const storeRow = storeDaily[shadowKey] || null;
      const total = Number(shadowRow && shadowRow.total) || 0;
      const storeTotal = Number(storeRow && storeRow.total) || 0;
      compared[date] = {
        shadow: shadowRow,
        store: storeRow,
        total,
        storeTotal,
        match: total === storeTotal
      };
    }
    comparedStoreDaily = compared;
  }

  return { files, uniqueEvents, duplicateEvents, daily, comparedStoreDaily };
}

function parseArgv(argv) {
  const args = { date: null, storeProjection: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date') {
      args.date = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--store-projection') {
      args.storeProjection = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseArgv(process.argv.slice(2));

  verifyCodexArchiveUsage({
    date: args.date,
    storeProjection: args.storeProjection
  }).then((result) => {
    console.log('files:', result.files);
    console.log('uniqueEvents:', result.uniqueEvents);
    console.log('duplicateEvents:', result.duplicateEvents);

    const dayRe = /^codex:(\d{4}-\d{2}-\d{2})$/;
    Object.keys(result.daily).sort().forEach((key) => {
      const match = dayRe.exec(key);
      if (match) {
        console.log(`daily ${match[1]}: total ${result.daily[key].total}`);
      }
    });

    let failed = false;
    if (result.comparedStoreDaily) {
      Object.keys(result.comparedStoreDaily).sort().forEach((date) => {
        const row = result.comparedStoreDaily[date];
        console.log(`compare ${date}: shadow ${row.total}, store ${row.storeTotal}, ${row.match ? 'match' : 'MISMATCH'}`);
        if (!row.match) failed = true;
      });
    }

    process.exitCode = failed ? 1 : 0;
  }).catch((error) => {
    console.error('verify:codex-archive-usage failed:', error && error.code ? error.code : 'VERIFY_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { verifyCodexArchiveUsage };

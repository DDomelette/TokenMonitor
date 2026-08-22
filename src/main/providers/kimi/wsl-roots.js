// WSL 环境 Kimi 日志目录自动探测(系统扫描环节):
// 通过 wsl.exe -l --running -q 列出运行中的发行版(输出为 UTF-16LE),
// 再经 \\wsl.localhost\<distro>(旧版回退 \\wsl$\<distro>)枚举 /home 下
// 各用户以及 root 的 .kimi-code/sessions 目录。探测结果持久化到
// providers.kimi.autoLogRoots,由 locallog.resolveKimiLogRoots 合并进扫描根列表。
// 发行版未运行时 UNC 路径不可达,扫描端会跳过并保留游标(见 locallog.js)。
const { execFile } = require('child_process');
const fs = require('fs');

const WSL_PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\'];
const SESSIONS_SUFFIX = '\\.kimi-code\\sessions';
const BOM_RE = /[\uFEFF]/g;

// wsl.exe -q 每行一个发行版名;UTF-16LE 解码后可能带 BOM / \0 残留。
// 无发行版时 wsl.exe 会输出一行本地化提示;含空白的提示行在此过滤,
// 实在滤不掉的"假名字"也无害——后续 fs.access/readdir 会自然落空。
function parseDistroNames(text) {
  return String(text || '')
    .replace(BOM_RE, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line && !/\s/.test(line));
}

function listRunningDistros(execFileImpl) {
  const impl = execFileImpl || execFile;
  return new Promise((resolve) => {
    try {
      impl('wsl.exe', ['-l', '--running', '-q'], {
        encoding: 'utf16le',
        timeout: 15000,
        windowsHide: true
      }, (error, stdout) => {
        // 非 Windows / 未装 WSL / 命令失败:静默返回空,不影响本地扫描
        if (error) return resolve([]);
        resolve(parseDistroNames(stdout));
      });
    } catch (_) {
      resolve([]);
    }
  });
}

async function accessible(fsImpl, target) {
  try {
    await fsImpl.promises.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

async function listSubdirs(fsImpl, dir) {
  try {
    const entries = await fsImpl.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) {
    return [];
  }
}

async function detectWslKimiRoots(options) {
  const opts = options || {};
  const fsImpl = opts.fsImpl || fs;
  const distros = await listRunningDistros(opts.execFileImpl);
  const roots = [];
  for (const distro of distros) {
    for (const prefix of WSL_PREFIXES) {
      const homeDir = prefix + distro + '\\home';
      const users = await listSubdirs(fsImpl, homeDir);
      if (!users.length) continue; // 此前缀不可用(如旧版无 wsl.localhost),尝试下一个
      // root 用户的家目录不在 /home 下,单独补一遍
      const userDirs = users.map((u) => homeDir + '\\' + u).concat([prefix + distro + '\\root']);
      for (const dir of userDirs) {
        const candidate = dir + SESSIONS_SUFFIX;
        if (await accessible(fsImpl, candidate)) roots.push(candidate);
      }
      break;
    }
  }
  return roots;
}

module.exports = { detectWslKimiRoots, parseDistroNames };

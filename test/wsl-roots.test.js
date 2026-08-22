const test = require('node:test');
const assert = require('node:assert/strict');

const { detectWslKimiRoots, parseDistroNames } = require('../src/main/providers/kimi/wsl-roots');

function fakeExecFile(names, error) {
  return (cmd, args, opts, cb) => {
    assert.equal(cmd, 'wsl.exe');
    assert.deepEqual(args, ['-l', '--running', '-q']);
    cb(error || null, error ? '' : names.join('\r\n'));
  };
}

// paths: 已存在的目录集合;homeEntries: readdir 到的子项名
function fakeFs(existingDirs, readdirMap) {
  const existing = new Set(existingDirs);
  return {
    promises: {
      async access(p) {
        if (!existing.has(p)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
      },
      async readdir(p) {
        const names = readdirMap[p];
        if (!names) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return names.map((name) => ({ name, isDirectory: () => true }));
      }
    }
  };
}

test('parseDistroNames strips BOM/CR/null and filters non-name lines', () => {
  assert.deepEqual(parseDistroNames('\uFEFFUbuntu-24.04\r\ndocker-desktop\r\n'), ['Ubuntu-24.04', 'docker-desktop']);
  assert.deepEqual(parseDistroNames(''), []);
  assert.deepEqual(parseDistroNames(null), []);
  // 无发行版时的本地化提示行(含空格)被过滤;无空白的提示行会残留,
  // 但下游 fs.access 会落空,不影响结果
  assert.deepEqual(parseDistroNames('Ubuntu\r\n适用于 Linux 的 Windows 子系统没有已安装的分发。\r\n'), ['Ubuntu']);
  assert.deepEqual(parseDistroNames('Ubuntu\r\n没有已安装的分发。\r\n'), ['Ubuntu', '没有已安装的分发。']);
});

test('detectWslKimiRoots finds sessions dirs for users and root, skips users without', async () => {
  const home = '\\\\wsl.localhost\\Ubuntu-24.04\\home';
  const sessions = home + '\\huawei\\.kimi-code\\sessions';
  const rootSessions = '\\\\wsl.localhost\\Ubuntu-24.04\\root\\.kimi-code\\sessions';
  const fsImpl = fakeFs(
    [home, sessions, rootSessions],
    { [home]: ['huawei', 'nobody'] }
  );
  const roots = await detectWslKimiRoots({ execFileImpl: fakeExecFile(['Ubuntu-24.04']), fsImpl });
  assert.deepEqual(roots.sort(), [rootSessions, sessions].sort());
});

test('detectWslKimiRoots returns empty when wsl.exe fails or no distro running', async () => {
  const fsImpl = fakeFs([], {});
  assert.deepEqual(await detectWslKimiRoots({ execFileImpl: fakeExecFile([], new Error('not found')), fsImpl }), []);
  assert.deepEqual(await detectWslKimiRoots({ execFileImpl: fakeExecFile([]), fsImpl }), []);
  // execFile 同步抛错(非 Windows)也不能漏出来
  await detectWslKimiRoots({ execFileImpl: () => { throw new Error('spawn ENOENT'); }, fsImpl });
});

test('detectWslKimiRoots falls back to \\\\wsl$ prefix when wsl.localhost has no home', async () => {
  const legacyHome = '\\\\wsl$\\Ubuntu\\home';
  const sessions = legacyHome + '\\alice\\.kimi-code\\sessions';
  const fsImpl = fakeFs(
    [legacyHome, sessions],
    { [legacyHome]: ['alice'] }
  );
  const roots = await detectWslKimiRoots({ execFileImpl: fakeExecFile(['Ubuntu']), fsImpl });
  assert.deepEqual(roots, [sessions]);
});

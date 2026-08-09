const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GUIDE_IDS, resolveGuidePath, openGuide } = require('../src/main/core/diagnostics/guides');

function makeGuideRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-guides-'));
  const developmentRoot = path.join(root, 'development');
  const packagedRoot = path.join(root, 'packaged');
  for (const guideId of GUIDE_IDS) {
    for (const guideRoot of [
      path.join(developmentRoot, 'docs', 'diagnostics'),
      path.join(packagedRoot, 'diagnostics-guides')
    ]) {
      fs.mkdirSync(guideRoot, { recursive: true });
      fs.writeFileSync(path.join(guideRoot, `${guideId}.md`), `# ${guideId}\n`);
    }
  }
  return { root, developmentRoot, packagedRoot };
}

test('resolves every whitelisted guide from real development and packaged roots', (t) => {
  const { root, developmentRoot, packagedRoot } = makeGuideRoots();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(GUIDE_IDS.size, 13);
  for (const guideId of GUIDE_IDS) {
    for (const environment of [
      { isPackaged: false, appPath: developmentRoot },
      { isPackaged: true, resourcesPath: packagedRoot }
    ]) {
      const resolved = resolveGuidePath(guideId, environment);
      assert.equal(resolved.ok, true);
      assert.equal(fs.statSync(resolved.path).isFile(), true);
    }
  }
});

test('rejects traversal and reports missing guide files', (t) => {
  const { root, developmentRoot } = makeGuideRoots();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(resolveGuidePath('../secret', { isPackaged: false, appPath: developmentRoot }).errorCode, 'INVALID_GUIDE_ID');
  fs.rmSync(path.join(developmentRoot, 'docs', 'diagnostics', 'codex-auth.md'));
  assert.equal(resolveGuidePath('codex-auth', { isPackaged: false, appPath: developmentRoot }).errorCode, 'GUIDE_NOT_FOUND');
});

test('reports a stable error when the shell cannot open a valid guide', async (t) => {
  const { root, developmentRoot } = makeGuideRoots();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await openGuide('codex-auth', {
    environment: { isPackaged: false, appPath: developmentRoot },
    shell: { openPath: () => 'The operating system denied access.' }
  });

  assert.deepEqual(result, { ok: false, errorCode: 'GUIDE_OPEN_FAILED' });
});

test('does not allow guide whitelist entries to be changed at runtime', () => {
  assert.throws(() => GUIDE_IDS.add('unexpected-guide'), /immutable/i);
  assert.equal(GUIDE_IDS.size, 13);
});

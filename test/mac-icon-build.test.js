const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function pngSize(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(buffer.subarray(0, 8), signature, 'ICNS image payload must be PNG');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function parseIcns(buffer) {
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(buffer.readUInt32BE(4), buffer.length, 'ICNS header length must match file length');

  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    assert.ok(offset + 8 <= buffer.length, 'ICNS chunk header must be complete');
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length >= 8, `ICNS chunk ${type} must include its header`);
    assert.ok(offset + length <= buffer.length, `ICNS chunk ${type} must stay inside the file`);
    const data = buffer.subarray(offset + 8, offset + length);
    chunks.push({ type, data, ...pngSize(data) });
    offset += length;
  }

  assert.equal(offset, buffer.length, 'ICNS chunks must consume the entire file');
  return chunks;
}

test('mac build generates icons before renderer packaging', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['generate:icons'], 'node scripts/generate-logo.js');
  assert.equal(
    pkg.scripts['build:mac'],
    'npm run generate:icons && npm run build:renderer && electron-builder --mac'
  );
  assert.match(read('electron-builder.yml'), /mac:\s+[\s\S]*icon: assets\/icon\.icns/);
});

test('shared logo generator writes a valid multi-size ICNS', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-icon-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const generator = require('../scripts/generate-logo');
  assert.equal(typeof generator.generateLogoAssets, 'function');
  generator.generateLogoAssets({
    rootDir: temporaryRoot,
    logger: { log() {} }
  });

  const icnsPath = path.join(temporaryRoot, 'assets', 'icon.icns');
  const rendererIconPath = path.join(temporaryRoot, 'src', 'renderer', 'assets', 'icon.png');
  const trayIconPath = path.join(temporaryRoot, 'src', 'renderer', 'assets', 'tray-icon.png');

  assert.equal(fs.existsSync(icnsPath), true);
  assert.deepEqual(pngSize(fs.readFileSync(rendererIconPath)), { width: 256, height: 256 });
  assert.deepEqual(pngSize(fs.readFileSync(trayIconPath)), { width: 64, height: 64 });

  const chunks = parseIcns(fs.readFileSync(icnsPath));
  assert.deepEqual(
    chunks.map(({ type, width, height }) => ({ type, width, height })),
    [
      { type: 'icp4', width: 16, height: 16 },
      { type: 'icp5', width: 32, height: 32 },
      { type: 'icp6', width: 64, height: 64 },
      { type: 'ic07', width: 128, height: 128 },
      { type: 'ic08', width: 256, height: 256 },
      { type: 'ic09', width: 512, height: 512 },
      { type: 'ic10', width: 1024, height: 1024 }
    ]
  );

  const rendererIcon = fs.readFileSync(rendererIconPath);
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === 'ic08').data,
    rendererIcon,
    'the 256px macOS icon must use the same generated logo bytes as the renderer icon'
  );
});

test('generated ICNS stays untracked and CI verifies clean regeneration', () => {
  assert.match(read('.gitignore'), /^\/assets\/icon\.icns$/m);

  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /rm -f assets\/icon\.icns/);
  assert.match(workflow, /npm run generate:icons/);
  assert.match(workflow, /test -s assets\/icon\.icns/);
  assert.match(workflow, /readUInt32BE\(4\)/);
});

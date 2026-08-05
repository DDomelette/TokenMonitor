const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EXPECTED_ICNS = new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
]);

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).equals(PNG_SIGNATURE), true, 'ICNS entries must contain PNG data');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function parseIcns(buffer) {
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(buffer.readUInt32BE(4), buffer.length, 'container length must cover the whole ICNS file');

  const entries = new Map();
  let offset = 8;
  while (offset < buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length >= 8, `invalid ${type} entry length`);
    assert.ok(offset + length <= buffer.length, `${type} entry exceeds the container`);
    entries.set(type, buffer.subarray(offset + 8, offset + length));
    offset += length;
  }
  assert.equal(offset, buffer.length);
  return entries;
}

test('logo generator creates one valid multi-size ICNS from the same PNG geometry', (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-icon-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  childProcess.execFileSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-logo.js'), '--output-root', outputRoot],
    { cwd: root, stdio: 'pipe' }
  );

  const tray = fs.readFileSync(path.join(outputRoot, 'src', 'renderer', 'assets', 'tray-icon.png'));
  const appIcon = fs.readFileSync(path.join(outputRoot, 'src', 'renderer', 'assets', 'icon.png'));
  const icns = fs.readFileSync(path.join(outputRoot, 'assets', 'icon.icns'));
  const entries = parseIcns(icns);

  assert.deepEqual(Array.from(entries.keys()), Array.from(EXPECTED_ICNS.keys()));
  for (const [type, size] of EXPECTED_ICNS) {
    assert.deepEqual(pngSize(entries.get(type)), { width: size, height: size });
  }

  assert.equal(entries.get('icp6').equals(tray), true, '64px tray and ICNS images must share the same source');
  assert.equal(entries.get('ic08').equals(appIcon), true, '256px renderer and ICNS images must share the same source');
});

test('macOS packaging generates the configured icon before electron-builder runs', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['generate:icons'], 'node scripts/generate-logo.js');
  assert.match(
    pkg.scripts['build:mac'],
    /^npm run generate:icons && npm run build:renderer && electron-builder --mac$/
  );

  const builder = read('electron-builder.yml');
  assert.match(builder, /mac:\r?\n(?:.*\r?\n)*?  icon: assets\/icon\.icns\r?\n/);
});

test('CI performs a clean macOS package build instead of only checking a path string', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /mac-package:/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: false/);
  assert.match(workflow, /run: npm run build:mac/);
});

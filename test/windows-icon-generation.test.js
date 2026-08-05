const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parsePng(buffer) {
  assert.equal(buffer.subarray(0, 8).equals(PNG_SIGNATURE), true, 'image must be PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, 'generated PNG must use the supported no-filter rows');
    raw.copy(rgba, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, rgba };
}

function parseDib(buffer, size) {
  assert.equal(buffer.readUInt32LE(0), 40, 'DIB must use BITMAPINFOHEADER');
  assert.equal(buffer.readInt32LE(4), size);
  assert.equal(buffer.readInt32LE(8), size * 2, 'ICO DIB height must include XOR and AND masks');
  assert.equal(buffer.readUInt16LE(12), 1);
  assert.equal(buffer.readUInt16LE(14), 32);
  assert.equal(buffer.readUInt32LE(16), 0, 'DIB must be uncompressed BI_RGB');

  const pixelBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  assert.equal(buffer.length, 40 + pixelBytes + maskStride * size);

  const rgba = Buffer.alloc(pixelBytes);
  for (let row = 0; row < size; row++) {
    const sourceY = size - 1 - row;
    for (let x = 0; x < size; x++) {
      const source = 40 + (row * size + x) * 4;
      const target = (sourceY * size + x) * 4;
      rgba[target] = buffer[source + 2];
      rgba[target + 1] = buffer[source + 1];
      rgba[target + 2] = buffer[source];
      rgba[target + 3] = buffer[source + 3];
    }
  }
  return rgba;
}

function parseIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'ICO reserved field must be zero');
  assert.equal(buffer.readUInt16LE(2), 1, 'ICO type must be icon');
  const count = buffer.readUInt16LE(4);
  assert.equal(count, EXPECTED_SIZES.length);

  const directoryEnd = 6 + count * 16;
  const entries = [];
  let previousEnd = directoryEnd;
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    const bytes = buffer.readUInt32LE(offset + 8);
    const imageOffset = buffer.readUInt32LE(offset + 12);
    assert.equal(width, height);
    assert.equal(buffer.readUInt16LE(offset + 4), 1);
    assert.equal(buffer.readUInt16LE(offset + 6), 32);
    assert.ok(imageOffset >= previousEnd, 'ICO images must not overlap the directory or each other');
    assert.ok(imageOffset + bytes <= buffer.length, 'ICO image must stay inside the file');
    const data = buffer.subarray(imageOffset, imageOffset + bytes);
    entries.push({ size: width, data });
    previousEnd = imageOffset + bytes;
  }
  assert.equal(previousEnd, buffer.length, 'ICO images must consume the complete file');
  return entries;
}

test('committed Windows icon is a valid ordered multi-size ICO', () => {
  const entries = parseIco(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
  assert.deepEqual(entries.map((entry) => entry.size), EXPECTED_SIZES);

  for (const entry of entries.slice(0, -1)) parseDib(entry.data, entry.size);
  const largest = parsePng(entries.at(-1).data);
  assert.deepEqual({ width: largest.width, height: largest.height }, { width: 256, height: 256 });
});

test('logo generator reproduces the committed ICO and keeps its 64px layer aligned with the tray logo', (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-windows-icon-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  childProcess.execFileSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-logo.js'), '--output-root', outputRoot],
    { cwd: root, stdio: 'pipe' }
  );

  const generatedIco = fs.readFileSync(path.join(outputRoot, 'assets', 'icon.ico'));
  assert.equal(generatedIco.equals(fs.readFileSync(path.join(root, 'assets', 'icon.ico'))), true);

  const entries = parseIco(generatedIco);
  const ico64 = parseDib(entries.find((entry) => entry.size === 64).data, 64);
  const tray64 = parsePng(fs.readFileSync(path.join(outputRoot, 'src', 'renderer', 'assets', 'tray-icon.png')));
  assert.equal(ico64.equals(tray64.rgba), true, 'ICO and tray icon must come from the same 64px raster');
});

test('Windows packaging generates icons before electron-builder runs', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(
    pkg.scripts['build:win'],
    /^npm run generate:icons && npm run build:renderer && electron-builder --win$/
  );
  assert.match(read('electron-builder.yml'), /win:\r?\n(?:.*\r?\n)*?  icon: assets\/icon\.ico\r?\n/);
});

test('CI performs a real unsigned Windows package build', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /windows-package:/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /windows-package:[\s\S]*CSC_IDENTITY_AUTO_DISCOVERY: false/);
  assert.match(workflow, /windows-package:[\s\S]*run: npm run build:win/);
});

// 生成 Token Monitor 商标(T 形圆角方块)的 PNG、ICNS 与 ICO 图标,零依赖。
// 用法: node scripts/generate-logo.js [--output-root <目录>]
// 输出: renderer PNG、assets/icon.icns、assets/icon.ico
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// T 形几何:5 个方块,上排 3 个(32px)+ 中列 2 个(32x38 稍拉长),间距 6px、圆角 7px,整体 108x120 近方形。
// 配色左→右、上→下渐变加深,白底下最浅块也清晰可辨。
const R = 7;
const W = 108;
const H = 120;
const BLOCKS = [
  { x: 0, y: 0, w: 32, h: 32, c: [195, 226, 249] },   // 上排左
  { x: 38, y: 0, w: 32, h: 32, c: [143, 198, 243] },  // 上排中
  { x: 76, y: 0, w: 32, h: 32, c: [97, 171, 236] },   // 上排右(最深)
  { x: 38, y: 38, w: 32, h: 38, c: [121, 185, 240] }, // 竖列上
  { x: 38, y: 82, w: 32, h: 38, c: [109, 179, 238] }  // 竖列下
];

const ICNS_ENTRIES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 }
];

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function inside(px, py, blk) {
  const cx = blk.x + blk.w / 2;
  const cy = blk.y + blk.h / 2;
  const hx = blk.w / 2 - R;
  const hy = blk.h / 2 - R;
  const qx = Math.max(Math.abs(px - cx) - hx, 0);
  const qy = Math.max(Math.abs(py - cy) - hy, 0);
  return qx * qx + qy * qy <= R * R;
}

// 4x4 超采样光栅化:颜色取覆盖样本均值,alpha 为覆盖率(straight alpha)
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = (size * 0.875) / H;
  const offX = (size - W * scale) / 2;
  const offY = (size - H * scale) / 2;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = ((x + (sx + 0.5) / SS) - offX) / scale;
          const ly = ((y + (sy + 0.5) / SS) - offY) / scale;
          const blk = BLOCKS.find((candidate) => inside(lx, ly, candidate));
          if (blk) {
            r += blk.c[0];
            g += blk.c[1];
            b += blk.c[2];
            covered += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      if (covered > 0) {
        rgba[i] = Math.round(r / covered);
        rgba[i + 1] = Math.round(g / covered);
        rgba[i + 2] = Math.round(b / covered);
      }
      rgba[i + 3] = Math.round((covered / n) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeICNSEntry(type, data) {
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error(`Invalid ICNS entry type: ${type}`);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(data.length + header.length, 4);
  return Buffer.concat([header, data]);
}

function encodeICNS(entries) {
  const encoded = entries.map(({ type, data }) => encodeICNSEntry(type, data));
  const totalLength = 8 + encoded.reduce((sum, entry) => sum + entry.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...encoded]);
}

function encodeIcoDib(size, rgba) {
  const pixelBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const maskBytes = maskStride * size;
  const dib = Buffer.alloc(40 + pixelBytes + maskBytes);

  dib.writeUInt32LE(40, 0); // BITMAPINFOHEADER
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8); // XOR bitmap + AND mask
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(pixelBytes + maskBytes, 20);

  for (let row = 0; row < size; row++) {
    const sourceY = size - 1 - row;
    const maskRowOffset = 40 + pixelBytes + row * maskStride;
    for (let x = 0; x < size; x++) {
      const source = (sourceY * size + x) * 4;
      const target = 40 + (row * size + x) * 4;
      dib[target] = rgba[source + 2];
      dib[target + 1] = rgba[source + 1];
      dib[target + 2] = rgba[source];
      dib[target + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0) {
        dib[maskRowOffset + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return dib;
}

function encodeICO(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);

  let imageOffset = directory.length;
  entries.forEach(({ size, data }, index) => {
    const entryOffset = 6 + index * 16;
    directory[entryOffset] = size === 256 ? 0 : size;
    directory[entryOffset + 1] = size === 256 ? 0 : size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(data.length, entryOffset + 8);
    directory.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += data.length;
  });

  return Buffer.concat([directory, ...entries.map(({ data }) => data)]);
}

function parseOutputRoot(args) {
  const index = args.indexOf('--output-root');
  if (index < 0) return path.resolve(__dirname, '..');
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('--output-root requires a path');
  }
  return path.resolve(args[index + 1]);
}

function generateLogoAssets(outputRoot) {
  const rendererDir = path.join(outputRoot, 'src', 'renderer', 'assets');
  const packagingDir = path.join(outputRoot, 'assets');
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.mkdirSync(packagingDir, { recursive: true });

  const rgbaBySize = new Map();
  const pngBySize = new Map();
  function rgbaFor(size) {
    if (!rgbaBySize.has(size)) rgbaBySize.set(size, render(size));
    return rgbaBySize.get(size);
  }
  function pngFor(size) {
    if (!pngBySize.has(size)) pngBySize.set(size, encodePNG(size, size, rgbaFor(size)));
    return pngBySize.get(size);
  }

  const trayPath = path.join(rendererDir, 'tray-icon.png');
  const appIconPath = path.join(rendererDir, 'icon.png');
  const icnsPath = path.join(packagingDir, 'icon.icns');
  const icoPath = path.join(packagingDir, 'icon.ico');
  const trayPng = pngFor(64);
  const appIconPng = pngFor(256);
  const icns = encodeICNS(ICNS_ENTRIES.map(({ type, size }) => ({
    type,
    data: pngFor(size)
  })));
  const ico = encodeICO(ICO_SIZES.map((size) => ({
    size,
    data: size === 256 ? pngFor(size) : encodeIcoDib(size, rgbaFor(size))
  })));

  fs.writeFileSync(trayPath, trayPng);
  fs.writeFileSync(appIconPath, appIconPng);
  fs.writeFileSync(icnsPath, icns);
  fs.writeFileSync(icoPath, ico);

  console.log('tray-icon.png', '64x64', trayPng.length, 'bytes');
  console.log('icon.png', '256x256', appIconPng.length, 'bytes');
  console.log('icon.icns', ICNS_ENTRIES.length, 'sizes', icns.length, 'bytes');
  console.log('icon.ico', ICO_SIZES.length, 'sizes', ico.length, 'bytes');

  return { trayPath, appIconPath, icnsPath, icoPath };
}

if (require.main === module) {
  generateLogoAssets(parseOutputRoot(process.argv.slice(2)));
}

module.exports = {
  ICNS_ENTRIES,
  ICO_SIZES,
  encodeICNS,
  encodeICO,
  encodeIcoDib,
  encodePNG,
  generateLogoAssets,
  parseOutputRoot,
  render
};

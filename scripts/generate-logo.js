// 生成 Token Monitor 商标(T 形圆角方块)的 PNG 与 ICNS 图标,零依赖。
// 用法: node scripts/generate-logo.js [--output-root <目录>]
// 输出: src/renderer/assets/tray-icon.png、src/renderer/assets/icon.png、assets/icon.icns
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

  const pngBySize = new Map();
  ICNS_ENTRIES.forEach(({ size }) => {
    pngBySize.set(size, encodePNG(size, size, render(size)));
  });

  const trayPath = path.join(rendererDir, 'tray-icon.png');
  const appIconPath = path.join(rendererDir, 'icon.png');
  const icnsPath = path.join(packagingDir, 'icon.icns');
  const trayPng = pngBySize.get(64);
  const appIconPng = pngBySize.get(256);
  const icns = encodeICNS(ICNS_ENTRIES.map(({ type, size }) => ({
    type,
    data: pngBySize.get(size)
  })));

  fs.writeFileSync(trayPath, trayPng);
  fs.writeFileSync(appIconPath, appIconPng);
  fs.writeFileSync(icnsPath, icns);

  console.log('tray-icon.png', '64x64', trayPng.length, 'bytes');
  console.log('icon.png', '256x256', appIconPng.length, 'bytes');
  console.log('icon.icns', ICNS_ENTRIES.length, 'sizes', icns.length, 'bytes');

  return { trayPath, appIconPath, icnsPath };
}

if (require.main === module) {
  generateLogoAssets(parseOutputRoot(process.argv.slice(2)));
}

module.exports = {
  ICNS_ENTRIES,
  encodeICNS,
  encodePNG,
  generateLogoAssets,
  parseOutputRoot,
  render
};

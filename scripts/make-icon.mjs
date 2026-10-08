/**
 * 生成 build/icon.ico —— §4 第 5 条。
 *
 * 为什么手写光栅化而不是"找张图塞进去"：
 *   仓库里没有任何图像依赖（无 sharp / pngjs / canvas），也不想为一个图标新增原生模块。
 *   纯数学画一个矢量感的品牌标记，反而能保证每个尺寸都是按该尺寸的视觉重量重画的
 *   （直接缩放 256 的图，16 档的细笔画会糊成一团灰）。
 *
 * 画面（与渲染层「素笺·朱批」同一套色：浓墨底 + 宣纸白 + 朱砂单一强调）：
 *   · 圆角方底：自上而下的墨色渐变（保证有 ≥4 种颜色，也保证不是纯色方块）
 *   · 一道由粗到细再收细的宣纸色笔锋（二次贝塞尔 + 沿程厚度变化）
 *   · 右下一枚朱砂印章（小尺寸下自然退化成一个红点，正好是品牌锚点）
 *   · 圆角之外 alpha=0：任务栏/桌面上是圆的，不带白边
 *
 * 抗锯齿用 4×4（小尺寸）/ 2×2（大尺寸）超采样覆盖计数，不做滤波——
 * 图标要在 16px 下仍然硬边可读。
 *
 * 用法：`node scripts/make-icon.mjs`（重写 build/icon.ico）
 * 结构校验由 tests/integration/app-icon.test.ts 钉住（容器头、biHeight=2×高、
 * 掩码全 0、dataSize 精确、alpha 非零、非纯色）。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 必须覆盖的四档是 Windows 自己会取的；其余是给它挑的余地 */
export const SIZES = [16, 24, 32, 48, 64, 128, 256];

const INK_TOP = [32, 38, 46];
const INK_BOTTOM = [11, 14, 18];
const PAPER = [242, 237, 227];
const CINNABAR = [196, 58, 43];

const GROUND_RADIUS = 0.22;

/** 笔锋：起点左下，控制点左上，终点右中——整体是"起笔轻、行笔重、收笔提" */
const STROKE = { x0: 0.12, y0: 0.72, cx: 0.36, cy: 0.22, x1: 0.88, y1: 0.42 };
const STROKE_THIN = 0.018;
const STROKE_THICK = 0.062;

/** 印章方（左上/右下角归一化坐标） */
const SEAL = { x0: 0.58, y0: 0.6, x1: 0.82, y1: 0.84, r: 0.045 };

const lerp = (a, b, t) => a + (b - a) * t;

/** 圆角矩形内部判定（归一化坐标） */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 沿程厚度：两端细、中段粗（sin 的幂次控制"肚子"位置与饱满度） */
function strokeWidth(t) {
  const belly = Math.sin(Math.PI * t) ** 0.75;
  return STROKE_THIN + (STROKE_THICK - STROKE_THIN) * belly;
}

/** 预采样笔锋折线，之后按"点到线段距离"求最近处 */
const STROKE_POLY = (() => {
  const n = 96;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      t,
      x: u * u * STROKE.x0 + 2 * u * t * STROKE.cx + t * t * STROKE.x1,
      y: u * u * STROKE.y0 + 2 * u * t * STROKE.cy + t * t * STROKE.y1,
    });
  }
  return pts;
})();

/** 点到笔锋轴线的最近距离与其参数 t */
function strokeDistance(x, y) {
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i < STROKE_POLY.length - 1; i++) {
    const a = STROKE_POLY[i];
    const b = STROKE_POLY[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = x - a.x;
    const wy = y - a.y;
    const len2 = vx * vx + vy * vy;
    const k = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    const dx = wx - k * vx;
    const dy = wy - k * vy;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      bestT = a.t + k * (b.t - a.t);
    }
  }
  return { dist: Math.sqrt(best), t: bestT };
}

/**
 * 单个采样点的颜色（归一化坐标，y 向下）。
 * 返回 null 表示透明。图层从上层往下判：印章 → 笔锋 → 墨底。
 */
function layerColor(x, y) {
  if (inRoundedRect(x, y, SEAL.x0, SEAL.y0, SEAL.x1, SEAL.y1, SEAL.r)) {
    // 印面里留一道宣纸色的"朱文"横画，大尺寸下能看出是印章，小尺寸自然消失
    const midY = (SEAL.y0 + SEAL.y1) / 2;
    const inBar =
      Math.abs(y - midY) < 0.022 && x > SEAL.x0 + 0.075 && x < SEAL.x1 - 0.075;
    return inBar ? PAPER : CINNABAR;
  }
  const { dist, t } = strokeDistance(x, y);
  if (dist <= strokeWidth(t)) return PAPER;
  if (inRoundedRect(x, y, 0, 0, 1, 1, GROUND_RADIUS)) {
    return [
      Math.round(lerp(INK_TOP[0], INK_BOTTOM[0], y)),
      Math.round(lerp(INK_TOP[1], INK_BOTTOM[1], y)),
      Math.round(lerp(INK_TOP[2], INK_BOTTOM[2], y)),
    ];
  }
  return null;
}

/**
 * 光栅化一个尺寸，返回 top-down 的 RGBA Buffer。
 * 超采样：每像素 ss×ss 个采样点，alpha 取覆盖比例，颜色取覆盖样本均值。
 */
export function rasterize(size) {
  const samples = size <= 48 ? 4 : 2;
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hit = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) * step;
          const y = (py + (sy + 0.5) / samples) * step;
          const c = layerColor(x, y);
          if (c) {
            hit++;
            r += c[0];
            g += c[1];
            b += c[2];
          }
        }
      }
      const i = (py * size + px) * 4;
      if (hit === 0) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
        continue;
      }
      // BGRA 由 ICO 侧再转；这里先按 RGBA 存，颜色不预乘 alpha
      out[i] = Math.round(r / hit);
      out[i + 1] = Math.round(g / hit);
      out[i + 2] = Math.round(b / hit);
      out[i + 3] = Math.round((hit * 255) / (samples * samples));
    }
  }
  return out;
}

/** AND 掩码单行字节数（1bpp，按 32 位对齐） */
const maskStride = (size) => Math.ceil(size / 32) * 4;

/** RGBA(top-down) → ICO 里的 32 位 BMP DIB（bottom-up，BGRA + 全 0 AND 掩码） */
function encodeBmpDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR 图 + AND 掩码 两份
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y; // BMP 自下而上：源第 y 行写到目标倒数第 y 行
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }
  // 32 位色深下透明度由 alpha 承担，AND 掩码必须全 0，否则图形会被啃掉
  const mask = Buffer.alloc(maskStride(size) * size);
  return Buffer.concat([header, pixels, mask]);
}

/** 把若干 (尺寸, DIB) 装进 ICO 容器；数据偏移按 4 字节对齐 */
export function buildIco(entries) {
  const count = entries.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = 图标（写成 2 是 "icon group"，系统不认）
  dir.writeUInt16LE(count, 4);
  let offset = dir.length;
  const blobs = [];
  entries.forEach((e, i) => {
    const at = 6 + i * 16;
    dir[at] = e.size >= 256 ? 0 : e.size; // 1 字节存不下 256，约定写 0
    dir[at + 1] = e.size >= 256 ? 0 : e.size;
    dir[at + 2] = 0; // 调色板色数（32 位下无意义）
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bitCount
    dir.writeUInt32LE(e.dib.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    blobs.push(e.dib);
    offset += e.dib.length;
    // 4 字节对齐：补零而不是截断，否则后段数据被系统按错位读
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      blobs.push(Buffer.alloc(pad));
      offset += pad;
    }
  });
  return Buffer.concat([dir, ...blobs]);
}

/** PNG（CRC 自己算，只为肉眼检查图标用，不进 ICO） */
export function encodePng(size, rgba) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    // PNG 的长度、CRC、IHDR 宽高全是大端；写反了会得到一张"合法但读不出"的图
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && resolve(process.argv[1]) === here;

if (isCli) {
  const out = join(dirname(here), '../build/icon.ico');
  const entries = SIZES.map((size) => ({ size, dib: encodeBmpDib(size, rasterize(size)) }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildIco(entries));
  // 图标没法直接看，--preview 另存一张 256 PNG 供肉眼检查（不进 ICO、不提交）
  const preview = process.argv[2];
  if (preview) writeFileSync(preview, encodePng(256, rasterize(256)));
  console.log(
    `build/icon.ico ← ${SIZES.join('/')} px，${(entries.reduce((a, e) => a + e.dib.length, 0) / 1024).toFixed(0)} KiB 图像数据`,
  );
}

/**
 * ★ 应用图标（§4 第 5 条）：`build/icon.ico` 此前根本不存在（`ls build` → 无此目录），
 * electron-builder 因此一路用 Electron 默认图标，任务栏/桌面/卸载列表里是一个通用
 * 蓝色 Atom 图标 —— 品牌名统一了（第 6 条），图标却还是别人的。
 *
 * 这个文件不测"好不好看"（测不了），只测**能不能被 Windows 正确读出来**：
 * ICO 是二进制容器，容器写坏了不是"丑"，是资源管理器直接回退到默认图标，
 * 而且 electron-builder 打包时不会报错——它只在找不到文件时警告。
 * 所以断言全部围绕容器结构 + 像素真的不是纯色：
 *   1. ICONDIR 头合法，至少 4 个尺寸（只有一个尺寸的话，小图标会被系统硬缩放糊成一团）
 *   2. 每个目录项自洽：planes=1、尺寸是方的、数据落在文件内
 *   3. BMP 项：BITMAPINFOHEADER.biHeight 必须是 2×高（XOR 图 + AND 掩码各一份），
 *      dataSize 必须**精确**等于 40 + w*h*4 + 掩码行距补齐后的长度
 *   4. 32 位项必须自带 alpha（否则 Windows 把整张方图当不透明，圆角外是白边）
 *   5. AND 掩码必须全 0（32 位色深下透明度由 alpha 承担，掩码非 0 会啃掉图形）
 *   6. 像素确有内容：不同颜色数 ≥ 4，不是"生成一个纯色方块交差"
 *   7. 打包配置真的会找到它（buildResources 必须指 build/）
 *
 * 生成方式见 `scripts/make-icon.mjs`（无第三方依赖，纯 Node 光栅化 + 手写容器）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const root = join(__dirname, '../..');
const ICO_PATH = join(root, 'build/icon.ico');

/** 一个目录项解析出来的元信息 */
interface Entry {
  w: number;
  h: number;
  planes: number;
  bitCount: number;
  dataSize: number;
  dataOffset: number;
  /** 项数据本身 */
  data: Buffer;
  /** 数据是 PNG（256 项允许）还是 BMP DIB */
  kind: 'png' | 'bmp';
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 目录项里的宽高是 1 字节，0 表示 256 */
const normalizeSize = (b: number): number => (b === 0 ? 256 : b);

function loadIco(): Buffer {
  expect(existsSync(ICO_PATH), `缺少 ${ICO_PATH}（Windows 图标必须打包在 build/icon.ico）`).toBe(true);
  const buf = readFileSync(ICO_PATH);
  expect(buf.length, 'icon.ico 是空文件').toBeGreaterThan(1024);
  return buf;
}

/**
 * ICONDIRENTRY 是 16 字节：
 *   +0 宽  +1 高  +2 调色板色数  +3 reserved
 *   +4 planes(2)  +6 bitCount(2)  +8 dataSize(4)  +12 dataOffset(4)
 */
function parseEntries(buf: Buffer): Entry[] {
  const count = buf.readUInt16LE(4);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const dir = 6 + i * 16;
    const w = normalizeSize(buf[dir]);
    const h = normalizeSize(buf[dir + 1]);
    const planes = buf.readUInt16LE(dir + 4);
    const bitCount = buf.readUInt16LE(dir + 6);
    const dataSize = buf.readUInt32LE(dir + 8);
    const dataOffset = buf.readUInt32LE(dir + 12);
    out.push({
      w,
      h,
      planes,
      bitCount,
      dataSize,
      dataOffset,
      data: buf.subarray(dataOffset, dataOffset + dataSize),
      kind: buf.subarray(dataOffset, dataOffset + 8).equals(PNG_SIG) ? 'png' : 'bmp',
    });
  }
  return out;
}

/** 1bpp AND 掩码的单行字节数，按 32 位对齐 */
const maskStride = (w: number): number => Math.ceil(w / 32) * 4;

describe('A. build/icon.ico 的容器结构必须合法', () => {
  it('ICONDIR 头：reserved=0、type=1（图标）、至少 4 个尺寸', () => {
    const buf = loadIco();
    expect(buf.readUInt16LE(0), 'reserved 必须为 0').toBe(0);
    expect(buf.readUInt16LE(2), 'type 必须为 1（1=光标，误写成 0 系统不认）').toBe(1);
    const count = buf.readUInt16LE(4);
    expect(count, '只有一个尺寸会被系统硬缩放成糊图').toBeGreaterThanOrEqual(4);
    expect(6 + count * 16, '目录项越界').toBeLessThanOrEqual(buf.length);
  });

  it('覆盖 16/32/48/256 四档（任务栏、桌面、资源管理器、高 DPI 各取一档）', () => {
    const sizes = new Set(parseEntries(loadIco()).map((e) => e.w));
    for (const s of [16, 32, 48, 256]) {
      expect(sizes.has(s), `缺 ${s}×${s}`).toBe(true);
    }
  });

  it('每个目录项自洽：方形、planes=1、色深 32、数据落在文件内', () => {
    const buf = loadIco();
    for (const e of parseEntries(buf)) {
      expect(e.w, '宽度不能是 0').toBeGreaterThan(0);
      expect(e.h, `${e.w}px 档不是方形`).toBe(e.w);
      expect(e.planes, `${e.w}px 档 planes 必须为 1`).toBe(1);
      expect(e.bitCount, `${e.w}px 档必须 32 位色深（带 alpha）`).toBe(32);
      expect(e.dataOffset, `${e.w}px 档数据起始越界`).toBeLessThanOrEqual(buf.length);
      expect(e.dataOffset + e.dataSize, `${e.w}px 档数据越过文件尾`).toBeLessThanOrEqual(buf.length);
      expect(e.data.length, `${e.w}px 档声明长度与实际不符`).toBe(e.dataSize);
    }
  });

  it('BMP 项：biHeight=2×高，dataSize 精确等于头+像素+掩码', () => {
    for (const e of parseEntries(loadIco()).filter((x) => x.kind === 'bmp')) {
      const bih = e.data.readUInt32LE(0);
      expect(bih, `${e.w}px 项的 BITMAPINFOHEADER 大小应为 40`).toBe(40);
      expect(e.data.readInt32LE(4), `${e.w}px 项 biWidth 与目录项不符`).toBe(e.w);
      // 关键：ICO 里的 BMP 高度是「XOR 图 + AND 掩码」两份，写成 h 会被当半个图
      expect(e.data.readInt32LE(8), `${e.w}px 项 biHeight 必须是 2×${e.h}`).toBe(e.h * 2);
      expect(e.data.readUInt32LE(16), `${e.w}px 项压缩方式必须为 0`).toBe(0);
      const expected = 40 + e.w * e.h * 4 + maskStride(e.w) * e.h;
      expect(e.dataSize, `${e.w}px 项数据长度与结构算出来的不一致`).toBe(expected);
    }
  });

  it('BMP 项：AND 掩码全 0，透明度只由 alpha 通道承担', () => {
    for (const e of parseEntries(loadIco()).filter((x) => x.kind === 'bmp')) {
      const mask = e.data.subarray(40 + e.w * e.h * 4);
      expect(mask.length, `${e.w}px 项掩码长度不对`).toBe(maskStride(e.w) * e.h);
      expect(mask.every((b) => b === 0), `${e.w}px 项 AND 掩码非 0，图形会被啃掉一块`).toBe(true);
    }
  });

  it('至少一档不是纯色：颜色种类 ≥ 4，且存在非 0 alpha（圆角外要真透明）', () => {
    const entries = parseEntries(loadIco()).filter((x) => x.kind === 'bmp');
    expect(entries.length, '没有 BMP 项可校验像素').toBeGreaterThan(0);
    let checked = 0;
    for (const e of entries) {
      if (e.w < 32) continue; // 16 档降采样后颜色数本就少
      const px = e.data.subarray(40, 40 + e.w * e.h * 4);
      const colors = new Set<string>();
      let transparent = 0;
      let opaque = 0;
      for (let i = 0; i < px.length; i += 4) {
        colors.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
        if (px[i + 3] === 0) transparent++;
        else opaque++;
      }
      expect(colors.size, `${e.w}px 档只有 ${colors.size} 种颜色，是纯色方块`).toBeGreaterThanOrEqual(4);
      expect(transparent, `${e.w}px 档完全没有透明像素（圆角外会发白）`).toBeGreaterThan(0);
      expect(opaque, `${e.w}px 档全是透明的`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, '32px 及以上档位一个都没有').toBeGreaterThan(0);
  });

  it('PNG 项（若有）签名与首个 chunk 合法', () => {
    for (const e of parseEntries(loadIco()).filter((x) => x.kind === 'png')) {
      expect(e.data.subarray(0, 8).equals(PNG_SIG)).toBe(true);
      expect(e.data.subarray(12, 16).toString('latin1'), 'PNG 第一个 chunk 必须是 IHDR').toBe('IHDR');
      // 能 inflate 才算没截断
      const idatStart = e.data.indexOf(Buffer.from('IDAT'));
      expect(idatStart, 'PNG 缺 IDAT').toBeGreaterThan(0);
      expect(() => zlib.inflateSync(e.data.subarray(idatStart + 4, e.data.indexOf('IEND', idatStart) - 8))).not.toThrow();
    }
  });
});

describe('B. 打包配置真的会找到这个图标', () => {
  it('electron-builder.yml 的 buildResources 指向 build/', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    // 缩进两格：它写在 `directories:` 下面
    expect(yml, '没有 buildResources 就不会去 build/ 找 icon.ico').toMatch(
      /^\s*buildResources:\s*build\s*$/m,
    );
  });

  it('win.icon 若显式声明，必须指向真实存在的文件', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    const m = yml.match(/^\s*icon:\s*(\S+)\s*$/m);
    if (m) {
      const p = m[1].replace(/^["']/, '');
      expect(existsSync(join(root, p)), `win.icon 指向不存在的 ${p}`).toBe(true);
    }
  });
});

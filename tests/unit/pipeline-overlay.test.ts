// tests/unit/pipeline-overlay.test.ts
// P2-A Task 1：提示词覆盖层解析/序列化（文件机制，删文件恢复默认）。
// 机制参照旧工具 WritingStudio 的"覆盖层+删文件恢复默认"做法，文本与措辞原创。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOverlay,
  serializeOverlay,
  overlayPath,
  loadOverlay,
  saveOverlay,
  removeOverlay,
} from '@main/pipeline/overlay';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mozhou-overlay-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('overlay 往返（serialize → parse 语义等值）', () => {
  it('带温度的完整往返：overlay 等值且零 warning', () => {
    const o = {
      role: 'writer' as const,
      temperature: 0.8,
      additional: '每章结尾必须留钩子。\n多用短句，少用成语堆叠。',
    };
    const parsed = parseOverlay('writer', serializeOverlay(o));
    expect(parsed.overlay).toEqual(o);
    expect(parsed.warnings).toEqual([]);
  });

  it('空温度（沿用内置）往返：temperature=null 且零 warning', () => {
    const o = { role: 'concept' as const, temperature: null, additional: '先给三个备选方案。' };
    const parsed = parseOverlay('concept', serializeOverlay(o));
    expect(parsed.overlay).toEqual(o);
    expect(parsed.warnings).toEqual([]);
  });

  it('附加要求为空的往返：additional="" 且零 warning', () => {
    const o = { role: 'architect' as const, temperature: 0.7, additional: '' };
    const parsed = parseOverlay('architect', serializeOverlay(o));
    expect(parsed.overlay).toEqual(o);
    expect(parsed.warnings).toEqual([]);
  });

  it('CRLF 文件同样往返等值（换行归一化）', () => {
    const o = { role: 'writer' as const, temperature: 0.9, additional: '两行\n要求' };
    const raw = serializeOverlay(o).replace(/\n/g, '\r\n');
    expect(parseOverlay('writer', raw).overlay).toEqual(o);
  });

  it('序列化产物自带说明头：机制说明/段名勿改/删除文件恢复默认都在', () => {
    const text = serializeOverlay({ role: 'writer', temperature: 0.9, additional: '留钩子' });
    expect(text).toContain('<!--');
    expect(text).toContain('覆盖层');
    expect(text).toContain('删除本文件');
    expect(text).toContain('## 附加要求');
    expect(text).toContain('温度：0.9');
  });

  it('说明头在注释里提到段名，但解析先剥注释、不会被头部文字骗出锚点', () => {
    const headerOnly = serializeOverlay({ role: 'writer', temperature: 0.9, additional: 'x' });
    const body = headerOnly.slice(headerOnly.indexOf('-->') + 3);
    const noAnchors = headerOnly.replace(body, '\n随便一段没有锚点的正文\n');
    const parsed = parseOverlay('writer', noAnchors);
    expect(parsed.overlay).toBeNull();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('同内容两次 serialize 逐字节相等（无时间戳/随机量——prompt cache 纪律的投影，T1 minor-1 并批）', () => {
    const o = { role: 'writer' as const, temperature: 0.85, additional: '留钩子\n短句为主。' };
    const a = serializeOverlay(o);
    expect(serializeOverlay({ ...o })).toBe(a);
    expect(serializeOverlay({ role: 'writer', temperature: 0.85, additional: '留钩子\n短句为主。' })).toBe(a);
    // additional 首尾空白差异会被 trim 抹平 → 同一份字节
    expect(serializeOverlay({ ...o, additional: '\n  留钩子\n短句为主。 \n' })).toBe(a);
  });
});

describe('overlay 容错（回退默认 + warning 直报，绝不静默吞）', () => {
  it('缺「温度：」行 → temperature=null + 温度相关 warning，overlay 仍返回', () => {
    const parsed = parseOverlay('writer', '## 附加要求\n只要附加要求。');
    expect(parsed.overlay).toEqual({ role: 'writer', temperature: null, additional: '只要附加要求。' });
    expect(parsed.warnings.join(' ')).toMatch(/温度/);
  });

  it('「温度：」存在但留空 → 合法，null 且零 warning（= 沿用内置）', () => {
    const parsed = parseOverlay('writer', '温度：\n\n## 附加要求\n空温度样例');
    expect(parsed.overlay).toEqual({ role: 'writer', temperature: null, additional: '空温度样例' });
    expect(parsed.warnings).toEqual([]);
  });

  it('「温度：」非法值（非数字/超范围）→ null + warning，其余照常解析', () => {
    for (const bad of ['偏高', '9', '-1']) {
      const parsed = parseOverlay('architect', `温度：${bad}\n\n## 附加要求\n正文`);
      expect(parsed.overlay, bad).toEqual({ role: 'architect', temperature: null, additional: '正文' });
      expect(parsed.warnings.join(' '), bad).toMatch(/温度/);
    }
  });

  it('缺「## 附加要求」段 → overlay 仍返回（additional=""）+「缺段」warning', () => {
    const parsed = parseOverlay('concept', '温度：1.05');
    expect(parsed.overlay).toEqual({ role: 'concept', temperature: 1.05, additional: '' });
    expect(parsed.warnings.join(' ')).toMatch(/缺段|附加要求/);
  });

  it('垃圾文件（无锚点乱码）→ overlay=null，warnings 直报真因', () => {
    const parsed = parseOverlay('writer', '▓▓ 这不是覆盖层 ▓▓\n完全不知道写了什么');
    expect(parsed.overlay).toBeNull();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('空文件 → overlay=null + warning', () => {
    const parsed = parseOverlay('writer', '   \n');
    expect(parsed.overlay).toBeNull();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('半角冒号「温度:」同样识别', () => {
    const parsed = parseOverlay('writer', '温度: 0.6\n\n## 附加要求\nx');
    expect(parsed.overlay?.temperature).toBe(0.6);
  });
});

describe('overlay 文件落点与读写（<dataDir>/prompt-overlays/<role>.md）', () => {
  it('overlayPath 落在数据目录的 prompt-overlays 子目录下，按角色命名', () => {
    expect(overlayPath(dataDir, 'writer')).toBe(join(dataDir, 'prompt-overlays', 'writer.md'));
    expect(overlayPath(dataDir, 'concept')).toBe(join(dataDir, 'prompt-overlays', 'concept.md'));
  });

  it('文件不存在 → exists=false、overlay=null、零 warning（默认态不是错误）', async () => {
    const loaded = await loadOverlay(dataDir, 'architect');
    expect(loaded).toEqual({ overlay: null, warnings: [], exists: false });
  });

  it('save → load 等值往返，目录自动创建，磁盘上就是带说明头的 md', async () => {
    await saveOverlay(dataDir, 'writer', { temperature: 0.85, additional: '对白要口语化。' });
    const loaded = await loadOverlay(dataDir, 'writer');
    expect(loaded.exists).toBe(true);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.overlay).toEqual({ role: 'writer', temperature: 0.85, additional: '对白要口语化。' });
    const onDisk = readFileSync(overlayPath(dataDir, 'writer'), 'utf8');
    expect(onDisk).toContain('<!--');
    expect(onDisk).toContain('## 附加要求');
  });

  it('损坏文件 load 不抛错：exists=true、overlay=null、warnings 带真因', async () => {
    await saveOverlay(dataDir, 'concept', { temperature: null, additional: 'x' });
    writeFileSync(overlayPath(dataDir, 'concept'), '彻底乱码 ▓▓▓', 'utf8');
    const loaded = await loadOverlay(dataDir, 'concept');
    expect(loaded.exists).toBe(true);
    expect(loaded.overlay).toBeNull();
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  it('remove：存在→true，文件消失后→false；remove 后即恢复默认态', async () => {
    await saveOverlay(dataDir, 'architect', { temperature: 0.7, additional: '' });
    expect(await removeOverlay(dataDir, 'architect')).toBe(true);
    const loaded = await loadOverlay(dataDir, 'architect');
    expect(loaded.exists).toBe(false);
    expect(await removeOverlay(dataDir, 'architect')).toBe(false);
  });

  it('save 覆盖旧文件（二次 save 后再 load 是新内容）', async () => {
    await saveOverlay(dataDir, 'writer', { temperature: 0.5, additional: '旧' });
    await saveOverlay(dataDir, 'writer', { temperature: 1.0, additional: '新' });
    const loaded = await loadOverlay(dataDir, 'writer');
    expect(loaded.overlay).toEqual({ role: 'writer', temperature: 1, additional: '新' });
  });
});

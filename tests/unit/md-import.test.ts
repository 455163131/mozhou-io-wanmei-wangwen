/**
 * 把 `chapters/*.md` 旧稿认出来、排好队（§4 第 19 条②，纯函数层）。
 *
 * ★ 修复前的现状（实测口径见 PROJECT-STATUS.md §4 第 19 条②）：
 *   `services.openProject()` 只 `ensureDir(join(rootDir,'chapters'))`，
 *   从不把目录里已有的 .md 读回库；全仓也没有任何"导入"入口。
 *   净效果：U 盘里带着旧稿换机器，库是空的，章节树也空 —— 稿子在磁盘上却看不见。
 *
 * ★ 三条口径（都是"不许盲做"的那三条，这里定死并用断言钉住）：
 *   · **同名冲突 → 跳过，绝不覆盖**：库里已有第 N 章，磁盘上的第 N 章就不动它。
 *     库里那份可能正在被编辑器改、可能是 Agent 刚写的，拿 md 盖掉等于删用户的字。
 *   · **编码 → 先 UTF-8（含 BOM），再 GBK，两个都失败就说"认不出"**：
 *     旧稿大量是 Windows 记事本的 ANSI(GBK)，只按 UTF-8 读会解出一堆乱码，
 *     而乱码写进库比"导入失败"难发现得多。
 *   · **认不出章号 → 挂到 unresolved，不猜号**：猜号就是把正文塞进错的章节位置。
 *
 * 这里只测纯函数（不碰 fs、不碰 electron），fs/装配层由
 * `chapter-import-md-wiring.test.ts` 钉，入库语义由 `chapter-import-md.test.ts` 钉。
 */
import { describe, it, expect } from 'vitest';
import {
  decodeMarkdownBytes,
  parseMarkdownChapter,
  planMarkdownImport,
} from '@main/fs/md-import';

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('A. 编码判定', () => {
  it('UTF-8 正文照常解，并回报 encoding', () => {
    const r = decodeMarkdownBytes(utf8('第 1 章 风雪夜\n\n他推开门。'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.encoding).toBe('utf-8');
      expect(r.text).toContain('他推开门');
    }
  });

  it('★ BOM 必须剥掉（不然首行标题匹配不上，正文开头还挂一个不可见字符）', () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('# 第一章标题\n正文')]);
    const r = decodeMarkdownBytes(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text.startsWith('﻿'), 'BOM 漏进正文').toBe(false);
      expect(r.text.startsWith('# ')).toBe(true);
    }
  });

  it('★ GBK（记事本"ANSI"）要能救回来，不能直接判死', () => {
    // '京州' 的 GBK 编码，按 UTF-8 解是非法字节序列
    const r = decodeMarkdownBytes(Buffer.from([0xbe, 0xa9, 0xd6, 0xdd]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.encoding).toBe('gbk');
      expect(r.text).toBe('京州');
    }
  });

  it('两种编码都解不开 → ok:false，宁可不导入', () => {
    const r = decodeMarkdownBytes(Buffer.from([0x80, 0x81]));
    expect(r.ok).toBe(false);
  });
});

describe('B. 文件名认章号 + 标题', () => {
  const cases: Array<[string, number | null]> = [
    ['第12章.md', 12],
    ['第 12 章.md', 12],
    ['第12章 风雪夜归.md', 12],
    ['第12章-风雪夜归.md', 12],
    ['第12章：风雪夜归.md', 12],
    ['012.md', 12],
    ['12 风雪夜.md', 12],
    ['第十二章.md', null],
    ['楔子.md', null],
    ['README.md', null],
    ['第10.5章.md', null],
  ];
  for (const [name, expected] of cases) {
    it(`${name} → 章号 ${expected === null ? '认不出' : expected}`, () => {
      expect(parseMarkdownChapter(name, '正文内容').number).toBe(expected);
    });
  }

  it('文件名里号后面的部分当标题', () => {
    expect(parseMarkdownChapter('第12章 风雪夜归.md', '正文').title).toBe('风雪夜归');
  });

  it('文件名只有号 → 标题留空（界面按 第N章 兜底）', () => {
    expect(parseMarkdownChapter('第12章.md', '正文').title).toBe('');
  });

  it('★ 正文首行的 `# ` 标题优先于文件名（旧稿常在 md 里写章名）', () => {
    const p = parseMarkdownChapter('第12章.md', '# 第12章 风雪夜归\n\n他推开门。');
    expect(p.title).toBe('风雪夜归');
  });

  it('★ 首行标题要一起吃掉，别在正文里再留一遍', () => {
    const p = parseMarkdownChapter('第12章.md', '# 风雪夜\n\n他推开门。');
    expect(p.body).toBe('他推开门。');
  });

  it('`## ` 这类小节标题不是章名，原样留在正文里', () => {
    const p = parseMarkdownChapter('第12章.md', '## 小节\n\n他推开门。');
    expect(p.title).toBe('');
    expect(p.body).toContain('## 小节');
  });

  it('CRLF 归一成 LF（编辑器与字数统计都按 \n 算）', () => {
    const p = parseMarkdownChapter('第3章.md', '第一行\r\n第二行');
    expect(p.body).toBe('第一行\n第二行');
  });
});

describe('C. 排队：谁入库、谁跳过、谁报不出来', () => {
  const files = (list: Array<[string, string | Buffer]>): Array<{ fileName: string; raw: Buffer }> =>
    list.map(([fileName, body]) => ({
      fileName,
      raw: Buffer.isBuffer(body) ? body : utf8(body),
    }));

  it('★ 库里已有同号 → skipped，理由要说清"没动它"', () => {
    const plan = planMarkdownImport(files([['第2章.md', '新的正文']]), ['1', '2']);
    expect(plan.imported).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toContain('第2章');
    expect(plan.skipped[0].reason).toMatch(/已有|不动|没动/);
  });

  it('不覆盖是硬规矩：库里是 1、2 时，只入 3', () => {
    const plan = planMarkdownImport(
      files([
        ['第2章.md', '盖掉库里'],
        ['第3章.md', '新章'],
      ]),
      ['1', '2'],
    );
    expect(plan.imported.map((d) => d.id)).toEqual(['3']);
    expect(plan.skipped.map((s) => s.fileName)).toEqual(['第2章.md']);
  });

  it('★ 一批里两个文件同号 → 只入排序在前的那个，后者 skipped 并注明本次导入', () => {
    const plan = planMarkdownImport(
      files([
        ['第3章.md', '甲'],
        ['003.md', '乙'],
      ]),
      [],
    );
    expect(plan.imported.map((d) => d.fileName)).toEqual(['第3章.md']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].fileName).toBe('003.md');
    expect(plan.skipped[0].reason).toContain('本次');
  });

  it('★ 按章号升序入库，不按文件名（字典序会把 10 排在 9 前面）', () => {
    const plan = planMarkdownImport(
      files([
        ['第10章.md', 'J'],
        ['第9章.md', 'I'],
        ['第2章.md', 'B'],
      ]),
      [],
    );
    expect(plan.imported.map((d) => d.number)).toEqual([2, 9, 10]);
  });

  it('非数字的既有 id（楔子、番外）不参与撞号判断', () => {
    const plan = planMarkdownImport(files([['第1章.md', '甲']]), ['楔子', '番外']);
    expect(plan.imported.map((d) => d.id)).toEqual(['1']);
    expect(plan.skipped).toHaveLength(0);
  });

  it('认不出章号 → unresolved，并告诉用户改成什么文件名', () => {
    const plan = planMarkdownImport(files([['第十二章.md', '甲']]), []);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0].reason).toMatch(/第\s*\d+\s*章|文件名/);
  });

  it('★ 编码解不开 → unresolved，绝不把乱码写进库', () => {
    const plan = planMarkdownImport(files([['第5章.md', Buffer.from([0x80, 0x81])]]), []);
    expect(plan.imported).toHaveLength(0);
    expect(plan.unresolved[0].reason).toMatch(/编码|GBK|UTF/);
  });

  it('正文是空的 → unresolved（导入一堆空章只会把目录搞乱）', () => {
    const plan = planMarkdownImport(files([['第6章.md', '  \n\n  ']]), []);
    expect(plan.imported).toHaveLength(0);
    expect(plan.unresolved[0].reason).toMatch(/空/);
  });

  it('导入项带 id / title / body，id 就是章号字符串', () => {
    const plan = planMarkdownImport(files([['第7章 初见.md', '他推开门。']]), []);
    const d = plan.imported[0];
    expect(d.id).toBe('7');
    expect(d.title).toBe('初见');
    expect(d.body).toBe('他推开门。');
  });

  it('空目录 → 三个桶都是空，不抛错', () => {
    const plan = planMarkdownImport([], ['1']);
    expect(plan.imported).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });
});

// tests/unit/chart-manual.test.ts —— C批「榜单手动导入」纯解析器（不碰网络/库）。
//
// 诚实纪律（DRD §7）：手动导入条目 live 恒 false + manual 恒 true——既不是实时抓取，
// 也不是演示集；热度解析不出 → null（绝不编造）；识别不出任何书目 → 抛真因，不静默回 []。
// 上限（200 条 / 100000 字符）超限同样抛真因，防粘贴一整站 HTML 撑爆 IPC。
import { describe, it, expect } from 'vitest';
import { parseManualChart } from '@main/inspiration/chart-manual';

describe('parseManualChart：CSV/TSV/裸书名', () => {
  it('CSV 带表头：表头跳过；列按 排名,书名,作者,热度,链接,标签；《》剥掉；live=false + manual=true', () => {
    const text = [
      '排名,书名,作者,热度,链接,标签',
      '1,《长河渡口》,驿舟子,27.7万,https://example.com/a,现实|群像',
      '2,守夜灯塔修补匠,迟迟雨,3456,,悬疑',
    ].join('\n');
    const entries = parseManualChart('番茄', text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      rank: 1,
      title: '长河渡口',
      author: '驿舟子',
      platform: '番茄',
      heat: 277000,
      tags: ['现实', '群像'],
      url: 'https://example.com/a',
      live: false,
      manual: true,
    });
    expect(entries[1]).toMatchObject({ rank: 2, title: '守夜灯塔修补匠', heat: 3456, url: '', tags: ['悬疑'], live: false, manual: true });
  });

  it('英文表头（title）同样跳过', () => {
    const entries = parseManualChart('晋江', 'rank,title,author\n1,书A,作者A');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('书A');
  });

  it('TSV：有 tab 就按 tab 切（行内逗号不再当分隔符）', () => {
    const entries = parseManualChart('起点', '1\t书A\t作者A\t1.2亿\thttps://example.com/b\t玄幻|热血');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rank: 1, title: '书A', author: '作者A', heat: 120000000, url: 'https://example.com/b', tags: ['玄幻', '热血'] });
  });

  it('裸书名行（无分隔符）：按行序排名，author 空 / heat null / url 空 / tags 空', () => {
    const entries = parseManualChart('晋江', '书A\n书B\n书C');
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.title)).toEqual(['书A', '书B', '书C']);
    for (const e of entries) {
      expect(e).toMatchObject({ author: '', heat: null, url: '', tags: [], live: false, manual: true, platform: '晋江' });
    }
  });

  it('排名列非整数 → 按已接受条目行序（1-based）；显式整数排名优先', () => {
    const entries = parseManualChart('番茄', '-,书A,甲\n5,书B,乙\nx,书C,丙');
    expect(entries.map((e) => e.rank)).toEqual([1, 5, 3]);
  });

  it('空行跳过；首尾空白 trim；书名只有分隔符没有内容 → 该行不识别', () => {
    const entries = parseManualChart('番茄', '\n  \n 1 , 书A , 甲 \n,,\n\n2,书B,乙\n');
    expect(entries.map((e) => e.title)).toEqual(['书A', '书B']);
    expect(entries[0]!.author).toBe('甲');
  });
});

describe('parseManualChart：热度诚实换算（万/亿自写，不冒认）', () => {
  it('27.7万→277000；1.2亿→120000000；3456→3456；空/不可解析→null（绝不编造）', () => {
    const text = ['1,书A,a,27.7万', '2,书B,b,1.2亿', '3,书C,c,3456', '4,书D,d,', '5,书E,e,未知热度'].join('\n');
    const entries = parseManualChart('番茄', text);
    expect(entries.map((e) => e.heat)).toEqual([277000, 120000000, 3456, null, null]);
  });

  it('小数换算四舍五入到整数（27.75万→277500）', () => {
    const entries = parseManualChart('番茄', '1,书A,a,27.75万');
    expect(entries[0]!.heat).toBe(277500);
  });
});

describe('parseManualChart：url 与标签', () => {
  it('url 只认 http(s):// 开头；相对路径/ftp/裸域名一律丢弃为空串（不对平台 origin 补全）', () => {
    const text = ['1,书A,a,,https://example.com/ok', '2,书B,b,,/book/123', '3,书C,c,,ftp://x/y', '4,书D,d,,example.com/z', '5,书E,e,,http://example.com/http-ok'].join('\n');
    const entries = parseManualChart('起点', text);
    expect(entries.map((e) => e.url)).toEqual(['https://example.com/ok', '', '', '', 'http://example.com/http-ok']);
  });

  it('标签按 | 拆分并 trim，空段丢弃', () => {
    const entries = parseManualChart('番茄', '1,书A,a,,, 现实 | 群像 || ');
    expect(entries[0]!.tags).toEqual(['现实', '群像']);
  });
});

// ── 审查修复波（2026-11-09）：quoted CSV / 表头误吞 / 热度锚定 ──
describe('parseManualChart：quoted CSV（Excel 导出含逗号字段必带引号）', () => {
  it('引号内逗号不劈列：1,"你好,世界",作者,27.7万 → 完整书名/作者/热度', () => {
    const entries = parseManualChart('番茄', '1,"你好,世界",作者,27.7万');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rank: 1, title: '你好,世界', author: '作者', heat: 277000 });
  });

  it('无内逗号的 quoted 字段剥引号（"《书名》" → 书名，引号与《》都不残留）', () => {
    const entries = parseManualChart('番茄', '1,"《书名》",甲');
    expect(entries[0]!.title).toBe('书名');
  });

  it('双写引号转义："a""b" → a"b', () => {
    const entries = parseManualChart('番茄', '1,"a""b",甲');
    expect(entries[0]!.title).toBe('a"b');
  });

  it('quoted 空书名列 → 该行不识别（与裸空列同口径）', () => {
    const entries = parseManualChart('番茄', '1,"",甲\n2,书B,乙');
    expect(entries.map((e) => e.title)).toEqual(['书B']);
  });
});

describe('parseManualChart：表头只认首个非空行且按列形状（不误吞真实书目）', () => {
  it('数据行含「书名」二字不吞：2,《书名》,乙 是真实书目', () => {
    const entries = parseManualChart('番茄', '1,正常的书,甲\n2,《书名》,乙');
    expect(entries.map((e) => e.title)).toEqual(['正常的书', '书名']);
  });

  it('英文书名含 title 不吞：1,Title Fight,甲 是首行数据不是表头', () => {
    const entries = parseManualChart('晋江', '1,Title Fight,甲');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Title Fight');
  });

  it('表头在空行之后仍识别（首个非空行口径）', () => {
    const entries = parseManualChart('番茄', '\n \n排名,书名,作者\n1,书A,甲');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('书A');
  });

  it('裸首行恰为「书名」/「title」按单列表头跳过', () => {
    expect(parseManualChart('番茄', '书名\n书A').map((e) => e.title)).toEqual(['书A']);
    expect(parseManualChart('晋江', 'title\n书B').map((e) => e.title)).toEqual(['书B']);
  });
});

describe('parseManualChart：热度全锚定（负号/杂质宁缺毋假）', () => {
  it('-3.2万 → null（负热度不编造成正数）；跌2万 / 1万2 / 27.7万热度 → null', () => {
    const text = ['1,书A,a,-3.2万', '2,书B,b,跌2万', '3,书C,c,1万2', '4,书D,d,27.7万热度'].join('\n');
    const entries = parseManualChart('番茄', text);
    expect(entries.map((e) => e.heat)).toEqual([null, null, null, null]);
  });
});

describe('parseManualChart：上限与失败真因（绝不静默回空）', () => {
  it('空输入/纯空白 → 抛「未识别到任何书目」真因', () => {
    expect(() => parseManualChart('番茄', '')).toThrowError('手动导入解析失败：未识别到任何书目（每行一本：排名,书名,作者,热度,链接,标签）');
    expect(() => parseManualChart('番茄', ' \n\t\n ')).toThrowError(/未识别到任何书目/);
  });

  it('全是表头/无书名列 → 同样抛真因，不回 []', () => {
    expect(() => parseManualChart('番茄', '排名,书名,作者\n1,,甲\n2,,乙')).toThrowError(/未识别到任何书目/);
  });

  it('200 条恰好收；201 条 → 抛「最多 200 条」真因', () => {
    const ok = Array.from({ length: 200 }, (_, i) => `${i + 1},书${i + 1},作者`).join('\n');
    expect(parseManualChart('番茄', ok)).toHaveLength(200);
    const over = Array.from({ length: 201 }, (_, i) => `${i + 1},书${i + 1},作者`).join('\n');
    expect(() => parseManualChart('番茄', over)).toThrowError('手动导入超出上限：最多 200 条');
  });

  it('超过 100000 字符 → 抛文本上限真因（先于逐行解析）', () => {
    expect(() => parseManualChart('番茄', '书'.repeat(100_001))).toThrowError(/手动导入超出上限.*100000/);
    // 恰好 100000 字符的合法输入不拦（单行裸书名）
    expect(parseManualChart('番茄', '书'.repeat(100_000))).toHaveLength(1);
  });
});
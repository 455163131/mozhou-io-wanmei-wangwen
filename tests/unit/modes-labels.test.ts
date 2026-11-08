/**
 * MODE_LABELS / modeLabel 行为钉（P2-E 收口波）。
 *
 * modes.ts 此前只被源码扫测试读文本（shell-r1 A 组钉清单↔分派），模块从未在
 * 测试里真正执行——覆盖率恒 0，每加一个 mode 就往总账添几行未覆盖。这里真 import
 * 真调用：label 非空、modeLabel 查得到/查不到回显，把「唯一来源」从文本钉升级成
 * 行为钉。键集合与 App/面板的逐字一致性仍归 shell-r1 A 组管，这里不重复抄清单。
 */
import { describe, expect, it } from 'vitest';
import { MODE_LABELS, modeLabel } from '@shared/constants/modes';

describe('MODE_LABELS 唯一来源行为', () => {
  it('每个 mode 都有非空显示名', () => {
    const entries = Object.entries(MODE_LABELS);
    expect(entries.length).toBe(17);
    for (const [id, label] of entries) {
      expect(label.trim(), `${id} 的显示名为空`).not.toBe('');
      expect(modeLabel(id)).toBe(label);
    }
  });

  it('P2-E 两页显示名钉死（三字档灵感池 / 四字档长期记忆）', () => {
    expect(MODE_LABELS.pool).toBe('灵感池');
    expect(MODE_LABELS.longterm).toBe('长期记忆');
  });

  it('认不出的 id 原样回显，不显示 undefined', () => {
    expect(modeLabel('no-such-mode')).toBe('no-such-mode');
    expect(modeLabel('')).toBe('');
  });
});
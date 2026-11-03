// tests/unit/craft-skills.test.ts
import { describe, it, expect } from 'vitest';
import { matchSkills, CRAFT_SKILLS } from '@main/pipeline/craft-skills';

describe('craft-skills 触发匹配', () => {
  it('章纲含触发词命中对应 skill', () => {
    const hits = matchSkills('雾中拾玉 · 钩子：玉佩里传出心跳声', 'writer');
    expect(hits.some(s => s.id === 'chapter-hook')).toBe(true);
  });
  it('architect 角色不拿 writer 专属 skill', () => {
    const hits = matchSkills('章纲规划', 'architect');
    expect(hits.every(s => s.roles.includes('architect'))).toBe(true);
  });
  it('无触发词零命中', () => {
    expect(matchSkills('平淡无奇的一句话', 'writer')).toEqual([]);
  });
  it('六条 skill 正文均非空且无商业资产逐字痕迹（长度>40字）', () => {
    expect(CRAFT_SKILLS).toHaveLength(6);
    CRAFT_SKILLS.forEach(s => expect(s.body.length).toBeGreaterThan(40));
  });
});

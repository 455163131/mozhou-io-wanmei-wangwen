// tests/unit/inspiration-overlay-roles.test.ts —— 重复联合两处逐字相等（本仓多副本病钉）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('overlay 角色重复联合同步', () => {
  it('overlay.ts PromptOverlayRole 与 ipc.ts OverlayRole 成员一致', () => {
    const overlay = readFileSync('src/main/pipeline/overlay.ts', 'utf8');
    const ipc = readFileSync('src/shared/types/ipc.ts', 'utf8');
    const a = overlay.match(/PromptOverlayRole\s*=\s*([^;]+);/)?.[1] ?? '';
    const b = ipc.match(/OverlayRole\s*=\s*([^;]+);/)?.[1] ?? '';
    const norm = (s: string) => s.split('|').map((x) => x.replace(/['\s]/g, '')).filter(Boolean).sort();
    expect(norm(a)).toEqual(norm(b));
    expect(norm(a)).toEqual(expect.arrayContaining(['concept', 'architect', 'writer', 'idea', 'teardown'])); // ★ R2：T5 加回 teardown（五角色齐）
  });
  it('OVERLAY_ROLES 运行时白名单含 idea/teardown', () => { // ★ R2：T5 扩回同时钉 idea+teardown
    const oipc = readFileSync('src/main/pipeline/overlay-ipc.ts', 'utf8');
    expect(oipc).toMatch(/OVERLAY_ROLES[\s\S]*idea[\s\S]*teardown|teardown[\s\S]*idea/);
  });
});
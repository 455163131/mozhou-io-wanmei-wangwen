/**
 * 凭据状态的**装配层**哨兵（§4 第 14 条②）。
 *
 * 纯函数写对了不等于用户看得见。本仓反复出现的正是"逻辑对、喂给它的是空气"
 * （§4 第 3/9/13/14①/17/18 条），所以这条链的每一环都要钉住：
 *   纯模块 → keyring 记录 → ProviderSettings 透出 → 主进程填值 → 设置界面真的显示。
 * 少一环的后果是用户继续看到"Key 没配"，而手上其实有一份解不开的旧凭据。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('A. 纯模块存在且不碰 electron', () => {
  const rel = 'src/main/llm/credential-file.ts';

  it('credential-file.ts 存在', () => {
    expect(existsSync(join(root, rel)), '四态判定必须能脱离 electron 单测').toBe(true);
  });

  it('★ 不 import electron（否则本仓 environment:node 的测试跑不起来）', () => {
    const src = read(rel);
    expect(src).not.toMatch(/from 'electron'/);
    expect(src).not.toMatch(/require\('electron'\)/);
  });

  it('四种状态一个都不能少', () => {
    const src = read(rel);
    for (const s of ['ok', 'none', 'needs-reentry', 'unreadable']) {
      expect(src, `少了 ${s} 就等于把它揉进别的态`).toContain(`'${s}'`);
    }
  });
});

describe('B. keyring 真的用上了它', () => {
  const src = read('src/main/llm/keyring.ts');

  it('import readCredential', () => {
    expect(src).toMatch(/import \{[^}]*readCredential[^}]*\} from '\.\/credential-file'/);
  });

  it('★ loadApiKey 里不再有"把两种失败揉成 undefined"的裸 catch', () => {
    const at = src.indexOf('export async function loadApiKey');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);
    expect(body, '必须走 readCredential 分类，而不是 catch 后一律 undefined').toMatch(/readCredential\(/);
    expect(body).not.toMatch(/catch \{\s*return undefined;\s*\}/);
  });

  it('状态记进 lastCredentialState 并对外可读', () => {
    expect(src).toMatch(/lastCredentialState = (r|res|outcome)\w*\.state/);
    expect(src).toMatch(/export function credentialState\(\): CredentialState/);
  });

  it('存盘成功 / 清除后状态要跟着复位（不然改完 Key 还挂着"需要重输"）', () => {
    const save = src.slice(src.indexOf('export async function saveApiKey'), src.indexOf('export async function loadApiKey'));
    expect(save).toMatch(/lastCredentialState =/);
    const clear = src.slice(src.indexOf('export async function clearApiKey'));
    expect(clear).toMatch(/lastCredentialState = 'none'/);
  });
});

describe('C. 契约与主进程透出', () => {
  const provider = read('src/shared/types/provider.ts');
  const services = read('src/main/services.ts');

  it('ProviderSettings 带 keyState（渲染层只有这一份可显示的信息）', () => {
    const at = provider.indexOf('export interface ProviderSettings');
    expect(provider.slice(at, at + 900)).toMatch(/keyState: CredentialState/);
  });

  it('CredentialState 是四态联合类型', () => {
    const union = provider.match(/export type CredentialState =([^;]*);/);
    expect(union, '没有单独声明就等于各处手写字符串').not.toBeNull();
    for (const s of ['ok', 'none', 'needs-reentry', 'unreadable']) {
      expect(union![1]).toContain(`'${s}'`);
    }
  });

  it('★ llmStatus 把状态填进 settings，且是在读完 Key 之后取（顺序错了永远显示旧值）', () => {
    const at = services.indexOf('async llmStatus()');
    const body = services.slice(at, at + 900);
    expect(body).toMatch(/keyState: credentialState\(\)/);
    expect(body.indexOf('await hasApiKey()')).toBeLessThan(body.indexOf('keyState: credentialState()'));
  });

  it('credentialState 从 keyring 引进来', () => {
    expect(services).toMatch(/import \{[^}]*credentialState[^}]*\} from '\.\/llm\/keyring'/);
  });
});

describe('D. 设置界面真的说给用户听', () => {
  const modal = read('src/renderer/components/settings/SettingsModal.tsx');

  it('★ needs-reentry 有专门文案，且写明要重新输入', () => {
    expect(modal).toMatch(/keyState === 'needs-reentry'/);
    expect(modal).toMatch(/重新输入/);
  });

  it('unreadable 不与 needs-reentry 共用同一句话（原因不同，别谎报换机器）', () => {
    expect(modal).toMatch(/keyState === 'unreadable'/);
  });

  it('用的样式类必须在同名 module.css 里存在（第 20 条①刚栽过）', () => {
    const css = read('src/renderer/components/settings/SettingsModal.module.css');
    for (const m of modal.matchAll(/\bstyles\.([A-Za-z_][\w-]*)/g)) {
      expect(css, `SettingsModal.module.css 缺 .${m[1]}`).toContain(`.${m[1]}`);
    }
  });
});

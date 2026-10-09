/**
 * 凭据文件到底"有没有"还是"解不开"（§4 第 14 条②）。
 *
 * 病灶（实测口径见 PROJECT-STATUS.md §4 第 14 条②）：`safeStorage` 的密钥是
 * **按机器 / 按 Windows 用户**的（DPAPI）。便携包换机器后，旧 `llm-credentials.bin`
 * 必然解不开——修复前 `loadApiKey()` 把"没有文件"和"有文件但解不开"揉成同一个
 * `undefined`（`keyring.ts:49-55`），于是用户看到的是"Key 没配"，
 * 完全不知道自己手上有一份解不了的旧凭据；第 14 条①的迁移还会把这个文件一并搬过去，
 * 让"我明明配过 Key"变成一次无法解释的失败。
 *
 * 这里只测纯函数（不 import electron）：把"读文件"和"解密"两个动作注进来，
 * 四种结局必须**互相可区分**。装配层由 `credential-state-wiring.test.ts` 钉。
 */
import { describe, it, expect } from 'vitest';
import { readCredential } from '@main/llm/credential-file';

function notFound(): Error {
  const e = new Error('ENOENT: no such file or directory');
  (e as Error & { code: string }).code = 'ENOENT';
  return e;
}

function denied(): Error {
  const e = new Error('EACCES: permission denied');
  (e as Error & { code: string }).code = 'EACCES';
  return e;
}

const buf = Buffer.from('cipher-bytes');
const decryptOk = (): string => 'sk-secret';
const decryptFails = (): never => {
  throw new Error('DPAPI 解不开：不是这台机器/这个用户加密的');
};

describe('A. 四种结局必须可区分', () => {
  it('没有文件 → none（用户确实从没配过）', async () => {
    const r = await readCredential({
      available: true,
      load: () => Promise.reject(notFound()),
      decrypt: decryptOk,
    });
    expect(r.state).toBe('none');
    expect(r.key).toBeUndefined();
  });

  it('文件在、解得开 → ok，并把明文交回去（只在本进程内）', async () => {
    const r = await readCredential({
      available: true,
      load: () => Promise.resolve(buf),
      decrypt: decryptOk,
    });
    expect(r.state).toBe('ok');
    expect(r.key).toBe('sk-secret');
  });

  it('★ 文件在、解不开 → needs-reentry，不许退化成 none', async () => {
    const r = await readCredential({
      available: true,
      load: () => Promise.resolve(buf),
      decrypt: decryptFails,
    });
    expect(r.state).toBe('needs-reentry');
    expect(r.key).toBeUndefined();
  });

  it('文件读不出字节（权限/占用）→ unreadable，不能谎报成"换机器了"', async () => {
    const r = await readCredential({
      available: true,
      load: () => Promise.reject(denied()),
      decrypt: decryptOk,
    });
    expect(r.state).toBe('unreadable');
  });

  it('needs-reentry 与 unreadable 必须是两个值（一个是换机器、一个是读不了）', async () => {
    const a = await readCredential({ available: true, load: () => Promise.resolve(buf), decrypt: decryptFails });
    const b = await readCredential({ available: true, load: () => Promise.reject(denied()), decrypt: decryptOk });
    expect(a.state).not.toBe(b.state);
  });
});

describe('B. 加密后端不可用时（无密钥环的平台）', () => {
  it('后端不可用 + 文件在 → unreadable，且**绝不调用 decrypt**', async () => {
    let decrypted = 0;
    const r = await readCredential({
      available: false,
      load: () => Promise.resolve(buf),
      decrypt: (b) => {
        decrypted += 1;
        return b.toString();
      },
    });
    expect(r.state).toBe('unreadable');
    expect(decrypted, '后端不可用时还去解密等于拿明文走危险路径').toBe(0);
  });

  it('后端不可用 + 没有文件 → none（别报"有一份解不开的凭据"）', async () => {
    const r = await readCredential({
      available: false,
      load: () => Promise.reject(notFound()),
      decrypt: decryptOk,
    });
    expect(r.state).toBe('none');
  });
});

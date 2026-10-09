/**
 * 凭据文件的读取与解密分类（§4 第 14 条②）。
 *
 * ★ 这个模块**不许 import electron**：`safeStorage` 在测试里（`environment: 'node'`）
 *   根本构造不出来，把判定揉进 keyring 就等于永远测不到。所以这里只吃两个注入动作
 *   （读字节 / 解密），keyring 负责把它们接到 `fs` 与 `safeStorage` 上。
 *
 * 为什么要分四态：修复前 `keyring.ts:49-55` 把"没有文件"和"有文件但解不开"揉成
 * 同一个 `undefined`，用户看到的是"Key 没配"，而手上其实有一份解不了的旧凭据——
 * `safeStorage` 的密钥按机器按用户（Windows DPAPI），便携包换机器后必然解不开，
 * 而第 14 条①的一次性迁移又会把这个文件一起搬过去，于是"我明明配过 Key"变成
 * 一次无法解释的失败。四态里 `needs-reentry` 与 `unreadable` 必须分开：
 * 前者能说"换机器了，重输一次"，后者不能（权限/坏文件扯不到换机器上）。
 */
import type { CredentialState } from '@shared/types/provider';

export interface CredentialInput {
  /** `safeStorage.isEncryptionAvailable()` 的结果，由调用方注入 */
  available: boolean;
  /** 读凭据文件；不存在时必须抛 `code === 'ENOENT'`（这是 none 的唯一判据） */
  load: () => Promise<Buffer>;
  /** 解密；解不开就抛，抛什么不看 */
  decrypt: (buf: Buffer) => string;
}

export interface CredentialResult {
  state: CredentialState;
  /** 仅 state='ok' 时有值。★ 明文只在主进程内流动，不许跨 contextBridge */
  key?: string;
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: string } | undefined)?.code === 'ENOENT';
}

export async function readCredential(input: CredentialInput): Promise<CredentialResult> {
  let buf: Buffer;
  try {
    buf = await input.load();
  } catch (e) {
    return { state: isNotFound(e) ? 'none' : 'unreadable' };
  }
  // 后端不可用：文件确实在，但连试都不该试（不去碰可能解出明文的路径）
  if (!input.available) return { state: 'unreadable' };
  try {
    return { state: 'ok', key: input.decrypt(buf) };
  } catch {
    return { state: 'needs-reentry' };
  }
}

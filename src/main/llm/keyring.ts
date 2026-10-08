/**
 * Key 存取（架构 T14）。
 *
 * ★ **Key 永不出主进程**（架构 §1.1 分层铁律 1）。
 * 渲染层只知道 `hasKey: boolean` 与 `displayKey: 'sk-a•••xyz'`（掩码）。
 *
 * 用 Electron 的 safeStorage 加密后落盘，明文永不落盘。
 * safeStorage 在部分平台不可用（如未加密的 Linux）——此时**不落盘**，
 * 只放在内存里，进程退出即失效。这是「宁可不方便，也不明文落盘」的选择。
 */
import { safeStorage } from 'electron';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { maskApiKey } from '@shared/util/hash';

/** 内存中的 Key：进程内有效，退出即失效（safeStorage 不可用时的降级路径） */
let memoryKey: string | undefined;

function keyFilePath(): string {
  return join(app.getPath('userData'), 'llm-credentials.bin');
}

/** 是否可用加密存储 */
export function secureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 保存 Key。永不返回明文给调用方之外的任何地方。 */
export async function saveApiKey(key: string): Promise<{ encrypted: boolean }> {
  memoryKey = key;
  if (!secureStorageAvailable()) {
    // 不落盘：明文写文件是不可接受的
    return { encrypted: false };
  }
  const buf = safeStorage.encryptString(key);
  await fs.writeFile(keyFilePath(), buf);
  return { encrypted: true };
}

/** 读取 Key；不存在或解密失败返回 undefined */
export async function loadApiKey(): Promise<string | undefined> {
  if (memoryKey) return memoryKey;
  if (!secureStorageAvailable()) return undefined;
  try {
    const buf = await fs.readFile(keyFilePath());
    memoryKey = safeStorage.decryptString(buf);
    return memoryKey;
  } catch {
    return undefined;
  }
}

export async function hasApiKey(): Promise<boolean> {
  return (await loadApiKey()) !== undefined;
}

/** 掩码后的 Key，供 UI 显示 */
export async function displayKey(): Promise<string> {
  const k = await loadApiKey();
  return k ? maskApiKey(k) : '';
}

export async function clearApiKey(): Promise<void> {
  memoryKey = undefined;
  try {
    await fs.unlink(keyFilePath());
  } catch {
    // 文件不存在 = 已清除，无需报错
  }
}

/**
 * 取 Key 供 fetch 使用。
 * ★ 这是一次性明文取出，仅在主进程内传给 fetch，永不跨越 contextBridge。
 */
export async function getApiKeyForFetch(): Promise<string | undefined> {
  return loadApiKey();
}
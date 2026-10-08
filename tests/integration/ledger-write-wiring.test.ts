/**
 * 账本写入侧的**装配层**哨兵（§4 第 13 条）。
 *
 * 为什么又是源码文本断言：`AppServices` 与主进程入口在测试里构造不出来
 * （`ELECTRON_RUN_AS_NODE` 下拿不到 electron 的 `app`），本仓既有先例
 * `apikey-wiring` / `ledger-statehash-wiring` / `portable-data-dir` / `volume-order-wiring`。
 *
 * ★ 这一层是第 13 条的正病：`ledger_*` 五张表、四个内存 Map、`detectConflicts()`
 *   全都是"逻辑齐了但没人喂"。`grep` 实测修复前：
 *     · 四个 mem* Map 全仓零 `.set()`；
 *     · `detectConflicts` / `makeRef`（tools/impl/ledger-query.ts）零调用方；
 *     · `handle('ledger:upsert', (p) => p.character)` 是回显桩，落库 0 条。
 *   repo 单测（ledger-repo.test.ts）证明"能写"，本文件证明"真有人写"。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('A. services 侧：内存 Map 必须彻底退场，读写都走 repo', () => {
  const services = read('src/main/services.ts');

  it('四个 mem* Map 与它们的 .set() 占位不许留在文件里', () => {
    for (const name of ['memCharacters', 'memNumbers', 'memTimeline', 'memForeshadows']) {
      expect(services, `${name} 还在——内存态一留，重启即丢就还在`).not.toContain(name);
    }
  });

  it('四类读取都走 ledgerRepo', () => {
    for (const m of ['characters', 'numbers', 'timeline', 'foreshadows'] as const) {
      expect(services, `services.${m}() 没走 repo`).toMatch(new RegExp(`ledgerRepo\\.${m}\\(`));
    }
  });

  it('有真实的写入方法 upsertLedger，且四类都能写', () => {
    expect(services).toMatch(/upsertLedger\(/);
    for (const m of ['Characters', 'Numbers', 'Timeline', 'Foreshadows'] as const) {
      expect(services, `upsertLedger 只写了一部分：缺 ${m}`).toMatch(
        new RegExp(`ledgerRepo\\.upsert${m}\\(`),
      );
    }
  });

  it('conflicts() 不再是硬编码空数组，必须真的调 detectConflicts', () => {
    expect(services, 'detectConflicts 此前全仓零调用方——冲突表恒空').toMatch(/detectConflicts\(/);
    const at = services.indexOf('conflicts(');
    expect(at).toBeGreaterThan(-1);
    expect(services.slice(at, at + 400), 'conflicts() 仍可能返回写死的 []').not.toMatch(/return \[\];/);
  });
});

describe('B. Agent 侧：必须有一个真的写工具，否则账本永远靠人肉', () => {
  const registry = read('src/main/tools/registry.ts');
  const impl = read('src/main/tools/impl/ledger-update.ts');

  it('注册表里有 update_ledger 工具', () => {
    expect(registry).toMatch(/name: 'update_ledger'/);
    expect(registry).toMatch(/updateLedger/);
  });

  it('它是写工具（writes: true），危险级不能谎报为只读', () => {
    const at = registry.indexOf("name: 'update_ledger'");
    expect(at).toBeGreaterThan(-1);
    const block = registry.slice(at, at + 1200);
    expect(block).toMatch(/writes: true/);
  });

  it('工具实现真的调 deps.upsertLedger，而不是又回显一遍', () => {
    expect(impl).toMatch(/deps\.upsertLedger\(/);
    expect(impl, '没打开项目必须如实报错，不能静默成功').toMatch(/尚未打开项目|未打开项目/);
  });

  it('出处由系统回填 offset，且引文原样保留（不许把短句换成一段上下文）', () => {
    expect(impl).toMatch(/indexOf\(r\.quote\)/);
    expect(impl, 'quote 被 snippet 覆盖就不是"逐字引文"了').toMatch(/quote: r\.quote/);
  });
});

describe('C. IPC/preload 四处同步：写通道不许还是回显桩', () => {
  const ipc = read('src/shared/types/ipc.ts');
  const register = read('src/main/ipc/register.ts');
  const preload = read('src/preload/api.ts');
  const bridge = read('src/preload/index.ts');

  it('ledger:upsert 的请求体是批量 entries，不再是单个 character', () => {
    expect(ipc).toMatch(/'ledger:upsert': \{ req: \{ entries: LedgerEntries \}/);
  });

  it('主进程 handle 真的落库', () => {
    const at = register.indexOf("handle('ledger:upsert'");
    expect(at).toBeGreaterThan(-1);
    const body = register.slice(at, at + 500);
    expect(body).toMatch(/upsertLedger\(/);
    expect(body, '回显桩留着就等于对外宣称"存过了"').not.toMatch(/=> p\.character/);
    expect(body, '未打开项目要抛结构化错误').toMatch(/!\w+\.project/);
  });

  it('preload 桥有对应方法且在白名单里', () => {
    expect(preload).toMatch(/upsert\(/);
    expect(preload).toMatch(/^\s+'ledger:upsert',\s*$/m);
    expect(bridge).toMatch(/'ledger:upsert'/);
  });
});

describe('D. 备份载荷：账本进 .mzproj 后必须还能读回来', () => {
  const services = read('src/main/services.ts');

  it('buildBackupPayload 里的 ledger 四路都取 repo 数据', () => {
    const at = services.indexOf('buildBackupPayload');
    expect(at).toBeGreaterThan(-1);
    const body = services.slice(at, at + 900);
    for (const m of ['characters', 'numbers', 'timeline', 'foreshadows'] as const) {
      expect(body, `备份里没有 ${m}`).toContain(`${m}(`);
    }
  });
});

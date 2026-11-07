/**
 * 章×人物状态矩阵 repo 层（P2-B T5）：v15 表 ledger_char_states + stateSet/stateList。
 *
 * ★ 矩阵是"每章×每人一条可回看的处境快照"——人物卡只有当下态，改一次覆盖一次；
 *   它不该塞进 payload（那不是快照），也不该另开平行伏笔账式的新通道族。
 *   UNIQUE(character_id, chapter_no) 是结构键：同人同章重写 = upsert 收敛，不增行。
 *
 * 真内存库（照 ledger-patch.test.ts 的 seed 模式：仓库无 tests/helpers）。
 * ★ better-sqlite3 默认开着 foreign_keys：projects 两行先建（'p1' 本方、'other' 对方），
 *   人物卡先登记——ledger_char_states 的 FK 指向 ledger_characters(id)。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { LedgerRepo } from '@main/db/repos/ledger-repo';
import { MzError } from '@shared/types/ipc';
import type { CharacterProfile } from '@shared/types/ledger';

const P = 'p1';
function mk() {
  const db = new Database(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO projects(id, name, root_dir, created_at, updated_at) VALUES(?,?,?,?,?)');
  ins.run(P, '测试书', '/tmp/p1', 1, 1);
  ins.run('other', '另一本书', '/tmp/other', 1, 1);
  return { db, repo: new LedgerRepo(db) };
}

const c = (id: string): CharacterProfile => ({
  id, name: '林晚', role: '女主', age: '26', note: '', refs: [], updatedAt: 1,
});

describe('v15 迁移', () => {
  it('user_version>=15 且 ledger_char_states 表存在', () => {
    const { db } = mk();
    // ★ P2-C T1：v16 落地后「最新版」不再是 15——本测试的意图是「v15 已应用」，
    //   故钉 >=15 而非 ===15，后续追加迁移不再误伤（口径同 topic-repo.test 的 >=16）。
    expect(currentVersion(db)).toBeGreaterThanOrEqual(15);
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_char_states'")
      .get();
    expect(t).toBeDefined();
  });
});

describe('LedgerRepo.stateSet / stateList', () => {
  it('登记后读回：字段逐一对上，snapshot 落库前 trim', () => {
    const { repo } = mk();
    repo.upsertCharacters(P, [c('ch1')]);
    const s = repo.stateSet(P, 'ch1', 3, '  重伤初愈，独自在客栈养伤。  ');
    expect(s).toEqual({
      id: s.id,
      characterId: 'ch1',
      projectId: P,
      chapterNo: 3,
      snapshot: '重伤初愈，独自在客栈养伤。',
    });
    expect(repo.stateList(P)).toEqual([s]);
  });

  it('★ 同 (characterId, chapterNo) 重写：单行、id 保持原行 id、snapshot 被覆盖', () => {
    const { db, repo } = mk();
    repo.upsertCharacters(P, [c('ch1')]);
    const first = repo.stateSet(P, 'ch1', 3, '受了伤');
    const second = repo.stateSet(P, 'ch1', 3, '伤好了');
    expect(second.id).toBe(first.id); // upsert 走 ON CONFLICT，旧行的主键不被换新
    expect(second.snapshot).toBe('伤好了');
    const n = db.prepare('SELECT COUNT(*) AS n FROM ledger_char_states').get() as { n: number };
    expect(n.n).toBe(1);
    expect(repo.stateList(P)[0].snapshot).toBe('伤好了');
  });

  it('snapshot 空白拒绝：空串/纯空白 → E_INVALID_ARGS，不写空快照', () => {
    const { db, repo } = mk();
    repo.upsertCharacters(P, [c('ch1')]);
    for (const bad of ['', '   ', '\n\t']) {
      expect(() => repo.stateSet(P, 'ch1', 1, bad), `snapshot=${JSON.stringify(bad)}`).toThrowError(MzError);
      try {
        repo.stateSet(P, 'ch1', 1, bad);
      } catch (e) {
        expect((e as MzError).code).toBe('E_INVALID_ARGS');
      }
    }
    expect(repo.stateList(P)).toHaveLength(0);
    void db;
  });

  it('章号必须是 ≥1 的整数：0 / -1 / 1.5 / NaN → E_INVALID_ARGS', () => {
    const { repo } = mk();
    repo.upsertCharacters(P, [c('ch1')]);
    for (const bad of [0, -1, 1.5, NaN]) {
      const e = (() => {
        try {
          repo.stateSet(P, 'ch1', bad, 'x');
          return null;
        } catch (err) {
          return err as MzError;
        }
      })();
      expect(e, `chapterNo=${bad} 应被拒`).toBeInstanceOf(MzError);
      expect(e!.code).toBe('E_INVALID_ARGS');
    }
  });

  it('跨项目 characterId 拒绝（assertIdNotTakenByOtherProject 同口径）：别书的人物不能给它记状态', () => {
    const { repo } = mk();
    repo.upsertCharacters('other', [c('ch9')]);
    expect(() => repo.stateSet(P, 'ch9', 1, '在别的书里')).toThrow(/不属于本项目/);
    expect(repo.stateList(P)).toHaveLength(0);
  });

  it('stateList 项目隔离 + 章号升序：只回本项目的快照', () => {
    const { repo } = mk();
    repo.upsertCharacters(P, [c('ch1')]);
    repo.upsertCharacters('other', [c('chO')]);
    repo.stateSet(P, 'ch1', 5, '第五章的状态');
    repo.stateSet(P, 'ch1', 2, '第二章的状态');
    repo.stateSet('other', 'chO', 1, '别人家的状态');
    const list = repo.stateList(P);
    expect(list.map((x) => x.chapterNo)).toEqual([2, 5]);
    expect(list.every((x) => x.projectId === P)).toBe(true);
    expect(repo.stateList('other')).toHaveLength(1);
  });

  it('★ remove("character") 连带删其全部章状态（T3 留的 ★ 在此闭合），同事务', () => {
    const { db, repo } = mk();
    repo.upsertCharacters(P, [c('ch1'), c('ch2')]);
    repo.stateSet(P, 'ch1', 1, 'ch1 第一章');
    repo.stateSet(P, 'ch1', 2, 'ch1 第二章');
    repo.stateSet(P, 'ch2', 1, 'ch2 第一章');
    expect(repo.remove(P, 'character', 'ch1')).toBe(true);
    const rest = repo.stateList(P);
    expect(rest.map((x) => x.characterId)).toEqual(['ch2']);
    const n = db.prepare('SELECT COUNT(*) AS n FROM ledger_char_states WHERE character_id = ?').get('ch1') as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it('remove("foreshadow") 不碰状态矩阵：删伏笔后快照一条不少', () => {
    const { repo } = mk();
    repo.upsertCharacters(P, [c('ch1')]);
    repo.upsertForeshadows(P, [
      { id: 'f1', plantedAt: { chapterId: 'c1', offset: 0, quote: 'q' }, plantedQuote: 'q', status: 'unresolved', resolvedAt: null },
    ]);
    repo.stateSet(P, 'ch1', 1, '第一章的状态');
    expect(repo.remove(P, 'foreshadow', 'f1')).toBe(true);
    expect(repo.stateList(P)).toHaveLength(1);
  });
});

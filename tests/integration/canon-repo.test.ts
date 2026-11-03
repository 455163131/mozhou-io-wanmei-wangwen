// tests/integration/canon-repo.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { CanonRepo } from '@main/db/repos/canon-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';

function setup() {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  return { db, canon: new CanonRepo(db), pid };
}

describe('CanonRepo', () => {
  it('add 去空行 trim 后入库，list 按创建序', () => {
    const { canon, pid } = setup();
    canon.add(pid, '  玉佩内时间流速 3000:3  ');
    canon.add(pid, '林渡出山时山海界仅过三日');
    const rows = canon.list(pid);
    expect(rows.map(r => r.text)).toEqual(['玉佩内时间流速 3000:3', '林渡出山时山海界仅过三日']);
  });
  it('空文本/纯空白拒绝且直报', () => {
    const { canon, pid } = setup();
    expect(() => canon.add(pid, '   \n  ')).toThrowError(/E_INVALID_ARGS|不能为空/);
  });
  it('remove 不存在返回 false，存在返回 true 且 list 不再含', () => {
    const { canon, pid } = setup();
    const e = canon.add(pid, '铁律一');
    expect(canon.remove(pid, 'cn-不存在')).toBe(false);
    expect(canon.remove(pid, e.id)).toBe(true);
    expect(canon.list(pid)).toHaveLength(0);
  });
});

/**
 * 灵感卡片 repo（P2-C T1）。
 *
 * 三类卡片（trend 扫榜 / idea 脑洞 / teardown 拆书摘要）同表异 payload——
 * payload 落库存 JSON TEXT，读出即已解析对象（kind 判别形状见
 * @shared/types/inspiration）。**全局子系统**：卡片在立项前就存在，不带
 * project_id。裸 SQL + 薄封装，与 draft-repo 同风格，不用 ORM。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import type { CardKind, CardPayload, InspirationCard, TrendPayload } from '@shared/types/inspiration';

interface CardRow {
  id: string;
  kind: string;
  title: string;
  payload: string;
  source_label: string;
  collected: number;
  created_at: number;
}

function toCard(r: CardRow): InspirationCard {
  return {
    id: r.id,
    kind: r.kind as CardKind,
    title: r.title,
    payload: JSON.parse(r.payload) as CardPayload,
    sourceLabel: r.source_label,
    collected: r.collected,
    createdAt: r.created_at,
  };
}

export class InspirationRepo {
  constructor(private readonly db: Database) {}

  /** 新卡片默认未收藏（collected=0）；id 由库侧生成，调用方不传主键 */
  insert(c: { kind: CardKind; title: string; payload: CardPayload; sourceLabel: string }): InspirationCard {
    const id = `ic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO inspiration_cards(id, kind, title, payload, source_label, collected, created_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(id, c.kind, c.title, JSON.stringify(c.payload), c.sourceLabel, 0, now);
    return {
      id,
      kind: c.kind,
      title: c.title,
      payload: c.payload,
      sourceLabel: c.sourceLabel,
      collected: 0,
      createdAt: now,
    };
  }

  /** 某类卡片列表；新卡在前（rowid 兜同毫秒写入的次序，口径同 flavor-baseline-repo） */
  listByKind(kind: CardKind): InspirationCard[] {
    const rows = this.db
      .prepare('SELECT * FROM inspiration_cards WHERE kind = ? ORDER BY created_at DESC, rowid DESC')
      .all(kind) as CardRow[];
    return rows.map(toCard);
  }

  /** 已收藏卡片（选题池取数口）；新卡在前 */
  listCollected(): InspirationCard[] {
    const rows = this.db
      .prepare('SELECT * FROM inspiration_cards WHERE collected = 1 ORDER BY created_at DESC, rowid DESC')
      .all() as CardRow[];
    return rows.map(toCard);
  }

  /** 翻转收藏态（收藏=进选题池的候选动作）；卡不存在抛 E_NOT_FOUND */
  setCollected(id: string, collected: boolean): InspirationCard {
    const cur = this.get(id);
    if (!cur) throw new MzError('E_NOT_FOUND', `灵感卡片不存在：${id}`);
    const v = collected ? 1 : 0;
    this.db.prepare('UPDATE inspiration_cards SET collected = ? WHERE id = ?').run(v, id);
    return { ...cur, collected: v };
  }

  /** 删卡；存在回 true，不存在回 false（幂等删除，不抛） */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM inspiration_cards WHERE id = ?').run(id).changes > 0;
  }

  get(id: string): InspirationCard | null {
    const r = this.db.prepare('SELECT * FROM inspiration_cards WHERE id = ?').get(id) as CardRow | undefined;
    return r ? toCard(r) : null;
  }

  /**
   * 按 sourceKey 找 trend 卡（P2-C T3/R9）。payload 是 JSON TEXT，不加列、
   * 不迁移、不用 json_extract——JS 扫 listByKind('trend') 即可（榜单卡量级小）。
   * 找不到回 null；旧卡无 sourceKey 不参与匹配。
   */
  findTrendBySourceKey(sourceKey: string): InspirationCard | null {
    for (const c of this.listByKind('trend')) {
      if ((c.payload as TrendPayload).sourceKey === sourceKey) return c;
    }
    return null;
  }

  /**
   * 幂等落 trend 卡（P2-C T3/R9）：payload.sourceKey 命中旧卡 → 原样返回
   * （热度刷新**不改写**旧卡——卡=首抓快照，UI 展示当次抓取的热度）；
   * 未命中 → insert kind='trend'。sourceKey 为空时不做去重（避免把无键旧卡挤掉）。
   */
  upsertTrend(c: { title: string; payload: TrendPayload; sourceLabel: string }): InspirationCard {
    const key = c.payload.sourceKey;
    if (key) {
      const existing = this.findTrendBySourceKey(key);
      if (existing) return existing;
    }
    return this.insert({ kind: 'trend', title: c.title, payload: c.payload, sourceLabel: c.sourceLabel });
  }

  /**
   * 历史脑洞摘要（direction+premise）——T4 抽脑洞的**反重复**取数口：
   * 已抽过的方向+前提拼进 prompt，让下一抽避开旧脑洞。新在前。
   */
  ideaHistory(): { direction: string; premise: string }[] {
    const rows = this.db
      .prepare("SELECT payload FROM inspiration_cards WHERE kind = 'idea' ORDER BY created_at DESC, rowid DESC")
      .all() as { payload: string }[];
    return rows.map((r) => {
      const p = JSON.parse(r.payload) as { direction?: string; premise?: string };
      return { direction: p.direction ?? '', premise: p.premise ?? '' };
    });
  }
}

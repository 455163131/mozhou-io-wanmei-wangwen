/**
 * 灵感线五通道的业务实现（P2-C T2）。
 *
 * register.ts 只做一行式委托（口径同 canon-ipc / overlay-ipc）：
 * zod 边界校验、卡片→选题的 premise 派生全在这里，可脱离 Electron 直测
 * （tests/unit/inspiration-ipc.test.ts 走真 :memory: 库）。
 *
 * ★ 全局子系统：五个通道都不要求已打开项目——灵感卡片在立项之前就存在。
 */
import { z } from 'zod';
import { MzError } from '@shared/types/ipc';
import type { CardKind, ChartFetchResult, InspirationCard, Platform, Topic } from '@shared/types/inspiration';
import type { IdeaPayload, TeardownPayload, TrendPayload } from '@shared/types/inspiration';
import type { InspirationRepo } from '../db/repos/inspiration-repo';
import type { TopicRepo } from '../db/repos/topic-repo';
import type { ChartDataSource } from './chart-source';
import { parseManualChart } from './chart-manual';

/** register.ts 从 AppServices 拼出的最小依赖面 */
export interface InspirationIpcDeps {
  inspiration: InspirationRepo;
  topics: TopicRepo;
  charts: ChartDataSource;
}

/* ── 边界 zod（IPC 入参在门口拦，坏值不透传到 repo/数据源）────────── */

const PlatformArgSchema = z.object({ platform: z.enum(['番茄', '晋江', '起点']) });
/** C批手动导入：text 上限与解析器 MAX_CHARS 同值（两侧各拦一道，坏值不透传） */
const ImportArgSchema = z.object({ platform: z.enum(['番茄', '晋江', '起点']), text: z.string().min(1).max(100_000) });
const ListArgSchema = z.object({ kind: z.enum(['trend', 'idea', 'teardown', 'collected']).optional() });
const CardIdArgSchema = z.object({ cardId: z.string().min(1) });

function invalid(channel: string, issue: z.ZodError): never {
  throw new MzError('E_INVALID_ARGS', `${channel} 入参非法：${issue.issues.map((i) => i.message).join('；')}`, {
    retryable: false,
  });
}

/* ── trending:fetch ────────────────────────────────────────────── */

/**
 * 抓榜：platform 过枚举后委托数据源；回落演示时 error 带真因（数据源自带）。
 * P2-C T3/R9：每条 entry 幂等落 kind='trend' 卡并回填 cardId——UI 收藏/套用
 * 直接拿 cardId 走 inspiration:collect / topic:create-from-card。
 * dedup key = `platform|url`（url 空 → `platform|title|author`），存 payload.sourceKey；
 * 命中旧卡原样返回（热度刷新不改写旧卡，卡=首抓快照）。落库复用本通道不开新口
 * （当时 CH 保持 24；C批的手动导入是另一条独立通道 trending:import，见下）。
 */
export async function fetchTrending(deps: InspirationIpcDeps, args: unknown): Promise<ChartFetchResult> {
  const parsed = PlatformArgSchema.safeParse(args);
  if (!parsed.success) invalid('trending:fetch', parsed.error);
  const platform = parsed.data.platform as Platform;
  const result = await deps.charts.fetch(platform);
  // ★ H3：整批走 upsertTrends（一个事务 + 新增/命中计数）。旧口径逐条 autocommit，
  //   中途抛错会留下半截榜单卡，而 UI 只报失败。
  const batch = deps.inspiration.upsertTrends(
    result.entries.map((entry) => {
      const sourceKey = `${platform}|${entry.url || `${entry.title}|${entry.author}`}`;
      return {
        title: entry.title,
        sourceLabel: platform,
        payload: {
          platform,
          author: entry.author,
          heat: entry.heat ?? undefined,
          rank: entry.rank,
          tags: entry.tags,
          url: entry.url || undefined,
          live: entry.live,
          sourceKey,
        },
      };
    }),
  );
  result.entries.forEach((entry, i) => {
    const card = batch.cards.at(i);
    // 事务返回与入参同序同长是 repo 的契约；破了就是 E_INTERNAL，不静默漏回填 cardId
    if (!card) throw new MzError('E_INTERNAL', '落库返回条数与榜单条目数不一致，无法回填 cardId');
    entry.cardId = card.id;
  });
  return { ...result, inserted: batch.inserted, deduped: batch.deduped };
}

/* ── trending:import（C批手动导入）──────────────────────────────── */

/**
 * 手动导入榜单：粘贴文本/CSV → parseManualChart 纯解析 → 幂等落 kind='trend' 卡。
 * ★ 诚实纪律（DRD §7）：source='manual'，payload live:false + manual:true——
 *   既不是实时抓取（没抓就是没抓），也不是演示集（数据是用户自己贴的真榜单）。
 * ★ dedup key = `manual|platform|title|author`——url **不入键**：手动输入的链接
 *   不可信（可能贴错/贴旧），同书换链接不该裂成两张卡；manual| 前缀与抓取卡隔离。
 * ★ 解析失败/超上限的真因原样上抛（原则#6），绝不静默回空或冒充演示兜底。
 */
export async function importTrending(deps: InspirationIpcDeps, args: unknown): Promise<ChartFetchResult> {
  const parsed = ImportArgSchema.safeParse(args);
  if (!parsed.success) invalid('trending:import', parsed.error);
  const { platform, text } = parsed.data;
  const entries = parseManualChart(platform as Platform, text);
  // ★ H3：整批一个事务（要么全落要么一张不留）+ 新增/命中计数如实上浮
  const batch = deps.inspiration.upsertTrends(
    entries.map((entry) => {
      const sourceKey = `manual|${platform}|${entry.title}|${entry.author}`;
      return {
        title: entry.title,
        sourceLabel: `${platform}·手动导入`,
        payload: {
          platform,
          author: entry.author,
          heat: entry.heat ?? undefined,
          rank: entry.rank,
          tags: entry.tags,
          url: entry.url || undefined,
          live: false,
          manual: true,
          sourceKey,
        },
      };
    }),
  );
  entries.forEach((entry, i) => {
    const card = batch.cards.at(i);
    // 同 fetchTrending：同序同长是契约，破了就 E_INTERNAL
    if (!card) throw new MzError('E_INTERNAL', '落库返回条数与导入条目数不一致，无法回填 cardId');
    entry.cardId = card.id;
  });
  return { entries, source: 'manual', inserted: batch.inserted, deduped: batch.deduped };
}

/* ── inspiration:list / collect / remove ───────────────────────── */

/** 卡片列表：kind=三类 → listByKind；kind='collected' → listCollected；缺省 → 三类合并（新在前） */
export function listCards(deps: InspirationIpcDeps, args: unknown): InspirationCard[] {
  const parsed = ListArgSchema.safeParse(args ?? {});
  if (!parsed.success) invalid('inspiration:list', parsed.error);
  const kind = parsed.data.kind;
  if (kind === 'collected') return deps.inspiration.listCollected();
  if (kind) return deps.inspiration.listByKind(kind as CardKind);
  const kinds: CardKind[] = ['trend', 'idea', 'teardown'];
  return kinds
    .flatMap((k) => deps.inspiration.listByKind(k))
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** 收藏进选题池（setCollected(id,true)）；卡不存在 → E_NOT_FOUND（repo 抛，原样出去） */
export function collectCard(deps: InspirationIpcDeps, args: unknown): InspirationCard {
  const parsed = CardIdArgSchema.safeParse(args);
  if (!parsed.success) invalid('inspiration:collect', parsed.error);
  return deps.inspiration.setCollected(parsed.data.cardId, true);
}

/** 删卡（幂等：不存在回 false 不抛） */
export function removeCard(deps: InspirationIpcDeps, args: unknown): boolean {
  const parsed = CardIdArgSchema.safeParse(args);
  if (!parsed.success) invalid('inspiration:remove', parsed.error);
  return deps.inspiration.remove(parsed.data.cardId);
}

/* ── topic:create-from-card ────────────────────────────────────── */

/**
 * 卡片 → 待立项选题（套用入口）。title/premise 按 kind 派生：
 * - trend：title=书名；premise=书名＋tags 拼一句（榜单观察口径；manual 带【手动导入】前缀，
 *   其余 live=false 带【演示数据】前缀）
 * - idea：premise=payload.premise（脑洞本来就是一句前提）
 * - teardown：premise=payload.summary（拆书摘要即前提种子）
 * 卡不存在 → E_NOT_FOUND，不落半程 topic。
 */
export function createTopicFromCard(deps: InspirationIpcDeps, args: unknown): Topic {
  const parsed = CardIdArgSchema.safeParse(args);
  if (!parsed.success) invalid('topic:create-from-card', parsed.error);
  const cardId = parsed.data.cardId;
  const card = deps.inspiration.get(cardId);
  if (!card) throw new MzError('E_NOT_FOUND', `灵感卡片不存在：${cardId}`);

  let premise: string;
  switch (card.kind) {
    case 'trend': {
      const p = card.payload as TrendPayload;
      const tags = p.tags && p.tags.length > 0 ? `（${p.tags.join('、')}）` : '';
      // ★ 终审修复波 A（诚实纪律 DRD §7）：live=false 的演示卡不许谎称「从X热榜套用」——
      //   与 idea 演示兜底的【演示】前缀同款口径，明示来源是演示集而非真实榜单。
      // ★ C批：manual 卡先判（live 也是 false，但数据是用户贴的真榜单，不是演示集）——
      //   【手动导入】前缀明示来源，绝不冒领【演示数据】，也不冒充「从X热榜套用」。
      premise =
        p.manual === true
          ? `【手动导入】榜单观察：《${card.title}》${tags}——从${p.platform}手动导入榜单套用的趋势选题`
          : p.live === false
            ? `【演示数据】榜单观察：《${card.title}》${tags}——从${p.platform}榜单演示集套用的趋势选题`
            : `榜单观察：《${card.title}》${tags}——从${p.platform}热榜套用的趋势选题`;
      break;
    }
    case 'idea':
      premise = (card.payload as IdeaPayload).premise;
      break;
    case 'teardown':
      premise = (card.payload as TeardownPayload).summary;
      break;
    default: {
      // 判别穷尽守卫：将来加 kind 忘改这里，编译期立红
      const never: never = card.kind;
      throw new MzError('E_INVALID_ARGS', `未知卡片种类：${String(never)}`);
    }
  }
  return deps.topics.insert({ title: card.title, premise, sourceCardId: cardId });
}

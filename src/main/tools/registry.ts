/**
 * 工具注册表（架构 T05）。
 *
 * ★ 设计原则：**显式注册，不用自动反射**。
 *   架构原话：「遍历 window.MZ 导出面自动生成工具描述」是 PRD 的 P0-3，
 *   但原型那套等于把整个内部实现裸奔给渲染层——本项目不让渲染层碰内部函数，
 *   故改为显式注册 + 显式标注 danger/写策略/参数 schema。
 */
import type { ToolHandler, ToolSpec } from '@shared/types/tool';
import { ToolDanger } from '@shared/types/tool';
import { deriveFixToolSpecs } from './derive-from-rules';
import { analyzeChapter, getHealthReport, locateIssues, listFixRules } from './impl/analyze';
import { applyFixTool, type FixDeps } from './impl/fix';
import { replacePhrase, type PhraseDeps } from './impl/phrase';
import { queryLedger, type LedgerDeps } from './impl/ledger-query';
import { scanProject, type ScanDeps } from './impl/scan';
import { distillReferenceWork, type DigestDeps } from './impl/digest';
import { undoToCheckpoint, rollbackSideEffect, type UndoDeps } from './impl/undo';
import type { ReadOnlyDeps } from './impl/analyze';

export interface ToolDeps extends ReadOnlyDeps, FixDeps, PhraseDeps, LedgerDeps, ScanDeps, DigestDeps, UndoDeps {
  /** 取章节标题（工具结果里要给用户看得懂的章名，而不是裸id） */
  chapterTitle: (id: string) => string;
}

interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** 构造只读工具的 spec（★1，全部 idempotent——只读工具重复调用安全） */
function readOnlySpec(
  name: string,
  displayName: string,
  description: string,
  params: ToolSpec['params'],
  costHintMs: number,
): ToolSpec {
  return {
    name,
    displayName,
    description,
    params,
    danger: ToolDanger.Precise,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs,
    idempotent: true,
    writes: false,
  };
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor(private readonly deps: ToolDeps) {
    this.registerBuiltins();
  }

  private reg(spec: ToolSpec, handler: ToolHandler): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`工具名重复：${spec.name}`);
    }
    this.tools.set(spec.name, { spec, handler });
  }

  /**
   * 公开注册入口，供内置工具之外的扩展使用（如专家团）。
   *
   * 为什么不直接放开 reg()：内置工具的注册是启动期硬编码的，
   * 扩展工具需要「按配置决定是否注册」（可开关），暴露 reg() 会让
   * 扩展绕过 registerBuiltins 的时序约定。
   */
  registerExternal(name: string, spec: ToolSpec, handler: ToolHandler): void {
    if (spec.name !== name) {
      throw new Error(`spec.name(${spec.name}) 与注册名(${name}) 不一致`);
    }
    this.reg(spec, handler);
  }

  private registerBuiltins(): void {
    const d = this.deps;

    // ── 只读工具（★1）──
    this.reg(
      readOnlySpec(
        'analyze_chapter',
        '章节体检',
        '对指定章节计算全部文体指标（句长、段落节奏、用字多样性、对白占比、AI 味标记密度），' +
          '并按用户自己的风格基线给出偏差判定与健康分。只读，不修改任何正文。',
        [
          {
            name: 'chapterIds',
            type: 'string[]',
            required: false,
            description: '要分析的章节 id 列表，如 ["37"]。不传 = 全项目。',
          },
        ],
        300,
      ),
      (args, ctx) => analyzeChapter(args as { chapterIds?: string[] }, ctx, d),
    );

    this.reg(
      readOnlySpec(
        'get_health_report',
        '全书体检报告',
        '生成全书体检汇总：各章健康分、命中最多的共性问题、平均分。' +
          '比 analyze_chapter 多了跨章视角，适合「全书有多少章有问题」这类问题。',
        [
          {
            name: 'chapterIds',
            type: 'string[]',
            required: false,
            description: '限定章节范围；不传 = 全项目。',
          },
        ],
        2000,
      ),
      (args, ctx) => getHealthReport(args as { chapterIds?: string[] }, ctx, d),
    );

    this.reg(
      readOnlySpec(
        'locate_issues',
        '定位问题位置',
        '在正文中定位某个指标/标记的具体位置，返回**逐字可寻的字符偏移**与短引文。' +
          '修改前应先定位，这样改写位置一定能在原文找到。',
        [
          {
            name: 'metric',
            type: 'string',
            required: true,
            description:
              '要定位的指标 key 或 marker。指标如 avgSent / sentCv / avgPara / sentsPerPara / ' +
              'ttr / bigramTtr / triRepeat / dialogRatio / openType；' +
              'marker 写作 marker:顿/停了一下 这样。',
          },
          {
            name: 'chapterIds',
            type: 'string[]',
            required: false,
            description: '限定章节；不传 = 全项目。',
          },
        ],
        800,
      ),
      (args, ctx) => locateIssues(args as { metric: string; chapterIds?: string[] }, ctx, d),
    );

    this.reg(
      readOnlySpec(
        'list_fix_rules',
        '读取规则表',
        '列出当前可用的修正规则（哪条规则负责哪些指标、能否自动执行），' +
          '以及不可自动执行的规则及其原因。' +
          '⚠️ 规则会演进——**调用本工具读取，不要凭记忆假设有哪些规则**。',
        [
          {
            name: 'layer',
            type: 'string',
            required: false,
            description: '按层筛选：结构层 / 表达层 / 素材层 / 叙事层 / 一致性层。不传 = 全部。',
          },
        ],
        100,
      ),
      (args, ctx) => listFixRules(args as { layer?: string }, ctx),
    );

    this.reg(
      readOnlySpec(
        'query_ledger',
        '查询情节记忆账本',
        '查询人物档案、数字锚点、时间线、伏笔与检测到的冲突。' +
          '冲突一律并列两处原文由作者裁决，系统不判断哪个对。',
        [
          {
            name: 'kind',
            type: 'string',
            required: false,
            description:
              '查询类别：characters（人物）/ numbers（数字）/ timeline（时间线）/ ' +
              'foreshadows（伏笔）/ conflicts（冲突）/ all（全部）。不传 = all。',
          },
          {
            name: 'subject',
            type: 'string',
            required: false,
            description: '限定人物名或主题，如 "林菲"。',
          },
        ],
        300,
      ),
      (args, ctx) => queryLedger(args as { kind?: string; subject?: string }, ctx, d),
    );

    this.reg(
      readOnlySpec(
        'scan_project',
        '全书批量质检',
        '按批扫描全书并汇总最差的章节与共性问题。批大小 20 章，只读。',
        [
          {
            name: 'threshold',
            type: 'number',
            required: false,
            description: '只报告健康分低于此值的章（如 70）。不传 = 报告全部。',
          },
        ],
        30000,
      ),
      (args, ctx) => scanProject(args as { threshold?: number }, ctx, d),
    );

    this.reg(
      readOnlySpec(
        'distill_reference_work',
        '拆书蒸馏',
        '对一部参考作品做确定性统计蒸馏，产出节奏/结构/钩子/人物的可执行参数卡。' +
          '★ 统计部分是可信的（纯计算），模型归纳不可信。' +
          '合规守卫：参数卡与原文的最长公共子串不得超过 20 字，防照抄。',
        [
          { name: 'title', type: 'string', required: true, description: '参考作品标题。' },
          { name: 'text', type: 'string', required: true, description: '参考作品正文（可分段）。' },
          {
            name: 'mode',
            type: 'string',
            required: false,
            description: 'rough = 只跑统计蒸馏（快）；deep = 统计 + 结构拆解（慢）。',
            enum: ['rough', 'deep'],
          },
        ],
        5000,
      ),
      (args, ctx) => distillReferenceWork(args as { title: string; text: string; mode?: string }, ctx, d),
    );

    // ── 修正工具（★2/★3，从 FIX_RULES 派生）──
    for (const spec of deriveFixToolSpecs()) {
      this.reg(spec, (args, ctx) =>
        applyFixTool(
          spec.name,
          args as { chapterIds: string[]; metrics?: string[]; markers?: string[]; families?: string[] },
          ctx,
          d,
          { reversible: spec.reversible },
        ),
      );
    }

    // ── replace_phrase（★1 Precise）──
    this.reg(
      {
        name: 'replace_phrase',
        displayName: '精确短语替换',
        description:
          '把一处短语做等义替换。这是改动最小、最精确的操作（回滚后逐字节一致）。' +
          '⚠️ 引号内的人物语言默认不动——除非用户明确要求改台词。',
        params: [
          { name: 'chapterId', type: 'string', required: true, description: '章节 id。' },
          {
            name: 'find',
            type: 'string',
            required: true,
            description:
              '要替换的原文短语，必须与原文**逐字一致**（含标点）。' +
              '建议先用 locate_issues 拿到原文再填。',
          },
          { name: 'replace', type: 'string', required: true, description: '替换后的文本。' },
          {
            name: 'includeQuotes',
            type: 'boolean',
            required: false,
            description:
              '是否连引号内（人物台词）一起替换。默认 false。' +
              '仅在用户明确要求修改台词时才传 true。',
            default: false,
          },
        ],
        danger: ToolDanger.Precise,
        reversible: true,
        maxAffectedBytes: 8 * 1024,
        crossChapter: false,
        costHintMs: 200,
        idempotent: false,
        writes: true,
      },
      (args, ctx) =>
        replacePhrase(
          args as { chapterId: string; find: string; replace: string; includeQuotes?: boolean },
          ctx,
          d,
        ),
    );

    // ── 撤销 / 回滚（★2）──
    this.reg(
      {
        name: 'undo_to_checkpoint',
        displayName: '回滚到指定步',
        description:
          '把项目回滚到某个 checkpoint 之前的状态。checkpoint 与轨迹面板的步骤一一对应，' +
          '所以「回到第 7 步之前」= 回滚到第 7 步的 checkpoint。' +
          '⚠️ 回滚前会自动检测你在此期间是否手动改过同一章，若有会先要求你确认。',
        params: [
          {
            name: 'checkpointId',
            type: 'string',
            required: true,
            description: '目标 checkpoint id（从轨迹面板或改动历史里拿）。',
          },
        ],
        danger: ToolDanger.Spillover,
        reversible: true,
        maxAffectedBytes: 8 * 1024,
        crossChapter: true,
        costHintMs: 500,
        idempotent: false,
        writes: true,
      },
      (args, ctx) => undoToCheckpoint(args as { checkpointId: string }, ctx, d),
    );

    this.reg(
      {
        name: 'rollback_side_effect',
        displayName: '回滚单条规则的副作用',
        description:
          '只撤销某条规则在某章造成的改动，保留其它规则的成果。' +
          '系统在复检发现副作用时会自动调用；你也可以手动调用。',
        params: [
          { name: 'checkpointId', type: 'string', required: true, description: '所属 checkpoint id。' },
          { name: 'chapterId', type: 'string', required: true, description: '要回滚的章节 id。' },
          { name: 'ruleId', type: 'string', required: true, description: '要撤销的规则 id（如 F4）。' },
        ],
        danger: ToolDanger.Spillover,
        reversible: true,
        maxAffectedBytes: 8 * 1024,
        crossChapter: false,
        costHintMs: 300,
        idempotent: false,
        writes: true,
      },
      (args, ctx) =>
        rollbackSideEffect(
          args as { checkpointId: string; chapterId: string; ruleId: string },
          ctx,
          d,
        ),
    );
  }

  /** 列出全部工具 spec（给 UI 与 LLM） */
  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  /** 只列出写工具 */
  listWriting(): ToolSpec[] {
    return this.list().filter((s) => s.writes);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  handlerOf(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  specOf(name: string): ToolSpec | undefined {
    return this.tools.get(name)?.spec;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
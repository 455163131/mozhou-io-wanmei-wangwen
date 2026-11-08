/**
 * 提示词覆盖层（P2-A Task 1）：解析 / 序列化 / 文件读写。
 *
 * ★ 机制与措辞的边界（AGPL 红线）：本模块的"覆盖层 + 删文件即恢复默认"
 *   机制参照了行业内旧工具 WritingStudio 公开的提示词覆盖层做法；
 *   文件格式、说明头文本与全部解释性措辞均为原创，未复制任何外部文本。
 *
 * ★ 设计要点（对齐计划的全局约束）：
 *   · 覆盖层只覆盖 concept / architect / writer 三角色（其余角色待质检闭环接入，
 *     类型层面直接不给他们开口的机会）；
 *   · 落点是数据目录下 `<dataDir>/prompt-overlays/<role>.md`——是文件不是表，
 *     不进 SQLite、不加迁移；dataDir 由调用方注入（本模块不 import electron，
 *     与 data-dir.ts 同口径的"纯函数可测"纪律，测试直接喂 tmp 目录）。
 *   · 损坏即回退 + 直报真因：段名缺失/温度非法 → overlay 照常返回但 warnings
 *     记录；整份无法解析（空文件/乱码）→ overlay=null，warnings 说清为什么。
 *     调用方（IPC/UI）拿 warnings 显示，不许静默吞。
 *   · 写手 system 的"逐字节稳定"纪律在此的投影：同书 + 同覆盖层内容 →
 *     serialize 产物逐字节恒定（无时间戳、无随机量），prompt cache 不误失效。
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/* ── 类型与落点 ────────────────────────────────────────────────── */

/** 覆盖层开放的角色（concept/architect/writer 三合成器 + idea 脑洞发生器 + teardown 拆书精读师，R42：不开假入口）。
 *  ★ P2-C T4：加 idea（抽脑洞）；★ P2-C T5：加 teardown（拆书报告）。与 ipc.ts OverlayRole 成员逐字同步。 */
export type PromptOverlayRole = 'concept' | 'architect' | 'writer' | 'idea' | 'teardown';

/**
 * 一份覆盖层的解析结果。
 * temperature=null 表示"沿用程序内置温度"（留空与缺失最终都归到这个语义）。
 */
export type PromptOverlay = {
  role: PromptOverlayRole;
  temperature: number | null;
  additional: string;
};

/** 数据目录下的覆盖层子目录名（ASCII，规避中文路径在同步盘/备份工具里的老雷区）。 */
const OVERLAY_DIRNAME = 'prompt-overlays';

/** 覆盖层文件的绝对路径：`<dataDir>/prompt-overlays/<role>.md`。纯拼路，不碰磁盘。 */
export function overlayPath(dataDir: string, role: PromptOverlayRole): string {
  return join(dataDir, OVERLAY_DIRNAME, `${role}.md`);
}

/* ── 解析 ──────────────────────────────────────────────────────── */

/** 温度行锚点：行首「温度」+ 全角/半角冒号，冒号后到行尾是值（可为空）。 */
const TEMP_LINE = /^[ \t]*温度[ \t]*[:：][ \t]*(.*)$/m;

/** 「## 附加要求」段锚点：允许标题行尾有多余文字（手改文件常见），段体到文件末尾。 */
const SECTION_LINE = /^##[ \t]*附加要求[^\n]*/m;

/** 剥掉全部 HTML 注释块（说明头在里面，防止注释里提到的段名骗过锚点匹配）。 */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/**
 * 解析覆盖层正文。永不抛错——一切异常形态都折算成 warnings（约束：回退默认 + 直报真因）。
 *
 * @param role 由调用方声明的角色（文件内容不自带角色，避免自证）
 * @param raw  文件原始文本
 */
export function parseOverlay(
  role: PromptOverlayRole,
  raw: string,
): { overlay: PromptOverlay | null; warnings: string[] } {
  const warnings: string[] = [];
  const content = stripComments(raw.replace(/\r\n/g, '\n'));

  if (!content.trim()) {
    return {
      overlay: null,
      warnings: [raw.trim() ? '覆盖层除说明头外没有正文，无法解析，按内置默认处理' : '覆盖层文件为空，无法解析，按内置默认处理'],
    };
  }

  const tempMatch = TEMP_LINE.exec(content);
  const sectionMatch = SECTION_LINE.exec(content);
  if (!tempMatch && !sectionMatch) {
    return {
      overlay: null,
      warnings: ['覆盖层无法解析：既无「温度：」行也无「## 附加要求」段（疑似乱码或别的文件），按内置默认处理'],
    };
  }

  // 温度：缺失/非法 → null + warning；存在但留空 → null 且**无** warning（留空=沿用内置，是合法态）。
  let temperature: number | null = null;
  if (!tempMatch) {
    warnings.push('覆盖层缺少「温度：」行，沿用内置温度');
  } else {
    const value = tempMatch[1].trim();
    if (value !== '') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        warnings.push(`覆盖层「温度：${value}」不是 0~2 的数字，沿用内置温度`);
      } else {
        temperature = n;
      }
    }
  }

  // 「附加要求」段：缺失不致命——overlay 照常返回，但必须留一条 warning（规格原话：缺段，按默认模板处理）。
  let additional = '';
  if (!sectionMatch) {
    warnings.push('覆盖层缺段（「## 附加要求」），按默认模板处理');
  } else {
    additional = content.slice(sectionMatch.index + sectionMatch[0].length).trim();
  }

  return { overlay: { role, temperature, additional }, warnings };
}

/* ── 序列化 ────────────────────────────────────────────────────── */

/**
 * 生成**完整模板文件**：说明头 + 温度行 + 「## 附加要求」段。
 * serialize → parse 语义等值（往返律，测试钉死），因此：
 *   · temperature=null 输出留空的温度行（而非省略），保持"合法空"而非"缺失告警"；
 *   · additional 落盘前 trim，与 parse 侧的 trim 对齐。
 * 输出无时间戳/随机量——同一覆盖层逐字节恒定（prompt cache 纪律的投影）。
 */
export function serializeOverlay(o: PromptOverlay): string {
  const header = [
    '<!--',
    `  墨书提示词覆盖层 · ${o.role}`,
    '  ──────────────────────────────────────────',
    '  1. 本文件是"覆盖层"，不是完整提示词：内置基线提示词住在程序里，',
    '     下面「附加要求」段的文字只会被**追加**在基线之后——补充，不替换。',
    '  2. 两处段名是机器锚点，请勿改名：「温度：」行与「## 附加要求」标题一旦',
    '     被改动，程序将认不出内容并回退内置默认（状态栏会给出告警）。',
    '  3. 「温度：」留空 = 沿用程序内置温度；填 0~2 之间的数字则覆盖内置。',
    '  4. 想恢复默认提示词：直接删除本文件即可，不必清空内容。',
    '-->',
  ].join('\n');
  const tempLine = `温度：${o.temperature === null ? '' : o.temperature}`;
  return `${header}\n\n${tempLine}\n\n## 附加要求\n${o.additional.trim()}\n`;
}

/* ── 文件读写（dataDir 注入，不 import electron） ──────────────── */

/**
 * 读取角色覆盖层。文件不存在 = 默认态（exists:false，零 warning，不是错误）；
 * 内容损坏 = exists:true + overlay:null + warnings 直报；
 * 读盘失败（非 ENOENT）不静默——warnings 带上报错真因。
 */
export async function loadOverlay(
  dataDir: string,
  role: PromptOverlayRole,
): Promise<{ overlay: PromptOverlay | null; warnings: string[]; exists: boolean }> {
  const file = overlayPath(dataDir, role);
  try {
    const raw = await readFile(file, 'utf8');
    const { overlay, warnings } = parseOverlay(role, raw);
    return { overlay, warnings, exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { overlay: null, warnings: [], exists: false };
    return { overlay: null, warnings: [`读取覆盖层失败（${code ?? '未知错误'}）：${(err as Error).message}`], exists: true };
  }
}

/**
 * 写入角色覆盖层（目录不存在时自动创建）。失败直接抛——错误消息带 fs 真因，
 * 由调用方（IPC 层）决定怎么报，本层不吞。
 */
export async function saveOverlay(
  dataDir: string,
  role: PromptOverlayRole,
  input: { temperature: number | null; additional: string },
): Promise<void> {
  const file = overlayPath(dataDir, role);
  const text = serializeOverlay({ role, temperature: input.temperature, additional: input.additional });
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  } catch (err) {
    throw new Error(`写入覆盖层失败（${(err as NodeJS.ErrnoException).code ?? '未知错误'}）：${(err as Error).message}`);
  }
}

/**
 * 删除角色覆盖层 —— 这就是"恢复默认"的正统路径（机制参照旧工具：删文件即恢复）。
 * @returns 删除前文件是否存在；其余错误照抛真因。
 */
export async function removeOverlay(dataDir: string, role: PromptOverlayRole): Promise<boolean> {
  try {
    await unlink(overlayPath(dataDir, role));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw new Error(`删除覆盖层失败（${code ?? '未知错误'}）：${(err as Error).message}`);
  }
}

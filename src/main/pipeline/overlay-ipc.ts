/**
 * P2-A T3：提示词覆盖层与工艺技能表五通道的 handler 实现
 * （overlay:get / overlay:save / overlay:remove / skills:list / skills:match）。
 *
 * ★ 分工与 canon-ipc.ts / pipeline/ipc.ts 同款：register.ts 只做通道登记（一行式
 *   委托），业务语义全在这里。dataDir 由调用方注入——本文件不 import electron，
 *   测试直接喂 mkdtemp 的 tmp 目录（与 overlay.ts 的"纯函数可测"纪律一致）。
 *   生产装配在 register.ts：`app.getPath('userData')`，与 services.ts 注入
 *   PipelineDeps.getOverlay 的路径**同一来源**，读写与生成链看到的永远是同一份文件。
 *
 * ★ 错误口径：边界校验一律 E_INVALID_ARGS + detail {retryable:false}（T1 评审
 *   minor-1 起的全仓口径——非法参数重试一万次还是非法，渲染层据此不画重试按钮）。
 *
 * ★ 角色白名单（R42 不开假入口）：
 *   · 覆盖层只开 concept/architect/writer（其余角色等质检闭环接入后在 T1 类型层扩）；
 *   · skills:match 只开 writer/architect——polisher 在 craft-skills 里零技能，
 *     concept 没有触发词匹配场景，传进来就是调用点缺陷，必须响。
 */
import { MzError } from '@shared/types/ipc';
import {
  loadOverlay,
  removeOverlay,
  saveOverlay,
  serializeOverlay,
  type PromptOverlay,
  type PromptOverlayRole,
} from './overlay';
import { CRAFT_SKILLS, matchSkills, type CraftRole, type CraftSkill } from './craft-skills';

/* ── 小工具 ────────────────────────────────────────────────────── */

/** 边界校验错误：E_INVALID_ARGS 一律带 retryable:false（minor-1 口径） */
function invalid(message: string): MzError {
  return new MzError('E_INVALID_ARGS', message, { retryable: false });
}

const OVERLAY_ROLES: readonly string[] = ['concept', 'architect', 'writer'];
const SKILL_MATCH_ROLES: readonly string[] = ['writer', 'architect'];

/**
 * 覆盖层角色运行时守卫。类型上 req.role 已是枚举，但渲染层递过来的字符串
 * 不经编译期（IPC 是序列化边界），非法值必须在这里拦下而不是落进文件路径。
 */
function assertOverlayRole(role: PromptOverlayRole): void {
  if (typeof role !== 'string' || !OVERLAY_ROLES.includes(role)) {
    throw invalid(`覆盖层只开放 concept / architect / writer 三角色，收到 ${String(role)}`);
  }
}

/* ── 覆盖层三通道 ──────────────────────────────────────────────── */

/**
 * 读覆盖层：loadOverlay 永不抛错（文件缺失/损坏都回默认 + warnings），
 * 这里只补角色边界守卫，并把默认模板一并带回（UI「恢复默认」预览用，
 * 省去渲染层再走一次序列化口径——序列化格式只住 overlay.ts 一处）。
 */
export async function overlayGet(
  dataDir: string,
  p: { role: PromptOverlayRole },
): Promise<{ exists: boolean; overlay: PromptOverlay | null; warnings: string[]; template: string }> {
  assertOverlayRole(p.role);
  const { overlay, warnings, exists } = await loadOverlay(dataDir, p.role);
  const template = serializeOverlay({ role: p.role, temperature: null, additional: '' });
  return { exists, overlay, warnings, template };
}

/**
 * 保存覆盖层。温度口径：null = 沿用内置（合法态，serialize 落空值行）；
 * 数值必须有限且 0~2（与 parseOverlay 的读取侧校验对称——写读两侧同一把尺，
 * 不会出现"存得进去、读出来告警"的分裂态）。
 */
export async function overlaySave(
  dataDir: string,
  p: { role: PromptOverlayRole; temperature: number | null; additional: string },
): Promise<{ ok: true }> {
  assertOverlayRole(p.role);
  const ok =
    p.temperature === null ||
    (typeof p.temperature === 'number' &&
      Number.isFinite(p.temperature) &&
      p.temperature >= 0 &&
      p.temperature <= 2);
  if (!ok) {
    throw invalid(`temperature 只能是 null 或 0~2 的数字，收到 ${String(p.temperature)}`);
  }
  if (typeof p.additional !== 'string') {
    throw invalid('additional 必须是字符串');
  }
  // saveOverlay 的失败带 fs 真因直接上抛（不吞）：由 IPC 错误序列化回渲染层
  await saveOverlay(dataDir, p.role, { temperature: p.temperature, additional: p.additional });
  return { ok: true };
}

/** 删除覆盖层文件 = 恢复默认的正统路径。幂等：文件本来不在也正常返回 existed:false。 */
export async function overlayRemove(
  dataDir: string,
  p: { role: PromptOverlayRole },
): Promise<{ existed: boolean }> {
  assertOverlayRole(p.role);
  return { existed: await removeOverlay(dataDir, p.role) };
}

/* ── 技能表两通道（纯函数直暴露）──────────────────────────────── */

/** craft-skills 全量，注册序即返回序（浏览六卡的数据源）。 */
export function skillsList(): CraftSkill[] {
  return CRAFT_SKILLS;
}

/**
 * 命中预览：与装配器（assemble.ts）同一个 matchSkills 判定内核，UI 预览与
 * 真生成命中不会两套口径。返回 ids/titles 两条等长数组，顺序保持注册序。
 */
export function skillsMatch(p: { text: string; role: CraftRole }): { ids: string[]; titles: string[] } {
  if (typeof p.text !== 'string') throw invalid('text 必须是字符串');
  if (!SKILL_MATCH_ROLES.includes(p.role)) {
    throw invalid(`skills:match 只支持 writer / architect 角色，收到 ${String(p.role)}`);
  }
  const hits = matchSkills(p.text, p.role);
  return { ids: hits.map((s) => s.id), titles: hits.map((s) => s.title) };
}

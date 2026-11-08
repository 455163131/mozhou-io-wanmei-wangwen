/**
 * 发布线双口径计数（P2-D T4）。
 *
 * ★ R26 口径对齐声明（src/main/pipeline/tools.ts:356 的裁决原文）：
 *   「不足阈值按 language 分口径——zh 数字符（现状）、en 数词数
 *   （content.trim().split(/\s+/).length）；海外平台 chapterWords 语义即
 *   单章目标词数，用字符数会把英文稿误判为达标。」
 *   本函数与 tools.ts 只做语义对齐、不做 import（shared 不依赖 main，方向铁律）。
 * ★ 两处口径若漂移：tests/unit/publish-schedule.test.ts 的中文/英文用例值即裁决所。
 *   已知刻意差：zh 此处为「去空白字符数」（发布口径不数排版空白；tools.ts 数
 *   s.length 含空白）；en 此处为 \S+ 连串数（空串计 0，
 *   避开 trim().split(/\s+/) 对空串得 [''] 计 1 的伪命中）。
 */

/** 文本体量 → 平台目标同口径的计数。zh=去空白字符数（'字'），en=非空白连串数（'words'）。 */
export function countUnits(text: string, lang: 'zh' | 'en'): { size: number; unit: '字' | 'words' } {
  if (lang === 'en') {
    return { size: (text.match(/\S+/g) ?? []).length, unit: 'words' };
  }
  return { size: text.replace(/\s/g, '').length, unit: '字' };
}

/**
 * 发布线确定性清洗（P2-D T4）。
 *
 * ★ 契约声明 ★
 * 1. **预览=服务端同函数**：发布预览与暂存落库前清洗必须调用本模块同一
 *    cleanForPublish——预览所见即所发，不允许"预览一套、正文另一套"。
 * 2. **确定性 + 幂等**：五规则按固定顺序执行（zero-width → horiz-rule →
 *    md-emphasis → whitespace →〔仅 overseas〕html-tags），同输入永远同输出，
 *    且 clean(clean(x)) 与 clean(x) 逐字节相同、二次跑 edits 为空。
 *    顺序不变式：后序规则不引入前序可修形状——两处**例外已就地闭合**：
 *    ① md-emphasis 剥完强调可能**裸露整行规则/围栏**（反包形 '**---**'、
 *    '__---__'、'**```**'、'正文\n**---**\n正文' 及空行并串变体；注意正包形
 *    '---**x**---' 剥后剩 '---x---' 非规则行，经实测本就安全）——md 道有编辑
 *    时补跑 horiz 再补跑 whitespace（行删除会并串空行）；
 *    ② html-tags 剥标签可能裸露行尾空白并把换行并串（'a␣␣<br>␣␣'、
 *    'a\n\n<br>\n\n\n\nb'）——html 道同理立即复归一空白。
 *    两处补跑都只调用已有规则道（零新规则名、主链顺序概念不变），
 *    T4 评审修复波经实测钉死（tests/unit/publish-clean.test.ts 幂等矩阵）。
 * 3. **不处理全半角**：全半角/标点风格属平台注记人工项，不做自动改写（YAGNI）。
 *
 * edits 审计口径：每条 edit 记 { rule, at, before, after }，at 为该规则
 * 输入文本内的起始索引（各 pass 独立坐标系，按 pass 顺序可回放）。
 */
import type { CleanEdit, CleanResult } from '@shared/types/publish';

/** 规则名逐字钉（红线测试与 UI 展示都按这些字面量比对） */
type RuleName = 'zero-width' | 'horiz-rule' | 'md-emphasis' | 'whitespace' | 'html-tags';

// 零宽 + C0/C1 控制字符：\n(000A) 与 \t(0009) 刻意保留——正文换行缩进是合法排版。
// 本规则的本职就是命中控制码位段（清洗器不是解析器），no-control-regex 在此为误报。
// eslint-disable-next-line no-control-regex
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// 水平线（- * _ 三连以上独占整行）与代码围栏行（``` / ```lang 整行）。
// 连同行尾换行一并删除，避免留下多余空行。
const HORIZ_RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,}|`{3,}[^\n]*)[ \t]*(?:\n|$)/gm;
// markdown 强调：只剥**成对**的 **x** / __x__（内容非空、紧贴闭合符）；不成对不动。
const MD_EMPHASIS_RE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
// 行尾空白（含整行只剩空白的行）：匹配整行以便 before 携原文可审。
const LINE_TRAILING_RE = /^[^\n]*?[ \t]+(?=\n|$)/gm;
// ★ 连续空行 >2 压到 2（字节裁决：钉用例 'b'+5×'\n'+'c' → 'b'+3×'\n'+'c'，
//   即 ≥4 个连续换行压到恰 3 个——'\n{3,}'→'\n\n\n' 会对结果 3 换行仍命中、
//   二次跑产 edit，破幂等；'\n{4,}'→'\n\n\n' 结果 3 换行不再命中）。
const BLANK_RUN_RE = /\n{4,}/g;
// HTML 标签残留（仅 overseas 市场）：标签整体剥除，不递归嵌套尖括号的畸形不用管。
const HTML_TAG_RE = /<[^>]*>/g;

/** 单遍替换并记账：每次命中产一条 edit（before=命中片段原文，after=替换后）。 */
function runPass(
  text: string,
  rule: RuleName,
  re: RegExp,
  edits: CleanEdit[],
  toAfter: (args: unknown[]) => string,
): string {
  return text.replace(re, (...args: unknown[]) => {
    const before = args[0] as string;
    const at = args[args.length - 2] as number;
    const after = toAfter(args);
    edits.push({ rule, at, before, after });
    return after;
  });
}

function passZeroWidth(text: string, edits: CleanEdit[]): string {
  return runPass(text, 'zero-width', ZERO_WIDTH_RE, edits, () => '');
}

function passHorizRule(text: string, edits: CleanEdit[]): string {
  return runPass(text, 'horiz-rule', HORIZ_RULE_RE, edits, () => '');
}

function passMdEmphasis(text: string, edits: CleanEdit[]): string {
  // args: [整段, 标记, 内容, offset, 全文] —— after 即成对符之间的内容本体
  const stripped = runPass(text, 'md-emphasis', MD_EMPHASIS_RE, edits, (args) => args[2] as string);
  if (stripped === text) return stripped;
  // 剥强调可能裸露整行规则/围栏（反包形 '**---**'——horiz 道已越过不回头，
  // 二次跑会在这里产 edit 改输出，破幂等契约）；行删除又可能并串空行，
  // 故补跑 horiz 再补跑 whitespace。只调已有规则道，零新规则名（T4 评审 Important-1）。
  return passWhitespace(passHorizRule(stripped, edits), edits);
}

function passWhitespace(text: string, edits: CleanEdit[]): string {
  const stripped = runPass(text, 'whitespace', LINE_TRAILING_RE, edits, (args) =>
    (args[0] as string).replace(/[ \t]+$/, ''),
  );
  // 先剥行尾再压空行：整行空白的行被剥成空行后才计入空行串，口径与钉用例一致。
  return runPass(stripped, 'whitespace', BLANK_RUN_RE, edits, () => '\n\n\n');
}

function passHtmlTags(text: string, edits: CleanEdit[]): string {
  const stripped = runPass(text, 'html-tags', HTML_TAG_RE, edits, () => '');
  if (stripped === text) return stripped;
  // 剥标签可能裸露行尾空白并把换行串并（见文件头契约 2），立即复归一空白。
  return passWhitespace(stripped, edits);
}

/**
 * 发布前确定性清洗。market 缺省 'cn'（cn 不动 HTML 标签——国内平台正文可含标签
 * 残留由人工取舍；overseas 剥之）。
 */
export function cleanForPublish(text: string, market: 'cn' | 'overseas' = 'cn'): CleanResult {
  const edits: CleanEdit[] = [];
  let out = passZeroWidth(text, edits);
  out = passHorizRule(out, edits);
  out = passMdEmphasis(out, edits);
  out = passWhitespace(out, edits);
  if (market === 'overseas') out = passHtmlTags(out, edits);
  return { cleaned: out, edits };
}

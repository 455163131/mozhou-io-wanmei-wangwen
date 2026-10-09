/**
 * 主题的 DOM / storage 落点。
 *
 * ★ 为什么单独一个文件，而不是并进 `theme.ts`：
 *   `theme.ts` 被 `store/index.ts` 引用，而 store 归 **tsconfig.node.json** 管——
 *   那个工程 `lib` 里没有 DOM（它的 include 注释写着"只纳入 DOM-free 的渲染层逻辑：
 *   store 是纯状态机"）。一旦 `theme.ts` 里出现 `document` / `localStorage`，
 *   typecheck 立刻在两个工程里各报一次。所以：**纯逻辑留在 theme.ts（可测），
 *   碰浏览器的那两手放这里（不可测，但只有两处，且由测试钉住调用点）。**
 */
import { applyTheme, writeTheme, type Theme } from './theme';

/** 换肤的两件事一起做：当场落到根元素 + 写回存储。少做第二件就是重启回到默认。 */
export function commitTheme(theme: Theme): void {
  applyTheme(document.documentElement, theme);
  writeTheme(localStorage, theme);
}

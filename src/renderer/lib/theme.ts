/**
 * 主题（皮肤）的纯逻辑。
 *
 * ★ 为什么单独成一个模块而不是直接写在 main.tsx / store 里：
 *   vitest 是 `environment: 'node'`（无 jsdom），凡碰 `document` / `localStorage` 的代码
 *   一行都测不了。而"存进去的键和读出来的键是不是同一个""坏值会不会把界面搞白屏"
 *   这两件事恰恰是**只能靠测试保证**的——它们出错时不会抛异常，只会静默不生效。
 *   所以这里只收 storage 的一个窄接口，DOM 那一层留给 main.tsx 去接。
 *   （同一个理由见 `src/main/util/data-dir.ts`、`src/main/db/repos/run-repo.ts`。）
 */

export type Theme = 'ink' | 'paper';

/** 存进 localStorage 的键。改这个值等于让所有老用户的皮肤选择失效，动它要写迁移。 */
export const THEME_STORAGE_KEY = 'mz.theme';

/**
 * 默认深寂。
 * ★ 这是老板 2026-10-10 定的一颗决策（"默认皮肤就定深寂"），不是技术默认值：
 *   目标用户是夜里日更数千字的网文作者，暗壳压眩光；素笺·朱批保留为可切皮肤。
 */
export const DEFAULT_THEME: Theme = 'ink';

export interface ThemeReader {
  getItem(key: string): string | null;
}

export interface ThemeStorage extends ThemeReader {
  setItem(key: string, value: string): void;
}

/** 只认 'ink' / 'paper'（大小写与首尾空格宽容），其余一律回落默认。 */
export function normalizeTheme(raw: unknown): Theme {
  if (typeof raw !== 'string') return DEFAULT_THEME;
  const v = raw.trim().toLowerCase();
  return v === 'ink' || v === 'paper' ? v : DEFAULT_THEME;
}

/**
 * 读用户上次的选择。
 * storage 在隐私模式/配额异常下会**抛**，这里必须吞掉——主题读不出来不该让应用起不来。
 */
export function readTheme(storage: ThemeReader | null | undefined): Theme {
  if (!storage) return DEFAULT_THEME;
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** 写回选择。同样吞异常：禁用 localStorage 时切换应当"当场生效、重启后回到默认"。 */
export function writeTheme(storage: ThemeStorage | null | undefined, theme: Theme): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    void 0;
  }
}

/** 结构型而非 HTMLElement，为的是能在 node 里被测到。 */
export interface ThemeTarget {
  dataset: Record<string, string | undefined>;
}

/** 把皮肤落到根元素上——`[data-theme="ink"]` 那批令牌全靠这一个属性生效。 */
export function applyTheme(target: ThemeTarget | null | undefined, theme: Theme): void {
  if (!target) return;
  target.dataset.theme = theme;
}

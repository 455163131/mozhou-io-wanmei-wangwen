/**
 * ★ 品牌名只有一个来源 —— §4 第 6 条（老板已定夺：统一为「木萱网文写作台」）。
 *
 * 修复前同一个产品对外有三个名字：
 *   · `electron-builder.yml:2` productName = 墨舟写作台  → 安装包/exe 名
 *   · `window.ts:25` / `index.html:7` / `menu.ts:17` = 墨舟写作台 → 窗口与菜单
 *   · `App.tsx:158` 侧栏 mark 的 title = **文枢** → 界面品牌
 *   · `menu.ts:15` 应用菜单的 label = `app.name` = **mozhou-agent** → 菜单第一项显示内部 id
 *
 * 这不是审美问题：用户按窗口标题去任务管理器/卸载列表找应用，找到的是另一个名字；
 * 菜单第一项显示 `mozhou-agent` 直接把内部标识泄露给了非技术用户。
 *
 * 本文件钉两件事：
 *   A. 所有面向用户的品牌字符串都取自同一个常量（改一处即全改）；
 *   B. **userData 目录名故意不跟着改**——它由 package.json 的 `name`
 *      （`mozhou-agent`）决定，实测就在 `%APPDATA%\mozhou-agent`，
 *      跟着品牌改名会让老用户一打开就找不到书稿。这条也钉住，不许"顺手统一"。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_BRAND_NAME } from '@shared/constants/brand';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('A. 面向用户的品牌字符串必须同源', () => {
  it('常量值必须是老板定的那个名字', () => {
    expect(APP_BRAND_NAME).toBe('木萱网文写作台');
  });

  it('窗口标题、菜单、页面 title 都不许再各写一份', () => {
    expect(read('src/main/window.ts')).toMatch(/title: APP_BRAND_NAME/);
    expect(read('src/main/menu.ts')).toMatch(/label: APP_BRAND_NAME/);
    expect(read('src/main/menu.ts')).toMatch(/关于\$\{APP_BRAND_NAME\}/);
    expect(read('src/main/menu.ts')).not.toMatch(/label: app\.name/);
    expect(read('src/renderer/index.html')).toMatch(
      new RegExp(`<title>${APP_BRAND_NAME}</title>`),
    );
  });

  it('渲染层侧栏 mark 的提示语用同一个常量', () => {
    expect(read('src/renderer/App.tsx')).toMatch(/title=\{APP_BRAND_NAME\}/);
  });

  it('打包配置与常量一致（否则 exe 名和界面名又是两套）', () => {
    const yml = read('electron-builder.yml');
    expect(yml).toMatch(new RegExp(`^productName: ${APP_BRAND_NAME}$`, 'm'));
  });

  it('src 下不许再残留旧品牌名「文枢」', () => {
    const offenders = [
      'src/renderer/App.tsx',
      'src/main/window.ts',
      'src/main/menu.ts',
      'src/renderer/index.html',
    ].filter((f) => read(f).includes('文枢'));
    expect(offenders, `仍写着旧品牌名：${offenders.join(', ')}`).toEqual([]);
  });
});

describe('B. 数据目录名故意与品牌名不同，不许被"统一"掉', () => {
  it('package.json 的 name 保持 mozhou-agent', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string };
    expect(pkg.name).toBe('mozhou-agent');
  });

  it('brand.ts 必须把这条理由写在注释里', () => {
    // 没有注释的下一次「顺手改名」就是用户数据失踪，所以把注释本身钉成断言
    expect(read('src/shared/constants/brand.ts')).toMatch(/userData/);
    expect(read('src/shared/constants/brand.ts')).toContain('mozhou-agent');
  });
});

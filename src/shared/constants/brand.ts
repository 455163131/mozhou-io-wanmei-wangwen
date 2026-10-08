/**
 * 品牌名（§4 第 6 条，老板 2026-10-09 定夺：统一为「木萱网文写作台」）。
 *
 * 修复前同一个产品对外有三套名字：打包 productName / 窗口标题写「墨舟写作台」，
 * 侧栏 mark 的提示语写「文枢」，应用菜单第一项直接显示 `app.name`
 * （即内部标识 `mozhou-agent`）。这里收成一处：所有面向用户的品牌字符串
 * 都取本常量，改一次全改。
 *
 * ★ 故意**不**跟着改的两处，别当"漏改"顺手统一：
 *   1. `package.json` 的 `name` 仍是 `mozhou-agent`。Electron 的 userData 目录
 *      由它决定，实测就在 `%APPDATA%\mozhou-agent`；改品牌名时一起改它，
 *      老用户一打开应用就找不到书稿（见 docs/PROJECT-STATUS.md §4 第 14 条）。
 *   2. `electron-builder.yml` 的 `appId` 仍是 `com.mozhou.writer`。NSIS 按它识别
 *      "同一个应用"，改了会被当成新装一份，老安装卸载不掉。
 *   3. Agent 的自我身份仍叫「墨舟写作 Agent」（`src/main/agent/prompt.ts:27`）。
 *      「墨舟」是作者的笔名/人设，不是产品品牌；备份提示、AI 味说明里的「墨舟」
 *      同理。品牌改名不覆盖笔名。
 */
export const APP_BRAND_NAME = '木萱网文写作台';

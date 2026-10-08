/**
 * 数据目录解析（§4 第 8 条）。
 *
 * electron-builder 的 `portable` 目标（electron-builder.yml:21）在启动器里注入
 * `PORTABLE_EXECUTABLE_DIR`，指向**exe 自己所在的目录**。识别它并把 userData
 * 指到 exe 旁边，便携版的数据才会跟着 U 盘走；不识别就只能永远写 %APPDATA%。
 *
 * 这里是纯函数（只吃 env，不 import electron），因此可以直接喂真 env 断言真返回值。
 * 装配点只有一个：`index.ts` 在读第一个 userData 之前 `app.setPath`。
 */
import { join } from 'node:path';

/**
 * exe 旁边的数据子目录名。
 * 刻意用 ASCII 短名：db / 备份 / 凭据都在这层目录下，而 better-sqlite3 是原生模块，
 * 中文目录名要穿过它的宽字符转换，在老系统和某些同步盘上是已知雷区。
 */
export const PORTABLE_DATA_DIRNAME = 'mozhou-data';

/**
 * @param env 默认 process.env；测试可注入
 * @returns 便携数据目录的绝对路径；**没注入或注入为空 → null**（保持 Electron 默认目录）
 */
export function portableDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  // trim 是必要的：空串/纯空白会让 join 拼出**相对 cwd** 的路径，
  // 数据就落到「双击 exe 时的工作目录」——那是最容易被清掉的地方
  const exeDir = env['PORTABLE_EXECUTABLE_DIR']?.trim();
  if (!exeDir) return null;
  // join 会归一化尾分隔符，`D:\Apps\` 不会变成 `D:\Apps\\mozhou-data`
  return join(exeDir, PORTABLE_DATA_DIRNAME);
}

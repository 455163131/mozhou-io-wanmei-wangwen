/**
 * 引擎 bundle 装配的共享模块（T05 抽取，compute 与 verify 两个脚本共用）。
 *
 * ★ 为什么抽出来：`scripts/compute-flavor-baseline.mjs` 与
 *   `scripts/verify-flavor-acceptance.mjs` 都需要「把 engine.ts 打包成 bundle 再 import」，
 *   这套逻辑（缺失/过期检测 + esbuild JS API 重建 + 失败明确报错）此前内联在 compute 里，
 *   若各复制一份必然漂移——而**口径漂移正是本项目最忌讳的事**。
 *
 * ★ 三态语义（与 compute 脚本一致，逐字沿用）：
 *   缺失 → 重建；过期（任一源码依赖比 bundle 新）→ 重建；存在且新鲜 → 原样返回（幂等）。
 *   任一步失败都打印**逐字可执行**的手动命令并 exit(1)——宁可报错停下，
 *   也不允许用缺失/过期的 bundle 算出错误数据。
 *
 * ★ 为何用 esbuild 的 JS API 而非 shell：本机沙箱禁 spawn 子进程
 *   （`spawnSync('node',…)` → EBUSY），但 `esbuild.buildSync` 实测可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const ENGINE_SRC = path.join(ROOT, 'src', 'shared', 'ai-flavor', 'engine.ts');
export const ENGINE_BUNDLE = path.join(__dirname, '.engine-bundle.mjs');

/** bundle 的源码依赖：任一比 bundle 新 → 视为过期，必须重建 */
export const ENGINE_BUNDLE_DEPS = [
  ENGINE_SRC,
  path.join(ROOT, 'src', 'shared', 'ai-flavor', 'baseline.ts'),
  path.join(ROOT, 'src', 'shared', 'types', 'ai-flavor.ts'),
];

/** 手动重建命令（出错时原样打印，逐字可执行） */
export const ESBUILD_CLI =
  'node_modules/.bin/esbuild src/shared/ai-flavor/engine.ts --bundle --format=esm ' +
  '--platform=node --alias:@shared=./src/shared --outfile=scripts/.engine-bundle.mjs';

/**
 * 行尾归一化（CRLF→LF）后的 md5 —— **引擎 pin 的唯一口径**。
 *
 * ★ 为什么要归一化：`.gitattributes` 是 `* text=auto eol=lf`，本机 `core.autocrlf=true`，
 *   所以 engine.ts 在工作区是 CRLF、在版本库里是 LF。实测两个字节 md5：
 *   工作区 `88d5a88e…`、`git cat-file -p HEAD:` `22437e38…`，差的正好是每行一个 `\r`
 *   （53693 vs 52445 字节 = 行数 1248）。直接钉原始字节等于钉死"换台机器就报引擎漂移"，
 *   而引擎一个字符都没动 —— pin 该钉代码，不该钉编辑器行为。
 */
export function md5Normalized(text) {
  return crypto.createHash('md5').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** engine.ts 的归一化 md5：compute 落 pin、verify 查漂移，两边都只走这一个函数 */
export function engineSourceMd5() {
  return md5Normalized(fs.readFileSync(ENGINE_SRC, 'utf8'));
}

/** 一组文件里最新的 mtime（毫秒）；缺失文件按 0 计（存在性另有检查） */
function newestMtimeMs(paths) {
  let newest = 0;
  for (const p of paths) {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* 缺失文件，另有存在性检查 */
    }
  }
  return newest;
}

/**
 * 确保 .engine-bundle.mjs 存在且不过期；缺失/过期则用 esbuild JS API 在本进程内重建。
 * 幂等：存在且不比任何源码旧时**原样返回**，不做任何重编译。
 */
export function ensureEngineBundle() {
  const exists = fs.existsSync(ENGINE_BUNDLE);
  const bundleMtime = exists ? fs.statSync(ENGINE_BUNDLE).mtimeMs : 0;
  const depsMtime = newestMtimeMs(ENGINE_BUNDLE_DEPS);
  const missing = !exists;
  const stale = exists && depsMtime > bundleMtime;

  if (!missing && !stale) return; // 存在且新鲜 → 直接用

  const why = missing ? '缺失' : '已过期（源码比 bundle 新）';
  console.log(`[bundle] .engine-bundle.mjs ${why} → 用 esbuild 重建中 ...`);
  try {
    // createRequire 在本 ESM 里同步拿到 esbuild 的 CJS 入口；buildSync 不启 shell。
    const esbuild = createRequire(import.meta.url)('esbuild');
    esbuild.buildSync({
      entryPoints: [ENGINE_SRC],
      bundle: true,
      format: 'esm',
      platform: 'node',
      // 绝对路径别名：不受调用时 cwd 影响（与 CLI 的 --alias:@shared=./src/shared 等价）
      alias: { '@shared': path.join(ROOT, 'src', 'shared') },
      outfile: ENGINE_BUNDLE,
      logLevel: 'warning',
    });
  } catch (e) {
    console.error('');
    console.error('✖ 重建 .engine-bundle.mjs 失败：' + (e && e.message ? e.message : String(e)));
    console.error('  相关脚本需先把 engine.ts 打包成 bundle 才能运行（这是与引擎「同口径」的前提）。');
    console.error('  请手动执行一次（逐字可执行）：');
    console.error('    ' + ESBUILD_CLI);
    console.error('  若 node_modules 未安装依赖，请先执行 npm install。');
    process.exit(1);
  }
  if (!fs.existsSync(ENGINE_BUNDLE)) {
    console.error('✖ esbuild 未产出 ' + ENGINE_BUNDLE + '（静默失败）。请手动执行：');
    console.error('    ' + ESBUILD_CLI);
    process.exit(1);
  }
  console.log('[bundle] 重建完成：' + path.relative(ROOT, ENGINE_BUNDLE).replace(/\\/g, '/'));
}

/**
 * 确保bundle 新鲜后动态 import 之，返回其命名导出。
 *
 * ★ 必须用动态 import：静态 import 会在「bundle 尚不存在」时直接 module-not-found，
 *   根本没有机会先重建。
 */
export async function loadEngineBundle() {
  ensureEngineBundle();
  return import(pathToFileURL(ENGINE_BUNDLE).href);
}

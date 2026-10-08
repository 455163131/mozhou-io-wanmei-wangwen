/**
 * ★ 安全边界测试：外链协议白名单、LLM 端点校验、写策略闸门 fail-closed、CSP。
 *
 * 为什么单独开一个文件：
 *
 *   这几处都是「出错时应该拒绝、而不是放行」的安全闸门，而修复前它们**全部 fail-open**：
 *
 *     · `window.ts` 注册了第二个 `will-navigate`，放行任意 `file://`，其余 URL
 *       **不经协议校验**直送 `shell.openExternal`。Windows 上 `search-ms:`、
 *       `ms-msdt:` 这类自定义协议可拉起可执行程序 —— 渲染层一旦被 XSS 攻破，
 *       这条路直接通到本机执行。而它注册在 security.ts 之后，两个都会触发，
 *       于是严格的那个形同虚设。
 *     · `client.ts` 的 baseUrl 来自 IPC 且零校验，允许 `http://` ——
 *       `Authorization: Bearer <key>` 明文过网，且响应可被中间人改写。
 *     · `write-policy.ts` 的 `default` 分支对未知策略返回 `execute`（放行）。
 *     · 跨章确认只判 `danger >= CrossScope`，而全部修正工具是 `Spillover(★2)` +
 *       `crossChapter:true` → 闸门**从未触发过**。
 *     · 生产构建**完全没有 CSP**：`onHeadersReceived` 对 `file://` 不触发，
 *       而生产正是 `loadFile()`；index.html 里也没有 meta。
 *
 *   把 URL/端点判定抽成 shared 的纯函数，正是为了让这些边界**可被单元测试覆盖**。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAllowedExternalUrl,
  isAllowedInternalNavigation,
  isAllowedLlmBaseUrl,
} from '@shared/util/external-url';
import { PROD_CSP, DEV_CSP, CSP_DIRECTIVES } from '@shared/constants/csp';
import { decideWrite } from '@main/tools/write-policy';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { ToolDanger, type ToolSpec, type WritePolicyConfig } from '@shared/types/tool';

describe('★ 外链协议白名单（shell.openExternal 的唯一判据）', () => {
  it('http / https / mailto 放行', () => {
    expect(isAllowedExternalUrl('https://example.com/a?b=1')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(true);
  });

  it('★ Windows 可执行协议一律拒绝（修复前无校验直送 openExternal）', () => {
    for (const url of [
      'search-ms:query=恶意&crumb=location:C:\\',
      'ms-msdt:/id123',
      'ms-officecmd:{...}',
      'mshta:http://evil/x.hta',
      'wscript://evil',
    ]) {
      expect(isAllowedExternalUrl(url), `${url} 不该被放行`).toBe(false);
    }
  });

  it('★ file: 不作为外链放行（本地文件不该由外链触发）', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('javascript: / data: / vbscript: 拒绝', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedExternalUrl('vbscript:msgbox')).toBe(false);
  });

  it('★ 前缀伪造无法绕过（这正是不能用 startsWith 的原因）', () => {
    // 用 `url.startsWith('https://')` 判断时，这条会漏判：协议根本不是 https
    expect(isAllowedExternalUrl('httpsx://evil.com')).toBe(false);
    // ★ WHATWG URL 对「特殊协议」会归一化斜杠：`https:/evil.com` 与
    //   `https:/\evil.com` 都解析成合法的 https://evil.com 并被放行。
    //   这**不是**漏洞——放行意味着交给系统浏览器打开一个 https 链接，
    //   不构成提权。钉在这里是为了说明判据是「解析后的 protocol」，
    //   而不是字符串长相；真正被挡住的是协议本身不对的那些。
    expect(isAllowedExternalUrl('https:/evil.com')).toBe(true);
    expect(isAllowedExternalUrl('https:/\\evil.com')).toBe(true);
    // 协议名大小写不敏感是规范行为
    expect(isAllowedExternalUrl('HTTPS://evil.com/x')).toBe(true);
    // 而这些「看着像 https」但协议不同的，startsWith 会全部误放行：
    expect(isAllowedExternalUrl('https-evil://x')).toBe(false);
    expect(isAllowedExternalUrl('x-https://evil.com')).toBe(false);
  });

  it('畸形 / 相对 URL / 空串一律拒绝', () => {
    for (const url of ['', 'not a url', '/relative/path', '//host/path', 'https://']) {
      expect(isAllowedExternalUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it('控制字符按 WHATWG 规范被剥离，结果仍是 https 链接（不是绕过）', () => {
    // URL 解析会移除首尾 C0 控制字符与字符串中的 tab/换行。
    // 剥离后得到的仍是合法 https URL —— 交给系统浏览器打开一个 https 链接
    // 不构成提权，故放行是正确行为。把它钉在这里是为了记录这个语义，
    // 避免以后有人误以为「含控制字符 = 攻击」而写成拒绝。
    expect(isAllowedExternalUrl('https://ok.com\n@evil.com')).toBe(true);
    expect(isAllowedExternalUrl('\u0000https://evil.com')).toBe(true);
    // 但控制字符**不能**把非白名单协议洗成白名单协议
    expect(isAllowedExternalUrl('\u0000search-ms:query=x')).toBe(false);
    expect(isAllowedExternalUrl('java\u0000script:alert(1)')).toBe(false);
  });
});

describe('★ 应用内导航白名单', () => {
  const prod = { devServerOrigin: null };
  const dev = { devServerOrigin: 'http://localhost:5173' };

  it('生产：只允许自身页面，其余一律拒绝', () => {
    const self = 'file:///app/out/renderer/';
    expect(isAllowedInternalNavigation(`${self}index.html`, prod, self)).toBe(true);
    expect(isAllowedInternalNavigation('https://evil.com', prod, self)).toBe(false);
    // ★ 任意本地文件不得由导航触达（修复前 window.ts 放行任意 file://）
    expect(isAllowedInternalNavigation('file:///C:/Windows/win.ini', prod, self)).toBe(false);
  });

  it('开发：放行 vite dev server，但仍拒绝外部站点', () => {
    expect(isAllowedInternalNavigation('http://localhost:5173/src/main.tsx', dev, null)).toBe(true);
    expect(isAllowedInternalNavigation('http://localhost:9999/x', dev, null)).toBe(false);
    expect(isAllowedInternalNavigation('https://evil.com', dev, null)).toBe(false);
  });

  it('畸形 URL 拒绝而非抛异常', () => {
    expect(isAllowedInternalNavigation('', prod, null)).toBe(false);
    expect(isAllowedInternalNavigation('nonsense', prod, null)).toBe(false);
  });
});

describe('★ LLM baseUrl 校验（API Key 的外泄防线）', () => {
  it('https 放行', () => {
    expect(isAllowedLlmBaseUrl('https://api.deepseek.com/v1').ok).toBe(true);
    expect(isAllowedLlmBaseUrl('https://openrouter.ai/api/v1').ok).toBe(true);
  });

  it('★ 本地回环的 http 放行（Ollama / LM Studio 的正当用法）', () => {
    expect(isAllowedLlmBaseUrl('http://127.0.0.1:11434/v1').ok).toBe(true);
    expect(isAllowedLlmBaseUrl('http://localhost:1234/v1').ok).toBe(true);
    expect(isAllowedLlmBaseUrl('http://[::1]:11434/v1').ok).toBe(true);
  });

  it('★ 非回环的 http 拒绝，并说明为什么（Key 会明文过网）', () => {
    const r = isAllowedLlmBaseUrl('http://192.168.1.50:11434/v1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('明文');
    expect(isAllowedLlmBaseUrl('http://api.deepseek.com/v1').ok).toBe(false);
    // localhost 伪装：主机名不是回环就不放行
    expect(isAllowedLlmBaseUrl('http://localhost.evil.com/v1').ok).toBe(false);
  });

  it('非 URL / 其它协议拒绝', () => {
    expect(isAllowedLlmBaseUrl('').ok).toBe(false);
    expect(isAllowedLlmBaseUrl('api.deepseek.com/v1').ok).toBe(false); // 缺协议
    expect(isAllowedLlmBaseUrl('file:///tmp/sock').ok).toBe(false);
  });
});

describe('★ CSP：生产必须严格，开发只放开 script 的内联', () => {
  it('生产 CSP 的 script-src 不含 unsafe-inline', () => {
    expect(CSP_DIRECTIVES.scriptSrc).not.toContain('unsafe-inline');
    expect(PROD_CSP).toContain("script-src 'self'");
    expect(PROD_CSP).not.toContain("'unsafe-inline' script");
    // script-src 那一段绝不能带 unsafe-inline
    const scriptPart = PROD_CSP.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(scriptPart).not.toContain('unsafe-inline');
  });

  it('开发 CSP 仅比生产多一个 script 的 unsafe-inline，其余指令一致', () => {
    expect(DEV_CSP).toContain("script-src 'self' 'unsafe-inline'");
    for (const key of ['defaultSrc', 'imgSrc', 'connectSrc', 'objectSrc', 'frameSrc'] as const) {
      expect(DEV_CSP).toContain(CSP_DIRECTIVES[key]);
      expect(PROD_CSP).toContain(CSP_DIRECTIVES[key]);
    }
  });

  it('收紧项到位：object/frame/base-uri/form-action 全 none，connect-src 只 self', () => {
    expect(PROD_CSP).toContain("object-src 'none'");
    expect(PROD_CSP).toContain("frame-src 'none'");
    expect(PROD_CSP).toContain("base-uri 'none'");
    expect(PROD_CSP).toContain("form-action 'none'");
    expect(PROD_CSP).toContain("connect-src 'self'");
  });

  it('★ 构建脚本确实往生产 index.html 注入了 CSP meta', () => {
    // file:// 下 onHeadersReceived 不触发，meta 是生产唯一的 CSP 载体。
    // 这条哨兵盯着「插件还在不在」，防止有人清理配置时把它删掉而无人察觉。
    const cfg = readFileSync(join(__dirname, '../../electron.vite.config.ts'), 'utf8');
    expect(cfg).toContain('cspMetaPlugin');
    expect(cfg).toContain('Content-Security-Policy');
    expect(cfg).toContain('PROD_CSP');
  });

  it('★ window.ts 不再自行注册导航处理器（单一收口在 security.ts）', () => {
    const win = readFileSync(join(__dirname, '../../src/main/window.ts'), 'utf8');
    // 只断言**代码**，不断言注释：解释「修复前错在哪」的注释里提到这些词是正当的。
    const code = win
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toContain("webContents.on('will-navigate'");
    expect(code).not.toContain('shell.openExternal');
    // shell 这个 import 也该一并去掉，否则留着就是给后人再犯一次的把手
    expect(code).not.toMatch(/import\s*\{[^}]*\bshell\b[^}]*\}\s*from\s*'electron'/);
  });

  it('★ security.ts 用的是协议白名单函数，而非字符串前缀判断', () => {
    const sec = readFileSync(join(__dirname, '../../src/main/security.ts'), 'utf8');
    expect(sec).toContain('isAllowedExternalUrl');
    expect(sec).toContain('isAllowedInternalNavigation');
    const code = sec
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    // 不许再出现 startsWith('https://') 这类字符串前缀判据
    expect(code).not.toContain("startsWith('https://')");
    expect(code).not.toContain("startsWith('http://')");
    // 每一处 openExternal 都必须有白名单守卫：调用次数不得多于守卫次数
    const calls = (code.match(/shell\.openExternal\(/g) ?? []).length;
    const guards = (code.match(/isAllowedExternalUrl\(/g) ?? []).length;
    expect(guards).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(guards);
  });
});

describe('★ 写策略闸门：fail-closed', () => {
  /** 造一个工具规格；默认是「修正工具」的真实形态：★2 + 跨章 */
  function spec(patch: Partial<ToolSpec> = {}): ToolSpec {
    return {
      name: 'fix_structure',
      displayName: '结构层修正',
      description: '测试用',
      params: [],
      danger: ToolDanger.Spillover,
      reversible: true,
      maxAffectedBytes: 10_000,
      crossChapter: true,
      costHintMs: 100,
      idempotent: false,
      writes: true,
      ...patch,
    } as ToolSpec;
  }

  it('★ 未知策略 → need-approval（修复前是 execute，安全闸门方向反了）', () => {
    const cfg = { ...DEFAULT_WRITE_POLICY, policy: 'totally-made-up' } as unknown as WritePolicyConfig;
    const d = decideWrite(spec({ crossChapter: false, danger: ToolDanger.Precise }), cfg);
    expect(d.action).toBe('need-approval');
    expect(d.action === 'need-approval' && d.reason).toContain('无法识别');
  });

  it('★ 跨章工具在 auto-with-undo 下必须确认（修复前闸门从未触发）', () => {
    const d = decideWrite(spec(), DEFAULT_WRITE_POLICY);
    expect(d.action).toBe('need-approval');
    expect(d.action === 'need-approval' && d.reason).toContain('跨章');
  });

  it('单章 + ★1 精确工具在 auto-with-undo 下仍自动执行（不要过度收紧）', () => {
    const d = decideWrite(
      spec({ crossChapter: false, danger: ToolDanger.Precise }),
      DEFAULT_WRITE_POLICY,
    );
    expect(d.action).toBe('execute');
  });

  it('只读工具永远直接执行', () => {
    const d = decideWrite(spec({ writes: false }), DEFAULT_WRITE_POLICY);
    expect(d.action).toBe('execute');
  });

  it('★ hardStop 优先于一切策略，preview-only 也拦不住它要求确认', () => {
    const cfg: WritePolicyConfig = { ...DEFAULT_WRITE_POLICY, policy: 'preview-only' };
    const d = decideWrite(spec({ danger: ToolDanger.Destructive }), cfg);
    expect(d.action).toBe('need-approval');
  });

  it('preview-only 对普通写工具只出 diff，不落盘', () => {
    const cfg: WritePolicyConfig = { ...DEFAULT_WRITE_POLICY, policy: 'preview-only' };
    expect(decideWrite(spec({ crossChapter: false, danger: ToolDanger.Precise }), cfg).action).toBe(
      'preview-only',
    );
  });

  it('ask-per-tool：达到阈值要确认，低于阈值放行', () => {
    const cfg: WritePolicyConfig = {
      ...DEFAULT_WRITE_POLICY,
      policy: 'ask-per-tool',
      autoApproveThreshold: ToolDanger.CrossScope,
    };
    expect(decideWrite(spec({ danger: ToolDanger.CrossScope }), cfg).action).toBe('need-approval');
    expect(decideWrite(spec({ danger: ToolDanger.Precise }), cfg).action).toBe('execute');
  });
});

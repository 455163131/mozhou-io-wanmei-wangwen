/**
 * 应用内确认框（架构 T21 RollbackConfirmDialog 的通用化）。
 *
 * ★ 为什么必须有它：修复前两处回滚入口问的是 `window.confirm`
 *   （`AgentPanel.tsx:384`、`HistoryTimeline.tsx:41`）。
 *   浏览器模态在这个应用里有两个具体的坏处，都不是观感问题：
 *   ① **它不告诉你撤回到哪一步、会丢多少**。用户按下「回滚上一步（丢弃改动）」
 *      之后，灰条上只有一句冲突说明——而这是本项目里唯一一处"不可撤销的
 *      覆盖别人的劳动"的动作，最该被设计的一句话恰恰是最没有设计的一句话。
 *   ② **它是 Chromium 自绘的，不是 `#32770`**。第 29 条已经栽过一次：
 *      自动化驱动点不动它，于是"界面上到底长什么样"只能靠读代码猜。
 *      换成应用内遮罩后，这一步才有真机验证的可能。
 *
 * ★ 设计口径（有意收窄，不做一个通用表单）：
 *   - **Promise 化**：`confirmDialog(...)` 返回 `Promise<boolean>`，
 *     遮罩内点确认 resolve true，取消 / Esc / 点遮罩 resolve false。
 *     调用方写法与 `window.confirm` 几乎一样，替换是纯机械的。
 *   - **不接管焦点陷阱**（没有 focus-trap）：这不是通用弹窗库。只保证
 *     打开时焦点落在取消键上、Esc 能走——敲坏的风险比多写一层陷阱小。
 *   - **危险动作必须是 danger 档**：`danger: true` 时确认键走 warn 族配色，
 *     且**默认焦点在「取消」**，不把 destructive 动作做成回车即中。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  /** 标题：一句话说清要做什么（不是"确认？"两个字的客套） */
  title: string;
  /** 正文：说清**后果**——撤回到哪、会丢什么 */
  body: string;
  /** 额外的警告行（例如「你在此期间对其它章节做了 3 处手动修改」） */
  warn?: string | null;
  confirmText?: string;
  cancelText?: string;
  /** 危险动作：确认键走 warn 族配色 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 纯展示组件：**不发请求、不判断语义**，只把决定交回调用方 */
export function ConfirmDialog({
  title,
  body,
  warn,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 默认焦点给「取消」：危险动作不该是回车即中
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className={styles.dialogMask}
      // 点遮罩 = 取消（与 Esc 同义）；点对话框本体不冒泡到这一层
      onMouseDown={onCancel}
    >
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.dialogTitle}>{title}</div>
        <div className={styles.dialogBody}>
          {body}
          {warn && <div className={styles.warnLine}>{warn}</div>}
        </div>
        <div className={styles.dialogActions}>
          <button ref={cancelRef} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            className={danger ? styles.dangerBtn : undefined}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 调用方交给 `useConfirm()` 的那一份：确认框外观，不含结果回调（由 hook 接管）。 */
export type ConfirmRequest = Omit<ConfirmDialogProps, 'onConfirm' | 'onCancel'>;

/**
 * 强制确认的 React 钩子。
 *
 * 用法（与 `window.confirm` 对位）：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, body, danger: true }))) return;
 *
 * ★ 返回的 `node` 必须渲染在组件树里——不渲染就等于用户永远点不到确认。
 *   这一点由 `tests/integration/confirm-dialog-wiring.test.ts` 的 D 组钉住。
 */
export function useConfirm(): {
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  node: JSX.Element | null;
} {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const settle = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((r: ConfirmRequest): Promise<boolean> => {
    // 并发调用：后一次把前一次当取消（不静默丢弃 promise，否则调用方永远 await）
    settle.current?.(false);
    return new Promise<boolean>((resolve) => {
      settle.current = resolve;
      setReq(r);
    });
  }, []);

  const close = useCallback((ok: boolean): void => {
    setReq(null);
    const s = settle.current;
    settle.current = null;
    s?.(ok);
  }, []);

  const node = req ? (
    <ConfirmDialog
      {...req}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { confirm, node };
}

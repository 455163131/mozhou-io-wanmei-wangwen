/**
 * 模型设置弹窗（API Key 配置入口）。
 *
 * ★ 安全边界：明文 Key 只在主进程落盘（safeStorage 加密），桥接层**永不回传明文**——
 *   表单里 Key 输入框永远留空，用主进程给的 displayKey 掩码（如 sk-a•••xyz）展示状态。
 *   留空保存 = 保留已存 Key（换模型/地址时不必重填 Key）。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { PROVIDERS } from '@shared/constants/providers';
import type { LlmStatus } from '@shared/types/provider';
import styles from './SettingsModal.module.css';

interface Props {
  status: LlmStatus | null;
  onClose: () => void;
  /** 保存成功后把最新状态回传给 App（头部状态点即时刷新） */
  onSaved: (s: LlmStatus) => void;
}

export function SettingsModal({ status, onClose, onSaved }: Props): JSX.Element {
  const settings = status?.settings ?? null;
  const [providerId, setProviderId] = useState(settings?.providerId ?? 'deepseek');
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '');
  const [model, setModel] = useState(settings?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];

  /** Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 切换提供商：Base URL 为空或等于上一家默认值时，自动填新默认（减少手输） */
  const onProviderChange = (id: string): void => {
    const prev = PROVIDERS.find((p) => p.id === providerId);
    const next = PROVIDERS.find((p) => p.id === id);
    setProviderId(id);
    if (next && (!baseUrl.trim() || baseUrl.trim() === prev?.defaultBaseUrl)) {
      setBaseUrl(next.defaultBaseUrl);
    }
  };

  const save = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const s = await api.llm.configure({
        providerId,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
        // 留空 = 保留已存 Key（主进程约定：undefined 不覆盖）
        apiKey: apiKey.trim() || undefined,
        reprobe: true,
      });
      setApiKey('');
      setMsg({ kind: 'ok', text: '已保存。' });
      onSaved(s);
      return true;
    } catch (e) {
      setMsg({ kind: 'err', text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }, [providerId, baseUrl, model, apiKey, onSaved]);

  /** 测试连接 = 先保存当前表单，再打 llm:test（test 测的是已保存配置） */
  const saveAndTest = useCallback(async (): Promise<void> => {
    if (!(await save())) return;
    setTesting(true);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const r = await api.llm.test();
      setMsg(
        r.ok
          ? { kind: 'ok', text: `连接成功：${r.message}` }
          : { kind: 'err', text: `连接失败：${r.message}` },
      );
    } catch (e) {
      setMsg({ kind: 'err', text: errorText(e) });
    } finally {
      setTesting(false);
    }
  }, [save]);

  const configured = status?.configured === true;
  const uiKind = status?.uiState.kind ?? 'unconfigured';

  return (
    <div className={styles.overlay} onClick={onClose} role='presentation'>
      <div
        className={styles.card}
        role='dialog'
        aria-modal='true'
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.head}>
          <span className={styles.title}>模型设置</span>
          <button className={styles.close} onClick={onClose} aria-label='关闭'>
            ✕
          </button>
        </div>

        {!configured && (
          <div className={styles.warn}>
            尚未配置模型 —— Agent 对话与专家团评审需要模型才能工作。
            填写下方信息并保存即可启用。
          </div>
        )}

        {/* 当前状态一览 */}
        <div className={styles.statusRow}>
          <span className={`${styles.dot} ${configured ? styles.dotOk : styles.dotWarn}`} />
          <span>
            {configured
              ? `${status?.uiState.kind === 'unconfigured' ? '已配置' : '已配置'} · ${
                  settings?.model || '（未填模型 ID）'
                } · Key ${settings?.hasKey ? settings.displayKey : '未配置'}`
              : '未配置'}
          </span>
          <span className={styles.mode}>
            {uiKind === 'cloud-native' && '工具调用：原生'}
            {uiKind === 'cloud-prompted' && '工具调用：文本协议（稳定性略低）'}
            {uiKind === 'local-prompted' && '本地模型 · 文本协议'}
            {uiKind === 'local-unsupported' && '本地模型 · 能力受限，将禁用自主规划'}
            {uiKind === 'unconfigured' && '规则模式可用（不需要模型）'}
          </span>
        </div>

        {/* 表单 */}
        <label className={styles.label}>
          提供商
          <select
            className={styles.input}
            value={providerId}
            onChange={(e) => onProviderChange(e.target.value)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.label}>
          Base URL
          <input
            className={styles.input}
            value={baseUrl}
            placeholder={provider.defaultBaseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className={styles.label}>
          模型 ID
          <input
            className={styles.input}
            value={model}
            placeholder="如 deepseek-chat"
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className={styles.label}>
          API Key{' '}
          {settings?.hasKey && (
            <span className={styles.masked}>已配置（{settings.displayKey}）</span>
          )}
          <div className={styles.keyRow}>
            <input
              className={styles.input}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder={settings?.hasKey ? '输入新值可更换，留空保留' : '粘贴你的 API Key'}
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
              autoComplete='off'
            />
            <button className={styles.eye} onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </label>

        <p className={styles.note}>
          Key 经系统 safeStorage 加密存储在本机，永不明文落盘、永不经前端回传。
          {provider.requiresKey === false && ' 该提供商无需 Key。'}
        </p>

        {msg && <div className={msg.kind === 'ok' ? styles.ok : styles.err}>{msg.text}</div>}

        <div className={styles.actions}>
          <button className={styles.btn} disabled={busy || testing} onClick={onClose}>
            关闭
          </button>
          <button
            className={styles.btn}
            disabled={busy || testing}
            onClick={() => void saveAndTest()}
          >
            {testing ? '测试中…' : '保存并测试连接'}
          </button>
          <button
            className={styles.btnPrimary}
            disabled={busy || testing}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

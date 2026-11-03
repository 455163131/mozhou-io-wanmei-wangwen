/**
 * 生成流水线 store（P0 T6）。
 *
 * 照抄 store/index.ts 的既有 slice 模式：immer + subscribeWithSelector。
 * ★ 必须用 selector 订阅（架构 §6 第 5 条硬要求）——progress 每次推送都会写，
 *   全订阅会让挂着 GenView 的整棵树跟着每条推送重渲染。
 *
 * ★ 本文件归 tsconfig.node.json 管（store/** 是 DOM-free 纯状态机），
 *   不许 import 任何碰 document/window 的东西，也不许在这里调 bridge。
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Draft } from '@shared/types/pipeline';

interface PipelineState {
  /** 草稿隔离区的 pending 列表（GenView 挂载与每次动作后刷新） */
  drafts: Draft[];
  /** 各动作的执行态。键：'params'|'concept'|'outline'|'draft'|`adopt:${id}`|`discard:${id}` */
  busy: Record<string, boolean>;
  /** 状态行文案：推送进度 / 成功回执 / 失败真因（含 error code，不拟人化） */
  progress: string;
  /** progress 是否是失败红字（渲染层据此上色，不靠解析文案） */
  progressFailed: boolean;

  setDrafts: (d: Draft[]) => void;
  setBusy: (key: string, v: boolean) => void;
  setProgress: (text: string, failed?: boolean) => void;
}

export const usePipelineStore = create<PipelineState>()(
  subscribeWithSelector(
    immer((set) => ({
      drafts: [],
      busy: {},
      progress: '',
      progressFailed: false,

      setDrafts: (d) =>
        set((s) => {
          s.drafts = d;
        }),
      setBusy: (key, v) =>
        set((s) => {
          s.busy[key] = v;
        }),
      setProgress: (text, failed = false) =>
        set((s) => {
          s.progress = text;
          s.progressFailed = failed;
        }),
    })),
  ),
);

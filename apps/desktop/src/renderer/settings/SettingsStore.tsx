/**
 * 设置窗的状态容器 —— 与主窗的 `state/store.tsx` **刻意不共用**（MU-3 切片 2）。
 *
 * 理由：主窗 store 订阅了十余条会话/分身事件并维护消息流，而设置窗一条都不需要。
 * 复用它等于让设置窗白白跟着整棵会话树重渲染，也让「渲染层薄壳」这条纪律
 * 在第二个窗口上失效。设置窗的真相只有一个：`ConfigSnapshot`。
 *
 * 数据流仍是主进程单向权威：
 *   config.get → 渲染；改一项 → config.patch → 主进程落盘 → config.changed → 重绘
 * 界面**不做乐观更新**（03 §5「无保存按钮」的前提是每次写都拿得到真结果）：
 * 拒绝的字段要能立刻标红，乐观更新会先显示一个假的成功再跳回去。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ConfigIssue, ConfigPatch, ConfigSnapshot, OpenPathKind } from '@axon/protocol';

export interface SettingsValue {
  /** 配置快照（主进程权威，含 env 覆盖表与路径）；未拉到时为 null。 */
  config: ConfigSnapshot | null;
  /** 上一次写操作被拒的字段（逐字段标红用）；成功则为空数组。 */
  issues: ConfigIssue[];
  /** 传输/命令级错误（不是字段校验错误）。 */
  error: string | null;
  /** 改一项或多项；返回是否被接受。 */
  patch: (patch: ConfigPatch) => Promise<boolean>;
  /** 恢复出厂（清白名单字段，保留未知键）。 */
  reset: () => Promise<boolean>;
  /** 在系统文件管理器里打开/定位一个已知位置。 */
  openPath: (kind: OpenPathKind) => Promise<void>;
  dismissError: () => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SettingsProvider({ children }: { children: ReactNode }): ReactElement {
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 首拉 + 订阅：`config.changed` 由主进程在任一窗口改配置后广播，
  // 所以另一个窗口改了这里也会跟着变（双窗同步的全部实现就是这一行）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const snap = await window.axon.invoke('config.get', {});
        if (alive) setConfig(snap);
      } catch (e) {
        if (alive) setError(messageOf(e));
      }
    })();
    const off = window.axon.subscribe('config.changed', ({ config: snap }) => setConfig(snap));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const patch = useCallback(async (p: ConfigPatch): Promise<boolean> => {
    try {
      const res = await window.axon.invoke('config.patch', { patch: p });
      setConfig(res.config);
      setIssues(res.errors);
      return res.accepted;
    } catch (e) {
      setError(messageOf(e));
      return false;
    }
  }, []);

  const reset = useCallback(async (): Promise<boolean> => {
    try {
      const res = await window.axon.invoke('config.reset', {});
      setConfig(res.config);
      setIssues(res.errors);
      return res.accepted;
    } catch (e) {
      setError(messageOf(e));
      return false;
    }
  }, []);

  const openPath = useCallback(async (kind: OpenPathKind): Promise<void> => {
    try {
      await window.axon.invoke('shell.openPath', { kind });
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);

  const value: SettingsValue = {
    config,
    issues,
    error,
    patch,
    reset,
    openPath,
    dismissError: () => setError(null),
  };
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const v = useContext(SettingsContext);
  if (!v) throw new Error('useSettings 必须在 <SettingsProvider> 内使用');
  return v;
}

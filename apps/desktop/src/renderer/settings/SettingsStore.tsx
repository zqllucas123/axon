/**
 * 设置窗的状态容器 —— 与主窗的 `state/store.tsx` **刻意不共用**（MU-3 切片 2）。
 *
 * 理由：主窗 store 订阅了十余条会话/分身事件并维护消息流，而设置窗一条都不需要。
 * 复用它等于让设置窗白白跟着整棵会话树重渲染，也让「渲染层薄壳」这条纪律
 * 在第二个窗口上失效。设置窗的真相只有一个：`ConfigSnapshot`。
 *
 * 数据流仍是主进程单向权威：
 *   config.get → 渲染；改一项 → config.patch → 主进程落盘 → config.changed → 重绘
 * **本 store 不做乐观更新**：它只持有快照真值与上一次写回来的 issues。
 * 字段级的乐观值与回滚在 `fields.tsx`（开关得立刻动，但一旦被拒就回落到
 * 这里的快照真值）—— 两层分得清：真相在主进程，「手感」在控件里。
 *
 * 除 `ConfigSnapshot` 外还拉三条**只读**数据（MU-3 §4.2 列的五条数据源）：
 * `storage.status`（关于 pane 的「会话与账本」）、`ledger.getAdoptionPolicy`
 * （裁决策略不走 config）、`role.list`（仲裁者候选）。仍然一条会话事件都不订。
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
import type {
  AdoptionPolicy,
  ConfigIssue,
  ConfigPatch,
  ConfigSnapshot,
  OpenPathKind,
  RoleEntry,
  StorageIssue,
} from '@axon/protocol';

/** 存储实况（`storage.status`）—— 「关于」pane 的「会话与账本」用它说实话。 */
export interface StorageStatus {
  root: string;
  sessionCount: number;
  loadedCount: number;
  issues: StorageIssue[];
}

export interface SettingsValue {
  /** 配置快照（主进程权威，含 env 覆盖表与路径）；未拉到时为 null。 */
  config: ConfigSnapshot | null;
  /**
   * 存储实况。M5 已落盘，所以原型那句「全在内存，关掉应用就一起消失」是过时的，
   * 必须用真数据重写（MU-3 §4.4）。拉一次即可：它不发事件（协议注释写明
   * 「渲染层不该对启动顺序做假设」），本窗提供手动刷新。
   */
  storage: StorageStatus | null;
  /**
   * 裁决策略。**不走 config**（它是 host 的运行期状态，`ledger.get/setAdoptionPolicy`），
   * 订 `ledger.policyChanged` 保证另一处改了这里跟着变。
   */
  policy: AdoptionPolicy | null;
  /** 角色清单 —— 只为「委派仲裁」的仲裁者候选项（按角色指定）。 */
  roles: RoleEntry[];
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
  /** 切换裁决策略（人工表态 / 委派给某角色）。 */
  setPolicy: (policy: AdoptionPolicy) => Promise<boolean>;
  /** 重新拉一次存储实况（会话跑起来后数字会变，但本窗收不到事件）。 */
  refreshStorage: () => Promise<void>;
  dismissError: () => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SettingsProvider({ children }: { children: ReactNode }): ReactElement {
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [policy, setPolicyState] = useState<AdoptionPolicy | null>(null);
  const [roles, setRoles] = useState<RoleEntry[]>([]);
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

  // 另外三条只读数据源（MU-3 §4.2 列的五条里的后三条）。
  // 刻意**不订阅任何会话/分身事件**：设置窗不参与会话，订了只会白白重渲染。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [st, pol, rs] = await Promise.all([
          window.axon.invoke('storage.status', {}),
          window.axon.invoke('ledger.getAdoptionPolicy', {}),
          window.axon.invoke('role.list', {}),
        ]);
        if (!alive) return;
        setStorage(st);
        setPolicyState(pol);
        setRoles(rs.entries);
      } catch (e) {
        if (alive) setError(messageOf(e));
      }
    })();
    const off = window.axon.subscribe('ledger.policyChanged', ({ policy: p }) => setPolicyState(p));
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

  const setPolicy = useCallback(async (next: AdoptionPolicy): Promise<boolean> => {
    try {
      const res = await window.axon.invoke('ledger.setAdoptionPolicy', { policy: next });
      setPolicyState(res.policy);
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    }
  }, []);

  const refreshStorage = useCallback(async (): Promise<void> => {
    try {
      setStorage(await window.axon.invoke('storage.status', {}));
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);

  const value: SettingsValue = {
    config,
    storage,
    policy,
    roles,
    issues,
    error,
    patch,
    reset,
    openPath,
    setPolicy,
    refreshStorage,
    dismissError: () => setError(null),
  };
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const v = useContext(SettingsContext);
  if (!v) throw new Error('useSettings 必须在 <SettingsProvider> 内使用');
  return v;
}

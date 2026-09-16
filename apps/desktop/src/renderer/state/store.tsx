/**
 * 渲染层状态容器 —— L3 薄壳的边界就画在这个文件里。
 *
 * 三条职责，多一条都不要（AGENTS.md §4.3 / ux 01 §5，kalo chat-store 的教训）：
 *   1. 拉取：启动与进入某屏时 invoke 只读命令，把结果按 id/path 缓存起来；
 *   2. 订阅：把主进程推来的事件 upsert 进缓存（全仓只在这里订阅一次）；
 *   3. 转发意图：把用户动作翻译成一条 invoke，**不判断能不能/该不该**——
 *      权限、并发闸门、预算、重试全部在主进程（L2）判。
 *
 * 明确不做（哪天需要，先改 ux 01 §5 再改这里）：
 *   - 派生数据一律去 selectors.ts 算，这里只存「实体 + 事件」；
 *   - 不做节流/合并/重试/乐观更新；
 *   - 不缓存「能不能点」这类编排判断的结果。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  AgentPath,
  AgentSnapshot,
  BudgetSnapshot,
  ConfigSnapshot,
  CreateSessionPayload,
  LedgerRecord,
  PendingRequest,
  RoleEntry,
  RoleIssue,
  SessionDetail,
  SessionSummary,
  TeamEntry,
  TeamIssue,
} from '@axon/protocol';
import type { Screen, SessionView } from './types.ts';

/** 预算告警现场（`budget.get` 只给一次快照，跃迁要靠事件）。 */
export interface BudgetAlert {
  state: 'warning' | 'frozen';
  scope: 'global' | 'session';
  sessionId?: string;
  limitedBy?: 'global' | 'team' | 'session';
  spentUsd: number;
}

/** `storage.status` 的结果形状（协议里是内联字面量，这里起个名字只为读起来清楚）。 */
export interface StorageStatus {
  root: string;
  sessionCount: number;
  loadedCount: number;
  issues: unknown[];
}

export interface StoreValue {
  // ── 数据缓存 ──
  storage: StorageStatus | null;
  sessions: SessionSummary[];
  details: Record<string, SessionDetail>;
  agents: Record<AgentPath, AgentSnapshot>;
  roles: { entries: RoleEntry[]; issues: RoleIssue[] };
  teams: { entries: TeamEntry[]; issues: TeamIssue[] };
  pending: PendingRequest[];
  ledger: LedgerRecord[];
  budget: BudgetSnapshot | null;
  budgetAlert: BudgetAlert | null;
  config: ConfigSnapshot | null;
  /** 最近一次失败的 invoke（原样透传，不吞）。 */
  error: string | null;
  // ── 视图状态（纯 UI，不入协议） ──
  screen: Screen;
  sessionId: string | null;
  sessionView: SessionView;
  focusPath: AgentPath | null;
  /** 当前会话摘要（无会话时为 null）。 */
  current: SessionSummary | null;
  // ── 意图 ──
  go: (screen: Screen) => void;
  openSession: (sessionId: string) => void;
  createSession: (payload: CreateSessionPayload) => Promise<SessionSummary | null>;
  removeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setSessionView: (view: SessionView) => void;
  setFocus: (path: AgentPath) => void;
  prompt: (path: AgentPath, text: string) => Promise<void>;
  interrupt: (path: AgentPath) => Promise<void>;
  respondApproval: (requestId: string, approved: boolean) => Promise<void>;
  answerQuestion: (requestId: string, answer: string) => Promise<void>;
  adopt: (id: string, adoption: 'adopted' | 'rejected') => Promise<void>;
  saveRole: (role: RoleEntry['role']) => Promise<{ accepted: boolean; errors: RoleIssue[] }>;
  saveTeam: (team: TeamEntry['team']) => Promise<{ accepted: boolean; errors: TeamIssue[] }>;
  dismissError: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useApp(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useApp 必须在 <AppProvider> 内使用');
  return v;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}

export function AppProvider({ children }: { children: ReactNode }): ReactElement {
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [agents, setAgents] = useState<Record<AgentPath, AgentSnapshot>>({});
  const [roles, setRoles] = useState<StoreValue['roles']>({ entries: [], issues: [] });
  const [teams, setTeams] = useState<StoreValue['teams']>({ entries: [], issues: [] });
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [budget, setBudget] = useState<BudgetSnapshot | null>(null);
  const [budgetAlert, setBudgetAlert] = useState<BudgetAlert | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [screen, setScreen] = useState<Screen>('s0');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionView, setSessionViewState] = useState<SessionView>('chat');
  const [focusPath, setFocusPath] = useState<AgentPath | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  /** 唯一的 invoke 通道：失败就记进 error，不静默、不吞。 */
  const call = useCallback(async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      setError(messageOf(e));
      return null;
    }
  }, []);

  // ── 拉取（一次性） ──
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [st, list, rs, ts, ps, bg, cfg] = await Promise.all([
        call(() => window.axon.invoke('storage.status', {})),
        call(() => window.axon.invoke('session.list', {})),
        call(() => window.axon.invoke('role.list', {})),
        call(() => window.axon.invoke('team.list', {})),
        call(() => window.axon.invoke('pending.list', {})),
        call(() => window.axon.invoke('budget.get', {})),
        call(() => window.axon.invoke('config.get', {})),
      ]);
      if (!alive) return;
      if (st) setStorage(st as StorageStatus);
      if (list) setSessions(list);
      if (rs) setRoles(rs);
      if (ts) setTeams(ts);
      if (ps) setPending(ps);
      if (bg) setBudget(bg);
      if (cfg) setConfig(cfg);
    })();
    return () => {
      alive = false;
    };
  }, [call]);

  // ── 订阅（全仓唯一一处） ──
  useEffect(() => {
    const offs: Array<() => void> = [];
    const sub = window.axon.subscribe.bind(window.axon);

    const upsertSession = (summary: SessionSummary) =>
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.record.id === summary.record.id);
        if (i < 0) return [...prev, summary];
        const next = [...prev];
        next[i] = summary;
        return next;
      });

    offs.push(sub('session.created', ({ summary }) => upsertSession(summary)));
    offs.push(
      sub('session.changed', ({ summary }) => {
        upsertSession(summary);
        // 已加载过的会话就地合并摘要字段（**不重拉树**，M5 懒加载纪律）。
        setDetails((prev) => {
          const d = prev[summary.record.id];
          if (!d) return prev;
          return { ...prev, [summary.record.id]: { ...d, ...summary } };
        });
      }),
    );
    offs.push(
      sub('session.removed', ({ sessionId: removed, paths }) => {
        setSessions((prev) => prev.filter((s) => s.record.id !== removed));
        setDetails((prev) => {
          if (!(removed in prev)) return prev;
          const next = { ...prev };
          delete next[removed];
          return next;
        });
        setAgents((prev) => {
          const next = { ...prev };
          for (const p of paths) delete next[p];
          return next;
        });
        if (sessionIdRef.current === removed) {
          setSessionId(null);
          setFocusPath(null);
          setScreen('s1');
        }
      }),
    );

    offs.push(
      sub('agent.created', ({ snapshot }) => {
        setAgents((prev) => ({ ...prev, [snapshot.path]: snapshot }));
        const sid = snapshot.sessionId;
        if (!sid) return;
        setDetails((prev) => {
          const d = prev[sid];
          if (!d || d.members.some((m) => m.path === snapshot.path)) return prev;
          return { ...prev, [sid]: { ...d, members: [...d.members, snapshot] } };
        });
      }),
    );
    offs.push(
      sub('agent.status', ({ path, status, error: err }) => {
        setAgents((prev) => {
          const cur = prev[path];
          if (!cur) return prev;
          return { ...prev, [path]: { ...cur, status, ...(err ? { lastError: err } : {}) } };
        });
        setDetails((prev) => {
          let hit: string | undefined;
          for (const [sid, d] of Object.entries(prev)) {
            if (d.members.some((m) => m.path === path)) {
              hit = sid;
              break;
            }
          }
          if (hit === undefined) return prev;
          const d = prev[hit];
          if (!d) return prev;
          return {
            ...prev,
            [hit]: {
              ...d,
              members: d.members.map((m) =>
                m.path === path ? { ...m, status, ...(err ? { lastError: err } : {}) } : m,
              ),
            },
          };
        });
      }),
    );
    offs.push(
      sub('agent.removed', ({ paths }) => {
        setAgents((prev) => {
          const next = { ...prev };
          for (const p of paths) delete next[p];
          return next;
        });
        setDetails((prev) => {
          const next: Record<string, SessionDetail> = {};
          for (const [sid, d] of Object.entries(prev)) {
            next[sid] = { ...d, members: d.members.filter((m) => !paths.includes(m.path)) };
          }
          return next;
        });
      }),
    );

    offs.push(sub('roles.changed', ({ entries, issues }) => setRoles({ entries, issues })));
    offs.push(sub('teams.changed', ({ entries, issues }) => setTeams({ entries, issues })));
    offs.push(sub('config.changed', ({ config: cfg }) => setConfig(cfg)));
    offs.push(sub('ledger.policyChanged', () => undefined));

    const upsertLedger = (record: LedgerRecord) =>
      setLedger((prev) => {
        const i = prev.findIndex((r) => r.id === record.id);
        if (i < 0) return [...prev, record];
        const next = [...prev];
        next[i] = record;
        return next;
      });
    offs.push(sub('ledger.recorded', ({ record }) => upsertLedger(record)));
    offs.push(sub('ledger.updated', ({ record }) => upsertLedger(record)));

    offs.push(
      sub('approval.request', (p) => {
        setPending((prev) =>
          prev.some((x) => x.requestId === p.requestId)
            ? prev
            : [
                ...prev,
                {
                  requestId: p.requestId,
                  kind: 'approval',
                  sessionId: p.sessionId,
                  origin: p.origin,
                  chain: p.chain,
                  tool: p.tool,
                  args: p.args,
                  approvalMode: p.approvalMode,
                  message: p.message,
                  at: Date.now(),
                  state: 'pending',
                },
              ],
        );
      }),
    );
    offs.push(
      sub('pending.resolved', ({ requestId, outcome }) => {
        setPending((prev) =>
          prev.map((x) => (x.requestId === requestId ? { ...x, state: 'resolved', detail: { outcome } } : x)),
        );
      }),
    );

    offs.push(
      sub('budget.warning', (p) => {
        setBudgetAlert({
          state: 'warning',
          scope: p.scope,
          ...(p.sessionId ? { sessionId: p.sessionId } : {}),
          ...(p.limitedBy ? { limitedBy: p.limitedBy } : {}),
          spentUsd: p.spentUsd,
        });
        setBudget((prev) =>
          prev ? { ...prev, state: 'warning', spentUsd: p.spentUsd, softUsd: p.softUsd, hardUsd: p.hardUsd } : prev,
        );
      }),
    );
    offs.push(
      sub('budget.frozen', (p) => {
        setBudgetAlert({
          state: 'frozen',
          scope: p.scope,
          ...(p.sessionId ? { sessionId: p.sessionId } : {}),
          ...(p.limitedBy ? { limitedBy: p.limitedBy } : {}),
          spentUsd: p.spentUsd,
        });
        setBudget((prev) =>
          prev ? { ...prev, state: 'frozen', spentUsd: p.spentUsd, softUsd: p.softUsd, hardUsd: p.hardUsd } : prev,
        );
      }),
    );

    return () => {
      for (const off of offs) off();
    };
  }, []);

  // ── 意图 ──
  const loadDetail = useCallback(
    async (id: string): Promise<SessionDetail | null> => {
      const d = await call(() => window.axon.invoke('session.get', { sessionId: id }));
      if (d) {
        setDetails((prev) => ({ ...prev, [id]: d }));
        setAgents((prev) => {
          const next = { ...prev };
          for (const m of d.members) next[m.path] = m;
          return next;
        });
      }
      return d;
    },
    [call],
  );

  const openSession = useCallback(
    (id: string) => {
      const known = details[id];
      const s = sessions.find((x) => x.record.id === id);
      setSessionId(id);
      setScreen('s2');
      setSessionViewState('chat');
      setFocusPath(known ? known.rootPath : (s?.rootPath ?? null));
      // 懒加载纪律：**只有这里**允许触发 session.get（读树）。
      if (!known) void loadDetail(id);
    },
    [details, loadDetail, sessions],
  );

  const createSession = useCallback(
    async (payload: CreateSessionPayload): Promise<SessionSummary | null> => {
      const s = await call(() => window.axon.invoke('session.create', payload));
      if (!s) return null;
      setSessions((prev) => (prev.some((x) => x.record.id === s.record.id) ? prev : [...prev, s]));
      setSessionId(s.record.id);
      setFocusPath(s.rootPath);
      setScreen('s2');
      setSessionViewState('chat');
      void loadDetail(s.record.id);
      return s;
    },
    [call, loadDetail],
  );

  const removeSession = useCallback(
    async (id: string) => {
      await call(() => window.axon.invoke('session.remove', { sessionId: id }));
    },
    [call],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const s = await call(() => window.axon.invoke('session.rename', { sessionId: id, title }));
      if (s) setSessions((prev) => prev.map((x) => (x.record.id === id ? s : x)));
    },
    [call],
  );

  const prompt = useCallback(
    async (path: AgentPath, text: string) => {
      await call(() => window.axon.invoke('agent.prompt', { path, text }));
    },
    [call],
  );

  const interrupt = useCallback(
    async (path: AgentPath) => {
      await call(() => window.axon.invoke('agent.interrupt', { path }));
    },
    [call],
  );

  const respondApproval = useCallback(
    async (requestId: string, approved: boolean) => {
      await call(() => window.axon.invoke('approval.respond', { requestId, approved }));
      setPending((prev) =>
        prev.map((x) =>
          x.requestId === requestId ? { ...x, state: 'resolved', detail: { outcome: approved ? 'approved' : 'denied' } } : x,
        ),
      );
    },
    [call],
  );

  const answerQuestion = useCallback(
    async (requestId: string, answer: string) => {
      await call(() => window.axon.invoke('question.respond', { requestId, answer }));
    },
    [call],
  );

  const adopt = useCallback(
    async (id: string, adoption: 'adopted' | 'rejected') => {
      const r = await call(() => window.axon.invoke('ledger.adopt', { id, adoption }));
      if (r) setLedger((prev) => prev.map((x) => (x.id === r.record.id ? r.record : x)));
    },
    [call],
  );

  const saveRole = useCallback(
    async (role: RoleEntry['role']) => {
      const res = await call(() => window.axon.invoke('role.save', { role }));
      if (res) return res;
      return { accepted: false, errors: [] as RoleIssue[] };
    },
    [call],
  );

  const saveTeam = useCallback(
    async (team: TeamEntry['team']) => {
      const res = await call(() => window.axon.invoke('team.save', { team }));
      if (res) return res;
      return { accepted: false, errors: [] as TeamIssue[] };
    },
    [call],
  );

  const value: StoreValue = {
    storage,
    sessions,
    details,
    agents,
    roles,
    teams,
    pending,
    ledger,
    budget,
    budgetAlert,
    config,
    error,
    screen,
    sessionId,
    sessionView,
    focusPath,
    current: sessions.find((s) => s.record.id === sessionId) ?? null,
    go: setScreen,
    openSession,
    createSession,
    removeSession,
    renameSession,
    setSessionView: setSessionViewState,
    setFocus: setFocusPath,
    prompt,
    interrupt,
    respondApproval,
    answerQuestion,
    adopt,
    saveRole,
    saveTeam,
    dismissError: () => setError(null),
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

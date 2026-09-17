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
import { sessionIdOfPath } from '@axon/protocol';
import { applyAppearance } from '../appearance.ts';
import type {
  AgentPath,
  AgentSnapshot,
  BudgetSnapshot,
  ConfigPatch,
  ConfigSnapshot,
  CreateSessionPayload,
  LedgerRecord,
  MessageLike,
  OpenPathKind,
  PendingRequest,
  RoleEntry,
  RoleIssue,
  SessionDetail,
  SessionSummary,
  TeamEntry,
  TeamIssue,
} from '@axon/protocol';
import type { Screen, SessionView } from './types.ts';
import {
  itemsFromMessage,
  replayStream,
  toolArgsLine,
  toolResultText,
  turnActivity,
  type StreamItem,
} from './selectors.ts';

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
  /**
   * 每个成员的消息流（切片 3）：`agent.messages` 回放 + 事件增量都落在这一份缓存。
   * 键是 AgentPath —— 成员是会话内的自然切片，切焦点不重拉。
   */
  streams: Record<AgentPath, StreamItem[]>;
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
  /** 拉本会话账本切片（ledger.query 只拉一次，之后靠增量事件）。 */
  loadLedger: (sessionId: string) => Promise<void>;
  /** 「叫人」：单兵会话升级为团队会话（session.escalate）。 */
  escalate: (sessionId: string, teamId: string) => Promise<boolean>;
  saveRole: (role: RoleEntry['role']) => Promise<{ accepted: boolean; errors: RoleIssue[] }>;
  saveTeam: (team: TeamEntry['team']) => Promise<{ accepted: boolean; errors: TeamIssue[] }>;
  /** 删除团队档（`team.delete` → 主进程 emit teams.changed，列表自动重绘）。 */
  deleteTeam: (name: string) => Promise<boolean>;
  /** 删除 Agent 类型（`role.delete`）。 */
  deleteRole: (name: string) => Promise<boolean>;
  /** 用系统文件管理器打开一个已知位置（`shell.openPath`，MU-3 E-3）。 */
  openPath: (kind: OpenPathKind) => Promise<void>;
  /** 打开（或聚焦）设置窗（`window.openSettings`）。 */
  openSettings: () => Promise<void>;
  /**
   * 改配置（`config.patch`）。主窗只用它改**界面偏好**（`ui.*`）；
   * 完整的设置表单在设置窗（自带 SettingsStore）。
   */
  patchConfig: (patch: ConfigPatch) => Promise<boolean>;
  /**
   * 本次运行期内已处理的待办流水（S5 「已处理」段，拍板 P-5）。
   *
   * 为什么只能是「本次运行期」：`ApprovalBroker` 结算即 `pending.delete`，
   * 协议没有 `pending.history`。写成派生值而不是新缓存，是为了让
   * 「刷新后这段会清空」这件事在代码里一目了然，而不是看起来像史料。
   */
  resolvedFeed: PendingRequest[];
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
  const [streams, setStreams] = useState<Record<AgentPath, StreamItem[]>>({});
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

  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  /** 已回放过的路径：回放只做一次（之后全靠事件增量），切焦点回来不重拉。 */
  const replayedRef = useRef<Set<AgentPath>>(new Set());

  /**
   * 消息流懒加载：**只在焦点切换 / 建会话时**拉一次 `agent.messages`，之后靠事件增量。
   * 与 `session.get` 同理 —— 列表渲染不得触发读史（MU-2 §5.3 反面纪律）。
   *
   * 合并口径：回放在前（它是权威历史，**用户消息不发事件**，只有回放能补上），
   * 已有的事件增量按 `streamKey` 去重后接在后面。所以即使会话在打开前就跑过一轮，
   * 点开时也能把历史补齐而不是丢开头。
   */
  const loadMessages = useCallback(
    async (path: AgentPath): Promise<void> => {
      if (replayedRef.current.has(path)) return;
      replayedRef.current.add(path); // 先占位，避免并发进来拉两遍
      const msgs = await call(() => window.axon.invoke('agent.messages', { path }));
      if (!msgs) {
        replayedRef.current.delete(path); // 失败要能重试
        return;
      }
      setStreams((prev) => {
        const history = replayStream(msgs);
        const seen = new Set(history.map(streamKey));
        // 回放是权威历史：未收口的 pending 占位一律丢掉（配对可能已经断了，
        // 留着它会让历史末尾永远挂一条假的「正在生成」）。
        const live = (prev[path] ?? []).filter(
          (i) => !seen.has(streamKey(i)) && !(i.kind === 'assistant' && i.pending),
        );
        return { ...prev, [path]: [...history, ...live] };
      });
    },
    [call],
  );

  /** 已拉过账本的会话（账本 append-only：拉一次 + 事件增量即可）。 */
  const ledgerLoadedRef = useRef<Set<string>>(new Set());

  /** 本会话账本切片（必带 sessionId：/sX/a 这类路径只在会话内唯一）。 */
  const loadLedger = useCallback(
    async (sid: string): Promise<void> => {
      if (ledgerLoadedRef.current.has(sid)) return;
      ledgerLoadedRef.current.add(sid);
      const res = await call(() => window.axon.invoke('ledger.query', { sessionId: sid, limit: 200 }));
      if (!res) {
        ledgerLoadedRef.current.delete(sid);
        return;
      }
      setLedger((prev) => [...prev.filter((r) => r.sessionId !== sid), ...res.records]);
    },
    [call],
  );

  /** 「叫人」= 单兵 → 团队（session.escalate）；失败已由 call 记进 error。 */
  const escalate = useCallback(
    async (sid: string, teamId: string): Promise<boolean> => {
      const d = await call(() => window.axon.invoke('session.escalate', { sessionId: sid, teamId, carryMessages: true }));
      if (!d) return false;
      setDetails((prev) => ({ ...prev, [sid]: d }));
      setAgents((prev) => {
        const next = { ...prev };
        for (const m of d.members) next[m.path] = m;
        return next;
      });
      return true;
    },
    [call],
  );

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

  /**
   * 外观偏好 → DOM（MU-3 切片 8）。
   *
   * 盯的是 `config` 状态而不是在三个 `setConfig` 调用点各写一遍：
   * 初次拉取、`config.changed` 事件、本窗 patch 回包都会更新它，
   * 盯终值只需一处，也不会漏掉以后新增的写入路径。
   */
  useEffect(() => {
    applyAppearance(config?.config.ui);
  }, [config]);

  // ── 订阅（全仓唯一一处） ──
  useEffect(() => {
    const offs: Array<() => void> = [];
    const sub = window.axon.subscribe.bind(window.axon);

    // ─ 消息流的三个写入口（回放走 loadMessages / 打开会话；增量全走这里）──
    const pushItem = (path: AgentPath, item: StreamItem) =>
      setStreams((prev) => ({ ...prev, [path]: [...(prev[path] ?? []), item] }));

    const upsertItem = (path: AgentPath, item: StreamItem) =>
      setStreams((prev) => {
        const list = prev[path] ?? [];
        const i = list.findIndex((x) => x.id === item.id);
        if (i < 0) return { ...prev, [path]: [...list, item] };
        const next = [...list];
        next[i] = item;
        return { ...prev, [path]: next };
      });

    const patchTool = (
      path: AgentPath,
      callId: string,
      patch: Partial<Extract<StreamItem, { kind: 'tool' }>>,
    ) =>
      setStreams((prev) => {
        const list = prev[path];
        if (!list) return prev;
        const i = list.findIndex((x) => x.kind === 'tool' && x.callId === callId);
        const cur = i < 0 ? undefined : list[i];
        if (i < 0 || !cur || cur.kind !== 'tool') return prev;
        const next = [...list];
        next[i] = { ...cur, ...patch };
        return { ...prev, [path]: next };
      });

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
        setStreams((prev) => {
          const next: Record<AgentPath, StreamItem[]> = {};
          for (const [p, list] of Object.entries(prev)) if (!paths.includes(p)) next[p] = list;
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
        // 只有失败带原因时才进流；成功/空闲是噪声。错误卡是一次性事件件，不随重渲染回放。
        if (status === 'failed' && err) pushItem(path, { kind: 'error', id: `err-${Date.now()}`, text: err });
      }),
    );
    offs.push(
      sub('agent.removed', ({ paths }) => {
        setStreams((prev) => {
          const next: Record<AgentPath, StreamItem[]> = {};
          for (const [p, list] of Object.entries(prev)) if (!paths.includes(p)) next[p] = list;
          return next;
        });
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

    // ── 消息流增量（MU-2 §5.2：占位 → 整块替换 → 工具两态 → 回合收尾）──
    offs.push(
      sub('agent.message.start', (_payload, meta) => {
        if (!meta.source) return;
        pushItem(meta.source, { kind: 'assistant', id: nextStreamId('pending'), text: '', pending: true });
      }),
    );
    offs.push(
      sub('agent.message.end', ({ message }, meta) => {
        // toolResult 是独立消息：它的结果已经并进工具卡，再渲染一条就出双份。
        if (!meta.source || message.role === 'toolResult') return;
        const path = meta.source;
        const items = itemsFromMessage(message, nextStreamId('msg'));
        setStreams((prev) => {
          const list = prev[path] ?? [];
          // 收口该成员**最后一个** pending 占位：start/end 成对，但协议不给消息 id
          // （见 nextStreamId 的注释），只能按「最近的未完成占位」配对。
          let i = -1;
          for (let k = list.length - 1; k >= 0; k--) {
            const it = list[k];
            if (it && it.kind === 'assistant' && it.pending) {
              i = k;
              break;
            }
          }
          const next = i < 0 ? [...list, ...items] : [...list.slice(0, i), ...items, ...list.slice(i + 1)];
          return { ...prev, [path]: next };
        });
      }),
    );
    offs.push(
      sub('agent.tool.start', ({ callId, tool, args }, meta) => {
        if (!meta.source) return;
        upsertItem(meta.source, {
          kind: 'tool',
          id: `tool-${callId}`,
          callId,
          name: tool,
          args: toolArgsLine(args),
          state: 'running',
          result: '',
        });
      }),
    );
    offs.push(
      sub('agent.tool.end', ({ callId, ok, result, error: err }, meta) => {
        if (!meta.source) return;
        patchTool(meta.source, callId, { state: ok ? 'ok' : 'err', result: toolResultText(result, err) });
      }),
    );
    offs.push(
      sub('agent.turn.end', ({ usage }, meta) => {
        if (!meta.source) return;
        const path = meta.source;
        // 回合结束 = 不会再有 message.end 来收口：把残留的「正在生成」占位清掉，
        // 否则它会以假「进行中」的形态留在流里（实测：助手正文前面挂了一条）。
        setStreams((prev) => {
          const list = prev[path];
          if (!list) return prev;
          const kept = list.filter((i) => !(i.kind === 'assistant' && i.pending));
          return { ...prev, [path]: [...kept, turnActivity(usage, `turn-${Date.now()}`)] };
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
    // 提问（MU-3）：与 approval.request 并列的第二类待办。
    //
    // 实情说明（写在这里而不是台账里，因为下一个读代码的人先到这）：
    // 当前**全仓没有任何地方发 `question.request`**（只有 `question.respond` 命令与
    // host 的应答通道），所以这条订阅在 v0.1 跑不到。先接上是因为：S5 收件箱
    // 把两类待办当一件事处理，漏接就会在将来发出该事件的那天变成「卡住了但
    // 收件箱看不到」—— 这是最难查的一类 bug。`question.respond` 已经存在，
    // 意味着只差发侧一半。
    offs.push(
      sub('question.request', (p) => {
        setPending((prev) =>
          prev.some((x) => x.requestId === p.requestId)
            ? prev
            : [
                ...prev,
                {
                  requestId: p.requestId,
                  kind: 'question',
                  // 事件只给 requestId + message（ipc.ts:329）：没有会话与发起者。
                  // 当前会话是此刻唯一能说得出口的归属，没有则留空 —— 不编。
                  sessionId: sessionIdRef.current ?? '',
                  origin: '' as AgentPath,
                  chain: [],
                  message: p.message,
                  at: Date.now(),
                  state: 'pending',
                },
              ],
        );
      }),
    );
    // 代批留痕（MU-1 审批修②）：链上有 auto/full_access 祖先时审批不会到人面前，
    // 但「谁替你批的」必须看得见。这条直接以 `state:'resolved'` 入 pending 表，
    // 于是它天然落在 S5 的「已处理」段 —— 它不需要你做任何事，只是一条流水。
    offs.push(
      sub('approval.delegated', (p) => {
        setPending((prev) => [
          ...prev,
          {
            requestId: `delegated-${p.origin}-${p.tool}-${p.at}`,
            kind: 'approval',
            sessionId: sessionIdOfPath(p.origin) ?? '',
            origin: p.origin,
            chain: p.chain,
            tool: p.tool,
            approvalMode: p.mode,
            message: `${p.approver} 代你批了 ${p.tool}（${p.mode}）`,
            at: p.at,
            state: 'resolved',
            detail: { outcome: 'approved', delegated: true, approver: p.approver },
          },
        ]);
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
      const root = known ? known.rootPath : (s?.rootPath ?? null);
      if (root) void loadMessages(root);
      void loadLedger(id);
    },
    [details, loadDetail, loadLedger, loadMessages, sessions],
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
      void loadMessages(s.rootPath);
      void loadLedger(s.record.id);
      return s;
    },
    [call, loadDetail, loadLedger, loadMessages],
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

  const deleteTeam = useCallback(
    async (name: string): Promise<boolean> => {
      const res = await call(() => window.axon.invoke('team.delete', { name }));
      return res?.deleted === true;
    },
    [call],
  );

  const deleteRole = useCallback(
    async (name: string): Promise<boolean> => {
      const res = await call(() => window.axon.invoke('role.delete', { name }));
      return res?.deleted === true;
    },
    [call],
  );

  /** 打开已知位置：失败已被 call 记进 error，这里不追加提示。 */
  const openPath = useCallback(
    async (kind: OpenPathKind): Promise<void> => {
      await call(() => window.axon.invoke('shell.openPath', { kind }));
    },
    [call],
  );

  const openSettings = useCallback(async (): Promise<void> => {
    await call(() => window.axon.invoke('window.openSettings', {}));
  }, [call]);

  /** 改配置：不做乐观更新 —— 主进程回的快照才是真相（字段可能被拒）。 */
  const patchConfig = useCallback(
    async (patch: ConfigPatch): Promise<boolean> => {
      const res = await call(() => window.axon.invoke('config.patch', { patch }));
      if (!res) return false;
      setConfig(res.config);
      if (!res.accepted && res.errors[0]) setError(res.errors[0].message);
      return res.accepted;
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
    streams,
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
    setFocus: (path) => {
      setFocusPath(path);
      void loadMessages(path);
    },
    prompt,
    interrupt,
    respondApproval,
    answerQuestion,
    adopt,
    loadLedger,
    escalate,
    saveRole,
    saveTeam,
    deleteTeam,
    deleteRole,
    openPath,
    openSettings,
    patchConfig,
    // 派生（不存第二份真相）：已结算的待办就是 `pending` 里 state!=='pending' 那些。
    resolvedFeed: pending.filter((p) => p.state !== 'pending'),
    dismissError: () => setError(null),
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// ─────────────────────────────────────────────────────────────
// 会话流的两个小工具（切片 3）
//
// 为什么定义在这里而不是从 selectors 导入：`messageId` 在协议里其实是 **agent 路径**
// （`host.ts:1963`：`this.emit('agent.message.start', { messageId: path }, path)`），
// 同一个成员的所有消息拿到的是同一个值。拿它当条目 id，后一条消息就会把前一条
// **就地覆盖**（实测：用户气泡被助手正文吃掉）。所以渲染层自己发号。
// ─────────────────────────────────────────────────────────────

let streamSeq = 0;

/** 会话流条目的发号器（回放用 `m<i>`，增量用这个，两套编号靠 `streamKey` 合并）。 */
function nextStreamId(prefix: string): string {
  streamSeq += 1;
  return `${prefix}-${streamSeq}`;
}

/**
 * 会话流条目的去重键 —— **回放 vs 事件增量**合并时判「这条是不是已经有了」。
 *
 * 不能用条目 id：回放用的是 `m<i>` 序号，增量是自己发的号，两边对不上。
 * 用内容键才稳：工具卡按 `callId`（唯一且两边一致），文本按 kind+正文。
 */
function streamKey(item: StreamItem): string {
  switch (item.kind) {
    case 'tool':
      return `tool:${item.callId}`;
    case 'turn':
      return `turn:${item.id}`;
    default:
      return `${item.kind}:${item.text}`;
  }
}

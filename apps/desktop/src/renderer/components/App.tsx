/**
 * App —— 唯一的顶层状态持有者。
 *
 * 薄壳纪律（AGENTS.md §4/§5）：这里只保存**呈现所需**的状态快照，
 * 所有真相在主进程（AxonHost）。事件流推什么，这里就同步到什么；
 * 任何 invoke 只发意图，不做编排决策。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdoptionPolicy,
  AgentPath,
  AgentSnapshot,
  LedgerRecord,
  PendingRequest,
  RoleEntry,
  RoleIssue,
  SessionSummary,
  UsageTotals,
} from '@axon/protocol';
import { RolePanel } from './RolePanel.tsx';
import { AgentTree } from './AgentTree.tsx';
import { EventLog, type LogLine } from './EventLog.tsx';
import { Composer } from './Composer.tsx';
import { RoleEditor } from './RoleEditor.tsx';
import { LedgerPanel } from './LedgerPanel.tsx';
import { ApprovalInbox } from './ApprovalInbox.tsx';
import { SessionPanel } from './SessionPanel.tsx';

const LOG_CAP = 500;

/** 会话列表的 upsert（事件驱动，与账本同构：按 id 换，没就插）。 */
function upsertSession(prev: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const i = prev.findIndex((s) => s.record.id === next.record.id);
  const out = i < 0 ? [next, ...prev] : prev.map((s, j) => (j === i ? next : s));
  // 与主进程 session.list 同序：创建时间倒序（最近的在最上面）。
  return out.sort((a, b) => b.record.createdAt - a.record.createdAt).slice(0, 50);
}

interface EditorState {
  mode: 'create';
  seed?: Partial<RoleEntry['role']>;
  editing?: string;
}

/**
 * 预算档位（M3 §4.4）：主进程事件驱动，这里只做呈现。
 *
 * M4 修正：以前只有一个 `limitUsd`，而主进程往里面填的是 **spent**，
 * 于是 banner 上「已用 / 上限」两个数永远相等（MX G9.1）。现在分开两个字段。
 */
interface BudgetView {
  state: 'ok' | 'warning' | 'frozen';
  usage?: UsageTotals;
  spentUsd?: number;
  hardUsd?: number;
}

const usd = (n?: number) => (n === undefined ? '?' : n.toFixed(2));

export function App() {
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [issues, setIssues] = useState<RoleIssue[]>([]);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  // MU-1：会话是一等公民 —— 左栏顶部列会话，树只是「当前会话的成员树」。
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // 订阅回调要读「当前会话」但不能因此重订阅，所以用 ref 持一份最新值。
  const sessionRef = useRef<string | null>(null);
  // 空串 = 「还没定选谁」；等会话就绪后由 effect 落到会话根。
  const [selected, setSelected] = useState<AgentPath>('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [budget, setBudget] = useState<BudgetView>({ state: 'ok' });
  // M4 账本：事件驱动的按 id upsert。`ledger.recorded` 与 `ledger.updated`
  // 共用同一条 upsert 路径 —— 这正是当初把 settle/adopt 合成一个事件的理由。
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [policy, setPolicy] = useState<AdoptionPolicy>({ mode: 'human' });
  const [pending, setPending] = useState<PendingRequest[]>([]);

  const upsertRecord = useCallback((record: LedgerRecord) => {
    setLedger((prev) => {
      const i = prev.findIndex((r) => r.id === record.id);
      if (i < 0) return [record, ...prev].slice(0, 200);
      const next = prev.slice();
      next[i] = record;
      return next;
    });
  }, []);

  const pushLog = useCallback((text: string, cls?: LogLine['cls']) => {
    const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLog((prev) => [...prev.slice(-(LOG_CAP - 1)), { at, text, cls }]);
  }, []);

  const reloadRoles = useCallback(async () => {
    const res = await window.axon.invoke('role.list', {});
    setRoles(res.entries);
    setIssues(res.issues);
  }, []);

  const reloadAgents = useCallback(async () => {
    setAgents(await window.axon.invoke('agent.list', {}));
  }, []);

  /** 当前会话（找不到就是 null：列表可能还没拉回来，或会话刚被删）。 */
  const current = sessions.find((s) => s.record.id === currentId) ?? null;
  const rootPath = current?.rootPath ?? '';

  /**
   * 选中的节点必须落在当前会话里。
   *
   * 三个入路：会话刚切换、会话根刚拿到、被选中的节点被删了。统一收敛到
   * 「不在本会话 ⇒ 回到会话根」—— 否则右栏会对着一棵不在显示范围内的树发指令。
   */
  useEffect(() => {
    if (!rootPath) return;
    setSelected((prev) => {
      if (prev === rootPath) return prev;
      const inSession = agents.some((a) => a.path === prev && a.sessionId === current?.record.id);
      return inSession ? prev : rootPath;
    });
  }, [rootPath, current?.record.id, agents]);

  const createSession = useCallback(async () => {
    try {
      const s = await window.axon.invoke('session.create', {
        title: '新会话',
        // 临时壳只开单兵会话：组队要选团队/挑成员，那是 S0 三张卡的活（MU-2）。
        executor: 'engine',
      });
      // 用户按的按钮，选中权归用户：不经事件，直接落。
      setCurrentId(s.record.id);
      pushLog(`+ 会话「${s.record.title}」已开（${s.rootPath}）`);
    } catch (err) {
      pushLog(`✗ ${(err as Error).message}`, 'e');
    }
  }, [pushLog]);

  const removeSession = useCallback(
    async (id: string) => {
      const { removedPaths } = await window.axon.invoke('session.remove', { sessionId: id });
      pushLog(`- 会话已删（连带 ${removedPaths.length} 个节点）`);
    },
    [pushLog],
  );

  /**
   * 冷启动/刷新时补齐 M4 的三份状态。
   *
   * 必须拉：账本、挂起待办、预算档位都是**事件驱动**的，
   * 只订阅不拉取的话，刷新一次窗口就把在途待办和 frozen 状态丢光了。
   */
  const reloadM4 = useCallback(async () => {
    const sid = sessionRef.current;
    const [q, p, pol, b] = await Promise.all([
      // MU-1：账本按会话切片（跨会话的账本没有语义）。
      window.axon.invoke('ledger.query', {
        limit: 200,
        ...(sid ? { sessionId: sid } : {}),
      }),
      window.axon.invoke('pending.list', {}),
      window.axon.invoke('ledger.getAdoptionPolicy', {}),
      window.axon.invoke('budget.get', {}),
    ]);
    setLedger(q.records);
    setPending(p);
    setPolicy(pol);
    setBudget({ state: b.state, usage: b.usage, spentUsd: b.spentUsd, hardUsd: b.hardUsd });
  }, []);

  useEffect(() => {
    sessionRef.current = currentId;
    // 切会话 = 换一份账本/挂起/预算：重拉（事件流只推增量，不重放历史）。
    void reloadM4();
    // 成员快照同理：建会话时不会发 agent.created（整棵树是一次性挂上去的），
    // 只订阅 agent.* 的话，新会话的树在界面上是空的。
    void reloadAgents();
  }, [currentId, reloadM4]);

  useEffect(() => {
    // 初始快照 + 事件订阅。unsub 收集起来，卸载时全部退订。
    // 账本/挂起/预算随会话切换重拉（sessionRef 在 effect 里同步，故此处只挂一次）。
    void reloadRoles();
    void reloadAgents();
    void reloadM4();
    // MU-1：多根模型下没有「总是存在的 /root」——调试壳先确保有一个会话可用，
    // 否则界面上根本没有可以挂分身的树（手工演示也因此不用先点一遍新建）。
    void (async () => {
      const list = await window.axon.invoke('session.list', {});
      if (list.length === 0) {
        await window.axon.invoke('session.create', {
          title: '调试会话',
          executor: 'engine',
        });
        return; // session.created 事件会把它放进列表并选中
      }
      setSessions(list);
      setCurrentId(list[0]!.record.id);
    })();
    const unsubs = [
      window.axon.subscribe('roles.changed', ({ entries, issues: iss }) => {
        setRoles(entries);
        setIssues(iss);
        pushLog('角色集合已更新（保存/热重载）', 't');
      }),
      window.axon.subscribe('agent.created', ({ snapshot }) => {
        pushLog(`${snapshot.path} 已就绪`);
        void reloadAgents();
      }),
      window.axon.subscribe('agent.status', ({ path, status, error }) => {
        pushLog(`${path} → ${status}${error ? `：${error}` : ''}`, error ? 'e' : 't');
        void reloadAgents();
      }),
      window.axon.subscribe('agent.removed', ({ paths }) => {
        pushLog(`- 已移除 ${paths.length} 个 Agent`);
        // 回到「未定选」：由上面的 effect 收敛到会话根（它才知道该回哪）。
        setSelected((prev) => (paths.includes(prev) ? '' : prev));
        void reloadAgents();
      }),
      window.axon.subscribe('agent.tool.start', ({ tool }, meta) => {
        pushLog(`[${meta.source}] 工具 ${tool}`, 't');
      }),
      window.axon.subscribe('agent.message.end', ({ message }, meta) => {
        const text = (message.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('');
        if (text.trim()) pushLog(`[${meta.source}] ${text}`);
      }),
      window.axon.subscribe('agent.turn.end', ({ usage }, meta) => {
        pushLog(
          `[${meta.source}] 本轮 ${usage.inputTokens}/${usage.outputTokens} tok`,
          't',
        );
        void reloadAgents();
      }),
      window.axon.subscribe('budget.warning', (p) => {
        // scope='session' 是会话档（三层取更严者）自己的线，另有会话行显示；
        // 不能拿它去覆盖全局 banner —— 否则全局还有余量时 banner 也会变红。
        if (p.scope === 'session') {
          pushLog(`⚠ 会话预算警告：已用 $${usd(p.spentUsd)} / 上限 $${usd(p.hardUsd)}`, 'w');
          return;
        }
        setBudget({ state: 'warning', usage: p.usage, spentUsd: p.spentUsd, hardUsd: p.hardUsd });
        pushLog(`⚠ 预算警告：已用 $${usd(p.spentUsd)} / 上限 $${usd(p.hardUsd)}`, 'w');
      }),
      window.axon.subscribe('budget.frozen', (p) => {
        if (p.scope === 'session') {
          pushLog('✗ 会话预算已冻结：本会话的新任务会被拒', 'e');
          return;
        }
        setBudget({ state: 'frozen', usage: p.usage, spentUsd: p.spentUsd, hardUsd: p.hardUsd });
        pushLog(`✗ 预算冻结：已用 $${usd(p.spentUsd)} / 上限 $${usd(p.hardUsd)}，新任务被拒绝`, 'e');
      }),

      // ── MU-1 会话 ──
      window.axon.subscribe('session.created', ({ summary }) => {
        setSessions((prev) => upsertSession(prev, summary));
        // 只在「手上一个都没有」时接管选中：否则冷启动自动补的调试会话会
        // 把用户刚点开的那一个抢走（选谁是用户意志，事件不许替用户决定）。
        setCurrentId((prev) => prev ?? summary.record.id);
        pushLog(`+ 会话 ${summary.record.title}（${summary.rootPath}）`);
      }),
      // 会话摘要是高频事件（主进程已节流到 ≤4Hz）：整体替换该条即可。
      window.axon.subscribe('session.changed', ({ summary }) => {
        setSessions((prev) => upsertSession(prev, summary));
      }),
      window.axon.subscribe('session.removed', ({ sessionId, paths }) => {
        setSessions((prev) => prev.filter((s) => s.record.id !== sessionId));
        setCurrentId((prev) => (prev === sessionId ? null : prev));
        setSelected((prev) => (paths.includes(prev) ? '' : prev));
        void reloadAgents();
      }),

      // ── M4 协作账本 ──
      window.axon.subscribe('ledger.recorded', ({ record }) => {
        // 只显示当前会话的账：主进程把全部会话的账都播出来（它们都真实发生），
        // 分片是呈现层的选择。
        if (record.sessionId !== sessionRef.current) return;
        upsertRecord(record);
        pushLog(`≡ ${record.from} → ${record.to}（${record.action}）`, 't');
      }),
      window.axon.subscribe('ledger.updated', ({ record }) => {
        if (record.sessionId !== sessionRef.current) return;
        upsertRecord(record);
      }),
      window.axon.subscribe('ledger.policyChanged', ({ policy: p }) => {
        setPolicy(p);
        pushLog(
          p.mode === 'human'
            ? '裁决策略：人工'
            : `裁决策略：委派给 ${'arbiterRole' in p ? p.arbiterRole : p.arbiter}`,
          'k',
        );
      }),

      // ── M4 审批穿透 ──
      // 能到这里的都是父链已经消化不了的，一律当人的待办。
      window.axon.subscribe('approval.request', (req) => {
        setPending((prev) => [
          ...prev,
          { ...req, kind: 'approval' as const, at: Date.now(), state: 'pending' as const },
        ]);
        pushLog(`✋ ${req.origin} 请求执行 ${req.tool}，等你表态`, 'w');
      }),
      window.axon.subscribe('pending.resolved', ({ requestId, outcome }) => {
        setPending((prev) => prev.filter((p) => p.requestId !== requestId));
        if (outcome === 'expired') pushLog('✗ 审批超时，按拒绝处理', 'e');
      }),
    ];
    pushLog('Axon 已启动。点击左侧角色创建分身。', 'k');
    // 冒烟探针：初始两轮 invoke 成功 = IPC 往返 + React 挂载正常。
    console.log('[renderer] boot ok');
    return () => unsubs.forEach((u) => u());
    // eslint 会嫌依赖数组不完整，但这是「仅挂载时执行一次」的标准形态：
    // pushLog/reload* 都是 setState 包装，稳定无副作用。
  }, [pushLog, reloadRoles, reloadAgents, reloadM4, upsertRecord]);

  const adopt = useCallback(
    async (id: string, adoption: 'adopted' | 'rejected') => {
      const { record } = await window.axon.invoke('ledger.adopt', { id, adoption });
      upsertRecord(record); // 事件也会到，但同步回写让点击手感不延迟
      pushLog(`${adoption === 'adopted' ? '✓ 已采纳' : '✗ 已驳回'} ${id}`, 'k');
    },
    [pushLog, upsertRecord],
  );

  const changePolicy = useCallback(async (next: AdoptionPolicy) => {
    const { policy: p } = await window.axon.invoke('ledger.setAdoptionPolicy', { policy: next });
    setPolicy(p);
  }, []);

  const respondApproval = useCallback(
    async (requestId: string, approved: boolean) => {
      await window.axon.invoke('approval.respond', { requestId, approved });
      setPending((prev) => prev.filter((p) => p.requestId !== requestId));
      pushLog(approved ? '✓ 已批准' : '✗ 已拒绝', approved ? 'k' : 'e');
    },
    [pushLog],
  );

  const spawn = useCallback(
    async (role: RoleEntry) => {
      // 挂当前会话根（文档 §4.10）：临时壳不做「挂在选中节点下」的精细操作 ——
      // 那需要把树的交互做对，是 MU-2 的活。至少保证不挂到别的会话里去。
      if (!rootPath) {
        pushLog('✗ 还没有会话：先点「+ 新建」', 'e');
        return;
      }
      try {
        const snap = await window.axon.invoke('agent.spawn', {
          role: role.role.name,
          parent: rootPath,
          sessionId: currentId ?? undefined,
        });
        pushLog(`+ 创建 ${snap.displayName} → ${snap.path}`);
        // 立即选中新生节点，跟随其后续消息
        setSelected(snap.path);
      } catch (err) {
        pushLog(`✗ ${(err as Error).message}`, 'e');
      }
    },
    [rootPath, currentId, pushLog],
  );

  const send = useCallback(
    async (text: string) => {
      pushLog(`> ${text}`, 'k');
      try {
        await window.axon.invoke('agent.prompt', { path: selected, text });
      } catch (err) {
        pushLog(`✗ ${(err as Error).message}`, 'e');
      }
    },
    [selected, pushLog],
  );

  const interrupt = useCallback(async () => {
    await window.axon.invoke('agent.interrupt', { path: selected });
  }, [selected]);

  const removeAgent = useCallback(async () => {
    if (!selected || selected === rootPath) return; // 会话根用「删会话」，不是删节点
    const { removed } = await window.axon.invoke('agent.remove', { path: selected });
    pushLog(`- 已移除 ${removed.length} 个 Agent`);
  }, [selected, rootPath, pushLog]);

  const openRoleDir = useCallback(async () => {
    const { path } = await window.axon.invoke('role.openDir', {});
    pushLog(`角色目录：${path}`, 't');
  }, [pushLog]);

  const saveRole = useCallback(
    async (role: RoleEntry['role']): Promise<readonly RoleIssue[]> => {
      const res = await window.axon.invoke('role.save', { role });
      if (res.accepted) {
        setEditor(null);
        pushLog(`✓ 已保存角色 ${role.name}`);
        void reloadRoles(); // roles.changed 事件也会到，但同步拉一次更稳
        return [];
      }
      return res.errors;
    },
    [pushLog, reloadRoles],
  );

  const deleteRole = useCallback(
    async (name: string) => {
      await window.axon.invoke('role.delete', { name });
      pushLog(`✓ 已删除角色 ${name}`);
      void reloadRoles();
    },
    [pushLog, reloadRoles],
  );

  return (
    <>
      <aside>
        <SessionPanel
          sessions={sessions}
          currentId={currentId}
          onSelect={setCurrentId}
          onCreate={() => void createSession()}
          onRemove={(id) => void removeSession(id)}
        />
        <RolePanel
          roles={roles}
          issues={issues}
          onSpawn={(role) => void spawn(role)}
          onCreate={() => setEditor({ mode: 'create' })}
          onEdit={(entry) =>
            setEditor({ mode: 'create', seed: entry.role, editing: entry.role.name })
          }
          onDelete={(name) => {
            if (window.confirm(`删除角色 ${name}？此操作不可撤销。`)) {
              void deleteRole(name);
            }
          }}
          onOpenDir={() => void openRoleDir()}
        />
        <AgentTree
          agents={current ? agents.filter((a) => a.sessionId === current.record.id) : []}
          rootPath={rootPath}
          selected={selected}
          onSelect={setSelected}
        />
        <LedgerPanel
          records={ledger}
          policy={policy}
          arbiterRoles={roles.map((e) => e.role.name)}
          onAdopt={(id, a) => void adopt(id, a)}
          onPolicyChange={(p) => void changePolicy(p)}
        />
      </aside>
      <main>
        <ApprovalInbox pending={pending} onRespond={(id, ok) => void respondApproval(id, ok)} />
        {current && current.budget.tier !== 'ok' && (
          // 会话口径那行（MU-1）：三层取更严者之后，这个会话自己离熔断线还有多远。
          <div className={`budget session ${current.budget.tier}`} data-smoke="session-budget-banner">
            {`本会话：已用 $${usd(current.budget.spentUsd)} ／生效上限 $${usd(current.budget.effectiveHardUsd)}${
              current.budget.limitedBy === 'global'
                ? '（全局更紧）'
                : current.budget.limitedBy === 'team'
                  ? '（团队预算更紧）'
                  : ''
            } —— ${current.budget.tier === 'frozen' ? '本会话新任务会被拒绝' : '接近熔断线'}`}
          </div>
        )}
        {budget.state !== 'ok' && (
          <div className={`budget ${budget.state}`} data-smoke="budget-banner">
            {budget.state === 'frozen'
              ? `预算已冻结（已用 $${usd(budget.spentUsd)} ／上限 $${usd(budget.hardUsd)}）：新分身与新任务被拒绝，在跑任务不受影响。`
              : `预算警告（已用 $${usd(budget.spentUsd)} ／上限 $${usd(budget.hardUsd)}）：接近熔断线，注意成本。`}
          </div>
        )}
        <EventLog lines={log} />
        <Composer
          onSend={(text) => void send(text)}
          onInterrupt={() => void interrupt()}
          onRemove={() => void removeAgent()}
          canRemove={selected !== '' && selected !== rootPath}
          disabled={budget.state === 'frozen'}
          disabledReason="预算已冻结"
        />
      </main>
      {editor && (
        <RoleEditor
          seed={editor.seed}
          editing={editor.editing}
          onClose={() => setEditor(null)}
          onSave={(role) => saveRole(role)}
        />
      )}
    </>
  );
}
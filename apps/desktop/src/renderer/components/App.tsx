/**
 * App —— 唯一的顶层状态持有者。
 *
 * 薄壳纪律（AGENTS.md §4/§5）：这里只保存**呈现所需**的状态快照，
 * 所有真相在主进程（AxonHost）。事件流推什么，这里就同步到什么；
 * 任何 invoke 只发意图，不做编排决策。
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AgentPath,
  AgentSnapshot,
  RoleEntry,
  RoleIssue,
  UsageTotals,
} from '@axon/protocol';
import { RolePanel } from './RolePanel.tsx';
import { AgentTree } from './AgentTree.tsx';
import { EventLog, type LogLine } from './EventLog.tsx';
import { Composer } from './Composer.tsx';
import { RoleEditor } from './RoleEditor.tsx';

const LOG_CAP = 500;

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
  const [selected, setSelected] = useState<AgentPath>('/root');
  const [log, setLog] = useState<LogLine[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [budget, setBudget] = useState<BudgetView>({ state: 'ok' });

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

  useEffect(() => {
    // 初始快照 + 事件订阅。unsub 收集起来，卸载时全部退订。
    void reloadRoles();
    void reloadAgents();
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
        setSelected((prev) => (paths.includes(prev) ? '/root' : prev));
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
      window.axon.subscribe('budget.warning', ({ usage, spentUsd, hardUsd }) => {
        setBudget({ state: 'warning', usage, spentUsd, hardUsd });
        pushLog(`⚠ 预算警告：已用 $${usd(spentUsd)} / 上限 $${usd(hardUsd)}`, 'w');
      }),
      window.axon.subscribe('budget.frozen', ({ usage, spentUsd, hardUsd }) => {
        setBudget({ state: 'frozen', usage, spentUsd, hardUsd });
        pushLog(`✗ 预算冻结：已用 $${usd(spentUsd)} / 上限 $${usd(hardUsd)}，新任务被拒绝`, 'e');
      }),
    ];
    pushLog('Axon 已启动。点击左侧角色创建分身。', 'k');
    // 冒烟探针：初始两轮 invoke 成功 = IPC 往返 + React 挂载正常。
    console.log('[renderer] boot ok');
    return () => unsubs.forEach((u) => u());
    // eslint 会嫌依赖数组不完整，但这是「仅挂载时执行一次」的标准形态：
    // pushLog/reload* 都是 setState 包装，稳定无副作用。
  }, [pushLog, reloadRoles, reloadAgents]);

  const spawn = useCallback(
    async (role: RoleEntry) => {
      try {
        const snap = await window.axon.invoke('agent.spawn', {
          role: role.role.name,
          parent: selected,
        });
        pushLog(`+ 创建 ${snap.displayName} → ${snap.path}`);
        // 立即选中新生节点，跟随其后续消息
        setSelected(snap.path);
      } catch (err) {
        pushLog(`✗ ${(err as Error).message}`, 'e');
      }
    },
    [selected, pushLog],
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
    if (selected === '/root') return;
    const { removed } = await window.axon.invoke('agent.remove', { path: selected });
    pushLog(`- 已移除 ${removed.length} 个 Agent`);
  }, [selected, pushLog]);

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
          agents={agents}
          selected={selected}
          onSelect={setSelected}
        />
      </aside>
      <main>
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
          canRemove={selected !== '/root'}
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
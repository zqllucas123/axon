/**
 * 展示口径层 —— 只放纯函数（协议数据 → 要渲染的东西）。
 *
 * 为什么单独一个文件：L3 薄壳纪律（AGENTS.md §4.3 / ux 01 §5）要求组件只做
 * 「渲染 + 发意图」，凡「这个状态该显示成什么」的判断都必须集中在这里，
 * 便于单测与逐值对齐原型（01 §2：状态色只有 run/idle/wait/err/done 五档）。
 */

import type { AgentPath, AgentSnapshot, AgentStatus, PendingRequest, SessionSummary } from '@axon/protocol';
import type { SessionView } from './types.ts';

/** 状态点类名（axon.css 的 .sdot 五档）。running→run、waiting→wait… */
export function statusDot(status: AgentStatus): 'run' | 'idle' | 'wait' | 'err' | 'done' {
  switch (status) {
    case 'running':
      return 'run';
    case 'waiting':
      return 'wait';
    case 'failed':
      return 'err';
    case 'done':
      return 'done';
    // interrupted = 上次运行被打断（M5 恢复后落回 idle 前的历史态）。
    // 原型没有第六档颜色，按灰点处理，靠文案区分。
    default:
      return 'idle';
  }
}

/** 状态的中文标签（会话条 / 成员行 / 总览共用同一套口径）。 */
export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'waiting':
      return '等待中';
    case 'failed':
      return '失败';
    case 'done':
      return '已完成';
    case 'interrupted':
      return '已中断';
    default:
      return '空闲';
  }
}

/** 终止态：进左栏「最近」分组（原型 shell.js 的 SESSIONS_DONE 口径）。 */
export function isTerminal(status: AgentStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'interrupted';
}

/** 左栏会话行的 meta：团队会话给团队名，单兵给「单兵」（原型 shell.js 口径）。 */
export function sessionMeta(s: SessionSummary): string {
  return s.team ? s.team.name : '单兵';
}

/** 左栏两个分组：终止态进「最近」，其余进「进行中」（都按 updatedAt 倒序）。 */
export function splitSessions(sessions: SessionSummary[]): {
  active: SessionSummary[];
  recent: SessionSummary[];
} {
  const byRecent = [...sessions].sort((a, b) => b.record.updatedAt - a.record.updatedAt);
  const active: SessionSummary[] = [];
  const recent: SessionSummary[] = [];
  for (const s of byRecent) (isTerminal(s.status) ? recent : active).push(s);
  return { active, recent };
}

/** 顶栏 chip 的跨会话口径（全局屏用；会话屏一律用 sessionChips）。 */
export function globalChips(input: {
  sessions: SessionSummary[];
  pending: PendingRequest[];
}): { activeSessions: number; pendingAll: number } {
  return {
    activeSessions: splitSessions(input.sessions).active.length,
    pendingAll: input.pending.filter((p) => p.state === 'pending').length,
  };
}

/** 会话屏 chip 的本会话口径（counts 由主进程算好，渲染层不重新累加）。 */
export function sessionChips(s: SessionSummary | null): {
  pending: number;
  ledger: number;
  running: number;
  members: number;
} {
  if (!s) return { pending: 0, ledger: 0, running: 0, members: 0 };
  return {
    pending: s.counts.pending,
    ledger: s.counts.ledger,
    running: s.counts.running,
    members: s.counts.members,
  };
}

/** 会话内视图的中文名（会话条 seg）。 */
export const VIEW_LABEL: Record<SessionView, string> = {
  chat: '对话',
  ledger: '账本',
  usage: '用量',
};

/** 成员树节点（扁平快照 → 树；父不在本会话时挂到顶层，避免丢人）。 */
export interface MemberNode {
  snapshot: AgentSnapshot;
  depth: number;
  children: MemberNode[];
}

export function buildMemberTree(members: AgentSnapshot[]): MemberNode[] {
  const byPath = new Map<AgentPath, AgentSnapshot>();
  for (const m of members) byPath.set(m.path, m);
  const childrenOf = new Map<AgentPath, AgentSnapshot[]>();
  const roots: AgentSnapshot[] = [];
  for (const m of members) {
    if (!m.parent || !byPath.has(m.parent)) {
      roots.push(m);
      continue;
    }
    const list = childrenOf.get(m.parent) ?? [];
    list.push(m);
    childrenOf.set(m.parent, list);
  }
  const order = (a: AgentSnapshot, b: AgentSnapshot) => a.path.localeCompare(b.path);
  const walk = (snap: AgentSnapshot, depth: number): MemberNode => ({
    snapshot: snap,
    depth,
    children: (childrenOf.get(snap.path) ?? []).sort(order).map((k) => walk(k, depth + 1)),
  });
  return roots.sort(order).map((r) => walk(r, 0));
}

/** 从 path 取叶子段（`/0/1/2` → '2'），成员行右侧显示（原型用 mono meta）。 */
export function leafOf(path: AgentPath): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? (parts[parts.length - 1] as string) : path;
}

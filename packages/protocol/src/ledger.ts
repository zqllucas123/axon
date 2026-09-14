/**
 * Axon 协作账本 —— 协议层类型。
 *
 * 设计取自 tutti 的 collaboration_runs（见 docs/02 §3.2）：协作不是自由消息，
 * 而是**四种枚举动作**，每一次都由「哪个 turn 的哪次 tool call」派生，落成一行账。
 *
 * 这个文件只放纯类型与纯常量，不得引入运行时依赖。
 */

import type { AgentPath, ForkModeSpec, UsageTotals } from './agent.ts';

// ─────────────────────────────────────────────────────────────
// 枚举
// ─────────────────────────────────────────────────────────────

/**
 * 协作动作四枚举（对齐 tutti collabrun.Mode）。
 *
 * 为什么是枚举而不是通用消息总线：总线会让「A 给 B 发了什么」变成不可分析的自由文本，
 * 账本也就无从裁决。枚举化之后每一笔协作都有确定的语义与终态。
 */
export type CollabAction = 'consult' | 'fork' | 'delegate' | 'handoff';

export const COLLAB_ACTIONS: readonly CollabAction[] = Object.freeze([
  'consult',
  'fork',
  'delegate',
  'handoff',
]);

/**
 * 裁决状态。
 * - consult / delegate：产出需要被采纳，默认 `pending`
 * - fork / handoff：交接语义本身即完成，无需裁决，直接 `not_applicable`
 */
export type Adoption = 'pending' | 'adopted' | 'rejected' | 'not_applicable';

/** 记录生命周期：发起时 open，目标进入终态时 settled。 */
export type LedgerStatus = 'open' | 'settled';

/** 账本 schema 版本外箱 —— M5 落盘时不必改形状（docs/03 §7）。 */
export const LEDGER_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────
// 记录
// ─────────────────────────────────────────────────────────────

/**
 * 谁做的裁决。
 *
 * 自动裁决必须与人工裁决**在账本上可区分** —— 否则开了 AutoAdoption 之后，
 * 整本账就失去了「这条是人看过的」这个最关键的信息。
 */
export type AdoptedBy =
  | { kind: 'human' }
  | { kind: 'agent'; path: AgentPath; policyAt: number };

/** 派生这笔协作的工具调用（tutti session_types.go:288-293 的「哪次 tool call」）。 */
export interface CollabOrigin {
  tool: string;
  toolCallId: string;
}

export interface LedgerRecord {
  version: number;
  /** 单调递增序号 + 随机后缀，保证排序稳定且不猜测。 */
  id: string;
  action: CollabAction;
  /** 发起方。永远是 agent —— M4 不做人工发起（决策 D1）。 */
  from: AgentPath;
  to: AgentPath;
  origin: CollabOrigin;
  /** 交接载体：URI 引用，不拷贝 transcript（docs/01 §6.4）。 */
  mention: string;
  /** 上下文口径，与 AgentSnapshot.forkMode 同源。 */
  contextScope?: ForkModeSpec;

  adoption: Adoption;
  adoptedAt?: number;
  adoptedNote?: string;
  adoptedBy?: AdoptedBy;

  /**
   * 这笔协作的**增量**消耗（子树 usage 快照差值，非累计）。
   *
   * 注意：并发协作下差值会重叠计数。这是归因估算，唯一权威是 root 累计
   * （预算熔断吃的那个）。详见 docs/milestones/M4 §6。
   */
  usage?: UsageTotals;

  status: LedgerStatus;
  at: number;
  settledAt?: number;
  /** 目标终态时的最后一条 assistant 文本预览（已截断）。 */
  summary?: string;
}

/** summary 的截断长度；超出部分丢弃并追加省略号。 */
export const LEDGER_SUMMARY_MAX = 500;

/** 内存账本上限；超出丢最旧（M5 落盘后改为分页读）。 */
export const LEDGER_MAX_RECORDS = 10_000;

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

export interface LedgerQuery {
  /** 限定与某 agent 相关（from 或 to 命中）。 */
  agent?: AgentPath;
  /** 与 agent 同用时，把子树内的 agent 也算命中。 */
  subtree?: boolean;
  action?: CollabAction[];
  adoption?: Adoption[];
  status?: LedgerStatus[];
  /** 默认 100。 */
  limit?: number;
  /** 游标：只取 id 严格小于它的记录（按时间倒序翻页）。 */
  before?: string;
}

export interface LedgerQueryResult {
  records: LedgerRecord[];
  /** 过滤后的总数（不受 limit/before 影响），用于 UI 显示「共 N 笔」。 */
  total: number;
}

// ─────────────────────────────────────────────────────────────
// 裁决策略（决策 D2：默认人工，可委派给指定 Agent）
// ─────────────────────────────────────────────────────────────

/**
 * 谁来对 pending 记录表态。
 *
 * 默认 `human`。委派给 Agent 时受三条硬约束（见 docs/milestones/M4 §4.5）：
 *  1. 裁决者不得是被裁决方 `to` 或其后代 —— 否则就是自己给自己发合格证
 *  2. 裁决必须留署名（`LedgerRecord.adoptedBy`）
 *  3. 裁决权靠 `ledger_adopt` 工具行使，且由 host 在运行期校验身份
 */
export type AdoptionPolicy =
  | { mode: 'human' }
  | { mode: 'delegate'; arbiter: AgentPath }
  | { mode: 'delegate'; arbiterRole: string };

export const DEFAULT_ADOPTION_POLICY: AdoptionPolicy = Object.freeze({ mode: 'human' });

/** 一笔记录默认该落哪个 adoption 值。 */
export function initialAdoption(action: CollabAction): Adoption {
  return action === 'fork' || action === 'handoff' ? 'not_applicable' : 'pending';
}

/** 该动作的产出是否需要裁决。 */
export function needsAdoption(action: CollabAction): boolean {
  return initialAdoption(action) === 'pending';
}

/** 构造指向某 Agent 会话的引用 URI（不拷贝 transcript）。 */
export function mentionUri(path: AgentPath): string {
  return `mention://agent-session${path}`;
}

/** 解析 mention URI 回 AgentPath；格式不符返回 undefined。 */
export function parseMentionUri(uri: string): AgentPath | undefined {
  const prefix = 'mention://agent-session';
  if (!uri.startsWith(prefix)) return undefined;
  const path = uri.slice(prefix.length);
  return path.startsWith('/') ? path : undefined;
}

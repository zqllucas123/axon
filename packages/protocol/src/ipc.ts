/**
 * 渲染进程 ↔ 内核 的通信契约。
 *
 * 设计原则：渲染进程只发**意图**，不持有 Agent 实例，也不做任何编排决策。
 * 所有状态的唯一真相在 kernel 侧，UI 通过事件流被动同步。
 * 这样 kernel 换宿主（CLI / 测试 / 未来的 server）时，UI 契约不用动。
 */

import type {
  AgentPath,
  AgentSnapshot,
  AgentStatus,
  ApprovalMode,
  ForkModeSpec,
  MessageLike,
  RoleDefinition,
  RoleEntry,
  RoleIssue,
  UsageTotals,
} from './agent.ts';
import type {
  Adoption,
  AdoptionPolicy,
  LedgerQuery,
  LedgerQueryResult,
  LedgerRecord,
} from './ledger.ts';

// ─────────────────────────────────────────────────────────────
// 信封
// ─────────────────────────────────────────────────────────────

export interface RequestEnvelope<C extends keyof CommandMap = keyof CommandMap> {
  id: string;
  command: C;
  payload: CommandMap[C]['payload'];
}

export interface ProtocolError {
  code: string;
  message: string;
  detail?: unknown;
}

export type ResponseEnvelope<C extends keyof CommandMap = keyof CommandMap> =
  | { id: string; ok: true; result: CommandMap[C]['result'] }
  | { id: string; ok: false; error: ProtocolError };

export interface NotificationEnvelope<E extends keyof EventMap = keyof EventMap> {
  event: E;
  payload: EventMap[E];
  /** 事件来自哪个 agent；UI 据此把事件路由到树上的节点。 */
  source: AgentPath;
  at: number;
}

// ─────────────────────────────────────────────────────────────
// 命令（渲染 → 内核，有应答）
// ─────────────────────────────────────────────────────────────

export interface SpawnAgentPayload {
  role: string;
  /** 省略则挂在 ROOT 下。 */
  parent?: AgentPath;
  /** 覆盖角色默认的分身模式。 */
  forkMode?: ForkModeSpec;
  /** 一次性覆写，不落盘。 */
  overrides?: Partial<Pick<RoleDefinition, 'displayName' | 'instructions' | 'model'>>;
  /** 创建后立即投喂的首条任务。 */
  initialPrompt?: string;
}

export interface CommandMap {
  'agent.spawn': { payload: SpawnAgentPayload; result: AgentSnapshot };
  'agent.list': { payload: Record<string, never>; result: AgentSnapshot[] };
  'agent.get': { payload: { path: AgentPath }; result: AgentSnapshot | null };
  'agent.messages': { payload: { path: AgentPath }; result: MessageLike[] };
  'agent.prompt': { payload: { path: AgentPath; text: string }; result: { accepted: true } };
  'agent.interrupt': { payload: { path: AgentPath }; result: { accepted: true } };
  /** 级联删除整棵子树。 */
  'agent.remove': { payload: { path: AgentPath }; result: { removed: AgentPath[] } };

  'role.list': {
    payload: Record<string, never>;
    result: { entries: RoleEntry[]; issues: RoleIssue[] };
  };
  /** 创建或覆盖同名用户角色；校验失败时 accepted=false 且带 errors。 */
  'role.save': {
    payload: { role: RoleDefinition };
    result: { accepted: boolean; errors: RoleIssue[] };
  };
  /** 删除用户角色文件；不存在视为已删除（幂等）。 */
  'role.delete': { payload: { name: string }; result: { deleted: boolean; errors: RoleIssue[] } };
  /** 让操作系统开文件管理器定位到角色目录；只读便捷操作。 */
  'role.openDir': { payload: Record<string, never>; result: { path: string } };

  /** 回应内核发起的审批请求。 */
  'approval.respond': {
    payload: { requestId: string; approved: boolean; note?: string };
    result: { accepted: true };
  };
  /** 回应内核发起的提问（Axon5 人机交互用）。 */
  'question.respond': {
    payload: { requestId: string; answer: string };
    result: { accepted: true };
  };
  /** 重连后拉取尚未回应的挂起请求，避免 UI 刷新丢失待办。 */
  'pending.list': { payload: Record<string, never>; result: PendingRequest[] };

  /** 查询协作账本；过滤条件见 LedgerQuery。 */
  'ledger.query': { payload: LedgerQuery; result: LedgerQueryResult };
  'ledger.get': { payload: { id: string }; result: LedgerRecord | null };
  /** 人工裁决一笔协作产出。 */
  'ledger.adopt': {
    payload: { id: string; adoption: Adoption; note?: string };
    result: { record: LedgerRecord };
  };
  'ledger.getAdoptionPolicy': { payload: Record<string, never>; result: AdoptionPolicy };
  /** 切换裁决策略（人工 / 委派给指定 Agent）。 */
  'ledger.setAdoptionPolicy': {
    payload: { policy: AdoptionPolicy };
    result: { policy: AdoptionPolicy };
  };

  /** 拉当前预算档位；frozen 是终态，没有查询通道 UI 刷新后就瞎了。 */
  'budget.get': { payload: Record<string, never>; result: BudgetSnapshot };
}

/**
 * 挂起中的待办（审批 / 提问）。
 *
 * `chain` 是审批穿透路径（origin → … → root，抄 TabTin subagent-hitl）：
 * UI 要能说清「这个请求是替谁问的、经过了谁」，否则深层子 Agent 的请求
 * 冒到人面前时完全没有来源感。
 */
export interface PendingRequest {
  requestId: string;
  kind: 'approval' | 'question';
  /** 谁要动手。 */
  origin: AgentPath;
  chain: AgentPath[];
  tool?: string;
  args?: unknown;
  /** 该 agent 生效的审批档。 */
  approvalMode?: ApprovalMode;
  message: string;
  detail?: unknown;
  at: number;
  /** 超时时刻；超时按拒绝处理并把原因回灌给模型。 */
  expiresAt?: number;
  state: 'pending' | 'resolved';
}

/** 预算档位快照。 */
export interface BudgetSnapshot {
  state: 'ok' | 'warning' | 'frozen';
  /** 已累计花费。 */
  spentUsd: number;
  /** 软线；disabled 时无意义。 */
  softUsd: number;
  /** 硬线；<= 0 表示熔断关闭。 */
  hardUsd: number;
  disabled: boolean;
  usage: UsageTotals;
}

// ─────────────────────────────────────────────────────────────
// 事件（内核 → 渲染，单向推送）
// ─────────────────────────────────────────────────────────────

export interface EventMap {
  'agent.created': { snapshot: AgentSnapshot };
  'agent.status': { path: AgentPath; status: AgentStatus; error?: string };
  'agent.removed': { paths: AgentPath[] };

  /** 流式输出三段式：start → delta* → end。 */
  'agent.message.start': { messageId: string };
  'agent.message.delta': { messageId: string; text: string };
  'agent.message.end': { messageId: string; message: MessageLike };

  'agent.tool.start': { callId: string; tool: string; args: unknown };
  'agent.tool.update': { callId: string; chunk: string };
  'agent.tool.end': { callId: string; ok: boolean; result?: unknown; error?: string };

  'agent.turn.end': { usage: UsageTotals };

  /**
   * 角色集合变化（保存/删除/编辑器外部改文件后热重载）。UI 直接拿 entries 重绘。
   *
   * 注意这里**没有** `agent.message.received`：Agent 间通信的唯一口径是账本
   * （`ledger.recorded`）。留一个平行的轻通知事件会让 UI 出现两份互相矛盾的
   * 协作记录（M4 决策 D3）。
   */
  'roles.changed': { entries: RoleEntry[]; issues: RoleIssue[] };

  /** 工具执行前的 HITL 门；沿父链穿透后仍无人代批时才发到人面前。 */
  'approval.request': {
    requestId: string;
    /** 谁要动手。 */
    origin: AgentPath;
    /** 穿透路径 origin → … → root。 */
    chain: AgentPath[];
    tool: string;
    args: unknown;
    approvalMode: ApprovalMode;
    message: string;
    expiresAt?: number;
  };
  'question.request': { requestId: string; message: string };
  /** 请求已有结果（被回应 / 超时 / agent 消失），UI 据此摘掉待办。 */
  'pending.resolved': {
    requestId: string;
    outcome: 'approved' | 'denied' | 'answered' | 'expired' | 'cancelled';
  };

  /** 账本落了一笔新协作。 */
  'ledger.recorded': { record: LedgerRecord };
  /**
   * 已有记录发生变化（settle 或 adoption 表态）。
   *
   * 刻意合成一个事件而不是拆 settled/adopted 两个：两者对 UI 都是
   * 「同一笔记录变了，按 id upsert」，拆开只会让渲染层写两遍相同逻辑。
   */
  'ledger.updated': { record: LedgerRecord };
  'ledger.policyChanged': { policy: AdoptionPolicy };

  /**
   * 预算软/硬熔断。
   *
   * `spentUsd` 与 `limits` 必须是两个不同来源的数 —— 之前的 `limitUsd` 字段
   * 实际塞的是 spent，导致 UI 上「已用 / 上限」永远相等（M4 修订 G9.1）。
   */
  'budget.warning': { usage: UsageTotals; spentUsd: number; softUsd: number; hardUsd: number };
  'budget.frozen': { usage: UsageTotals; spentUsd: number; softUsd: number; hardUsd: number };
}

// ─────────────────────────────────────────────────────────────
// 桥接接口
// ─────────────────────────────────────────────────────────────

/** preload 通过 contextBridge 暴露给渲染进程的对象形状。 */
export interface AxonBridge {
  invoke<C extends keyof CommandMap>(
    command: C,
    payload: CommandMap[C]['payload'],
  ): Promise<CommandMap[C]['result']>;

  subscribe<E extends keyof EventMap>(
    event: E,
    handler: (payload: EventMap[E], meta: { source: AgentPath; at: number }) => void,
  ): () => void;
}

export const IPC_COMMAND_CHANNEL = 'axon:command';

export function ipcEventChannel(event: keyof EventMap): string {
  return `axon:event:${event}`;
}

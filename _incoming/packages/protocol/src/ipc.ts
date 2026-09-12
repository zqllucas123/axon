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
  ForkModeSpec,
  MessageLike,
  RoleDefinition,
  UsageTotals,
} from './agent.ts';

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

  'role.list': { payload: Record<string, never>; result: RoleDefinition[] };
  'role.save': { payload: { role: RoleDefinition }; result: RoleDefinition };
  'role.delete': { payload: { name: string }; result: { deleted: boolean } };

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
}

export interface PendingRequest {
  requestId: string;
  kind: 'approval' | 'question';
  source: AgentPath;
  message: string;
  detail?: unknown;
  at: number;
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

  /** Agent 间通信：某 agent 收到了来自另一个 agent 的消息。 */
  'agent.message.received': { from: AgentPath; kind: 'task' | 'note'; text: string };

  'approval.request': { requestId: string; message: string; detail?: unknown };
  'question.request': { requestId: string; message: string };

  /** 预算软/硬熔断。 */
  'budget.warning': { usage: UsageTotals; limitUsd: number };
  'budget.frozen': { usage: UsageTotals; limitUsd: number };

  /** 编排层检测到互相等待。 */
  'orchestration.deadlock': { involved: AgentPath[] };
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

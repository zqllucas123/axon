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
import type { ConfigIssue, ConfigPatch, ConfigSnapshot } from './config.ts';
import type {
  Adoption,
  AdoptionPolicy,
  LedgerQuery,
  LedgerQueryResult,
  LedgerRecord,
} from './ledger.ts';
import type {
  CreateSessionPayload,
  EscalateSessionPayload,
  SessionDetail,
  SessionListQuery,
  SessionSummary,
} from './session.ts';
import type { TeamDefinition, TeamEntry, TeamIssue } from './team.ts';

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
  /**
   * 事件来自哪个 agent；UI 据此把事件路由到树上的节点。
   *
   * MU-1 起改为**可选**：会话/团队/配置级事件（`session.created`、`teams.changed`、
   * `config.changed`）没有单一 agent 源，硬塞一个只会逼实现编个假路径出来。
   */
  source?: AgentPath;
  /** 事件所属会话；会话内的事件必有，全局事件没有。 */
  sessionId?: string;
  at: number;
}

// ─────────────────────────────────────────────────────────────
// 命令（渲染 → 内核，有应答）
// ─────────────────────────────────────────────────────────────

export interface SpawnAgentPayload {
  role: string;
  /** 父 Agent 路径。MU-1 起父子树以会话为根，缺省值交给宿主按会话选。 */
  parent?: AgentPath;
  /**
   * 归属会话。只缺 parent 时用它定位会话根（`/<sessionId>`）。
   *
   * 两个都给也可以，但两者必须同属一个会话（宿主体检查），否则会造出
   * 跨树的孤儿节点 —— 那会让「按会话切片」全部失真。
   */
  sessionId?: string;
  /** 覆盖角色默认的分身模式。 */
  forkMode?: ForkModeSpec;
  /**
   * 一次性覆写，不落盘。
   *
   * MU-1 起带上 `tools`/`approval`：团队成员计划（session-instantiate）把
   * 「引用角色 + 本队覆写」预合成后再交到这里。**覆写只减不增** 的守门人
   * 在宿主（host.spawn），不在调用方 —— 这里只是传声筒。
   */
  overrides?: Partial<
    Pick<RoleDefinition, 'displayName' | 'instructions' | 'model' | 'tools' | 'approval'>
  >;
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

  // ─ MU-1：会话（一等公民，UX 02 §2.2）──

  /** 建会话并按执行方式实例化（engine 只建根 / team 按编队 / adhoc 现挑）。 */
  'session.create': { payload: CreateSessionPayload; result: SessionSummary };
  /** 会话详情：摘要 + 本会话成员树（S2 右栏顶部面板、S5 deep link 的数据源）。 */
  'session.get': { payload: { sessionId: string }; result: SessionDetail | null };
  'session.list': { payload: SessionListQuery; result: SessionSummary[] };
  /** 单兵 → 团队的升级（「叫人」）；已产生的消息不丢。 */
  'session.escalate': { payload: EscalateSessionPayload; result: SessionDetail };
  'session.rename': { payload: { sessionId: string; title: string }; result: SessionSummary };
  /** 删会话 = 级联删整棵树 + 清理账本切片/挂起/队列。 */
  'session.remove': { payload: { sessionId: string }; result: { removedPaths: AgentPath[] } };

  // ── MU-1：团队（S3 团队管理）──

  'team.list': {
    payload: Record<string, never>;
    result: { entries: TeamEntry[]; issues: TeamIssue[] };
  };
  /** 创建或覆盖同名用户团队；校验失败时 accepted=false 且带 errors。 */
  'team.save': {
    payload: { team: TeamDefinition };
    result: { accepted: boolean; errors: TeamIssue[] };
  };
  'team.delete': { payload: { name: string }; result: { deleted: boolean; errors: TeamIssue[] } };
  'team.openDir': { payload: Record<string, never>; result: { path: string } };

  // ── MU-1：配置（S8 设置窗）──

  'config.get': { payload: Record<string, never>; result: ConfigSnapshot };
  /**
   * 改配置。与 role.save / team.save 同构：**校验失败不落盘**，
   * 返回 issues 让 UI 逐字段标红，而不是抛错让人去猜哪个字段坏了。
   */
  'config.patch': {
    payload: { patch: ConfigPatch };
    result: { accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot };
  };
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
  /**
   * 请求属于哪个会话。
   *
   * 它是 S5 收件箱「跨会话聚合」的分组键（UX 02 §3.4 的「双重主键」：
   * 请求属于某会话，但「有人卡住等你」是跨会话的）。
   */
  sessionId: string;
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
    /** 属于哪个会话（MU-1：收件箱按会话切片；渲染层要能直接把事件拼进待办表）。 */
    sessionId: string;
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
   *
   * MU-1 加 `scope`：三层限额（全局/团队/会话）取更严者后，UI 必须知道
   * 是哪一层触发的——否则会话被团队预算卡住时，用户看全局额度还富余，会以为程序坏了。
   */
  'budget.warning': BudgetEventPayload;
  'budget.frozen': BudgetEventPayload;

  // ─ MU-1：会话 / 团队 / 配置 ──

  /** 会话建立成功。 */
  'session.created': { summary: SessionSummary };
  /**
   * 会话 rollup 变化（成员状态 / 账本 / 待批 / 用量）。
   *
   * 发送侧要节流（≤ 4Hz/会话，实现放 index.ts 转发层）：一个忙碌会话的
   * turn.end + status 事件会以每秒几十条的频率出现，不节流会把 IPC 打满。
   */
  'session.changed': { summary: SessionSummary };
  /** 会话被删。`paths` 是级联删掉的全部路径（子先父后），UI 逐个摘节点。 */
  'session.removed': { sessionId: string; paths: AgentPath[] };

  /** 团队集合变化（保存/删除/外部改文件后热重载）。UI 直接拿 entries 重绘。 */
  'teams.changed': { entries: TeamEntry[]; issues: TeamIssue[] };
  /** 配置落盘成功（含来自其他途径的变更）；UI 全量重绘而不是局部打补丁。 */
  'config.changed': { config: ConfigSnapshot };

  /**
   * 代批留痕（MU-1 审批修②）。
   *
   * 背景：`resolveDelegation` 只要链上有 auto/full_access 祖先就直接放行，
   * **不发事件、无记录**；而内置 planner/architect/aligner 都是 auto，
   * aligner 又常当 lead ⇒ 默认配置下 HITL 形同虚设。留痕之后，S5 的
   * 「已处理流水」与调试台都能回答「这次是谁替你批的」。
   */
  'approval.delegated': {
    /** 真正要动手的那个 agent。 */
    origin: AgentPath;
    tool: string;
    /** 替它批的祖先。 */
    approver: AgentPath;
    /** 代批者生效的审批档（auto 或 full_access）。 */
    mode: ApprovalMode;
    /** 穿透路径 origin → … → approver。 */
    chain: AgentPath[];
    at: number;
  };
}

/** 预算跃迁事件的载荷（warning / frozen 共用）。 */
export interface BudgetEventPayload {
  usage: UsageTotals;
  spentUsd: number;
  softUsd: number;
  hardUsd: number;
  /** 触发口径：全局档还是某会话档。 */
  scope: 'global' | 'session';
  /** scope='session' 时必有。 */
  sessionId?: string;
  /** 生效上限来自哪一层（会话口径时有意义，UI 显示「受团队预算限制」）。 */
  limitedBy?: 'global' | 'team' | 'session';
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
    handler: (
      payload: EventMap[E],
      meta: { source?: AgentPath; sessionId?: string; at: number },
    ) => void,
  ): () => void;
}

export const IPC_COMMAND_CHANNEL = 'axon:command';

export function ipcEventChannel(event: keyof EventMap): string {
  return `axon:event:${event}`;
}

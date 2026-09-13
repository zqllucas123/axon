/**
 * Axon 协议层 —— Agent 相关的共享类型。
 *
 * 这个包被 kernel 与 desktop 同时依赖，所以只能放**纯类型与纯函数**，
 * 不得引入任何运行时依赖（尤其是 electron 与 pi）。
 */

// ─────────────────────────────────────────────────────────────
// 消息结构
//
// 刻意不直接复用 pi 的类型：协议层若绑死上游 0.85.x 的结构，
// 上游一改，desktop 也得跟着改。这里只声明 Axon 需要的最小形状，
// kernel 负责在边界上做转换。
// ─────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'toolResult';

/**
 * 只约束 Axon 关心的判别字段，其余透传。
 *
 * 字段名对齐 pi 运行时实测结构（0.85.1）：toolCall 块的标识字段是 `id`，
 * 不是 `callId`。这一条必须以真实 transcript 为准 —— 猜错会让所有
 * 配对修复逻辑静默退化成 no-op。
 */
export type ContentBlockLike =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'toolCall'; id: string; name?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/**
 * 注意 toolResult 的形态：它是一条**独立消息**（role: 'toolResult'），
 * 被应答的调用 id 在**消息顶层**的 `toolCallId` 上，而它的 content 里
 * 装的只是普通 text 块。不存在「toolResult 类型的内容块」。
 */
export interface MessageLike {
  role: MessageRole;
  content: ContentBlockLike[];
  /** 仅当 role === 'toolResult' 时存在。 */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// 分身模式（ForkMode）
//
// 取值与 codex 的 fork_turns 对齐：none | all | 正整数。
// 语义按 **round（对话轮）** 而非消息条数切片，详见 kernel/src/fork.ts。
// ─────────────────────────────────────────────────────────────

export type ForkMode =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'lastRounds'; rounds: number };

export const FORK_NONE: ForkMode = Object.freeze({ kind: 'none' });
export const FORK_ALL: ForkMode = Object.freeze({ kind: 'all' });

export function forkLastRounds(rounds: number): ForkMode {
  if (!Number.isInteger(rounds) || rounds <= 0) {
    throw new RangeError(`fork rounds 必须是正整数，收到 ${rounds}`);
  }
  return { kind: 'lastRounds', rounds };
}

/** 配置文件/UI 里的字面量写法。 */
export type ForkModeSpec = string | number | undefined | null;

/**
 * 默认分身模式 —— **纯净上下文**。
 *
 * 这个默认值是被三个已上线产品的实践反过来定的，不是拍脑袋：
 *
 *  - TabTin 最初默认 filtered 继承，后来改回 none，并留下复盘
 *    （`packages/agent-runtime/src/subagent/fork-query.ts:70-82`）：继承会把父原文
 *    「调 N 个 agent 做 X」灌进子上下文，弱模型被父原文带跑，thinking 里反复纠结
 *    「父原文 vs 自己的 directive」。
 *  - kalo 的 subagent 干脆只传 prompt 文本，不复制父消息历史。
 *  - tutti 不设默认，强制每次显式选 none/recent/full。
 *
 * 所以子 Agent 的输入应当是**结构化的 task 契约**（systemPrompt + 明确任务），
 * 而不是把父会话原样灌过去。`all` 仍然保留，但降级为显式逃生门。
 */
export const DEFAULT_FORK_MODE: ForkMode = FORK_NONE;

/**
 * 解析分身模式字面量。
 * - undefined / null / 空串 → none（纯净，见 DEFAULT_FORK_MODE 的理由）
 * - "none" → 纯净上下文
 * - "all"  → 继承全部（显式逃生门）
 * - "3"    → 继承最后 3 个 round
 *
 * 用 /^\d+$/ 而非 parseInt，否则 "1.5"、"3abc" 会被悄悄截断成 3。
 */
export function parseForkMode(spec: ForkModeSpec): ForkMode {
  if (spec === undefined || spec === null) return DEFAULT_FORK_MODE;

  if (typeof spec === 'number') return forkLastRounds(spec);

  const raw = spec.trim();
  if (raw === '') return DEFAULT_FORK_MODE;

  const normalized = raw.toLowerCase();
  if (normalized === 'none') return FORK_NONE;
  if (normalized === 'all') return FORK_ALL;

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return forkLastRounds(n);
    throw new RangeError(`fork rounds 必须大于 0，收到 "${spec}"`);
  }

  throw new TypeError(`无法解析 forkMode: "${spec}"（可选 none | all | 正整数）`);
}

export function formatForkMode(mode: ForkMode): string {
  switch (mode.kind) {
    case 'none':
      return 'none';
    case 'all':
      return 'all';
    case 'lastRounds':
      return String(mode.rounds);
  }
}

// ─────────────────────────────────────────────────────────────
// Agent 寻址
//
// 借鉴 codex 的 AgentPath：树形路径既是身份也是层级关系，
// 免去额外维护一张父子映射表。
// ─────────────────────────────────────────────────────────────

export type AgentPath = string;

export const ROOT_PATH: AgentPath = '/root';

export function childPath(parent: AgentPath, id: string): AgentPath {
  if (id.includes('/')) throw new TypeError(`agent id 不得包含 "/": ${id}`);
  return parent === '/' ? `/${id}` : `${parent}/${id}`;
}

export function parentPath(path: AgentPath): AgentPath | undefined {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return undefined;
  return path.slice(0, idx);
}

/** a 是否为 b 的祖先。用于禁止「等待自己的祖先」造成的死锁。 */
export function isAncestorOf(a: AgentPath, b: AgentPath): boolean {
  return b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

// ─────────────────────────────────────────────────────────────
// 状态与角色
// ─────────────────────────────────────────────────────────────

/**
 * 审批档。`always_ask` 是最安全的默认；`full_access` 必须用户显式选。
 */
export type ApprovalMode = 'always_ask' | 'auto' | 'full_access';

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'always_ask';

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'interrupted';

export const TERMINAL_STATUSES: readonly AgentStatus[] = Object.freeze([
  'done',
  'failed',
  'interrupted',
]);

export function isTerminal(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface RoleDefinition {
  /** 唯一标识，同时用作 AgentPath 的前缀，如 developer → /root/developer-1 */
  name: string;
  displayName: string;
  description: string;
  /** 角色的 systemPrompt。 */
  instructions: string;
  model?: string;
  /**
   * 工具白名单。省略 = 继承父级全集。
   * 强约束：角色只能减能，不能越权 —— 见 kernel/src/fork.ts 的 intersectTools。
   */
  tools?: string[];
  shellAllow?: string[];
  /** 省略则用 DEFAULT_FORK_MODE（none）。 */
  defaultForkMode?: ForkModeSpec;
  /**
   * 审批档 —— 与 tools 白名单**正交**的第二个维度（抄 TabTin 的
   * AgentMode × ApprovalMode，`packages/agent-modes/src/types.ts:70-74`）：
   * tools 管「能碰什么」，approval 管「多大程度放手」。
   *
   * 两者分开的理由：“测试 Agent 只读”是能力限制（tools），
   * “开发 Agent 改代码前要问我”是信任度（approval），
   * 塑进同一个枚举会立刻组合爆炸。
   */
  approval?: ApprovalMode;
}

// ─────────────────────────────────────────────────────────────
// 角色加载（M2 RoleLoader）
// ─────────────────────────────────────────────────────────────

/** 角色文件加载/校验时发现的问题。 */
export interface RoleIssue {
  /** 机器可读的问题代码，UI 据此选择展示方式。 */
  code: 'parse_error' | 'validation';
  message: string;
  /** 出自哪个文件；内置/全局问题则缺省。 */
  file?: string;
}

export type RoleSource = 'builtin' | 'user';

/**
 * 角色列表条目 = 角色定义 + 来源 + 加载健康度。
 *
 * 为什么带 errors 而不是遇见坏文件就抛：角色文件是用户手写物，
 * 一个坏文件不该打瘸整棵树。errors 留给 UI 渲染成红条，
 * 加载器只承诺「坏文件不生效、好文件不受牵连」。
 */
export interface RoleEntry {
  role: RoleDefinition;
  source: RoleSource;
  /** 用户角色覆盖了同名内置角色时为 true。 */
  overridesBuiltin?: boolean;
  /** 用户角色的落盘文件路径。 */
  filePath?: string;
  /** 该条目自身的加载问题；解析失败的文件不会出现在列表里，其错误由 role.list 结果另行携带。 */
  errors: RoleIssue[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentSnapshot {
  path: AgentPath;
  role: string;
  displayName: string;
  status: AgentStatus;
  parent?: AgentPath;
  children: AgentPath[];
  createdAt: number;
  updatedAt: number;
  usage: UsageTotals;
  lastError?: string;
}

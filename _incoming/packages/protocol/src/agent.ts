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
 * 解析分身模式字面量。
 * - undefined / null / 空串 → all（继承全部，最不意外的默认）
 * - "none" → 纯净上下文
 * - "all"  → 继承全部
 * - "3"    → 继承最后 3 个 round
 *
 * 用 /^\d+$/ 而非 parseInt，否则 "1.5"、"3abc" 会被悄悄截断成 3。
 */
export function parseForkMode(spec: ForkModeSpec): ForkMode {
  if (spec === undefined || spec === null) return FORK_ALL;

  if (typeof spec === 'number') return forkLastRounds(spec);

  const raw = spec.trim();
  if (raw === '') return FORK_ALL;

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
  defaultForkMode?: ForkModeSpec;
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

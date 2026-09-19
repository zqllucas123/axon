/**
 * 展示口径层 —— 只放纯函数（协议数据 → 要渲染的东西）。
 *
 * 为什么单独一个文件：L3 薄壳纪律（AGENTS.md §4.3 / ux 01 §5）要求组件只做
 * 「渲染 + 发意图」，凡「这个状态该显示成什么」的判断都必须集中在这里，
 * 便于单测与逐值对齐原型（01 §2：状态色只有 run/idle/wait/err/done 五档）。
 */

import type {
  AgentPath,
  AgentSnapshot,
  AgentStatus,
  ContentBlockLike,
  MessageLike,
  PendingRequest,
  ProjectRecord,
  SessionSummary,
  UsageTotals,
} from '@axon/protocol';
import type { SessionView } from './types.ts';

/**
 * 会话流条目 —— 协议消息/事件 → 可渲染项的**唯一中间形状**。
 *
 * 放在本文件（展示口径层）而不是 `state/types.ts`：它是「这个状态该显示成什么」
 * 的产物，生成它的纯函数就在下面（`replayStream` 回放 / `itemsFromMessage` 增量），
 * 组件只按 `kind` 渲染，不再二次判断（L3 薄壳纪律）。
 *
 * 刻意不带时间戳：`MessageLike` 没有 `at`（台账 A-1），编一个时间就是假数据。
 */
export type StreamItem =
  | { kind: 'user'; id: string; text: string }
  /** `pending` = 已收到 message.start 但还没 end（不接流式，见台账 B-1）。 */
  | { kind: 'assistant'; id: string; text: string; pending: boolean }
  /**
   * `state` 四态：running（进行中）/ ok / err（工具自己报错）/ lost（回放时找不到
   * 对应 toolResult —— 例如上次运行被打断，**不编成功也不编失败**）。
   */
  | {
      kind: 'tool';
      id: string;
      callId: string;
      name: string;
      args: string;
      state: 'running' | 'ok' | 'err' | 'lost';
      result: string;
    }
  /** 活动行：回放提示（已恢复 N 条）与回合收尾（本轮用量）。 */
  | { kind: 'turn'; id: string; text: string; detail: string }
  | { kind: 'error'; id: string; text: string };


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
/** 仅本文件用（`splitSessions` 与旧 S7 分段），不导出：避免与 `@axon/protocol` 的同名函数混淆。 */
function isTerminal(status: AgentStatus): boolean {
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

/** 一个项目及其会话切片（左栏「项目」分组的数据源）。 */
export interface ProjectSessionGroup {
  project: ProjectRecord;
  sessions: SessionSummary[];
}

/**
 * 项目 → 会话分组。纯展示：
 * - 以 projects 顺序生成分组（空项目也在内，返回 sessions: []）；
 * - 只把 `record.projectId === project.id` 的会话放进对应项目；
 * - 会话按 updatedAt 倒序（与左栏其它列表口径一致）；
 * - 不匹配/无 projectId 的会话不在这里出现（仍走全局「进行中/最近」分组）。
 */
export function groupSessionsByProject(
  projects: ProjectRecord[],
  sessions: SessionSummary[],
): ProjectSessionGroup[] {
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const pid = s.record.projectId;
    if (pid === undefined) continue;
    const list = byProject.get(pid) ?? [];
    list.push(s);
    byProject.set(pid, list);
  }
  return projects.map((project) => ({
    project,
    sessions: (byProject.get(project.id) ?? []).sort((a, b) => b.record.updatedAt - a.record.updatedAt),
  }));
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
export function sessionChips(
  s: SessionSummary | null,
  /**
   * 实时待批数（来自 `pending` 缓存）。为什么不直接用 `s.counts.pending`：
   * 那是主进程算好、随 `session.changed` **节流**下发的数字，会与屏幕上的审批卡
   * 差一拍（实测：卡在等批，chip 却写「待批 0」）。有实时值就用实时值，
   * counts 只当没有实时值时的兜底。
   */
  livePending?: number,
): {
  pending: number;
  ledger: number;
  running: number;
  members: number;
} {
  if (!s) return { pending: 0, ledger: 0, running: 0, members: 0 };
  return {
    pending: livePending ?? s.counts.pending,
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

// ─────────────────────────────────────────────────────────────
// 会话流（MU-2 切片 3）：协议消息/事件 → 可渲染条目
// ─────────────────────────────────────────────────────────────

/** 内容块里的纯文本（其余块一律忽略 —— 不猜形状，见台账 B-2）。 */
function textOfBlocks(blocks: ContentBlockLike[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    const t = (b as { text?: unknown }).text;
    if (typeof t === 'string') out.push(t);
  }
  return out.join('\n');
}

function oneLine(s: string, max = 110): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 工具卡右上的参数摘要（原型是「名字 + 关键参数」两段式）。
 * 优先取最有信息量的一列，取不到就退化成整串 JSON 的单行截断。
 */
export function toolArgsLine(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return oneLine(args);
  if (typeof args !== 'object') return oneLine(String(args));
  const o = args as Record<string, unknown>;
  for (const k of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
  }
  try {
    return oneLine(JSON.stringify(o));
  } catch {
    return '';
  }
}

/** `agent.tool.end` 的结果文本（`result` 是 unknown：字符串直用，对象转 JSON）。 */
export function toolResultText(result: unknown, error?: string): string {
  if (error) return error;
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** 千分位整数（用量行）。 */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 回合活动行：`agent.turn.end` 只给 usage，**没有秒数就不编秒数**（§4.6）。 */
export function turnActivity(usage: UsageTotals, id: string): StreamItem {
  return {
    kind: 'turn',
    id,
    text: `本轮 · ${fmtInt(usage.inputTokens)} in · ${fmtInt(usage.outputTokens)} out`,
    detail: `· $${usage.costUsd.toFixed(3)}`,
  };
}

/**
 * 回放：把 `agent.messages` 的整条历史拍成流条目。
 *
 * 两遍扫描：第一遍按 `toolCallId` 建 toolResult 索引（结果消息总在调用块**之后**
 * 出现，见 `agent.ts:35-43` 的注释：toolResult 是独立消息，不是内容块），
 * 第二遍才算条目 —— 这样工具卡能一次成型成 ok/err，不会先闪 running。
 */
export function replayStream(messages: MessageLike[]): StreamItem[] {
  const results = new Map<string, { ok: boolean; text: string }>();
  messages.forEach((m, i) => {
    if (m.role !== 'toolResult') return;
    const key = typeof m.toolCallId === 'string' ? m.toolCallId : `#${i}`;
    results.set(key, { ok: m.isError !== true, text: textOfBlocks(m.content) });
  });

  const out: StreamItem[] = [];
  messages.forEach((m, i) => {
    out.push(...walkMessage(m, `m${i}`, results));
  });
  // 原型首行是「已恢复 N 条历史消息」的活动行；这是**真实计数**（消息条数）。
  if (messages.length > 0) {
    out.unshift({
      kind: 'turn',
      id: 'restored',
      text: `已恢复 ${messages.length} 条历史消息`,
      detail: '· 由 agent.messages 回放',
    });
  }
  return out;
}

/** 单条消息 → 条目（流式增量用；没有 toolResult 索引，工具卡先落 running）。 */
export function itemsFromMessage(message: MessageLike, id: string): StreamItem[] {
  return walkMessage(message, id, null);
}

/**
 * 一条消息展开成若干条目：user → 气泡；assistant → 正文段落 + 工具卡；
 * toolResult → 空（结果已经并进工具卡，独立渲染会出双份）。
 *
 * 正文与工具卡的交错顺序按内容块原序保留（先 flush 正文再落卡）。
 */
function walkMessage(
  message: MessageLike,
  base: string,
  results: Map<string, { ok: boolean; text: string }> | null,
): StreamItem[] {
  if (message.role === 'user') {
    const text = textOfBlocks(message.content);
    return text.trim() ? [{ kind: 'user', id: `${base}`, text }] : [];
  }
  if (message.role !== 'assistant') return [];

  const out: StreamItem[] = [];
  let buf: string[] = [];
  let n = 0;
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text) out.push({ kind: 'assistant', id: `${base}-t${n++}`, text, pending: false });
  };

  message.content.forEach((b, j) => {
    if (b.type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') buf.push(t);
      return;
    }
    if (b.type !== 'toolCall') return;
    flush();
    const callId = typeof b.id === 'string' ? b.id : `${base}-c${j}`;
    const name = typeof b.name === 'string' ? b.name : 'tool';
    const raw = (b as { arguments?: unknown; args?: unknown; input?: unknown });
    const hit = results?.get(callId);
    out.push({
      kind: 'tool',
      id: `tool-${callId}`,
      callId,
      name,
      args: toolArgsLine(raw.arguments ?? raw.args ?? raw.input),
      state: hit ? (hit.ok ? 'ok' : 'err') : results ? 'lost' : 'running',
      result: hit?.text ?? '',
    });
  });
  flush();
  return out;
}

/** 助手正文的最小解析：空行分段、`- `/数字起列表（不引 markdown 依赖）。 */
type Prose = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

export function parseProse(text: string): Prose[] {
  const out: Prose[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ kind: 'p', text: para.join('\n') });
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push({ kind: 'ul', items: list });
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      list.push(m[1] ?? '');
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

/** 行内 `code` 切分（只认反引号；不匹配的奇偶段按 code 处理）。 */
type InlineSeg = { code: boolean; text: string };

export function inlineSegments(text: string): InlineSeg[] {
  const out: InlineSeg[] = [];
  text.split('`').forEach((p, i) => {
    if (p === '') return;
    out.push({ code: i % 2 === 1, text: p });
  });
  return out;
}

// ────────────────────────────────────────────────────────────
// MU-3 切片 2.5：跨屏共用的格式化与口径
//
// 抽到这里的理由：S5/S6/S7 三屏由三个并行会话分别实现，如果各自再写一遍
// `$${n.toFixed(2)}` 与「今天/昨天/9-14」，最后一定会出现三种钱与三种时间。
// 口径是产品的一部分，不是各屏的实现细节。
// （MU-2 遗留的 S1Workbench / S2Views / Chips / S3Teams 四份局部 money 在
//   切片 8 死链核销时一并归并，此处先立唯一口径。）
// ────────────────────────────────────────────────────────────

/** 金额：默认两位小数；`digits=3` 给单回合成本那种小额用。 */
export function money(n: number | undefined, digits = 2): string {
  return `$${(n ?? 0).toFixed(digits)}`;
}

/** 粗粒度相对日期：「今天 / 昨天 / 9-14」（原型右栏口径）。 */
export function relDay(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今天';
  if (same(d, new Date(today.getTime() - 86_400_000))) return '昨天';
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/** 时刻：「今天 14:03 / 昨天 14:03 / 9-14 14:03」—— 中断时刻、待办到达时刻共用。 */
export function fmtTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${relDay(at)} ${hh}:${mm}`;
}

/**
 * 相对时长：「刚刚 / 3 分钟前 / 2 小时前 / 3 天前」。
 * 只在**有真实时间戳**时用（`MessageLike` 没有 at，别拿它编）。
 */
export function since(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86_400)} 天前`;
}

// ── S5 收件箱口径 ──────────────────────────────────────────

/**
 * 待办分段（UX 02 §3.4）：**按紧迫度而不是按会话**。
 * 会话只是分组键，「有人卡住等你」是跨会话的事实。
 */
export function splitPending(pending: PendingRequest[]): {
  waiting: PendingRequest[];
  resolved: PendingRequest[];
} {
  const byNew = [...pending].sort((a, b) => b.at - a.at);
  return {
    waiting: byNew.filter((p) => p.state === 'pending'),
    // 注意：这份「已处理」只覆盖**本次运行期**（拍板 P-5）——
    // ApprovalBroker 结算即 delete，协议没有 `pending.history`。
    resolved: byNew.filter((p) => p.state !== 'pending'),
  };
}

/* `blockedCount` 已删（MU-3 切片 8）：S5 实现时发现「卡住几个人」要的不是个数而是
   具体名字（`BlockedList` 直接渲染 chain 上的分身），数字反而要再展开一次才能用。 */

// ── S6 预算与用量口径 ──────────────────────────────────────

/**
 * 按会话的花费排行（降序）。用 `SessionSummary.usage`，
 * **绝不为了算用量去 `session.get`**（那会打穿 M5 懒加载，见 MU-3 R-7）。
 */
export function spendRanking(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => (b.usage.costUsd ?? 0) - (a.usage.costUsd ?? 0));
}

/** 全部会话里最严的档位（S6「最严会话档位」指标）。 */
export function strictestTier(sessions: SessionSummary[]): {
  tier: 'ok' | 'warning' | 'frozen';
  session?: SessionSummary;
} {
  const rank = { ok: 0, warning: 1, frozen: 2 } as const;
  let out: { tier: 'ok' | 'warning' | 'frozen'; session?: SessionSummary } = { tier: 'ok' };
  for (const s of sessions) {
    const t = s.budget.tier;
    if (rank[t] > rank[out.tier]) out = { tier: t, session: s };
  }
  return out;
}

/** 用量合计（跨会话）。同上：只加 summary 里已有的数，不触发加载。 */
export function totalUsage(sessions: SessionSummary[]): UsageTotals {
  return sessions.reduce<UsageTotals>(
    (acc, s) => ({
      inputTokens: acc.inputTokens + (s.usage.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (s.usage.outputTokens ?? 0),
      costUsd: acc.costUsd + (s.usage.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

// ── S7 会话恢复口径 ────────────────────────────────────────

/**
 * 「上次中断」：只有**落盘 rollup 里带 interruptedAt** 才算（MU-3 E-1）。
 * 当前正在跑的会话不算中断 —— 那是「运行中」，不是「上次没跑完」。
 */
export function interruptedAt(s: SessionSummary): number | undefined {
  return s.rollup?.interruptedAt;
}

// `splitRecoverable` 已删（MU-3 切片 8）：S7 实现时发现分段口径不同 ——
// 它分的是「可恢复 / 运行中 / 已结束」（看运行时 status），而 S7 要的是
// 「全部 / 可恢复 / 已归档」（后者看 `record.status === 'closed'` 这个**用户意志态**，
// 与运行时状态正交）。两套口径同时存在只会让人拿错，留 S7 实际在用的那套。
// 分段逻辑在 `components/S7Sessions.tsx` 的 `isRecoverable` / `isArchived` / `inSeg`。


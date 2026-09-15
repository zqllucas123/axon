/**
 * 会话（Session）—— 任务容器，一等公民（UX `02-团队与会话模型.md` §2.2）。
 *
 * 换轴的动机（三份原型评审的结论）：旧模型里「分身」是一等公民，树是全局唯一一棵，
 * 于是五个不相干任务的分身混在同一个列表里；且想干任何事都得先想清楚「派哪个角色」——
 * 改个错别字也要走 spawn。新模型把**任务**提到顶层：
 *
 *     Agent 类型（角色模板） → Agent（团队成员） → Team（班子模板） → Session（一次任务）
 *
 * 落成协议后：一个会话 = 一棵分身树（§4.1 多根注册表），会话根路径 = `/<sessionId>`。
 * 协作账本、用量、审批挂起全部以 `sessionId` 为主键——跨会话的账本没有语义
 * （把两个不相干任务的 delegate 摆在同一个列表里，读者第一件事就是把它们分开）。
 *
 * 这个文件只放纯类型、纯常量与纯函数，不得引入运行时依赖。
 */

import type {
  AgentPath,
  AgentSnapshot,
  AgentStatus,
  ForkModeSpec,
  UsageTotals,
} from './agent.ts';

// ─────────────────────────────────────────────────────────────
// 执行方式（S0 的三张模式卡）
// ────────────────────────────────────────────────────────────

/**
 * 会话的执行方式。
 *
 * - `engine`：内置引擎单兵干，不组队（**默认**）。对应 UX 02 §3.1 的产品判断
 *   ——「默认不组队」，理由与 ForkMode 默认 none 同源：协作是成本，不是福利。
 * - `team`：按既有团队编队实例化整棵分身树。
 * - `adhoc`：临时编队，从 Agent 类型库现挑 2~6 个，用完即散（可事后存为团队）。
 */
export type SessionExecutor = 'engine' | 'team' | 'adhoc';

export const SESSION_EXECUTORS: readonly SessionExecutor[] = Object.freeze([
  'engine',
  'team',
  'adhoc',
]);

export function isSessionExecutor(value: unknown): value is SessionExecutor {
  return typeof value === 'string' && (SESSION_EXECUTORS as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────
// 记录
// ─────────────────────────────────────────────────────────────

/**
 * 会话的生命周期（**落盘的口径**，与实时状态正交）。
 *
 * 刻意与 `AgentStatus` 分开：`open`/`closed` 是用户意志（这个任务还开着吗），
 * 而 `AgentStatus` 是运行时事实（正在跑 / 排队 / 已终态）。把两者塞进同一个枚举，
 * M5 落盘时就得回答「重启后 running 算什么」这种没有真答案的问题。
 * 实时状态在 `SessionSummary.status` 里单独给。
 */
export type SessionStatus = 'open' | 'closed';

/** 会话落盘 schema 版本 —— 与账本的 LEDGER_SCHEMA_VERSION 各自独立（M5 读侧迁移用）。 */
export const SESSION_SCHEMA_VERSION = 1;

/** 会话标题上限：首条任务截断到 60 字（UX s0 原型的输入提示长度）。 */
export const SESSION_TITLE_MAX = 60;

/** 临时编队的成员数范围（UX 02 §3「现挑 2~6 个」）。 */
export const SESSION_MEMBER_MIN = 2;
export const SESSION_MEMBER_MAX = 6;

/**
 * 会话 id 的字符集约束。
 *
 * 它会成为路径的一段（`/<sessionId>`），所以必须排除 `/` —— 否则
 * 「会话根」与「子节点」的区分会塌掉（这是多根注册表唯一的寻址前提）。
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && SESSION_ID_RE.test(id);
}

/**
 * 生成会话 id：`s` + base36 时间戳 + `-` + 4 位随机。
 *
 * 时间戳在前是为了**字典序 = 创建序**（列表分组「进行中 / 最近」直接排序，
 * 不必额外读字段）；随机后缀防同毫秒碰撞。
 * 两个参数可注入，测试里要确定性 id。
 */
export function newSessionId(
  now: number = Date.now(),
  rand: () => string = () => Math.random().toString(36).slice(2, 6),
): string {
  const suffix = rand().replace(/[^a-z0-9]/gi, '').padEnd(4, '0').slice(0, 4);
  return `s${now.toString(36)}-${suffix}`;
}

/** 临时编队的一名成员（不进团队库，用完即散）。 */
export interface AdhocMemberSpec {
  /** Agent 类型（roles 的 name）。 */
  role: string;
  /** 显示名；缺省用角色 displayName。 */
  name?: string;
  /** 建会话后立刻交给它的任务。 */
  task?: string;
  forkMode?: ForkModeSpec;
  /** formation='custom' 时的父成员 name；缺省挂会话根。 */
  parent?: string;
}

/** 会话元数据 —— M5 落盘的 `session.json` 就是这个形状 + `schemaVersion`。 */
export interface SessionRecord {
  id: string;
  /** 首条任务截断（≤ SESSION_TITLE_MAX）；可改名。 */
  title: string;
  /** 工作目录（成员的工具默认落在这里；S0 的「/works/prjs/demo」）。 */
  cwd: string;
  executor: SessionExecutor;
  /** executor='team' 时的团队名（`~/.axon/teams/<name>.json`）。 */
  teamId?: string;
  /** executor='adhoc' 时的临时成员表（团队定义可从它「另存为模板」）。 */
  members?: AdhocMemberSpec[];
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  /**
   * 会话级预算（UX s3「团队预算是会话预算的默认值；会话可下调不可上调」）。
   * 与全局、团队三档取更严者，见 SessionBudgetView。
   */
  budget?: SessionBudgetSpec;
  /** 会话级并发上限（团队 maxConcurrent 实例化到本会话的副本）。 */
  maxConcurrent?: number;
}

// ─────────────────────────────────────────────────────────────
// 汇总视图（左栏会话行 / S1 会话总览 / S2 会话条的数据源）
// ─────────────────────────────────────────────────────────────

/** 会话内的计数。左栏行只显示状态点 + 名 + meta，这里是右栏与总览的料。 */
export interface SessionCounts {
  /** 成员数（不含会话根）。 */
  members: number;
  /** 正在跑（占并发额度）。 */
  running: number;
  /** 排队等额度（parked）。 */
  parked: number;
  /** 父在等后代（suspended，退位让额）。 */
  suspended: number;
  /** 本会话账本笔数。 */
  ledger: number;
  /** 本会话挂起中的审批/提问数（S5 收件箱的会话切片）。 */
  pending: number;
}

/** 一层预算限额。所有字段可选；**0 与缺省同义 = 不设**（与 budget.ts 的 hard<=0 关闭同义）。 */
export interface SessionBudgetSpec {
  softUsd?: number;
  hardUsd?: number;
}

/** 预算档位；与 BudgetGuard 的 BudgetState 同名同义（ok/warning/frozen）。 */
export type BudgetTier = 'ok' | 'warning' | 'frozen';

/**
 * 会话视角的预算：三档限额 + 取更严者之后的生效值。
 *
 * 为什么要把三档原样带出来而不只给生效值：UI 必须能解释「为什么是 $1.50」——
 * 团队线比全局线更严时，用户看到的应当是团队那张卡上的数，而不是一个来历不明的数字。
 */
export interface SessionBudgetView {
  /** 本会话已花（会话根快照的 usage.costUsd，父链已汇总）。 */
  spentUsd: number;
  /** 全局档（`~/.axon/config.json` 的 budgetUsd/soft）。 */
  global: SessionBudgetSpec;
  /** 团队档（TeamDefinition.budget）。 */
  team?: SessionBudgetSpec;
  /** 会话档（SessionRecord.budget）。 */
  self?: SessionBudgetSpec;
  /** 三者取更严者的结果；0 = 不设限。 */
  effectiveSoftUsd: number;
  effectiveHardUsd: number;
  tier: BudgetTier;
  /** 生效上限来自哪一层 —— UI 显示「受团队预算限制」用。 */
  limitedBy?: 'global' | 'team' | 'session';
}

/** 会话引用的团队摘要（S2 会话条上的「团队 · 4 成员」）。 */
export interface SessionTeamRef {
  /** 团队名（与 `~/.axon/teams/<name>.json` 同名）。 */
  id: string;
  name: string;
  memberCount: number;
  /** 临时加入的成员数（UX 02 §6 拍板：不算团队成员，只属于本会话）。 */
  tempCount: number;
}

/** 列表与事件里用的会话摘要。 */
export interface SessionSummary {
  record: SessionRecord;
  /** 会话根路径（= `/<id>`）；UI 一切寻址从这里出发。 */
  rootPath: AgentPath;
  /** 实时状态 = 会话根的 AgentStatus（record.status 是用户意志，此处是运行时事实）。 */
  status: AgentStatus;
  team?: SessionTeamRef;
  counts: SessionCounts;
  /** 本会话累计用量（含全部成员）。 */
  usage: UsageTotals;
  budget: SessionBudgetView;
}

/** `session.get` 的结果：摘要 + 本会话成员树（G10.3，右栏顶部面板的数据源）。 */
export interface SessionDetail extends SessionSummary {
  /** 本会话全部分身快照（扁平数组，前端按 parent 组树）。 */
  members: AgentSnapshot[];
}

// ────────────────────────────────────────────────────────────
// 命令 payload
// ─────────────────────────────────────────────────────────────

/** `session.create`。executor='team' 时 teamId 必填；'adhoc' 时 members 必填。 */
export interface CreateSessionPayload {
  title: string;
  /** 缺省用 config.defaultCwd 或 process.cwd()。 */
  cwd?: string;
  executor: SessionExecutor;
  teamId?: string;
  members?: AdhocMemberSpec[];
  /** 建完立刻交给会话根（lead / 内置引擎）的任务。 */
  initialPrompt?: string;
  /** 会话级限额；不填则从团队档继承。 */
  budget?: SessionBudgetSpec;
  /** 会话级并发；不填则从团队档继承。 */
  maxConcurrent?: number;
}

/**
 * `session.escalate` —— 单兵 → 团队的逃生门（UX s2-solo 的「叫人」）。
 *
 * 语义：把当前会话根的角色换成新团队的 lead，**已产生的消息不丢**
 * （carryMessages 缺省 true 时灌回新引擎，等价 fork: all 的作用范围仅限 lead 自己），
 * 其余成员按各自 ForkMode 决定看到多少。
 */
export interface EscalateSessionPayload {
  sessionId: string;
  /** 与 members 二选一。 */
  teamId?: string;
  members?: AdhocMemberSpec[];
  /** false = 只换角色不带历史（逃生门；缺省 true）。 */
  carryMessages?: boolean;
  /** 升级后立刻交给 lead 的任务。 */
  task?: string;
}

/** `session.list` 的过滤与分页。 */
export interface SessionListQuery {
  /** 缺省 'all'。 */
  status?: SessionStatus | 'all';
  /** 缺省 50。 */
  limit?: number;
}
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

/** 会话落盘 schema 版本 —— 与账本的 LEDGER_SCHEMA_VERSION 各自独立（M5 读侧迁移用）。
 *
 * v1 → v2（M9）：SessionRecord 新增 `engineId`、`externalSessionId`、`resumeCursor`。
 * v2 → v3（M10）：SessionRecord 新增 `parentSessionId`、`parentAgentPath`、`childSessionIds`。
 * v3 → v4（M15）：SessionRecord 新增 `modelRef`（会话级模型，`providerId:modelId`）。
 * 字段全部可选，旧记录正常读出，新字段缺省即 undefined。
 */
export const SESSION_SCHEMA_VERSION = 4;

/**
 * 落盘**外箱**版本（M5）：会话目录布局与文件集的版本。
 *
 * 与 SESSION_SCHEMA_VERSION 分两层：
 *  - 外箱（本常量）：目录结构、有哪些文件、文件名规则；
 *  - 记录（SESSION_SCHEMA_VERSION）：单份 SessionRecord / transcript 的字段形状。
 * 两者可以独立演进（例如改文件名规则不需要动记录字段）。
 */
export const SESSION_STORAGE_VERSION = 1;

/**
 * 会话汇总缓存（M5 懒加载的代价对冲，见 M5 §4.2）。
 *
 * 启动只读 session.json（不读树），列表要显示的用量/计数/状态就靠它。
 * **它不是真相**：真相在 transcript 与 registry；选中会话后由实时值修正。
 */
export interface SessionRollup {
  /** 观测时刻（写入时的时间戳）。 */
  at: number;
  usage: UsageTotals;
  counts: SessionCounts;
  /** 会话根的运行时状态（写入时的观测值）。 */
  status: AgentStatus;
  /** 上次退出时仍有 running/waiting 成员的时刻；无则缺省（M5 §4.6）。 */
  interruptedAt?: number;
}

/** 存储问题的种类（M5 §4.8；`write-failed` 是切片 2 补的：R6 要求写失败不静默）。 */
export type StorageIssueKind =
  | 'corrupt-line'
  | 'partial-line'
  | 'missing-header'
  | 'version-too-new'
  | 'path-mismatch'
  | 'unreadable-dir'
  | 'orphan-dir'
  | 'write-failed';

/**
 * 存储问题 —— 坏文件不阻断启动，但要能被用户看见（S7 / S8 的数据源）。
 */
export interface StorageIssue {
  kind: StorageIssueKind;
  sessionId?: string;
  /** 相对 sessions root 的路径（不暴露用户绝对路径）。 */
  path: string;
  detail: string;
  at: number;
}

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
  /** 项目会话的归属；缺省代表历史/自由会话。 */
  projectId?: string;
  executor: SessionExecutor;
  /** executor='team' 时的团队名（`~/.axon/teams/<name>.json`）。 */
  teamId?: string;
  /** executor='adhoc' 时的临时成员表（团队定义可从它「另存为模板」）。 */
  members?: AdhocMemberSpec[];
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  /** 会话级并发上限（团队 maxConcurrent 实例化到本会话的副本）。 */
  maxConcurrent?: number;
  /**
   * 会话级模型（M15），`providerId:modelId` 复合键（见 `formatModelRef`）。
   *
   * 优先级：角色/成员 overrides.model > 本字段 > config.defaultModelRef。
   * 即建会话时选的模型盖过全局默认，但不越过角色显式声明（「角色只能减能」）。
   * 解析不到时静默回落全局默认 —— 配置坏了不能让会话起不来。
   */
  modelRef?: string;
  /**
   * 外部引擎 id（M9）。缺省或 undefined = 走内置 pi 引擎（历史会话兼容）。
   * 值域与 `AgentToolId`（`@axon/protocol/agent-tools`）对齐。
   */
  engineId?: string;
  /**
   * 父会话 id（M10）。由 `task_spawn` 工具创建的子 session 带此字段，
   * 指向发出派生的主管 session。顶层会话（用户直接建的）无此字段。
   */
  parentSessionId?: string;
  /**
   * 派生本会话的主管 Agent 路径（M10）。
   * 用于审批穿透：子 session 里的审批请求可以沿此路径转发到主管 session。
   */
  parentAgentPath?: string;
  /**
   * 本会话作为主管派生的子 session id 列表（M10）。
   * 由 host 在 `task_spawn` 成功后维护（append-only）；落盘后跨重启持久。
   */
  childSessionIds?: string[];
  /**
   * 外部引擎给出的会话标识（M9）。
   *
   * 对 Claude Code（`claude_sdk`）是 SDK 返回的 `providerSessionId`，用于
   * 下次 `query({ resume: externalSessionId })` 恢复上下文。
   * 由主进程在会话首次启动成功后写回并落盘；重启后 `restoreEngines()` 读它。
   */
  externalSessionId?: string;
  /**
   * 外部引擎的完整恢复游标（M9，Claude Code 专用）。
   *
   * 形状参照 tutti `sessionRuntime.ts:1237`：
   * `{ kind: 'claude-agent-sdk'; version: 1; resume: string; resumeSessionAt?: string; turnCount: number }`
   *
   * 比 `externalSessionId` 更完整：携带轮次计数与最后一条消息 UUID，
   * 让 SDK 能精确地从中断点重接而不是从会话头部重播。
   * `externalSessionId` 保持冗余字段（= `resumeCursor.resume`），方便快速读取。
   */
  resumeCursor?: Record<string, unknown>;
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

/* 预算限额三档（SessionBudgetSpec / BudgetTier / SessionBudgetView）已删
   —— 2026-10-10 用户决策：成本熔断整体下线。

   用量没有一起删：「花了多少」由 `SessionSummary.usage`（UsageTotals）承载，
   原 `SessionBudgetView.spentUsd` 本就是 `usage.costUsd` 的副本，删掉不丢数据。

   旧落盘记录里残留的 `budget` 字段读出来即忽略（多余键不碰类型），
   因此 SESSION_SCHEMA_VERSION 不升 —— 没有任何字段改变语义或需要回填。 */

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
  /**
   * 上次退出时落盘的汇总（M5 §4.6）。**只有从磁盘恢复的会话才有**：
   * 它是 S7「上次中断」那行字的唯一来源 —— 运行中的会话看 `status` 就够了，
   * 而已经退出的会话，`interruptedAt` 是「当时还有成员在跑」的唯一证据。
   */
  rollup?: SessionRollup;
  /**
   * 子任务 session 的精简状态列表（M10，仅对有子任务的主管 session 出现）。
   *
   * 用于 S2「子任务」面板的列表行：知道 id / title / status 就够渲染，
   * 不必每个子任务都走 session.get（懒加载）。
   */
  childSessions?: Array<{
    sessionId: string;
    title: string;
    status: AgentStatus;
    /** 用量摘要（成本一行字）。 */
    costUsd: number;
    /** 有挂起审批时为 true，驱动列表行的红点。 */
    hasPending: boolean;
  }>;
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
  /**
   * 归属项目。传了则主进程以项目工作空间覆盖 cwd 并把 projectId 固化到记录；
   * 找不到项目时创建失败。
   */
  projectId?: string;
  executor: SessionExecutor;
  teamId?: string;
  members?: AdhocMemberSpec[];
  /** 建完立刻交给会话根（lead / 内置引擎）的任务。 */
  initialPrompt?: string;
  /** 会话级并发；不填则从团队档继承。 */
  maxConcurrent?: number;
  /**
   * 会话级模型（M15），`providerId:modelId` 复合键。
   * 缺省 = 跟全局 `defaultModelRef`。见 `SessionRecord.modelRef` 的优先级说明。
   */
  modelRef?: string;
  /**
   * 用户通过原生文件选择器选中、希望放入本次会话工作目录的文件绝对路径列表。
   * 主进程负责把它们复制进 record.cwd（不修改原文件）；渲染层不自己写文件。
   * 字段是**传输用**：落盘的 SessionRecord 里没有它，Agent 直接在 cwd 里看到文件。
   */
  attachments?: string[];
  /**
   * 外部引擎 id（M9）。与 `SessionRecord.engineId` 对应，
   * 值域为 `AgentToolId`（'claude' | 'codex' | …）。
   * 缺省 = 走内置 pi 引擎。
   */
  engineId?: string;
  /**
   * 子任务 session 的派生来源（M10）。
   *
   * 由 `task_spawn` 工具调用时填入，用户手动建的会话不应带这两个字段。
   * host 在创建 session 后会把 `id` 反向追加到父 session 的 `childSessionIds`。
   */
  parentSessionId?: string;
  /** 发出 task_spawn 的那个 Agent 路径；用于审批穿透（阶段 C）。 */
  parentAgentPath?: string;
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
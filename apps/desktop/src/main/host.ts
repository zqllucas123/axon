/**
 * AxonHost —— 内核宿主。命令的唯一执行者，事件的唯一来源。
 *
 * 它故意**不依赖 electron**：构造时注入一个 `emit` 回调即可。
 * 这样同一个宿主能跑在三个地方 —— Electron 主进程、CLI、单元测试 ——
 * 而 UI 契约（@axon/protocol 的 CommandMap/EventMap）一行都不用变。
 *
 * 反过来说，这里出现 `import ... from "electron"` 就是设计事故，
 * 它会让编排逻辑再也无法 headless 测试。
 *
 * ── M3 并发闸门语义（决策 #2 拍板）──
 *
 * running-only 计数 + parked FIFO + 父等子退位（suspended）+ 免检 promote：
 *
 *   running  = 真正在烧 token，占并发额度（maxConcurrent 只数它）
 *   waiting  = (a) parked —— 任务已领但额满排队；(b) suspended —— 父在
 *              agent_wait 里等后代，主动退位让额
 *   promote  = waiting→running 免检（额度来自「它等的子刚结束」，或排队轮到）
 *
 * 没有这层语义，父(占1)+6子 > 上限6 会结构性死锁：第 6 子永远拿不到额度，
 * 父永远等不来它。等边只沿树向下（M3 决策 #3），于是每逢子终态先解父、
 * 再补队首，链上任意深度都有进展。
 *
 * ─ MU-1：会话成为一等公民 ──
 *
 * 树不再挂在唯一的 `/root` 下，而是**每个会话一棵**（根路径 `/<sessionId>`）。
 * 随之落地四件事：
 *   - 会话 CRUD 与 rollup（session-store.ts）—— 账本/用量/待批按会话切片；
 *   - 团队实例化（session-instantiate.ts）—— 三角合成不变，只多了「谁和谁一起上」；
 *   - 三层预算取更严者（全局/团队/会话）与会话级并发闸门；
 *   - 审批代批留痕（approval.ts 修②）—— 不再静默放行。
 */

import {
  DEFAULT_ADOPTION_POLICY,
  SESSION_MEMBER_MAX,
  SESSION_MEMBER_MIN,
  SESSION_SCHEMA_VERSION,
  isTerminal,
  needsAdoption,
  newSessionId,
  parseForkMode,
  sessionIdOfPath,
  sessionRootPath,
  type AdhocMemberSpec,
  type Adoption,
  type AdoptionPolicy,
  type AgentPath,
  type AgentSnapshot,
  type AgentStatus,
  type ApprovalMode,
  type AxonConfig,
  type BudgetSnapshot,
  type BudgetTier,
  CONFIG_DEFAULTS,
  type CollabAction,
  type CollabOrigin,
  type CommandMap,
  type CreateSessionPayload,
  type EscalateSessionPayload,
  type EventMap,
  type LedgerQuery,
  type LedgerRecord,
  type MessageLike,
  type PendingRequest,
  type RoleDefinition,
  type RoleEntry,
  type RoleIssue,
  type SessionBudgetSpec,
  type SessionDetail,
  type SessionExecutor,
  type SessionListQuery,
  type SessionRecord,
  type SessionRollup,
  type SessionSummary,
  type SpawnAgentPayload,
  type StorageIssue,
  type TeamDefinition,
  type TeamEntry,
  type TeamIssue,
  type UsageTotals,
} from '@axon/protocol';
import {
  AgentRegistry,
  BudgetGuard,
  Ledger,
  createAxonEngine,
  forkMessages,
  repairMessages,
  fromMessageLike,
  intersectTools,
  type AgentEvent,
  type AxonEngine,
  type BudgetState,
  type ModelSource,
} from '@axon/kernel';
import {
  createOrchestrationTools,
  type OrchestrationDriver,
} from './orchestrator.ts';
import { ApprovalBroker, DEFAULT_APPROVAL_TIMEOUT_MS } from './approval.ts';
import { ENGINE_ROLE, LEAD_ROLE } from './roles.ts';
import { arbiterIneligibleReason, resolveArbiter } from './adoption.ts';
import {
  SessionStore,
  buildSessionSummary,
  computeEffectiveBudget,
  titleFromPrompt,
  type SessionStoreChange,
} from './session-store.ts';
import { SessionPersistence, type SessionListItem } from './session-persistence.ts';
import type { ParsedTranscript, TranscriptHeader } from './session-files.ts';
import {
  adhocTasks,
  adhocTeam,
  planTeam,
  rosterPrompt,
  stricterApproval,
  type MemberPlan,
  type TeamPlan,
} from './session-instantiate.ts';

export type EmitFn = <E extends keyof EventMap>(
  event: E,
  payload: EventMap[E],
  source?: AgentPath,
) => void;

export interface BudgetOptions {
  /** 软线（美元）。省略 = hard × 0.8。 */
  softUsd?: number;
  /** 硬线（美元）；<= 0 表示熔断关闭。 */
  hardUsd: number;
}

export interface HostOptions {
  emit: EmitFn;
  /** 模型来源。由调用方决定是真 provider 还是 faux —— 宿主不关心。 */
  modelSource: ModelSource;
  roles: RoleDefinition[];
  /** 工具全集。角色的白名单在此之上做交集，只能减不能加。 */
  tools?: unknown[];
  maxConcurrent?: number;
  /** 分身树最大深度（会话根为 0）；缺省 2。 */
  maxDepth?: number;
  /** 预算熔断（M3）。缺省 = 关闭。 */
  budget?: BudgetOptions;
  /** idle 看门狗：running 且超时无任何事件 → 中断。0 = 关闭。默认 5 分钟（kalo 同值）。 */
  idleTimeoutMs?: number;
  /** 审批请求超时（M4）。0 = 不超时。 */
  approvalTimeoutMs?: number;
  /** 裁决策略初值（M4 决策 D2）。缺省 = 人工表态。 */
  adoptionPolicy?: AdoptionPolicy;
  /** 角色未写审批档时的全局兜底（config.defaultApproval）。 */
  defaultApproval?: ApprovalMode;
  /** 新建会话的缺省工作目录。 */
  defaultCwd?: string;
  /** 新建会话的缺省执行方式（S0 三张卡的默认选中项）。 */
  defaultExecutor?: SessionExecutor;
  /**
   * 会话落盘（M5）。缺省 = **不落盘**（内存态）。
   *
   * 为什么不在这里 new 一个默认实例：默认根是 `~/.axon/sessions`，
   * 测试与冒烟一旦忘了传，就会把垃圾写进用户的 home。落盘根的决策
   * 属于接线层（index.ts 读 `AXON_SESSIONS_DIR`），不属于宿主。
   */
  persistence?: SessionPersistence;
  /**
   * 启动装载的会话（M5 §4.5）：**记录 + 汇总**，都不读树。
   *
   * 带 rollup 进来是懒加载的前提：`session.list` 永不触发加载，列表里的
   * 成员数/用量就只剩落盘时写下的那一份可用（§4.5）。
   */
  records?: readonly SessionListItem[];
}

/** 可被 `config.patch` 热改的运行期参数。 */
interface RuntimeConfig {
  /** 全局档预算（configured 值，不是 BudgetGuard 里补过默认值的版本）。 */
  globalBudget: SessionBudgetSpec;
  defaultApproval: ApprovalMode;
  defaultCwd?: string;
  defaultExecutor: SessionExecutor;
}

/** 默认 idle 看门狗 5 分钟 —— 抄 kalo `IDLE_TIMEOUT_MS = 5min`（02 §2.3）。 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** 预算档位的严重度排序（只往更差的方向报，回退时不播事件）。 */
const TIER_RANK: Record<BudgetTier, number> = { ok: 0, warning: 1, frozen: 2 };

/**
 * 路径深度（`/<s>` = 1，`/<s>/dev-1` = 2）。
 *
 * 恢复引擎时要「父先于子」，用的就是它（restoreNodes 内部另有一份 depthOf）。
 */
function depthOf(path: AgentPath): number {
  return path.split('/').filter(Boolean).length;
}

/** 消息里带的用量之和（重启后没有 state 行时的兜底口径）。 */
function usageOfMessages(messages: readonly MessageLike[]): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const message of messages) {
    const usage = (message as { usage?: Partial<UsageTotals> }).usage;
    if (!usage) continue;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    costUsd += usage.costUsd ?? 0;
  }
  return { inputTokens, outputTokens, costUsd };
}

export class AxonHost {
  private readonly registry: AgentRegistry;
  private roles = new Map<string, RoleEntry>();
  /** 加载期坏文件的错误（不在 roles 里，单独携带给 UI 渲染红条）。 */
  private roleIssues: RoleIssue[] = [];
  /** 团队表（由 TeamBridge 灌入，与 roles 同构）。 */
  private teams = new Map<string, TeamEntry>();
  private teamIssues: TeamIssue[] = [];
  /** 会话元数据（落盘挂点见 onSessionChanged；M5 起由构造参数注入初始记录）。 */
  private readonly sessions: SessionStore;
  /**
   * 每会话的预算档位上次观测值。
   *
   * 与「事件节流」不是一回事：这里只负责「只报变化」，一个会话的
   * 档位从 ok 变 warning 只该发一次，而不是每轮 turn.end 都发。
   */
  private readonly sessionTiers = new Map<string, BudgetTier>();
  /** 可热改的运行期配置（config.patch 的落点，见 applyConfig）。 */
  private runtime: RuntimeConfig;
  private readonly emit: EmitFn;
  /** 模型来源。config.patch 改了 provider 后会整体替换（见 setModelSource）。 */
  private modelSource: ModelSource;
  private readonly tools: unknown[];
  // ── M3：闸门 / 预算 / 活性 ──────────────────────────────
  private readonly budget: BudgetGuard;
  private idleTimeoutMs: number;
  /** parked FIFO：等额度的 Agent，按请求先后排队。 */
  private readonly pendingRuns: AgentPath[] = [];
  private readonly pendingTexts = new Map<AgentPath, string>();
  private readonly parkedResolvers = new Map<AgentPath, () => void>();
  /** wait 图：suspended 父 → 尚未终态的目标集。边只沿树向下（决策 #3）。 */
  private readonly waits = new Map<AgentPath, Set<AgentPath>>();
  private readonly waitResolvers = new Map<AgentPath, () => void>();
  /** 每父一条共享 Promise：同一父的并发多次 wait 合并进同一集合、等同一结局。 */
  private readonly waitPromises = new Map<AgentPath, Promise<void>>();
  /** per-agent idle 计时器与最后活动时间（看门狗，按空闲而非总时长）。 */
  private readonly idleTimers = new Map<AgentPath, ReturnType<typeof setTimeout>>();
  private readonly lastActivity = new Map<AgentPath, number>();

  // ── M4：账本 / 审批 / 裁决 ───────────────────────
  private readonly ledger: Ledger;
  /** 会话落盘（缺省 undefined = 纯内存，见 HostOptions.persistence）。 */
  private readonly persistence: SessionPersistence | undefined;
  /** 已懒加载的会话（§4.5：用到哪个装哪个；`session.list` 永不触发）。 */
  private readonly loaded = new Set<string>();
  /** 未加载会话的汇总缓存（来自 session.json 的 rollup）。 */
  private readonly sessionRollups = new Map<string, SessionRollup>();
  private readonly approvals: ApprovalBroker;
  private adoptionPolicy: AdoptionPolicy;
  private adoptionPolicyAt: number;
  /**
   * 正在等人批的 agent。看门狗对它们豁免 —— 等审批期间 agent 仍是 running，
   * 不豁免就会被 idle 看门狗 abort 掉。另一个选项是定期 touch() 保活，
   * 但那是骗看门狗，语义上不诚实。
   */
  private readonly awaitingApproval = new Set<AgentPath>();
  /** 裁决请求的 recordId → arbiter，供 ledger_adopt 校验「你是不是被问的那个」。 */
  private readonly arbitrationTargets = new Map<string, AgentPath>();

  constructor(options: HostOptions) {
    this.persistence = options.persistence;
    // 启动装载：记录进 store、汇总进缓存，**都不读树**（§4.5 的第一段）。
    for (const item of options.records ?? []) {
      if (item.rollup) this.sessionRollups.set(item.record.id, item.rollup);
    }
    this.sessions = new SessionStore({
      ...(options.records ? { records: options.records.map((item) => item.record) } : {}),
      onChange: (event) => this.onSessionChanged(event),
    });
    this.ledger = new Ledger({ onChange: (entry) => this.onLedgerChanged(entry) });
    this.emit = options.emit;
    this.modelSource = options.modelSource;
    this.tools = options.tools ?? [];
    this.registry = new AgentRegistry({
      maxConcurrent: options.maxConcurrent ?? 6,
      maxDepth: options.maxDepth ?? 2,
    });
    this.budget = new BudgetGuard(options.budget ?? { hardUsd: 0 });
    // 全局线要接着上次算：不把已花的钱种子化，重启就等于把预算重置了。
    const restoredSpend = [...this.sessionRollups.values()].reduce(
      (sum, rollup) => sum + rollup.usage.costUsd,
      0,
    );
    if (restoredSpend > 0) this.budget.record(restoredSpend);
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.runtime = {
      globalBudget: {
        ...(options.budget?.hardUsd ? { hardUsd: options.budget.hardUsd } : {}),
        ...(options.budget?.softUsd ? { softUsd: options.budget.softUsd } : {}),
      },
      defaultApproval: options.defaultApproval ?? 'always_ask',
      defaultExecutor: options.defaultExecutor ?? 'engine',
      ...(options.defaultCwd ? { defaultCwd: options.defaultCwd } : {}),
    };
    this.adoptionPolicy = options.adoptionPolicy ?? DEFAULT_ADOPTION_POLICY;
    this.adoptionPolicyAt = Date.now();
    this.approvals = new ApprovalBroker({
      approvalModeOf: (p) => this.approvalModeOf(p),
      exists: (p) => this.registry.has(p),
      emit: (event, payload, source) => this.emit(event, payload, source),
      onWaitStart: (p) => this.awaitingApproval.add(p),
      onWaitEnd: (p) => {
        this.awaitingApproval.delete(p);
        // 批完就要让看门狗重新计时，否则人拖了五分钟再批，
        // 工具刚开始跑就立刻被判定为卡死。
        this.touch(p);
      },
      timeoutMs: options.approvalTimeoutMs,
    });
    for (const role of options.roles) {
      this.roles.set(role.name, { role, source: 'builtin', errors: [] });
    }
  }

  /** 释放全部计时器（测试与退出时用）。 */
  dispose(): void {
    // §4.6：挂起的审批/提问只活在内存里（§4.7 明确不落盘），重启后必然消失。
    // 退出时按「拒绝」结算并留一笔痕 —— 否则用户重启回来只看到一个莫名卡住的
    // 会话，收件箱里的待办则无声蒸发。respond 是幂等的，重复退出也安全。
    for (const pending of this.approvals.list()) {
      if (pending.state !== 'pending') continue;
      if (this.loaded.has(pending.sessionId)) {
        this.persistNote(pending.origin, '应用退出：挂起的审批/提问未决，已按拒绝结算');
      }
      this.approvals.respond(pending.requestId, false, '应用退出，未决请求已拒绝');
    }
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    this.approvals.dispose();
    this.awaitingApproval.clear();
    this.arbitrationTargets.clear();
    this.waits.clear();
    this.waitResolvers.clear();
    this.waitPromises.clear();
    this.pendingRuns.length = 0;
    this.pendingTexts.clear();
    this.parkedResolvers.clear();
    this.sessionTiers.clear();
  }

  /**
   * 整表替换角色集合（M2 RoleLoader 的热重载入口）。
   *
   * 运行中的 Agent 不受影响：spawn 时角色定义已被快照进实例
   * （systemPrompt / 白名单在那一刻定死），改角色只影响**之后**的 spawn。
   * 这是有意为之——热改导致在跑任务中途换性格，对用户是惊吓不是惊喜。
   */
  updateRoles(entries: RoleEntry[], issues: RoleIssue[]): void {
    this.roles = new Map(entries.map((entry) => [entry.role.name, entry]));
    this.roleIssues = issues;
    this.emit('roles.changed', { entries, issues });
  }

  listRoles(): { entries: RoleEntry[]; issues: RoleIssue[] } {
    return { entries: [...this.roles.values()], issues: [...this.roleIssues] };
  }

  /**
   * 换模型源（`config.patch` 改了 provider 之后）。
   *
   * 已 spawn 的引擎不受影响：它们在创建时就把 model/streamFn 固化进 pi Agent 了
   * —— 与角色热重载同一条纪律。新会话/新成员走新模型。
   */
  setModelSource(source: ModelSource): void {
    this.modelSource = source;
  }

  /**
   * 整表替换团队集合（TeamBridge 的热重载入口）。
   *
   * 与角色同理：已在跑的会话不受影响（团队只在会话创建/升级时被解读，
   * 解读结果已落在那棵树上），改团队只影响之后新建的会话。
   */
  updateTeams(entries: TeamEntry[], issues: TeamIssue[]): void {
    this.teams = new Map(entries.map((entry) => [entry.team.name, entry]));
    this.teamIssues = issues;
    this.emit('teams.changed', { entries, issues });
  }

  getTeams(): { entries: TeamEntry[]; issues: TeamIssue[] } {
    return { entries: [...this.teams.values()], issues: [...this.teamIssues] };
  }

  list(): AgentSnapshot[] {
    return this.registry.list();
  }

  get(path: AgentPath): AgentSnapshot | null {
    return this.registry.snapshot(path);
  }

  messagesOf(path: AgentPath): MessageLike[] {
    const sessionId = sessionIdOfPath(path);
    if (sessionId !== undefined) this.ensureSessionLoaded(sessionId);
    return this.registry.get(path)?.engine?.messages() ?? [];
  }

  /** 预算档位（M3）。UI 与编排工具都看它。 */
  budgetState(): BudgetState {
    return this.budget.current;
  }

  /**
   * 预算快照（M4 / MX G7.3）。
   *
   * frozen 是终态且只通过一次性事件宣布，UI 一刷新就再也不知道自己
   * 已经被冻住了——所以必须有查询通道。
   */
  budgetSnapshot(): BudgetSnapshot {
    const { softUsd, hardUsd } = this.budget.limits;
    // usage 取全部会话根的和（多根模型下没有唯一的「总账根」）。
    // spentUsd 也用它而不是 budget.spent：后者是「上次 record 时的值」，
    // 没人跑任务时会停在旧数上。
    const usage = this.registry.totalUsage();
    return {
      state: this.budget.current,
      // M5：冷启动时 registry 里一个节点都没有（会话还在盘上），此时「已花」
      // 只剩构造时按 rollup 种子化的那一份 —— 取两者更大的，别让 UI 显示成 $0。
      spentUsd: Math.max(usage.costUsd, this.budget.spent),
      softUsd,
      hardUsd,
      disabled: this.budget.disabled,
      usage,
    };
  }

  /** 某会话的预算视图（三层取更严者）。UI 与会话级闸门都用它。 */
  private budgetViewOf(sessionId: string) {
    const record = this.sessions.get(sessionId);
    const team = record?.teamId ? this.teams.get(record.teamId)?.team : undefined;
    const rootPath = sessionRootPath(sessionId);
    const spentUsd = this.registry.get(rootPath)?.snapshot.usage.costUsd ?? 0;
    return computeEffectiveBudget(
      {
        global: this.runtime.globalBudget,
        ...(team?.budget ? { team: team.budget } : {}),
        ...(record?.budget ? { self: record.budget } : {}),
      },
      spentUsd,
    );
  }

  // ── M4：协作账本 ───────────────────────────────

  queryLedger(query: LedgerQuery) {
    // 账本在内存里：带 sessionId 查就是「用到了这个会话」（§4.5）。
    if (query.sessionId !== undefined) this.ensureSessionLoaded(query.sessionId);
    return this.ledger.query(query);
  }

  getLedgerRecord(id: string): LedgerRecord | null {
    return this.ledger.get(id);
  }

  /** 人工裁决（`ledger.adopt` 命令的落点）。 */
  adoptByHuman(id: string, adoption: Adoption, note?: string): LedgerRecord {
    const record = this.ledger.adopt(id, adoption, { kind: 'human' }, note);
    if (!record) throw new Error(`账本记录不存在: ${id}`);
    this.emit('ledger.updated', { record }, record.to);
    return record;
  }

  getAdoptionPolicy(): AdoptionPolicy {
    return this.adoptionPolicy;
  }

  setAdoptionPolicy(policy: AdoptionPolicy): AdoptionPolicy {
    this.adoptionPolicy = policy;
    this.adoptionPolicyAt = Date.now();
    this.emit('ledger.policyChanged', { policy });
    return policy;
  }

  /** 挂起中的审批/提问（`pending.list`）。 */
  listPending(): PendingRequest[] {
    return this.approvals.list();
  }

  respondApproval(requestId: string, approved: boolean, note?: string): { accepted: true } {
    return this.approvals.respond(requestId, approved, note);
  }

  // ── MU-1：会话（一等公民）────────────────────────────────
  //
  // 会话与「树」是同一件事的两种视角：会话根 `/<sessionId>` 是那棵树的锚点，
  // 它的后代就是会话成员。多根模型下没有全局 `/root`，所以顺序固定：
  // 建根 → 挂成员 → 写会话记录 → 装主控引擎 → 跑首条任务。
  // （记录放在成员之后：摘要要数成员，而成员的 spawn 只需要根已存在。）

  /**
   * 建会话（S0 的「开始」按钮）。三种执行方式共用这一条路径 ——
   * 「内置引擎」在这里被当作「零成员的团队」的退化形式，而不是另一套创建流程。
   * 两条流程必然在第三个月开始分叉（同样的教训写进了 session-instantiate 的头注）。
   */
  createSession(payload: CreateSessionPayload): SessionSummary {
    const title = titleFromPrompt(payload.title || payload.initialPrompt || '');
    if (!title) throw new Error('会话标题不能为空');

    const plan = this.planFor(payload.executor, payload.teamId, payload.members);
    const sessionId = newSessionId();
    const rootPath = sessionRootPath(sessionId);
    const cwd = payload.cwd ?? this.runtime.defaultCwd ?? process.cwd();
    // 并发上限：团队档是默认值，会话档**只能更严**（与预算同一条规则）。
    const teamLimit = plan.team.maxConcurrent ?? 0;
    const limit =
      payload.maxConcurrent !== undefined && payload.maxConcurrent > 0
        ? teamLimit > 0
          ? Math.min(payload.maxConcurrent, teamLimit)
          : payload.maxConcurrent
        : teamLimit;

    // ① 主控：会话先有根，子节点才有地方挂
    this.registry.createRoot(sessionId, {
      role: plan.lead.role.name,
      displayName: plan.lead.displayName,
      ...(plan.lead.forkMode !== undefined ? { forkMode: plan.lead.forkMode } : {}),
    });
    this.registry.setSessionLimit(sessionId, limit);

    // ② 成员（计划里已拓扑排序：父先于子）
    const spawned = this.spawnMembers(sessionId, plan);

    // ③ 记录
    const now = Date.now();
    const record: SessionRecord = {
      id: sessionId,
      title,
      cwd,
      executor: payload.executor,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      schemaVersion: SESSION_SCHEMA_VERSION,
      ...(payload.teamId !== undefined ? { teamId: payload.teamId } : {}),
      ...(payload.members !== undefined ? { members: payload.members } : {}),
      ...(payload.budget !== undefined ? { budget: payload.budget } : {}),
      ...(limit > 0 ? { maxConcurrent: limit } : {}),
    };
    this.sessions.create(record);
    // 基线档位：建档时先记一次，之后只在**变差**时播事件（否则开局就发一条噪音）。
    this.sessionTiers.set(sessionId, this.budgetViewOf(sessionId).tier);

    // ④ 主控引擎：roster 只写给真组队的会话（单兵没有成员，写了是撒谎）
    const roster = plan.members.length > 0 ? rosterPrompt(sessionId, spawned) : undefined;
    this.buildRootEngine(rootPath, sessionId, plan.lead, {
      orchestration: plan.members.length > 0,
      ...(roster !== undefined ? { systemPromptExtra: roster } : {}),
    });

    // ⑤ 第一条任务：不 await —— 建会话是「下单」，不是「等交付」
    const prompt = payload.initialPrompt?.trim();
    if (prompt) void this.requestRun(rootPath, prompt).catch(() => undefined);

    const summary = this.summaryOf(sessionId);
    if (!summary) throw new Error(`会话 ${sessionId} 建后即不可读（内部错误）`);
    this.emit('session.created', { summary });
    return summary;
  }

  /**
   * 按计划把成员挂上树。
   *
   * 父子关系用的是**实际路径**而不是名字：plan 里的 parentName 要在 spawn 之后
   * 才有对应路径（链形编队里父必须先建）。所以这里维护一张 name → path 的
   * 临时表，而不是让计划层提前算路径 —— 路径由注册表分配，计划层不该臆测。
   */
  private spawnMembers(
    sessionId: string,
    plan: TeamPlan,
    tasks?: ReadonlyMap<string, string>,
  ): { plan: MemberPlan; path: AgentPath }[] {
    const rootPath = sessionRootPath(sessionId);
    const paths = new Map<string, AgentPath>();
    const spawned: { plan: MemberPlan; path: AgentPath }[] = [];
    for (const member of plan.members) {
      const parent = member.parentName !== undefined ? paths.get(member.parentName) : rootPath;
      if (!parent) {
        throw new Error(`成员「${member.name}」的父「${member.parentName ?? ''}」尚未实例化`);
      }
      const task = member.task ?? tasks?.get(member.name);
      // 生效角色已在计划层套好覆写（只减不增），这里再走一遍 spawn 的合成：
      // 求交与取更严都是幂等的，重复应用不会放大权限。
      const snapshot = this.spawn({
        role: member.role.name,
        parent,
        sessionId,
        ...(member.forkMode !== undefined ? { forkMode: member.forkMode } : {}),
        overrides: {
          displayName: member.displayName,
          ...(member.role.model !== undefined ? { model: member.role.model } : {}),
          tools: member.role.tools,
          approval: member.role.approval,
        },
        ...(task !== undefined ? { initialPrompt: task } : {}),
      });
      paths.set(member.name, snapshot.path);
      spawned.push({ plan: member, path: snapshot.path });
    }
    return spawned;
  }

  /**
   * 执行方式 → 实例化计划。
   *
   * 三种方式在这里收敛成同一个 TeamPlan，之后就没有分支了 ——
   * 「内置引擎」= 只有一个成员（它就是 lead）的团队；临时编队先转成
   * 一份 TeamDefinition 再走 planTeam（adhocTeam 的头注解释了为什么不另写一条）。
   */
  private planFor(
    executor: SessionExecutor,
    teamId?: string,
    members?: readonly AdhocMemberSpec[],
  ): TeamPlan {
    const roles = this.roleTable();
    const opts = { roles, defaultApproval: this.runtime.defaultApproval };
    if (executor === 'engine') {
      // 单兵会话 = 只有一个成员的退化团队：root 即全部，没有任何子节点。
      // 这里不过 planTeam：没有需要解析的成员组合，也没必要因为宿主没带
      // engine 角色就抛错（测试里的宿主常用自定义角色表）。
      const role = this.roles.get(ENGINE_ROLE.name)?.role ?? ENGINE_ROLE;
      const member: MemberPlan = {
        name: role.displayName,
        role,
        displayName: role.displayName,
        lead: true,
        ...(role.defaultForkMode !== undefined ? { forkMode: role.defaultForkMode } : {}),
      };
      return {
        lead: member,
        members: [],
        team: {
          name: '单兵',
          description: '内置引擎单独执行（不是团队）',
          members: [{ name: member.name, role: role.name, lead: true }],
        },
      };
    }
    if (executor === 'team') {
      if (!teamId) throw new Error('指定团队模式必须提供 teamId');
      const teamEntry = this.teams.get(teamId);
      if (!teamEntry) throw new Error(`团队不存在: ${teamId}`);
      const blocking = teamEntry.errors.filter((e) => e.level === 'error');
      // 坏团队不实例化：宁可当场报错，也不要把半支队伍摆到用户面前。
      if (blocking.length > 0) throw new Error(`团队「${teamId}」不可用：${blocking[0]!.message}`);
      return planTeam(teamEntry.team, opts);
    }
    const specs = [...(members ?? [])];
    if (specs.length < SESSION_MEMBER_MIN || specs.length > SESSION_MEMBER_MAX) {
      throw new Error(`临时编队成员数须在 ${SESSION_MEMBER_MIN}~${SESSION_MEMBER_MAX} 之间，收到 ${specs.length}`);
    }
    const nameOf = (m: AdhocMemberSpec, i: number) => m.name ?? (i === 0 ? '主控' : m.role);
    return planTeam(adhocTeam(specs), {
      ...opts,
      tasks: adhocTasks(specs, nameOf),
    });
  }

  /** 角色表（name → 定义），供纯逻辑层（planTeam）做解析。 */
  private roleTable(): Map<string, RoleDefinition> {
    return new Map([...this.roles.values()].map((e) => [e.role.name, e.role]));
  }

  /**
   * 会话根引擎 —— 单兵内置引擎与团队主控共用这一条装配路径。
   *
   * 与 spawn 的三点区别（都是「根不是普通节点」的体现）：
   *  1. 它由**执行方式**决定拿不拿编排工具（orchestration），而不是角色白名单；
   *  2. 它的 systemPrompt 追加 roster（运行期事实：成员是谁、路径在哪）；
   *  3. 升级（escalate）时可以把旧消息灌回来 —— 换的是引擎，不是会话。
   */
  private buildRootEngine(
    rootPath: AgentPath,
    sessionId: string,
    lead: MemberPlan,
    opts: {
      orchestration: boolean;
      systemPromptExtra?: string;
      messages?: MessageLike[];
    },
  ): AxonEngine {
    const allowSet = lead.role.tools ? new Set(lead.role.tools) : undefined;
    const engine = createAxonEngine({
      systemPrompt: [lead.role.instructions, opts.systemPromptExtra].filter(Boolean).join('\n\n'),
      model: this.modelSource.model,
      streamFn: this.modelSource.streamFn,
      messages: fromMessageLike(opts.messages ?? []),
      tools: this.toolsFor(rootPath, allowSet, { orchestration: opts.orchestration }) as never,
      sessionId,
      onBeforeTool: async (name, args) => {
        if (allowSet && !allowSet.has(name)) {
          return { allow: false, reason: `角色 ${lead.role.name} 未获授权使用 ${name}` };
        }
        return this.approvals.gate(rootPath, name, args);
      },
    });
    // attachEngine 覆盖旧的：升级路径靠这一句完成「换引擎不换会话」。
    this.registry.attachEngine(rootPath, engine);
    this.wire(rootPath, engine);
    return engine;
  }

  /**
   * spawn 的父路径解析。
   *
   * 多根模型下不存在「默认根」，所以两者至少有其一；两个都给时以 parent 为准
   * （更具体），但会校验它确实属于 sessionId 指的会话 —— 静默接受跨会话的
   * parent 会造出「会话切片看不见的节点」，那是比报错更难查的故障。
   */
  private resolveParent(payload: SpawnAgentPayload): AgentPath {
    if (payload.parent !== undefined) {
      if (payload.sessionId !== undefined) {
        const owner = sessionIdOfPath(payload.parent);
        if (owner !== undefined && owner !== payload.sessionId) {
          throw new Error(`父路径 ${payload.parent} 属于会话 ${owner}，与 ${payload.sessionId} 不符`);
        }
      }
      return payload.parent;
    }
    if (payload.sessionId !== undefined) return sessionRootPath(payload.sessionId);
    throw new Error('spawn 必须指定 parent 或 sessionId（多根模型下没有全局默认根）');
  }

  /** 会话预算闸门：额满时拒绝再往这个会话里放新节点（三层取更严者）。 */
  private assertSessionCanStart(sessionId: string, what: string): void {
    const view = this.budgetViewOf(sessionId);
    if (view.effectiveHardUsd > 0 && view.spentUsd >= view.effectiveHardUsd) {
      const by = view.limitedBy === 'team' ? '团队预算' : view.limitedBy === 'session' ? '会话预算' : '全局预算';
      throw new Error(
        `${what}被拒绝：会话 ${sessionId} 已到硬线（$${view.spentUsd.toFixed(2)} / $${view.effectiveHardUsd.toFixed(2)}，受${by}限制）`,
      );
    }
  }

  // ─ 会话的读侧（IPC 的 session.* 直接落在这里）────────────

  /**
   * 会话摘要。
   *
   * 根不在注册表里时返回 undefined（会话已被 remove / 树被删过）：宁可让 UI
   * 少一行，也不发一份字段齐全但根是假的摘要 —— 后者会让点击行为变成
   * 「打开一个空页面」，比缺行更难解释。
   */
  private summaryOf(sessionId: string): SessionSummary | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    // 懒加载：没装进内存的会话**不读树**（§4.5「session.list 永不触发加载」），
    // 摘要只用记录 + 落盘的 rollup。
    if (!this.loaded.has(sessionId)) return this.rollupSummaryOf(record);
    const rootPath = sessionRootPath(sessionId);
    const members = this.registry.listOf(sessionId);
    const root = members.find((m) => m.path === rootPath);
    if (!root) return undefined;

    const team = record.teamId !== undefined ? this.teams.get(record.teamId)?.team : undefined;
    // 临时成员 = 树上实际有、团队定义里没有的那些（UX 02 §6 拍板：不算团队成员）。
    const tempCount = team ? Math.max(0, members.length - 1 - team.members.length) : 0;
    const rollup = this.sessionRollups.get(sessionId);
    return buildSessionSummary({
      record,
      rootPath,
      status: root.status,
      members,
      // limit 0：只要 total，不要记录体（账本面板自己会再查一次带分页的）。
      ledgerCount: this.ledger.query({ sessionId, limit: 0 }).total,
      pending: this.approvals.list().filter((p) => p.sessionId === sessionId),
      globalBudget: this.runtime.globalBudget,
      ...(team?.budget !== undefined ? { teamBudget: team.budget } : {}),
      ...(team !== undefined ? { team } : {}),
      tempCount,
      // E-1：已装载的会话也带上 rollup —— S7 用它的 `interruptedAt` 说「上次中断」，
      // 那是历史事实，不因为本次装载了就消失。
      ...(rollup ? { rollup } : {}),
    });
  }

  private requireSummary(sessionId: string): SessionSummary {
    const summary = this.summaryOf(sessionId);
    if (!summary) throw new Error(`会话不存在或已结束: ${sessionId}`);
    return summary;
  }

  getSession(sessionId: string): SessionDetail | null {
    // 懒加载触发点（§4.5）：用户点开哪个会话，才读哪个会话的树。
    this.ensureSessionLoaded(sessionId);
    const summary = this.summaryOf(sessionId);
    if (!summary) return null;
    return { ...summary, members: this.registry.listOf(sessionId) };
  }

  listSessions(query: SessionListQuery = {}): SessionSummary[] {
    // 先过滤再算摘要：算摘要是按会话的一次全表扫（成员/账本/待批），
    // 对已删根的会话直接跳过更省事。
    return this.sessions
      .list(query)
      .map((record) => this.summaryOf(record.id))
      .filter((s): s is SessionSummary => s !== undefined);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    const clean = titleFromPrompt(title);
    if (!clean) throw new Error('会话标题不能为空');
    const updated = this.sessions.update(sessionId, { title: clean });
    if (!updated) throw new Error(`会话不存在: ${sessionId}`);
    const summary = this.requireSummary(sessionId);
    this.emit('session.changed', { summary });
    return summary;
  }

  /**
   * 删会话 = 删树 + 删记录。
   *
   * 顺序有讲究：先 remove 整棵树（它会中断引擎、清队列、结算账本、取消审批），
   * 再删记录 —— 反过来的话，树还在跑而摘要已经查不到了，用户会看到
   * 「左栏没了、右栏还在烧 token」。
   */
  removeSession(sessionId: string): { removedPaths: AgentPath[] } {
    if (!this.sessions.has(sessionId)) return { removedPaths: [] };
    const removedPaths = this.remove(sessionRootPath(sessionId));
    this.sessions.remove(sessionId);
    this.sessionTiers.delete(sessionId);
    this.emit('session.removed', { sessionId, paths: removedPaths });
    return { removedPaths };
  }

  /**
   * 单兵 → 团队（S2-solo 的「叫人」）。
   *
   * 语义是「换主控」而不是「再建一个会话」：会话 id / 记录 / 已有消息都留着，
   * 换掉的是根的**引擎与角色**，外加新成员。三条前置条件（都在下面拦）：
   *  1. 会话必须存在，且根不能正在跑（换引擎时旧轮次会凭空消失）；
   *  2. 会话必须还是**单兵**（已经组过队的会话再升级 = 两套成员混在一起，
   *     想加人就该走 agent.spawn，而不是 escalate）；
   *  3. 新团队必须可用（validateTeam 无 error），且预算未到硬线。
   */
  escalateSession(payload: EscalateSessionPayload): SessionDetail {
    const record = this.sessions.get(payload.sessionId);
    if (!record) throw new Error(`会话不存在: ${payload.sessionId}`);
    const sessionId = record.id;
    // 升级要往树上加人：冷会话必须先加载（§4.5）。
    this.ensureSessionLoaded(sessionId);
    const rootPath = sessionRootPath(sessionId);

    const node = this.registry.get(rootPath);
    if (!node) throw new Error(`会话根不存在: ${rootPath}`);
    const status = node.snapshot.status;
    if (status === 'running' || this.waits.has(rootPath) || status === 'waiting') {
      throw new Error('会话正在运行：先等它跑完或中断，再叫人（升级会换掉主控引擎）');
    }
    if (node.snapshot.children.length > 0) {
      throw new Error('该会话已经有成员了：直接派新成员即可，不必升级');
    }
    this.budget.assertCanStart('升级');
    this.assertSessionCanStart(sessionId, '升级');

    const plan = this.planFor(
      payload.teamId !== undefined ? 'team' : 'adhoc',
      payload.teamId,
      payload.members,
    );

    // ① 换身份：根从「内置引擎」变成团队主控
    this.registry.updateIdentity(rootPath, {
      role: plan.lead.role.name,
      displayName: plan.lead.displayName,
    });
    const teamLimit = plan.team.maxConcurrent ?? 0;
    this.registry.setSessionLimit(sessionId, teamLimit);
    this.persistNote(
      rootPath,
      `会话升级：主控换为「${plan.lead.displayName}」，新增 ${plan.members.length} 名成员`,
    );

    // ② 成员
    const spawned = this.spawnMembers(sessionId, plan);

    // ③ 换引擎：carryMessages 缺省 true —— 换的是引擎，不是会话。
    //    旧消息灌回新引擎，等价于「fork: all 但只作用于主控自己」。
    const carry = payload.carryMessages !== false;
    const roster = rosterPrompt(sessionId, spawned);
    this.buildRootEngine(rootPath, sessionId, plan.lead, {
      orchestration: true,
      systemPromptExtra: roster,
      ...(carry ? { messages: this.messagesOf(rootPath) } : {}),
    });

    // ④ 记录：执行方式与团队引用一起改，摘要才对得上
    this.sessions.update(sessionId, {
      executor: plan.team.members.length > 1 && payload.teamId !== undefined ? 'team' : 'adhoc',
      ...(payload.teamId !== undefined ? { teamId: payload.teamId } : {}),
      ...(payload.members !== undefined ? { members: payload.members } : {}),
      ...(teamLimit > 0 ? { maxConcurrent: teamLimit } : {}),
    });

    const detail = this.getSession(sessionId);
    if (!detail) throw new Error(`升级后会话不可读: ${sessionId}`);
    this.emit('session.changed', { summary: detail });

    // ⑤ 升级后立刻派活（可选）
    const task = payload.task?.trim();
    if (task) void this.requestRun(rootPath, task).catch(() => undefined);
    return detail;
  }

  /**
   * 会话变更播报（节流交给 IPC 层，见 index.ts 的 session.changed）。
   *
   * 只在**可能改变摘要**的地方调用：状态跃迁、落账、结算、审批挂起/解除、
   * turn.end（用量）。调用点不多不少正好这些 —— 每处都对应摘要里的一个字段。
   */
  private touchSession(sessionId: string): void {
    const summary = this.summaryOf(sessionId);
    if (!summary) return;
    this.scheduleRollup(sessionId, summary);
    this.emit('session.changed', { summary });
  }

  // ── M5：懒加载与恢复（§4.5 / §4.6）─────────────────────────

  /**
   * 懒加载：把一个冷会话从磁盘装进内存（树 + 引擎 + 账本 + 用量/状态）。
   *
   * 幂等；**只在被用到时才读树**（§4.5：`session.list` 永不触发加载）。
   * 触发点：`getSession` / `messagesOf` / `prompt` / `spawn` /
   * `escalateSession` / `queryLedger({sessionId})`。
   */
  ensureSessionLoaded(sessionId: string): void {
    if (this.loaded.has(sessionId)) return;
    const record = this.sessions.get(sessionId);
    if (!record) return;
    // 先标记再装：装载过程中若有人再来要，不该递归装第二遍（幂等的落点）。
    this.loaded.add(sessionId);
    const p = this.persistence;
    if (!p) return;

    const loaded = p.loadSessionSync(record);
    if (loaded.rollup) this.sessionRollups.set(sessionId, loaded.rollup);
    const agents = loaded.agents.filter(
      (a): a is ParsedTranscript & { header: TranscriptHeader } => a.header !== undefined,
    );

    const snapshots = agents.map((agent) => this.restoredSnapshot(record, agent));
    // 恢复 = 搬真相，不是重建：不补状态机、不发新序号、不自动认亲（restoreNodes）。
    const result = this.registry.restoreNodes(snapshots);
    if (record.maxConcurrent !== undefined) {
      this.registry.setSessionLimit(sessionId, record.maxConcurrent);
    }
    // 账本：先装进内存，再按决策 2A 结算重启时仍 open 的账目。
    this.ledger.load(loaded.ledger);
    this.settleOpenOnRestore(sessionId);
    this.restoreEngines(record, agents);

    // §4.6：重启前在跑的成员降为空闲，必须留痕（R7：别让用户以为任务已完成）。
    //
    // 三种「非终态」在状态机上只有两个值：running 与 waiting。§4.6 表里的
    // 「suspended（父在等后代）」是 waiting 的一种（waitingOn 非空），重启后
    // 等待边全部丢弃，所以这里一并降级。
    const interrupted = agents.filter((a) => {
      const status = a.states.at(-1)?.status;
      return status === 'running' || status === 'waiting';
    });
    for (const agent of interrupted) {
      this.persistNote(agent.header.path, '应用重启：运行中被中断，已降为空闲');
    }
    if (interrupted.length > 0) this.markInterruptedAt(sessionId);
    // 父的 transcript 丢了 ⇒ 整棵子树跳过（宁可少几个人，也不把孤儿挂到会话根上）。
    for (const path of result.skipped) {
      this.persistNote(sessionRootPath(sessionId), `恢复时跳过 ${path}：父缺失或重复`);
    }
  }

  /** transcript 还原成一个节点（状态按 §4.6 降级；用量取最后一条 state 行）。 */
  private restoredSnapshot(
    record: SessionRecord,
    agent: ParsedTranscript & { header: TranscriptHeader },
  ): AgentSnapshot {
    const header = agent.header;
    const isRoot = header.parent === undefined;
    // 升级过的会话：磁盘上的根仍是 engine 身份（升级只追加 note，不重写 header）。
    // 恢复时按 record 校正 —— 否则重启后「主控」拿着单兵工具表，编排全废。
    const escalated = isRoot && record.executor !== 'engine' && header.role !== LEAD_ROLE.name;
    const last = agent.states.at(-1);
    const lastStatus = last?.status;
    // parked(waiting) / suspended(waiting + waitingOn) / running 一律降为空闲（§4.6）。
    const status: AgentStatus =
      lastStatus === 'running' || lastStatus === 'waiting' ? 'idle' : (lastStatus ?? 'idle');
    return {
      path: header.path,
      role: escalated ? LEAD_ROLE.name : header.role,
      displayName: escalated ? LEAD_ROLE.displayName : header.displayName,
      status,
      ...(header.parent !== undefined ? { parent: header.parent } : {}),
      children: [], // restoreNodes 按 parent 重建
      createdAt: header.createdAt,
      updatedAt: last?.at ?? header.createdAt,
      usage: last?.usage ?? usageOfMessages(agent.messages),
      ...(last?.lastError !== undefined && last.lastError !== null
        ? { lastError: last.lastError }
        : {}),
      sessionId: record.id,
      ...(header.forkMode !== undefined ? { forkMode: header.forkMode } : {}),
    };
  }

  /**
   * 引擎重灌：按角色 + 读回来的消息重新实例化（§4.5）。
   *
   * 消息过 `repairMessages`（与 fork 路径同一道修复）：悬空的 toolCall 灌回去
   * 会让模型重新调用、或让 provider 直接报错（R12）。
   */
  private restoreEngines(
    record: SessionRecord,
    agents: readonly (ParsedTranscript & { header: TranscriptHeader })[],
  ): void {
    const sessionId = record.id;
    const rootPath = sessionRootPath(sessionId);
    const msgs = new Map(agents.map((a) => [a.header.path, repairMessages(a.messages)]));
    const nodes = [...this.registry.listOf(sessionId)].sort(
      (a, b) => depthOf(a.path) - depthOf(b.path),
    );

    // 第一遍：解析角色与有效工具（父先于子 —— 浅到深就是父子序），攒出 roster。
    const allowedByPath = new Map<AgentPath, string[] | undefined>();
    const plans = new Map<AgentPath, MemberPlan>();
    for (const snap of nodes) {
      const isRoot = snap.path === rootPath;
      const role = isRoot
        ? this.roleDefOf(snap.role, snap.role === LEAD_ROLE.name ? LEAD_ROLE : ENGINE_ROLE)
        : this.roleDefOf(snap.role, {
            name: snap.role,
            displayName: snap.displayName,
            description: '',
            instructions: `你是 ${snap.displayName}。`,
            tools: [],
            approval: this.runtime.defaultApproval,
          });
      const allowed = intersectTools(
        snap.parent !== undefined ? allowedByPath.get(snap.parent) : undefined,
        role.tools,
      );
      allowedByPath.set(snap.path, allowed);
      plans.set(snap.path, {
        name: snap.displayName,
        role,
        displayName: snap.displayName,
        lead: isRoot,
      });
    }

    // 第二遍：装配引擎（根走 buildRootEngine，成员与 spawn 同一套裁剪）。
    const entries = [...plans.entries()].map(([path, plan]) => ({ plan, path }));
    for (const snap of nodes) {
      const plan = plans.get(snap.path);
      if (!plan) continue;
      const messages = msgs.get(snap.path) ?? [];
      if (snap.path === rootPath) {
        const roster = nodes.length > 1 ? rosterPrompt(sessionId, entries) : undefined;
        this.buildRootEngine(rootPath, sessionId, plan, {
          orchestration: record.executor !== 'engine',
          messages,
          ...(roster !== undefined ? { systemPromptExtra: roster } : {}),
        });
        continue;
      }
      const allowSet = allowedByPath.get(snap.path);
      const allow = allowSet !== undefined ? new Set(allowSet) : undefined;
      const engine = createAxonEngine({
        systemPrompt: plan.role.instructions,
        model: this.modelSource.model,
        streamFn: this.modelSource.streamFn,
        messages: fromMessageLike(messages),
        // 与 spawn 同一套：白名单 ∩ 父级 —— 重启后工具表必须一模一样
        tools: this.toolsFor(snap.path, allow) as never,
        sessionId,
        onBeforeTool: async (name, args) => {
          if (allow && !allow.has(name)) {
            return { allow: false, reason: `角色 ${plan.role.name} 未获授权使用 ${name}` };
          }
          return this.approvals.gate(snap.path, name, args);
        },
      });
      this.registry.attachEngine(snap.path, engine);
      this.wire(snap.path, engine);
    }
  }

  private roleDefOf(name: string, fallback: RoleDefinition): RoleDefinition {
    return this.roles.get(name)?.role ?? fallback;
  }

  /** 决策 2A：重启时仍 open 的账目结算掉，summary 写明「未及结算」。 */
  private settleOpenOnRestore(sessionId: string): void {
    const open = this.ledger.query({ sessionId }).records.filter((r) => r.status === 'open');
    for (const record of open) this.ledger.settle(record.id, { summary: '应用重启，未及结算' });
  }

  /** rollup.interruptedAt：给 MU-2 的「恢复自上次运行」提示留证据（R7）。 */
  private markInterruptedAt(sessionId: string): void {
    const p = this.persistence;
    const record = this.sessions.get(sessionId);
    const summary = this.summaryOf(sessionId);
    if (!p || !record || !summary) return;
    const at = Date.now();
    p.scheduleRollup(record, {
      at,
      usage: summary.usage,
      counts: summary.counts,
      status: summary.status,
      interruptedAt: at,
    });
  }

  /** 未加载会话的摘要：只用 record + rollup，**不读树**（§4.5）。 */
  private rollupSummaryOf(record: SessionRecord): SessionSummary {
    const rollup = this.sessionRollups.get(record.id);
    const team = record.teamId !== undefined ? this.teams.get(record.teamId)?.team : undefined;
    return buildSessionSummary({
      record,
      rootPath: sessionRootPath(record.id),
      status: rollup?.status ?? 'idle',
      members: [],
      ledgerCount: rollup?.counts.ledger ?? 0,
      pending: [],
      globalBudget: this.runtime.globalBudget,
      ...(team?.budget !== undefined ? { teamBudget: team.budget } : {}),
      ...(team !== undefined ? { team } : {}),
      tempCount: 0,
      ...(rollup ? { countsFromRollup: rollup.counts, usageFromRollup: rollup.usage, rollup } : {}),
    });
  }

  /** 存储实况（`storage.status`，§4.9）。 */
  storageStatus(): {
    root: string;
    sessionCount: number;
    loadedCount: number;
    issues: StorageIssue[];
  } {
    const p = this.persistence;
    return {
      root: p ? p.root : '',
      sessionCount: this.sessions.size,
      loadedCount: this.loaded.size,
      issues: p ? p.issues() : [],
    };
  }

  // ── M5：落盘（写入点 = 状态变更点，§4.4）──────────────────

  /**
   * 会话记录的落盘（`SessionStore.onChange` 的落点）。
   *
   * 三条命令共用这一个入口，是为了让「哪些命令要落盘」只有一处答案：
   * 宿主里任何一次 `this.sessions.create/update/remove` 都自动带上落盘，
   * 不需要每个 call site 记得各写一遍。
   */
  private onSessionChanged(event: SessionStoreChange): void {
    const record = event.record;
    // 「已加载 / 汇总缓存」这两个账本**与落盘无关**：本进程里造的会话天然在
    // 内存里，而删掉的会话必须把缓存一起清掉（否则列表会拿旧汇总显示幽灵行）。
    // 所以这两句要放在 `if (!p) return` 之前 —— 落在后面的话，纯内存宿主
    // （测试、冒烟）里的每个会话都会被当成「未加载」，摘要全走落盘兜底（踩过）。
    if (event.kind === 'create') this.loaded.add(record.id);
    if (event.kind === 'remove') {
      this.loaded.delete(record.id);
      this.sessionRollups.delete(record.id);
    }
    const p = this.persistence;
    if (!p) return;
    if (event.kind === 'create') {
      // 此刻树已经建好（createRoot + 成员都注册完了），header 一次性写全。
      const headers = this.registry.listOf(record.id).map((snap) => this.headerOf(snap));
      // 三笔写要**同步入队**：await 之后才入队的话，`flush()` 取等待快照在前、
      // 尾巴漏在后 —— 收尾时才落地（删目录测试里就是 ENOTEMPTY 的温床）。
      // 顺序不用愁：header 与记录共用 ledger 队列，先入队的先落。
      void p.createSession(record, headers);
      void p.writeLedgerHeader(record);
      this.scheduleRollup(record.id);
      return;
    }
    if (event.kind === 'remove') {
      // 决策 4A：删会话 = 物理删整个目录（含成员 transcript 与账本）。
      void p.removeSession(record);
      return;
    }
    void p.saveRecord(record);
  }

  /** 成员快照 → transcript header（权威身份在 header 里，文件名只是索引）。 */
  private headerOf(snapshot: AgentSnapshot): TranscriptHeader {
    return {
      sessionId: snapshot.sessionId,
      path: snapshot.path,
      ...(snapshot.parent !== undefined ? { parent: snapshot.parent } : {}),
      role: snapshot.role,
      displayName: snapshot.displayName,
      ...(snapshot.forkMode !== undefined ? { forkMode: snapshot.forkMode } : {}),
      createdAt: snapshot.createdAt,
    };
  }

  private recordOf(path: AgentPath): SessionRecord | undefined {
    // 用**纯路径解析**而不是 registry 查询：删成员时节点已经从 registry 摘掉了，
    // 但它属于哪个会话仍写在路径里（`/<sessionId>/<leaf>`）。用 registry 查询的
    // 话，`host.remove()` 里那句「删 transcript」永远查不到会话，文件就留下了，
    // 重启后那个成员会复活（真盘测试抓到的）。
    const sessionId = sessionIdOfPath(path);
    return sessionId === undefined ? undefined : this.sessions.get(sessionId);
  }

  /** spawn 之后补一行 header（create 之前发生的那些由 createSession 一次写全）。 */
  private persistAgentHeader(snapshot: AgentSnapshot): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.sessions.get(snapshot.sessionId);
    if (!record) return;
    void p.writeAgentHeader(record, this.headerOf(snapshot));
  }

  /** 每条 user / assistant / toolResult 消息一行（wire 的 message_end）。 */
  private persistMessage(path: AgentPath, message: MessageLike): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.recordOf(path);
    if (!record) return;
    void p.appendMessage(record, path, message, Date.now());
  }

  /**
   * 状态行：每次状态跃迁都写一条（含当时的 usage 快照）。
   *
   * 读侧只取最后一条来恢复 usage/lastError，所以「每次都写」比「只在终态写」
   * 更稳：进程被杀在 running 中途时，至少还有一个近似的用量在盘上。
   */
  private persistState(path: AgentPath, status: AgentStatus): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.recordOf(path);
    if (!record) return;
    const snap = this.registry.snapshot(path);
    void p.appendState(record, path, {
      at: Date.now(),
      status,
      ...(snap ? { usage: snap.usage } : {}),
      ...(snap?.lastError !== undefined ? { lastError: snap.lastError } : {}),
    });
  }

  private persistNote(path: AgentPath, text: string): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.recordOf(path);
    if (!record) return;
    void p.appendNote(record, path, text);
  }

  private persistRemoveTranscript(path: AgentPath): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.recordOf(path);
    if (!record) return;
    void p.removeTranscript(record, path);
  }

  /** 账本落盘（Ledger.onChange）：账本按会话切片存，先找到它属于哪个会话。 */
  private onLedgerChanged(entry: LedgerRecord): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.sessions.get(entry.sessionId);
    if (!record) return;
    void p.appendLedger(record, entry);
  }

  /** 汇总缓存（列表在懒加载下的数据源）：合并窗口由 persistence 管（§4.4）。 */
  private scheduleRollup(sessionId: string, summary?: SessionSummary): void {
    const p = this.persistence;
    if (!p) return;
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const computed = summary ?? this.summaryOf(sessionId);
    if (!computed) return;
    p.scheduleRollup(record, {
      at: Date.now(),
      usage: computed.usage,
      counts: computed.counts,
      status: computed.status,
    });
  }

  /**
   * 热改运行期配置（`config.patch` 的落点）。
   *
   * 只改「下一件事生效」的参数：并发/深度/超时/默认档。已经在跑的 Agent
   * 不受影响（角色与工具在 spawn 那刻就定死了，与 updateRoles 同一条道理）。
   */
  applyConfig(config: AxonConfig): void {
    this.registry.setMaxConcurrent(config.maxConcurrent ?? CONFIG_DEFAULTS.maxConcurrent);
    this.registry.setMaxDepth(config.maxDepth ?? CONFIG_DEFAULTS.maxDepth);
    this.idleTimeoutMs = config.idleTimeoutMs ?? CONFIG_DEFAULTS.idleTimeoutMs;
    this.approvals.setTimeoutMs(config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
    const hardUsd = config.budgetUsd ?? 0;
    const softUsd = config.budgetSoftUsd ?? (hardUsd > 0 ? hardUsd * 0.8 : 0);
    this.budget.setLimits({ hardUsd, softUsd });
    this.runtime = {
      globalBudget: {
        ...(hardUsd > 0 ? { hardUsd } : {}),
        ...(softUsd > 0 ? { softUsd } : {}),
      },
      defaultApproval: config.defaultApproval ?? 'always_ask',
      defaultExecutor: config.defaultExecutor ?? 'engine',
      ...(config.defaultCwd !== undefined ? { defaultCwd: config.defaultCwd } : {}),
    };
  }

  /** 落一笔协作账（编排工具的 driver.recordCollab 主体）。 */
  private recordCollab(
    from: AgentPath,
    spec: { action: CollabAction; to: AgentPath; origin: CollabOrigin; contextScope?: string },
  ): void {
    const record = this.ledger.record({
      action: spec.action,
      from,
      to: spec.to,
      origin: spec.origin,
      contextScope: spec.contextScope,
      // 基线：记录时刻目标子树的累计 usage。registry.addUsage 沿父链上滚，
      // 所以节点自身的 usage 就是它子树的总和。
      usageBaseline: this.registry.get(spec.to)?.snapshot.usage,
    });
    this.emit('ledger.recorded', { record }, spec.to);
    // 账本笔数是会话摘要的字段（左栏的「N 笔」），落账即刷新。
    const sessionId = this.registry.sessionIdOf(spec.to);
    if (sessionId !== undefined) this.touchSession(sessionId);
  }

  /**
   * 目标进终态（或被删）时结算它名下全部 open 记录。
   *
   * 不留悬空的 open 记录：否则账本上会积一堆永远未结算的行，
   * 而 UI 无从分辨「还在跑」与「已经没了」。
   */
  private settleCollabFor(to: AgentPath, note?: string): void {
    const open = this.ledger.openRecordsFor(to);
    if (open.length === 0) return;
    const usageNow = this.registry.get(to)?.snapshot.usage;
    const summary = note ?? this.lastAssistantText(to);
    for (const r of open) {
      const settled = this.ledger.settle(r.id, { usageNow, summary });
      if (!settled) continue;
      this.emit('ledger.updated', { record: settled }, to);
      this.maybeRequestArbitration(settled);
    }
  }

  private lastAssistantText(path: AgentPath): string | undefined {
    const messages = this.messagesOf(path);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      const text = (m.content ?? [])
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) return text;
    }
    return undefined;
  }

  /**
   * 结算后，若策略把裁决权委派给了 Agent，向它投递一条裁决请求。
   *
   * 两个递归必须堵住（M4 §4.5）：
   *  1. 裁决请求本身不落账（它走 requestRun，不过编排工具）；
   *  2. 每条记录最多发一次请求（markArbitrationSent 幂等标记）。
   */
  private maybeRequestArbitration(record: LedgerRecord): void {
    if (!needsAdoption(record.action) || record.adoption !== 'pending') return;

    const resolution = resolveArbiter(this.adoptionPolicy, record, {
      agents: () => this.registry.list(),
      exists: (p) => this.registry.has(p),
    });
    if (resolution.kind === 'human') {
      // 回落人工时把原因写进账，不静默失败——否则用户以为开了开关
      // 就不用管了，实际上这些记录在默默堆积。
      if (resolution.reason) {
        const updated = this.ledger.adoptNote(record.id, resolution.reason);
        if (updated) this.emit('ledger.updated', { record: updated }, record.to);
      }
      return;
    }

    if (!this.ledger.markArbitrationSent(record.id)) return;
    const arbiter = resolution.path;
    this.arbitrationTargets.set(record.id, arbiter);

    const prompt =
      `[协作裁决] 记录 ${record.id}：${record.action} ${record.from} → ${record.to}\n` +
      `交付摘要：${record.summary ?? '（无文本产出）'}\n` +
      `请用 ledger_adopt 工具给出 adopted 或 rejected，并用一句话说明理由。`;

    // fire：裁决跑不起来（在忙/预算冻结）不能拖城下水，
    // 记录会保持 pending 等人来点。
    void this.requestRun(arbiter, prompt).catch(() => undefined);
  }

  /** `ledger_adopt` 工具的落点：跑资格校验后写账。 */
  private adoptByAgent(
    arbiter: AgentPath,
    spec: { id: string; adoption: Adoption; note?: string },
  ): void {
    const record = this.ledger.get(spec.id);
    if (!record) throw new Error(`账本记录不存在: ${spec.id}`);

    const expected = this.arbitrationTargets.get(spec.id);
    if (expected !== arbiter) {
      throw new Error(
        `你不是记录 ${spec.id} 的裁决者${expected ? `（应为 ${expected}）` : ''}`,
      );
    }
    // 再跑一遍资格校验：派发时合格不代表此刻合格（树形可能变了）。
    const ineligible = arbiterIneligibleReason(arbiter, record);
    if (ineligible) throw new Error(ineligible);

    const updated = this.ledger.adopt(
      spec.id,
      spec.adoption,
      { kind: 'agent', path: arbiter, policyAt: this.adoptionPolicyAt },
      spec.note,
    );
    if (updated) this.emit('ledger.updated', { record: updated }, updated.to);
  }

  /**
   * 某 Agent 生效的审批档。
   *
   * MU-1 起会话根也有角色（内置引擎 / 团队主控），所以「根无角色」这条
   * 早退没有存在余地了。它不影响默认行为：内置引擎与主控都是 always_ask，
   * 请求照样冒到人面前。角色缺省时用全局默认档兜底，而不是返回
   * undefined —— undefined 在 broker 里意味着「不能代批」，与 always_ask
   * 等价，但表达意图更清晰。
   */
  private approvalModeOf(path: AgentPath): ApprovalMode | undefined {
    const role = this.registry.get(path)?.snapshot.role;
    if (!role) return undefined;
    return this.roles.get(role)?.role.approval ?? this.runtime.defaultApproval;
  }

  /**
   * 创建分身。
   *
   * 三个维度在这里一次性合成，且**顺序不能反**：
   *   1. 角色 → systemPrompt / model / 工具白名单
   *   2. 权限 → 与父级工具求交集（只能减能，不能越权）
   *   3. 上下文 → 按 forkMode 从父级切片（默认 none，见 DEFAULT_FORK_MODE）
   *
   * 先算权限再切上下文，是因为切片不改变权限，反之则不成立。
   */
  spawn(payload: SpawnAgentPayload): AgentSnapshot {
    this.budget.assertCanStart('分身');
    // 冷会话首次用到：先把树装进来，否则下面 resolveParent 会以「父不存在」
    // 拒绝 —— 而这里「父不存在」其实只是「还没加载」（§4.5）。
    const hinted =
      payload.sessionId ??
      (payload.parent !== undefined ? sessionIdOfPath(payload.parent) : undefined);
    if (hinted !== undefined) this.ensureSessionLoaded(hinted);

    const entry = this.roles.get(payload.role);
    if (!entry) throw new Error(`角色不存在: ${payload.role}`);
    const base = entry.role;
    // 成员级覆写（团队成员的 overrides）：**只减不增**。
    // tools 与角色白名单求交，approval 取更严者 —— 调用方即使传了更宽的
    // 档位，也不会在本函数里被采纳。权限的守门人应当是执行点本身。
    const ov = payload.overrides ?? {};
    const role: RoleDefinition = {
      ...base,
      ...(ov.displayName !== undefined ? { displayName: ov.displayName } : {}),
      ...(ov.instructions !== undefined ? { instructions: ov.instructions } : {}),
      ...(ov.model !== undefined ? { model: ov.model } : {}),
      tools: intersectTools(base.tools, ov.tools),
      ...(ov.approval !== undefined
        ? { approval: stricterApproval(ov.approval, base.approval ?? this.runtime.defaultApproval) }
        : {}),
    };

    const parent = this.resolveParent(payload);
    const parentNode = this.registry.get(parent);
    if (!parentNode) throw new Error(`父 Agent 不存在: ${parent}`);
    const sessionId = parentNode.snapshot.sessionId;
    this.assertSessionCanStart(sessionId, '新建分身');

    // ① 权限：父级白名单 ∩ 角色白名单
    const parentTools = this.toolNamesOf(parent);
    const allowed = intersectTools(parentTools, role.tools);

    // ② 上下文：缺省走角色默认，角色也没写就是全局默认（none）
    const mode = parseForkMode(payload.forkMode ?? role.defaultForkMode);
    const inherited = forkMessages(this.messagesOf(parent), mode);

    const allowSet = allowed ? new Set(allowed) : undefined;
    const snapshot = this.registry.register({
      role: role.name,
      displayName: ov.displayName ?? role.displayName,
      parent,
      forkMode: payload.forkMode ?? role.defaultForkMode,
    });

    const engine = createAxonEngine({
      systemPrompt: payload.overrides?.instructions ?? role.instructions,
      model: this.modelSource.model,
      streamFn: this.modelSource.streamFn,
      messages: fromMessageLike(inherited),
      tools: this.toolsFor(snapshot.path, allowSet) as never,
      sessionId: snapshot.sessionId,
      // 闸门兜底：即使工具在 tools 全集里，未获角色授权也执行不了。
      // 与其指望上游正确裁剪 tools 数组，不如在执行前再拦一道。
      //
      // 两道闸互不覆盖（M4）：白名单管「能碰什么」，HITL 管「多大程度放手」。
      // 顺序也不能反：未获授权的工具不该惊动人去批。
      onBeforeTool: async (name, args) => {
        if (allowSet && !allowSet.has(name)) {
          return { allow: false, reason: `角色 ${role.name} 未获授权使用 ${name}` };
        }
        return this.approvals.gate(snapshot.path, name, args);
      },
    });

    this.registry.attachEngine(snapshot.path, engine);
    this.wire(snapshot.path, engine);
    this.persistAgentHeader(snapshot);
    this.emit('agent.created', { snapshot }, snapshot.path);
    this.touchSession(sessionId);

    if (payload.initialPrompt) {
      // 不 await：spawn 要立刻返回快照给 UI，任务在后台跑（经济/排队由 requestRun 管）。
      void this.requestRun(snapshot.path, payload.initialPrompt);
    }
    return snapshot;
  }

  /**
   * 请求跑一轮任务（用户 prompt / spawn 的任务 / agent_resume 的追加任务）。
   *
   * M3 统一入口（修 M2 的状态漂移缺陷）：终态先归位 idle → 看额度：
   * 有额度 → running 直接跑；没额度 → parked(waiting) 排队，由 drain() 补位。
   *
   * 返回的 Promise 在本轮**跑完**（done/failed）或排队中被取消时 resolve。
   */
  requestRun(path: AgentPath, text: string): Promise<void> {
    this.budget.assertCanStart('任务');

    const node = this.registry.get(path);
    if (!node?.engine) throw new Error(`Agent 无引擎: ${path}`);

    const status = node.snapshot.status;
    if (status === 'running' || this.waits.has(path)) {
      throw new Error(`Agent 正在运行: ${path}`);
    }
    if (status === 'waiting') {
      throw new Error(`Agent 已有排队任务: ${path}`);
    }

    if (isTerminal(status)) {
      // 终态归位（done/failed/interrupted → idle），这是「追加任务」的落点
      this.setStatus(path, 'idle');
    }

    if (this.registry.canRun(node.snapshot.sessionId)) {
      this.setStatus(path, 'running');
      return this.runEngine(path, text);
    }

    // 额满：parked 排队
    this.setStatus(path, 'waiting');
    this.pendingRuns.push(path);
    this.pendingTexts.set(path, text);
    return new Promise((resolve) => this.parkedResolvers.set(path, resolve));
  }

  /** 兼容入口：跑一轮并等它结束（旧 API，测试与 root prompt 用）。 */
  async prompt(path: AgentPath, text: string): Promise<void> {
    await this.requestRun(path, text);
  }

  interrupt(path: AgentPath): void {
    // parked：直接出队并取消任务
    const qi = this.pendingRuns.indexOf(path);
    if (qi >= 0) {
      this.pendingRuns.splice(qi, 1);
      this.pendingTexts.delete(path);
      this.parkedResolvers.get(path)?.();
      this.parkedResolvers.delete(path);
      this.setStatus(path, 'idle');
      return;
    }

    const node = this.registry.get(path);
    node?.engine?.abort();
    // 状态由 abort 引发的事件流兜住；这里只做乐观标记。
    // suspended（在 waits 里）的父也打 interrupted：abort 会沿 signal 传到 wait 工具。
    if (node && (node.snapshot.status === 'running' || this.waits.has(path))) {
      this.setStatus(path, 'interrupted');
    }
  }

  remove(path: AgentPath): AgentPath[] {
    // 先中断整棵子树，否则删掉记录后引擎仍在后台烧 token。
    const node = this.registry.get(path);
    if (node) {
      const visit = (p: AgentPath) => {
        const n = this.registry.get(p);
        if (!n) return;
        for (const c of n.snapshot.children) visit(c);
        n.engine?.abort();
      };
      visit(path);
    }
    const removed = this.registry.remove(path);
    if (!removed.length) return removed;

    // 清理 M3 队列/图/计时器里的残留（drain 出队前还会做 has() 兜底）。
    for (const p of removed) {
      const qi = this.pendingRuns.indexOf(p);
      if (qi >= 0) {
        this.pendingRuns.splice(qi, 1);
        this.pendingTexts.delete(p);
        this.parkedResolvers.get(p)?.();
        this.parkedResolvers.delete(p);
      }
      if (this.waits.has(p)) {
        this.waits.delete(p);
        this.waitResolvers.get(p)?.();
        this.waitResolvers.delete(p);
      }
      // M4：目标被删时也要结算，不留悬空的 open 记录。
      this.settleCollabFor(p, '目标已被删除');
      // M5：成员 transcript 也要删 —— 留着它，重启后那个成员会「复活」。
      this.persistRemoveTranscript(p);
      this.approvals.cancelFor(p);
      this.awaitingApproval.delete(p);
      const timer = this.idleTimers.get(p);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(p);
      }
      this.lastActivity.delete(p);
    }
    this.emit('agent.removed', { paths: removed }, path);
    return removed;
  }

  // ── M3：wait 生命周期（OrchestrationDriver 的 beginWait/endWait 主体）──

  /**
   * 挂起：父声明自己等这些目标（子级，边沿树向下）直到全部终态。
   *
   * - 已在终态的目标直接剔除（不挂起就直接 resolve）
   * - 有未终态目标时：父退位 waiting（让出额度）→ 立刻 drain（额度马上补位）
   * - 返回的 Promise 在全部目标终态时 resolve（由 drain 在子终态时解）
   * - 同一父的并发多次 wait：目标集合并，共享同一个 Promise
   */
  beginWait(parent: AgentPath, targets: AgentPath[]): Promise<void> {
    const pending = targets.filter((t) => {
      const s = this.registry.get(t)?.snapshot.status;
      return s !== undefined && !isTerminal(s);
    });

    if (pending.length === 0) return Promise.resolve();

    const existing = this.waits.get(parent);
    if (existing) {
      for (const t of pending) existing.add(t);
      this.syncWaitingOn(parent);
      return this.waitPromises.get(parent) ?? Promise.resolve();
    }

    this.waits.set(parent, new Set(pending));
    this.syncWaitingOn(parent);
    const promise = new Promise<void>((resolve) => {
      this.waitResolvers.set(parent, resolve);
    });
    this.waitPromises.set(parent, promise);

    // 退位让额（running→waiting 合法；若已 waiting 则是并发 wait，不动）
    const status = this.registry.get(parent)?.snapshot.status;
    if (status === 'running') {
      this.setStatus(parent, 'waiting');
      void this.drain(); // 释出的额度立刻补位，别浪费
    }
    return promise;
  }

  /**
   * 摘 wait 边（连同该父的全部等待者一起解除——目标集是合并的）。
   * 若父已无任何边且仍是 waiting，恢复 running（超时/中断路径：引擎马上继续烧 token）。
   */
  endWait(parent: AgentPath): void {
    if (!this.waits.has(parent)) return;
    this.waits.delete(parent);
    this.syncWaitingOn(parent);
    this.waitResolvers.get(parent)?.();
    this.waitResolvers.delete(parent);
    this.waitPromises.delete(parent);
    const status = this.registry.get(parent)?.snapshot.status;
    if (status === 'waiting' && !this.pendingRuns.includes(parent)) {
      this.promote(parent);
    }
  }

  // ── 内部：运行与调度 ──────────────────────────────────

  private async runEngine(path: AgentPath, text: string): Promise<void> {
    const node = this.registry.get(path);
    if (!node?.engine) throw new Error(`Agent 无引擎: ${path}`);
    this.touch(path);
    try {
      await node.engine.prompt(text);
      await node.engine.waitForIdle();
      this.setStatus(path, 'done');
    } catch (err) {
      this.setStatus(path, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      void this.drain();
    }
  }

  /**
   * 补位调度（幂等）：子终态后解挂其父 + parked FIFO 填空额。
   *
   * 顺序刻意如此：**先解父**——父等的额度刚被释放，理应还给它（resume
   * 免信号量）；父解挂后若继续等别的子，仍处 suspended（不占额），
   * 自然轮到 parked 队首填剩余额度。
   *
   * MU-1：队首也要过**会话闸门**。会话额满时跳过它继续往后找，而不是
   * 让整个队列陪着一起等 —— 两个不相干的会话不该互相饿死（全局闸门
   * 已经由 canRun 兜住，会话闸门是它之上的一层追加准入）。
   */
  private drain(): void {
    // ① 解挂目标全终态的父
    for (const [parent, pending] of [...this.waits]) {
      const allDone = [...pending].every((t) => {
        const s = this.registry.get(t)?.snapshot.status;
        return s === undefined || isTerminal(s);
      });
      if (!allDone) continue;
      this.waits.delete(parent);
      this.syncWaitingOn(parent);
      this.waitResolvers.get(parent)?.();
      this.waitResolvers.delete(parent);
      this.waitPromises.delete(parent);
      if (this.registry.get(parent)?.snapshot.status === 'waiting') {
        this.promote(parent);
      }
    }

    // ② parked 填空额：扫描而非只看队首（见头注）
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.pendingRuns.length; i++) {
        const p = this.pendingRuns[i]!;
        const n = this.registry.get(p);
        if (!n?.engine || n.snapshot.status !== 'waiting' || this.registry.canRun(n.snapshot.sessionId)) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      const path = this.pendingRuns.splice(idx, 1)[0]!;
      const text = this.pendingTexts.get(path);
      if (!text || !this.registry.has(path)) continue; // interrupt/remove 兜底
      this.pendingTexts.delete(path);
      const resolve = this.parkedResolvers.get(path);
      this.parkedResolvers.delete(path);

      const node = this.registry.get(path);
      const status = node?.snapshot.status;
      if (!node?.engine || status !== 'waiting') {
        resolve?.();
        continue;
      }

      this.promote(path);
      // requestRun 的 Promise 在本轮跑完时结账
      void this.runEngine(path, text)
        .then(() => resolve?.())
        .catch(() => resolve?.());
    }
  }

  /**
   * 把 waits 图的当前边镜像到快照（MX G4.6）。
   * 真相仍在 this.waits；快照只是给 UI 读的副本。
   */
  private syncWaitingOn(parent: AgentPath): void {
    this.registry.setWaitingOn(parent, [...(this.waits.get(parent) ?? [])]);
  }

  /** waiting → running，免检（registry.promote），并对外发事件。 */
  private promote(path: AgentPath): void {
    try {
      const snapshot = this.registry.promote(path);
      this.emit('agent.status', { path, status: snapshot.status }, path);
    } catch {
      // 竞态兜底：可能已被 interrupt/remove 抢先挪走了状态。
    }
  }

  /** 某个 Agent 实际可用的工具名集合（取自它角色的白名单）。 */
  private toolNamesOf(path: AgentPath): string[] | undefined {
    const entry = this.roles.get(this.registry.get(path)?.snapshot.role ?? '');
    return entry?.role.tools;
  }

  /**
   * 向 Agent 投递指导消息（agent_message 的落点）。
   * pi 的 steer 是"本轮结束后注入、下一轮生效"；对 parked 目标是下一轮开始时生效。
   */
  steer(path: AgentPath, text: string): void {
    this.registry.get(path)?.engine?.steer(text);
  }

  /**
   * 为该 Agent 现造编排工具（per-spawn bind selfPath），并按其角色白名单
   * 裁剪：allowSet 里有的工具名才发放（M3 §4.1）。
   * 公开是为了测试与将来的工具自省（M6 诊断）；宿主内部在 spawn 时调用。
   */
  orchestrationToolsFor(path: AgentPath, allowSet?: Set<string>) {
    return createOrchestrationTools(this.driverFor(path)).filter(
      (t) => !allowSet || allowSet.has(t.name),
    );
  }

  /**
   * 该 Agent 实际拿到的工具数组：宇宙里的叶子工具 + 现造的编排工具。
   * 叶子工具同样按白名单过滤 —— 模型只能看到自己有权唤起的工具。
   *
   * `orchestration: false` 用于单兵会话：不发编排六件套。理由见 ENGINE_ROLE
   * 的头注 —— 让一个没有下属的 agent 拿着 agent_wait，只会让它去等一支
   * 不存在的队伍。
   */
  private toolsFor(
    path: AgentPath,
    allowSet?: Set<string>,
    opts: { orchestration?: boolean } = {},
  ): unknown[] {
    const leaves = allowSet
      ? this.tools.filter((t) => (t as { name?: unknown }).name !== undefined
          && allowSet.has((t as { name: string }).name))
      : [...this.tools];
    if (opts.orchestration === false) return leaves;
    return [...leaves, ...this.orchestrationToolsFor(path, allowSet)];
  }

  /** 把宿主能力收窄成编排工具需要的驱动面（调用者身份在此 bind）。 */
  private driverFor(path: AgentPath): OrchestrationDriver {
    return {
      selfPath: path,
      spawnChild: (spec) =>
        this.spawn({
          role: spec.role,
          parent: path,
          initialPrompt: spec.task,
          forkMode: spec.forkMode,
        }).path,
      requestRun: (p, text) => this.requestRun(p, text),
      interrupt: (p) => this.interrupt(p),
      snapshot: (p) => this.get(p),
      messagesOf: (p) => this.messagesOf(p),
      beginWait: (targets) => this.beginWait(path, targets),
      endWait: () => this.endWait(path),
      steerTo: (p, text) => this.steer(p, text),
      recordCollab: (spec) => this.recordCollab(path, spec),
      adoptCollab: (spec) => this.adoptByAgent(path, spec),
    };
  }

  private setStatus(path: AgentPath, status: AgentSnapshot['status'], error?: string) {
    try {
      this.registry.setStatus(path, status, error);
    } catch {
      // 非法跃迁不该让整轮崩掉（例如 abort 与 done 竞态）。
      // 状态机的价值在于挡住写入，不在于惩罚调用方。
      return;
    }
    this.persistState(path, status);
    this.onStatusChanged(path, status);
    this.emit('agent.status', error ? { path, status, error } : { path, status }, path);
    // 会话条的实时字段（status/成员计数）跟着变 —— 摘要只在真变了时才播，
    // 节流由 IPC 层做（index.ts 的 session.changed）。
    const sessionId = this.registry.sessionIdOf(path);
    if (sessionId !== undefined) this.touchSession(sessionId);
  }

  /** 状态迁到终态时解挂 + 看门狗计时联动。 */
  private onStatusChanged(path: AgentPath, status: AgentSnapshot['status']): void {
    if (status === 'running') {
      this.scheduleIdleCheck(path);
    } else {
      const t = this.idleTimers.get(path);
      if (t) {
        clearTimeout(t);
        this.idleTimers.delete(path);
      }
    }
    // M4：目标进终态 ⇒ 结算它名下的 open 记录。
    if (isTerminal(status)) {
      this.settleCollabFor(path);
      // 中断后挂起的审批没人会再管它，取消掉免得在收件箱里变幽灵待办。
      if (status === 'interrupted') this.approvals.cancelFor(path);
    }
  }

  /** 活动记录：看门狗按**空闲**计时，有事件即归零。 */
  private touch(path: AgentPath): void {
    this.lastActivity.set(path, Date.now());
    if (this.registry.get(path)?.snapshot.status === 'running') {
      this.scheduleIdleCheck(path);
    }
  }

  /** 重置该 Agent 的空闲计时器。超时仍 running 且真空闲 → 中断。 */
  private scheduleIdleCheck(path: AgentPath): void {
    if (this.idleTimeoutMs <= 0) return;
    const old = this.idleTimers.get(path);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.idleTimers.delete(path);
      const node = this.registry.get(path);
      if (!node || node.snapshot.status !== 'running') return;
      // 等人批审批的不算卡死（M4）：它确实没活动，但原因是在等人，
      // 杀掉它等于惩罚用户没及时点按钮。
      if (this.awaitingApproval.has(path)) {
        this.scheduleIdleCheck(path);
        return;
      }
      const last = this.lastActivity.get(path) ?? 0;
      if (Date.now() - last < this.idleTimeoutMs) {
        this.scheduleIdleCheck(path); // 有活动，重新计（按空闲而非总时长）
        return;
      }
      // 卡死：无任何事件且仍挂着 running。abort 兜底，乐观标记由 interrupt 做。
      node.engine?.abort();
      this.setStatus(path, 'interrupted');
    }, this.idleTimeoutMs);
    this.idleTimers.set(path, timer);
  }

  /** 把 pi 的事件流翻译成 Axon 协议事件。 */
  private wire(path: AgentPath, engine: AxonEngine): void {
    engine.subscribe((event: AgentEvent) => {
      this.touch(path);
      switch (event.type) {
        case 'message_start':
          this.emit('agent.message.start', { messageId: path }, path);
          break;
        case 'message_end': {
          const message = event.message as unknown as MessageLike;
          // 先登记落盘再播事件（写入本身异步串行，见 session-persistence）：
          // 顺序反了的话，两条语句之间抛异常就会留下「已显示、未落盘」的消息。
          this.persistMessage(path, message);
          this.emit('agent.message.end', { messageId: path, message }, path);
          break;
        }
        case 'tool_execution_start':
          this.emit(
            'agent.tool.start',
            { callId: event.toolCallId, tool: event.toolName, args: event.args },
            path,
          );
          break;
        case 'tool_execution_end':
          this.emit(
            'agent.tool.end',
            { callId: event.toolCallId, ok: !event.isError, result: event.result },
            path,
          );
          break;
        case 'turn_end': {
          // usage 只挂在 assistant 消息上，且是**本轮累计**而非增量。
          const usage = (event.message as { usage?: {
            input: number; output: number; cost: { total: number };
          } }).usage;
          const delta = {
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            costUsd: usage?.cost.total ?? 0,
          };
          this.registry.addUsage(path, delta);

          // ① 全局档：多根模型下没有唯一的「总账根」，用全部会话根之和
          const totalUsage = this.registry.totalUsage();
          const transition = this.budget.record(totalUsage.costUsd);
          if (transition !== 'none') {
            const { softUsd, hardUsd } = this.budget.limits;
            // spentUsd 与 limits 必须是两个不同来源的数：旧实现把
            // `limitUsd` 填成了 budget.spent，于是 UI banner 的「已用 / 上限」
            // 永远相等（MX G9.1）。
            this.emit(
              transition === 'warning' ? 'budget.warning' : 'budget.frozen',
              { usage: totalUsage, spentUsd: totalUsage.costUsd, softUsd, hardUsd, scope: 'global' },
            );
          }

          // ② 会话档（三层取更严者）：只在**变差**时播一次
          const sessionId = this.registry.sessionIdOf(path);
          if (sessionId !== undefined) {
            const view = this.budgetViewOf(sessionId);
            const prev = this.sessionTiers.get(sessionId) ?? 'ok';
            // 只在会话**自带限额**（团队档或会话档）时播会话级事件。
            // 三层限额全等于全局档时（多数单兵会话就是如此），全局事件已经说过
            // 同一件事 —— 再播一次会在 UI 上叠出两个内容相同的 banner。
            const hasOwnLayer = view.team !== undefined || view.self !== undefined;
            if (hasOwnLayer && TIER_RANK[view.tier] > TIER_RANK[prev]) {
              this.sessionTiers.set(sessionId, view.tier);
              this.emit(
                view.tier === 'frozen' ? 'budget.frozen' : 'budget.warning',
                {
                  usage: this.registry.get(sessionRootPath(sessionId))?.snapshot.usage ?? totalUsage,
                  spentUsd: view.spentUsd,
                  softUsd: view.effectiveSoftUsd,
                  hardUsd: view.effectiveHardUsd,
                  scope: 'session',
                  sessionId,
                  ...(view.limitedBy !== undefined ? { limitedBy: view.limitedBy } : {}),
                },
              );
            }
            this.touchSession(sessionId);
          }

          this.emit('agent.turn.end', { usage: delta }, path);
          break;
        }
        default:
          break;
      }
    });
  }

  /** 命令分发 —— IPC 层只需把 envelope 丢进来。 */
  async execute<C extends keyof CommandMap>(
    command: C,
    payload: CommandMap[C]['payload'],
  ): Promise<CommandMap[C]['result']> {
    switch (command) {
      case 'agent.spawn':
        return this.spawn(payload as SpawnAgentPayload) as never;
      case 'agent.list':
        return this.list() as never;
      case 'agent.get':
        return this.get((payload as { path: AgentPath }).path) as never;
      case 'agent.messages':
        return this.messagesOf((payload as { path: AgentPath }).path) as never;
      case 'agent.prompt': {
        const p = payload as { path: AgentPath; text: string };
        void this.prompt(p.path, p.text);
        return { accepted: true } as never;
      }
      case 'agent.interrupt':
        this.interrupt((payload as { path: AgentPath }).path);
        return { accepted: true } as never;
      case 'agent.remove':
        return { removed: this.remove((payload as { path: AgentPath }).path) } as never;
      case 'role.list':
        return this.listRoles() as never;

      // ── M4 ──
      case 'approval.respond': {
        const p = payload as { requestId: string; approved: boolean; note?: string };
        return this.respondApproval(p.requestId, p.approved, p.note) as never;
      }
      case 'question.respond': {
        // 提问通道与审批共用挂起表（Axon5 人机交互留的入口）。
        const p = payload as { requestId: string; answer: string };
        return this.approvals.respond(p.requestId, true, p.answer) as never;
      }
      case 'pending.list':
        return this.listPending() as never;
      case 'ledger.query':
        return this.queryLedger(payload as LedgerQuery) as never;
      case 'ledger.get':
        return this.getLedgerRecord((payload as { id: string }).id) as never;
      case 'ledger.adopt': {
        const p = payload as { id: string; adoption: Adoption; note?: string };
        return { record: this.adoptByHuman(p.id, p.adoption, p.note) } as never;
      }
      case 'ledger.getAdoptionPolicy':
        return this.getAdoptionPolicy() as never;
      case 'ledger.setAdoptionPolicy':
        return {
          policy: this.setAdoptionPolicy((payload as { policy: AdoptionPolicy }).policy),
        } as never;
      case 'budget.get':
        return this.budgetSnapshot() as never;

      // ─ MU-1：会话 ──
      case 'session.create':
        return this.createSession(payload as CreateSessionPayload) as never;
      case 'session.get':
        return this.getSession((payload as { sessionId: string }).sessionId) as never;
      case 'session.list':
        return this.listSessions(payload as SessionListQuery) as never;
      case 'session.escalate':
        return this.escalateSession(payload as EscalateSessionPayload) as never;
      case 'session.rename': {
        const p = payload as { sessionId: string; title: string };
        return this.renameSession(p.sessionId, p.title) as never;
      }
      case 'session.remove':
        return this.removeSession((payload as { sessionId: string }).sessionId) as never;

      //  M5：存储实况（§4.9）──
      case 'storage.status':
        return this.storageStatus() as never;

      default:
        throw new Error(`未实现的命令: ${String(command)}`);
    }
  }
}
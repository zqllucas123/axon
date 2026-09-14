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
 */

import {
  DEFAULT_ADOPTION_POLICY,
  ROOT_PATH,
  isTerminal,
  needsAdoption,
  parseForkMode,
  type Adoption,
  type AdoptionPolicy,
  type AgentPath,
  type AgentSnapshot,
  type BudgetSnapshot,
  type CollabAction,
  type CollabOrigin,
  type CommandMap,
  type EventMap,
  type LedgerQuery,
  type LedgerRecord,
  type MessageLike,
  type PendingRequest,
  type RoleDefinition,
  type RoleEntry,
  type RoleIssue,
  type SpawnAgentPayload,
  type UsageTotals,
} from '@axon/protocol';
import {
  AgentRegistry,
  BudgetGuard,
  Ledger,
  createAxonEngine,
  forkMessages,
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
import { ApprovalBroker } from './approval.ts';
import { arbiterIneligibleReason, resolveArbiter } from './adoption.ts';

export type EmitFn = <E extends keyof EventMap>(
  event: E,
  payload: EventMap[E],
  source: AgentPath,
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
  /** 预算熔断（M3）。缺省 = 关闭。 */
  budget?: BudgetOptions;
  /** idle 看门狗：running 且超时无任何事件 → 中断。0 = 关闭。默认 5 分钟（kalo 同值）。 */
  idleTimeoutMs?: number;
  /** 审批请求超时（M4）。0 = 不超时。 */
  approvalTimeoutMs?: number;
  /** 裁决策略初值（M4 决策 D2）。缺省 = 人工表态。 */
  adoptionPolicy?: AdoptionPolicy;
}

/** 默认 idle 看门狗 5 分钟 —— 抄 kalo `IDLE_TIMEOUT_MS = 5min`（02 §2.3）。 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export class AxonHost {
  private readonly registry: AgentRegistry;
  private roles = new Map<string, RoleEntry>();
  /** 加载期坏文件的错误（不在 roles 里，单独携带给 UI 渲染红条）。 */
  private roleIssues: RoleIssue[] = [];
  private readonly emit: EmitFn;
  private readonly modelSource: ModelSource;
  private readonly tools: unknown[];
  /** 每个 Agent 的 transcript 由引擎自持，这里只缓存根节点的（根无引擎）。 */
  private readonly rootMessages: MessageLike[] = [];

  // ── M3：闸门 / 预算 / 活性 ──────────────────────────────
  private readonly budget: BudgetGuard;
  private readonly idleTimeoutMs: number;
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
  private readonly ledger = new Ledger();
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
    this.emit = options.emit;
    this.modelSource = options.modelSource;
    this.tools = options.tools ?? [];
    this.registry = new AgentRegistry({ maxConcurrent: options.maxConcurrent ?? 6 });
    this.budget = new BudgetGuard(options.budget ?? { hardUsd: 0 });
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
    this.emit('roles.changed', { entries, issues }, ROOT_PATH);
  }

  listRoles(): { entries: RoleEntry[]; issues: RoleIssue[] } {
    return { entries: [...this.roles.values()], issues: [...this.roleIssues] };
  }

  list(): AgentSnapshot[] {
    return this.registry.list();
  }

  get(path: AgentPath): AgentSnapshot | null {
    return this.registry.snapshot(path);
  }

  messagesOf(path: AgentPath): MessageLike[] {
    if (path === ROOT_PATH) return [...this.rootMessages];
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
    return {
      state: this.budget.current,
      spentUsd: this.budget.spent,
      softUsd,
      hardUsd,
      disabled: this.budget.disabled,
      usage: this.registry.get(ROOT_PATH)?.snapshot.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
    };
  }

  // ── M4：协作账本 ───────────────────────────────

  queryLedger(query: LedgerQuery) {
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
    this.emit('ledger.policyChanged', { policy }, ROOT_PATH);
    return policy;
  }

  /** 挂起中的审批/提问（`pending.list`）。 */
  listPending(): PendingRequest[] {
    return this.approvals.list();
  }

  respondApproval(requestId: string, approved: boolean, note?: string): { accepted: true } {
    return this.approvals.respond(requestId, approved, note);
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

  /** 某 Agent 生效的审批档。root 无角色 ⇒ undefined（它代表人，不能代批）。 */
  private approvalModeOf(path: AgentPath) {
    if (path === ROOT_PATH) return undefined;
    const role = this.registry.get(path)?.snapshot.role;
    return role ? this.roles.get(role)?.role.approval : undefined;
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

    const entry = this.roles.get(payload.role);
    if (!entry) throw new Error(`角色不存在: ${payload.role}`);
    const role = entry.role;

    const parent = payload.parent ?? ROOT_PATH;
    const parentNode = this.registry.get(parent);
    if (!parentNode) throw new Error(`父 Agent 不存在: ${parent}`);

    // ① 权限：父级白名单 ∩ 角色白名单
    const parentTools = this.toolNamesOf(parent);
    const allowed = intersectTools(parentTools, role.tools);

    // ② 上下文：缺省走角色默认，角色也没写就是全局默认（none）
    const mode = parseForkMode(payload.forkMode ?? role.defaultForkMode);
    const inherited = forkMessages(this.messagesOf(parent), mode);

    const allowSet = allowed ? new Set(allowed) : undefined;
    const snapshot = this.registry.register({
      role: role.name,
      displayName: payload.overrides?.displayName ?? role.displayName,
      parent,
      forkMode: payload.forkMode ?? role.defaultForkMode,
    });

    const engine = createAxonEngine({
      systemPrompt: payload.overrides?.instructions ?? role.instructions,
      model: this.modelSource.model,
      streamFn: this.modelSource.streamFn,
      messages: fromMessageLike(inherited),
      tools: this.toolsFor(snapshot.path, allowSet) as never,
      sessionId: snapshot.path,
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
    this.emit('agent.created', { snapshot }, snapshot.path);

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

    if (this.registry.canRun()) {
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

    // ② parked FIFO 填空额
    while (this.registry.canRun() && this.pendingRuns.length > 0) {
      const path = this.pendingRuns.shift()!;
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

  /** 某个 Agent 实际可用的工具名集合。根节点返回 undefined（无限制）。 */
  private toolNamesOf(path: AgentPath): string[] | undefined {
    if (path === ROOT_PATH) return undefined;
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
   * 叶子工具同样按白名单过滤——模型只能看到自己有权唤起的工具。
   */
  private toolsFor(path: AgentPath, allowSet?: Set<string>): unknown[] {
    const leaves = allowSet
      ? this.tools.filter((t) => (t as { name?: unknown }).name !== undefined
          && allowSet.has((t as { name: string }).name))
      : this.tools;
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
    this.onStatusChanged(path, status);
    this.emit('agent.status', error ? { path, status, error } : { path, status }, path);
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
        case 'message_end':
          this.emit(
            'agent.message.end',
            { messageId: path, message: event.message as unknown as MessageLike },
            path,
          );
          break;
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

          // M3 预算熔断：root 是全局总账，记录跃迁并广播事件
          const totalUsd = this.registry.get(ROOT_PATH)?.snapshot.usage.costUsd ?? 0;
          const transition = this.budget.record(totalUsd);
          if (transition !== 'none') {
            const { softUsd, hardUsd } = this.budget.limits;
            // spentUsd 与 limits 必须是两个不同来源的数：旧实现把
            // `limitUsd` 填成了 budget.spent，于是 UI banner 的「已用 / 上限」
            // 永远相等（MX G9.1）。
            this.emit(
              transition === 'warning' ? 'budget.warning' : 'budget.frozen',
              {
                usage: this.registry.get(ROOT_PATH)!.snapshot.usage,
                spentUsd: this.budget.spent,
                softUsd,
                hardUsd,
              },
              ROOT_PATH,
            );
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

      default:
        throw new Error(`未实现的命令: ${String(command)}`);
    }
  }
}
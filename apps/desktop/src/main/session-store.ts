/**
 * SessionStore —— 会话元数据的 CRUD 与 rollup（纯逻辑，electron-free）。
 *
 * 分工（与 host 的边界）：
 *  - 这里是**账房**：存记录、算汇总、算三层预算的取更严者；
 *  - host 是**工头**：它知道 registry / ledger / approvals 的实时状态，
 *    把这些原料喂给 buildSessionSummary()。
 *
 * 为什么 rollup 不放在 host 里：会话汇总的字段会被三个屏消费（S0 最近用过、
 * S1 会话总览、S2 会话条），它一旦长在宿主内部，就只能通过 IPC 事件整块传出，
 * 测试与 UI 都失去了「自己造一份原料算一遍」的能力。纯函数则可以穷举。
 *
 * M5 起**没有条数上限**（R9）：磁盘是全景，内存也应当是全景 —— 淘汰是单机内存
 * 时代的产物，留着会让用户的会话「自己消失」。返回多少条由 `list(query.limit)`
 * 决定（缺省 50）。
 */

import {
  SESSION_TITLE_MAX,
  type AgentPath,
  type AgentSnapshot,
  type AgentStatus,
  type BudgetTier,
  type PendingRequest,
  type SessionBudgetSpec,
  type SessionBudgetView,
  type SessionCounts,
  type SessionListQuery,
  type SessionRecord,
  type SessionRollup,
  type SessionSummary,
  type SessionTeamRef,
  type TeamDefinition,
  type UsageTotals,
} from '@axon/protocol';

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

// ─────────────────────────────────────────────────────────────
// 记录表
// ─────────────────────────────────────────────────────────────

export interface SessionStoreOptions {
  now?: () => number;
  /** 初始记录 —— 启动装载（M5 §4.5）。 */
  records?: readonly SessionRecord[];
  /**
   * 记录变动回调（M5 落盘挂点）：create / update / remove 各触发一次。
   *
   * 与 `Ledger.onChange` 同款约定：落盘实现自己把失败变成 issue，不往外抛。
   * 挂在这里而不是宿主里，是为了让「哪些命令要落盘」这件事只有一处答案。
   */
  onChange?: (event: SessionStoreChange) => void;
}

export interface SessionStoreChange {
  kind: 'create' | 'update' | 'remove';
  record: SessionRecord;
}

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly onChange: ((event: SessionStoreChange) => void) | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange;
    if (options.records) this.load(options.records);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * 装入启动时扫到的记录（M5 切片 3）。
   *
   * 幂等：同 id 不覆盖（先到的赢 —— 与 `Ledger.load` 同一约定）。
   * **不触发 onChange**：装载是「把磁盘上的东西搬进内存」，再落一次盘
   * 会在每次启动时把所有 session.json 重写一遍（既无意义，也把
   * 「文件被外部改坏」的现场覆盖掉）。
   */
  load(records: readonly SessionRecord[]): void {
    for (const r of records) {
      if (!this.records.has(r.id)) this.records.set(r.id, { ...r });
    }
  }

  create(record: SessionRecord): SessionRecord {
    this.records.set(record.id, { ...record });
    this.onChange?.({ kind: 'create', record: { ...record } });
    return { ...record };
  }

  get(id: string): SessionRecord | undefined {
    const r = this.records.get(id);
    return r ? { ...r } : undefined;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** 按创建时间倒序（最近的在前）；可按 open/closed 过滤。 */
  list(query: SessionListQuery = {}): SessionRecord[] {
    const status = query.status ?? 'all';
    const all = [...this.records.values()]
      .filter((r) => status === 'all' || r.status === status)
      // id 前缀是 base36 时间戳，字典序即创建序；同毫秒再比 id。
      .sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1));
    return all.slice(0, query.limit ?? 50).map((r) => ({ ...r }));
  }

  all(): SessionRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** 局部更新；`undefined` 的字段不改（区别于「置空」）。 */
  update(id: string, patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>): SessionRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      (r as unknown as Record<string, unknown>)[k] = v;
    }
    r.updatedAt = this.now();
    this.onChange?.({ kind: 'update', record: { ...r } });
    return { ...r };
  }

  remove(id: string): SessionRecord | undefined {
    const r = this.records.get(id);
    if (!r) return undefined;
    this.records.delete(id);
    this.onChange?.({ kind: 'remove', record: { ...r } });
    return { ...r };
  }
}

// ─────────────────────────────────────────────────────────────
// 会话标题
// ─────────────────────────────────────────────────────────────

/**
 * 从首条任务文本生成标题（S0 的「例如：把 apps/api 的支付回调改成幂等…」。
 * 单行化 + 截断：标题要能在左栏一行里显示完，换行会让列表高矮不一。
 */
export function titleFromPrompt(text: string, max = SESSION_TITLE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

// ─────────────────────────────────────────────────────────────
// 三层预算（G10.4）
// ─────────────────────────────────────────────────────────────

export interface BudgetTiers {
  global: SessionBudgetSpec;
  team?: SessionBudgetSpec;
  self?: SessionBudgetSpec;
}

/** 有效值：0 与缺省同义 = 不设（与 BudgetGuard 的 hard<=0 关闭熔断同义）。 */
function positive(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}

function minDefined(values: readonly (number | undefined)[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const v of values) if (v !== undefined && v < best) best = v;
  return Number.isFinite(best) ? best : 0;
}

/**
 * 三层限额取更严者（UX 02 §6 拍板 4：团队软/硬线在全局档之内取更严者；
 * 会话档同理，且「会话可下调不可上调」——min 天然满足这条）。
 *
 * 每层的软线缺省 = 该层硬线 × 0.8；**逐层算完再取更严**，而不是拿最终硬线
 * 反推 —— 否则「团队只写了软线、全局只写了硬线」这种组合会算错。
 */
export function computeEffectiveBudget(tiers: BudgetTiers, spentUsd: number): SessionBudgetView {
  const layerHard = (spec: SessionBudgetSpec | undefined) => positive(spec?.hardUsd);
  const layerSoft = (spec: SessionBudgetSpec | undefined) => {
    const soft = positive(spec?.softUsd);
    if (soft !== undefined) return soft;
    const hard = layerHard(spec);
    return hard !== undefined ? hard * 0.8 : undefined;
  };

  const globals = tiers.global;
  const layers: { name: 'global' | 'team' | 'session'; spec?: SessionBudgetSpec }[] = [
    { name: 'global', spec: globals },
    { name: 'team', spec: tiers.team },
    { name: 'session', spec: tiers.self },
  ];

  const effectiveHardUsd = minDefined(layers.map((l) => layerHard(l.spec)));
  const effectiveSoftUsd = minDefined(layers.map((l) => layerSoft(l.spec)));

  // 生效硬线来自哪一层 —— UI 要能说「受团队预算限制」而不是给个孤零零的数。
  let limitedBy: SessionBudgetView['limitedBy'];
  if (effectiveHardUsd > 0) {
    for (const l of layers) {
      if (layerHard(l.spec) === effectiveHardUsd) {
        limitedBy = l.name === 'session' ? 'session' : l.name;
        break;
      }
    }
  }

  let tier: BudgetTier = 'ok';
  if (effectiveHardUsd > 0 && spentUsd >= effectiveHardUsd) tier = 'frozen';
  else if (effectiveSoftUsd > 0 && spentUsd >= effectiveSoftUsd) tier = 'warning';

  return {
    spentUsd,
    global: { ...globals },
    ...(tiers.team ? { team: { ...tiers.team } } : {}),
    ...(tiers.self ? { self: { ...tiers.self } } : {}),
    effectiveSoftUsd,
    effectiveHardUsd,
    tier,
    ...(limitedBy ? { limitedBy } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────

export interface SummaryInput {
  record: SessionRecord;
  rootPath: AgentPath;
  status: AgentStatus;
  /** 本会话全部成员快照（含根）。 */
  members: AgentSnapshot[];
  /** 本会话账本笔数。 */
  ledgerCount: number;
  /** 本会话挂起中的审批/提问。 */
  pending: readonly PendingRequest[];
  /** 全局档限额。 */
  globalBudget: SessionBudgetSpec;
  /** 团队档（会话引用的团队）。 */
  teamBudget?: SessionBudgetSpec;
  team?: TeamDefinition;
  /** 并入会话的临时成员数（adhoc 里由「存为团队」之外的方式加的）。 */
  tempCount?: number;
  /**
   * 懒加载：未装树的会话直接用落盘的计数（§4.5 —— 列表永不触发加载）。
   * 有则覆盖按成员算出来的那几个字段（members/running/parked/suspended/ledger）。
   */
  countsFromRollup?: Partial<SessionCounts>;
  /** 懒加载：未装树的会话，用量也只剩落盘那一份（列表的用量列要用）。 */
  usageFromRollup?: UsageTotals;
  /**
   * 上次退出落盘的汇总原件（MU-3 E-1）。原样透传给 UI 而不拆开：
   * `interruptedAt` 是 S7「上次中断」的唯一来源，之前它落了盘却到不了界面。
   */
  rollup?: SessionRollup;
}

/**
 * 组装一份会话摘要。
 *
 * 计数口径（与设计稿一致）：
 *  - `members` 不含会话根（根是 lead，用户眼里「成员」指的是它带的人）；
 *  - `parked` 与 `suspended` 分开：都是 waiting，但前者是「排队等额度」，
 *    后者是「父在等后代」——把两者混成一个数字，用户就无法判断是资源不够还是结构使然。
 */
export function buildSessionSummary(input: SummaryInput): SessionSummary {
  const { record, members } = input;
  const children = members.filter((m) => m.path !== input.rootPath);
  const counts: SessionCounts = {
    members: children.length,
    running: children.filter((m) => m.status === 'running').length,
    parked: 0,
    suspended: 0,
    ledger: input.ledgerCount,
    pending: input.pending.length,
  };
  // parked = waiting 且没在等后代；suspended = waiting 且在等（waitingOn 非空）。
  for (const m of children) {
    if (m.status !== 'waiting') continue;
    if (m.waitingOn && m.waitingOn.length > 0) counts.suspended += 1;
    else counts.parked += 1;
  }
  if (input.countsFromRollup) Object.assign(counts, input.countsFromRollup);

  const usage = input.usageFromRollup ?? members.find((m) => m.path === input.rootPath)?.usage ?? { ...ZERO_USAGE };
  const budget = computeEffectiveBudget(
    {
      global: input.globalBudget,
      ...(input.teamBudget ? { team: input.teamBudget } : {}),
      ...(record.budget ? { self: record.budget } : {}),
    },
    usage.costUsd,
  );

  const team: SessionTeamRef | undefined = input.team
    ? {
        id: input.team.name,
        name: input.team.name,
        memberCount: input.team.members.length,
        tempCount: input.tempCount ?? 0,
      }
    : undefined;

  return {
    record,
    rootPath: input.rootPath,
    status: input.status,
    ...(team ? { team } : {}),
    counts,
    usage,
    budget,
    ...(input.rollup ? { rollup: input.rollup } : {}),
  };
}
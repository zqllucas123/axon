/**
 * Ledger —— 协作账本（M4）。
 *
 * 纯内存、纯数据结构：进出都是值，不碰 electron、不碰 registry、不碰 pi。
 * 所以它属于可复用内核，可以 headless 测。「审批穿透」那种要读角色档、
 * 要沿父链走、要发 IPC 的逻辑刻意留在宿主（apps/desktop/src/main/approval.ts），
 * 混进来会把 registry 依赖拖进 kernel。
 *
 * 落盘是 M5 的正题（docs/03 §7）：这里每条记录带 `version` 外箱，
 * M5 直接序列化即可，不必改形状。
 */

import {
  LEDGER_MAX_RECORDS,
  LEDGER_SCHEMA_VERSION,
  LEDGER_SUMMARY_MAX,
  initialAdoption,
  isAncestorOf,
  mentionUri,
  sessionIdOfPath,
  type Adoption,
  type AdoptedBy,
  type AgentPath,
  type CollabAction,
  type CollabOrigin,
  type LedgerQuery,
  type LedgerQueryResult,
  type LedgerRecord,
  type UsageTotals,
} from '@axon/protocol';

export interface RecordCollabSpec {
  action: CollabAction;
  from: AgentPath;
  to: AgentPath;
  origin: CollabOrigin;
  /**
   * 所属会话。调用方（宿主）已经知道它，显式传入最稳。
   *
   * 缺省时从 `from`/`to` 路径的首段解（`sessionIdOfPath`）—— 留这条退路是因为
   * 「路径里就写着会话」是多根模型的红利，不该逼调用方多传一个参数。
   * 两者都没有就抛：一笔没有会话归属的账目在 MU-1 之后没有意义（无法切片）。
   */
  sessionId?: string;
  contextScope?: string | number | null;
  /** 记录时刻目标子树的累计 usage，作为 settle 时求增量的基线。 */
  usageBaseline?: UsageTotals;
}

export interface SettleSpec {
  /** settle 时目标子树的累计 usage；与基线求差得到本笔归因。 */
  usageNow?: UsageTotals;
  summary?: string;
}

export interface LedgerOptions {
  now?: () => number;
  maxRecords?: number;
  /** 随机后缀生成器；测试里注入常量以获得确定性 id。 */
  suffix?: () => string;
  /**
   * 每次账目变动后的回调（M5 切片 3 的落盘挂点）。
   *
   * 只在**真的发生变动**时触发（幂等命中、重复 settle 不触发）；拿到的是副本。
   * 约定：落盘实现自己把失败变成 issue，不从回调里往外抛（SessionPersistence 即如此）。
   */
  onChange?: (record: LedgerRecord) => void;
}

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

function diffUsage(baseline: UsageTotals | undefined, now: UsageTotals): UsageTotals {
  const base = baseline ?? ZERO_USAGE;
  return {
    // 子树可能在期间被裁剪导致累计值回退，钳到 0 而不是报负数。
    inputTokens: Math.max(0, now.inputTokens - base.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - base.outputTokens),
    costUsd: Math.max(0, now.costUsd - base.costUsd),
  };
}

export function truncateSummary(text: string, max = LEDGER_SUMMARY_MAX): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export class Ledger {
  private readonly records = new Map<string, LedgerRecord>();
  /** origin.toolCallId → record id，做重复落账的幂等键。 */
  private readonly byToolCall = new Map<string, string>();
  /** 已经派发过裁决请求的记录 id —— 堵住「裁决请求触发裁决请求」的环。 */
  private readonly arbitrationSent = new Set<string>();
  private readonly usageBaselines = new Map<string, UsageTotals>();
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly suffix: () => string;
  private readonly onChange: ((record: LedgerRecord) => void) | undefined;
  private seq = 0;
  /** 因超出上限被丢弃的最旧记录数，UI 可提示「更早的记录已截断」。 */
  private droppedCount = 0;

  constructor(options: LedgerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxRecords = options.maxRecords ?? LEDGER_MAX_RECORDS;
    this.suffix = options.suffix ?? (() => Math.random().toString(36).slice(2, 8));
    this.onChange = options.onChange;
  }

  /**
   * 从落盘记录装载（M5 切片 3）。
   *
   * 三件事：记录进 Map（保持传入顺序 = 磁盘上的首次出现序，last-wins 已由读侧完成）；
   * 重建 `byToolCall` 幂等索引（否则重启后模型重试会再落一笔同源账）；
   * 把 `seq` 推到已用最大序号之后（否则新账目会与旧 id 撞号）。
   *
   * `usageBaselines` 刻意不重建：它是**进程内的**「上次观测」，跨重启没有意义，
   * 而错灌一个旧基线会让 settle 的增量算出负数（被钳成 0，于是归因永远是 0）。
   */
  load(records: readonly LedgerRecord[]): void {
    for (const r of records) {
      if (this.records.has(r.id)) continue;
      this.records.set(r.id, structuredClone(r));
      this.byToolCall.set(r.origin.toolCallId, r.id);
      const m = /^L(\d+)-/.exec(r.id);
      if (m?.[1]) this.seq = Math.max(this.seq, Number(m[1]));
    }
    this.evictIfNeeded();
  }

  /** 变动通知（见 LedgerOptions.onChange）。 */
  private notify(record: LedgerRecord): void {
    this.onChange?.(structuredClone(record));
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * 落一笔新协作。
   *
   * 幂等：同一个 toolCallId 重复落账（模型重试 / 引擎重放）返回已有记录，
   * 不会在账上出现两行同源记录。
   */
  record(spec: RecordCollabSpec): LedgerRecord {
    const existingId = this.byToolCall.get(spec.origin.toolCallId);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) return structuredClone(existing);
    }

    const at = this.now();
    this.seq += 1;
    // 序号左补零：id 的字典序必须与时间序一致，否则 before 游标翻页会乱。
    const id = `L${String(this.seq).padStart(8, '0')}-${this.suffix()}`;

    const sessionId =
      spec.sessionId ?? sessionIdOfPath(spec.to) ?? sessionIdOfPath(spec.from);
    if (!sessionId) {
      throw new Error(`账本记录缺少会话归属: ${spec.from} → ${spec.to}`);
    }

    const record: LedgerRecord = {
      version: LEDGER_SCHEMA_VERSION,
      id,
      sessionId,
      action: spec.action,
      from: spec.from,
      to: spec.to,
      origin: { ...spec.origin },
      mention: mentionUri(spec.to),
      contextScope: spec.contextScope,
      adoption: initialAdoption(spec.action),
      status: 'open',
      at,
    };

    this.records.set(id, record);
    this.byToolCall.set(spec.origin.toolCallId, id);
    if (spec.usageBaseline) this.usageBaselines.set(id, { ...spec.usageBaseline });
    this.evictIfNeeded();
    if (this.records.has(id)) this.notify(record);
    return structuredClone(record);
  }

  get(id: string): LedgerRecord | null {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }

  /** 某个 agent 名下所有仍 open 的记录（它作为 `to` 的那些）。 */
  openRecordsFor(to: AgentPath): LedgerRecord[] {
    const out: LedgerRecord[] = [];
    for (const r of this.records.values()) {
      if (r.status === 'open' && r.to === to) out.push(structuredClone(r));
    }
    return out;
  }

  /**
   * 结算一笔协作（目标进入终态 / 被中断 / 被删除）。
   * 已 settled 的记录再次 settle 是 no-op —— 中断与终态可能连着来。
   */
  settle(id: string, spec: SettleSpec = {}): LedgerRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.status === 'settled') return structuredClone(record);

    record.status = 'settled';
    record.settledAt = this.now();
    if (spec.usageNow) {
      record.usage = diffUsage(this.usageBaselines.get(id), spec.usageNow);
    }
    if (spec.summary !== undefined) record.summary = truncateSummary(spec.summary);
    this.usageBaselines.delete(id);
    this.notify(record);
    return structuredClone(record);
  }

  /**
   * 裁决。
   *
   * 不做「裁决者是否有资格」的判断——那要走 registry 的父子关系，
   * 是宿主职责（见 apps/desktop/src/main/adoption.ts 的 assertArbiterEligible）。
   * 这里只负责把结果与署名写进账。
   */
  adopt(id: string, adoption: Adoption, by: AdoptedBy, note?: string): LedgerRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    record.adoption = adoption;
    record.adoptedAt = this.now();
    record.adoptedBy = by;
    if (note !== undefined) record.adoptedNote = note;
    this.notify(record);
    return structuredClone(record);
  }

  /**
   * 只写备注不改裁决——用于「本想自动裁决但回落了人工」的原因留痕。
   * 记录仍保持 pending 等人来点，不静默失败。
   */
  adoptNote(id: string, note: string): LedgerRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    record.adoptedNote = note;
    this.notify(record);
    return structuredClone(record);
  }

  /** 标记「已为这条记录派发过裁决请求」；返回 false 表示之前已派过。 */
  markArbitrationSent(id: string): boolean {
    if (this.arbitrationSent.has(id)) return false;
    this.arbitrationSent.add(id);
    return true;
  }

  /** 按时间倒序查询。 */
  query(q: LedgerQuery = {}): LedgerQueryResult {
    const matched: LedgerRecord[] = [];
    for (const r of this.records.values()) {
      if (!this.matches(r, q)) continue;
      matched.push(r);
    }
    // id 的字典序即时间序（见 record() 里的补零），倒序即最新在前。
    matched.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    const total = matched.length;
    let page = matched;
    if (q.before) page = page.filter((r) => r.id < q.before!);
    page = page.slice(0, q.limit ?? 100);

    return { records: page.map((r) => structuredClone(r)), total };
  }

  private matches(r: LedgerRecord, q: LedgerQuery): boolean {
    // 会话是最外层的切片维度：先过它，后面几项都是会话内的细筛。
    if (q.sessionId && r.sessionId !== q.sessionId) return false;
    if (q.participant && r.from !== q.participant && r.to !== q.participant) return false;
    if (q.agent) {
      const hit = q.subtree
        ? this.touchesSubtree(r, q.agent)
        : r.from === q.agent || r.to === q.agent;
      if (!hit) return false;
    }
    if (q.action && !q.action.includes(r.action)) return false;
    if (q.adoption && !q.adoption.includes(r.adoption)) return false;
    if (q.status && !q.status.includes(r.status)) return false;
    return true;
  }

  private touchesSubtree(r: LedgerRecord, root: AgentPath): boolean {
    const inSubtree = (p: AgentPath) => p === root || isAncestorOf(root, p);
    return inSubtree(r.from) || inSubtree(r.to);
  }

  /** 超出上限时丢最旧（Map 保持插入序，第一个即最旧）。 */
  private evictIfNeeded(): void {
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      const victim = this.records.get(oldest.value);
      this.records.delete(oldest.value);
      this.usageBaselines.delete(oldest.value);
      this.arbitrationSent.delete(oldest.value);
      if (victim) this.byToolCall.delete(victim.origin.toolCallId);
      this.droppedCount += 1;
    }
  }
}

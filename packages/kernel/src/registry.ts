/**
 * AgentRegistry —— Agent 实例的生命周期、寻址与并发闸门。
 *
 * 设计取舍记录（为什么长这样）：
 *
 * 1. **树形路径既是身份也是层级**（借鉴 codex 的 `AgentPath`）。
 *    路径形如 `/root/developer-1/tester-1`。不额外维护父子映射表 ——
 *    多一张表就多一处能和真相不一致的地方。父子关系用字符串前缀就能算。
 *
 * 2. **Registry 不碰上下文，也不决定派给谁**。它只管「谁存在、什么状态、
 *    能不能再起一个」。切上下文是 ContextForker 的事，派活是 Orchestrator 的事。
 *    这条边界一旦破了，Registry 会长成一个什么都管的上帝对象。
 *
 * 3. **状态机是显式的白名单**，非法跃迁直接抛。多 Agent 场景下状态错乱的症状
 *    是「UI 显示在跑但其实早死了」，极难定位；宁可在写入侧炸掉。
 *
 * 4. **并发上限拦在 `running` 的入口**，而不是 spawn 的入口。
 *    理由：允许用户一次性建出 10 个 Agent 摆在树上（这是编排的表达），
 *    但同时真正烧 token 的不能超过上限。kalo 的子 agent 信号量是同一思路
 *    （`DEFAULT_MAX_CONCURRENCY = 6`）。
 */

import {
  ROOT_PATH,
  childPath,
  isTerminal,
  type AgentPath,
  type AgentSnapshot,
  type AgentStatus,
  type UsageTotals,
} from '@axon/protocol';
import type { AxonEngine } from './engine.ts';

/**
 * 合法的状态跃迁。
 *
 * 几条刻意的规定：
 *  - `done` / `failed` 可以回到 `idle` —— 这是「追加任务」（followup）的落点，
 *    Agent 完成后仍可被重新唤起，不必重建实例（kalo 的 `reviveChild` 同理）。
 *  - `interrupted` 也能回 `idle`，否则用户一按停止，这个 Agent 就废了。
 *  - 任何状态都能进 `failed`：错误可以在任何时刻发生，包括 idle 时的外部崩溃。
 *  - `idle` 可以进 `waiting`（M3 新增）：并发额度满时新任务先排队（parked），
 *    等有额度再由 `promote()` 免检提升——排队本身不失败、不丢任务。
 */
const TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ['running', 'waiting', 'failed'],
  running: ['waiting', 'done', 'failed', 'interrupted'],
  waiting: ['running', 'done', 'failed', 'interrupted'],
  done: ['idle', 'failed'],
  failed: ['idle'],
  interrupted: ['idle', 'failed'],
};

export interface AgentNode {
  snapshot: AgentSnapshot;
  /** 根节点可能尚未绑定引擎（纯容器）；子节点一般都有。 */
  engine?: AxonEngine;
}

export interface RegisterSpec {
  role: string;
  displayName: string;
  /** 省略则挂在 ROOT 下。 */
  parent?: AgentPath;
  engine?: AxonEngine;
  /** 创建时解析出的分身口径，入快照供 UI 与账本 contextScope 同源。 */
  forkMode?: AgentSnapshot['forkMode'];
}

export interface RegistryOptions {
  /** 同时处于 running/waiting 的上限。0 表示不限制。 */
  maxConcurrent?: number;
  /** 树的最大深度（根为 0）。防止自主派发时无限递归 spawn。 */
  maxDepth?: number;
  /** 注入时钟，便于测试。 */
  now?: () => number;
}

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/**
 * 默认最大深度 2 —— 即 root → 子 → 孙。
 *
 * 抄 TabTin 的 `MAX_SUBAGENT_DEPTH = 2`。他们的复盘说明：深度是在
 * 「子 Agent 默认不继承父上下文」的保护下才敢放到 2 的。既然 Axon 的
 * `DEFAULT_FORK_MODE` 也是 none，这个值可以照搬。
 */
const DEFAULT_MAX_DEPTH = 2;

export class AgentRegistry {
  private readonly nodes = new Map<AgentPath, AgentNode>();
  /** 每个父节点下、每个角色各自的自增序号，用于生成不重名的 path。 */
  private readonly counters = new Map<string, number>();
  private readonly maxConcurrent: number;
  private readonly maxDepth: number;
  private readonly now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 0;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.now = options.now ?? (() => Date.now());

    // 根节点总是存在。它是所有分身的挂载点，也是「Axon 内核本体」的位置。
    const at = this.now();
    this.nodes.set(ROOT_PATH, {
      snapshot: {
        path: ROOT_PATH,
        role: 'root',
        displayName: 'Axon',
        status: 'idle',
        children: [],
        createdAt: at,
        updatedAt: at,
        usage: { ...ZERO_USAGE },
        // M4：sessionId 暂等于 path；M5 落盘后两者解耦（见 AgentSnapshot 注释）。
        sessionId: ROOT_PATH,
      },
    });
  }

  // ── 查询 ────────────────────────────────────────────────

  get(path: AgentPath): AgentNode | undefined {
    return this.nodes.get(path);
  }

  has(path: AgentPath): boolean {
    return this.nodes.has(path);
  }

  /** 快照列表。返回拷贝，调用方（含 IPC 序列化）改不动内部状态。 */
  list(): AgentSnapshot[] {
    return [...this.nodes.values()].map((n) => structuredClone(n.snapshot));
  }

  snapshot(path: AgentPath): AgentSnapshot | null {
    const node = this.nodes.get(path);
    return node ? structuredClone(node.snapshot) : null;
  }

  /**
   * 当前占用并发额度的 Agent 数。
   *
   * M3 语义（决策 #2 拍板）：**只有 running 占额度**。
   * waiting 分两种，都不该占额——parked（排队等额度）与 suspended
   * （父 Agent 在等后代，主动退位让额）。占额语义错位会让「父等子」
   * 与并发上限交织出结构性死锁（父占 1 + 6 子 > 6）。
   */
  activeCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) {
      if (node.snapshot.status === 'running') n++;
    }
    return n;
  }

  depthOf(path: AgentPath): number {
    if (path === ROOT_PATH) return 0;
    // ROOT_PATH 本身含一个 '/'，所以减掉它的那一层。
    return path.split('/').length - ROOT_PATH.split('/').length;
  }

  // ── 注册 / 注销 ─────────────────────────────────────────

  register(spec: RegisterSpec): AgentSnapshot {
    const parent = spec.parent ?? ROOT_PATH;
    const parentNode = this.nodes.get(parent);
    if (!parentNode) throw new Error(`父 Agent 不存在: ${parent}`);

    const depth = this.depthOf(parent) + 1;
    if (depth > this.maxDepth) {
      throw new Error(
        `超出最大深度 ${this.maxDepth}（尝试在 ${parent} 下创建第 ${depth} 层）`,
      );
    }

    const key = `${parent}::${spec.role}`;
    const seq = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, seq);
    const path = childPath(parent, `${spec.role}-${seq}`);

    const at = this.now();
    const snapshot: AgentSnapshot = {
      path,
      role: spec.role,
      displayName: spec.displayName,
      status: 'idle',
      parent,
      children: [],
      createdAt: at,
      updatedAt: at,
      usage: { ...ZERO_USAGE },
      sessionId: path,
      forkMode: spec.forkMode,
    };

    this.nodes.set(path, spec.engine ? { snapshot, engine: spec.engine } : { snapshot });
    parentNode.snapshot.children.push(path);
    parentNode.snapshot.updatedAt = at;

    return structuredClone(snapshot);
  }

  /**
   * 级联删除整棵子树。返回被删的全部路径（深度优先，子先父后）。
   *
   * 顺序很重要：UI 依据这个数组逐个摘节点，父先删会让子节点变成孤儿渲染。
   */
  remove(path: AgentPath): AgentPath[] {
    if (path === ROOT_PATH) throw new Error('不能删除根 Agent');
    const node = this.nodes.get(path);
    if (!node) return [];

    const removed: AgentPath[] = [];
    const visit = (p: AgentPath) => {
      const n = this.nodes.get(p);
      if (!n) return;
      for (const child of [...n.snapshot.children]) visit(child);
      this.nodes.delete(p);
      removed.push(p);
    };
    visit(path);

    const parent = node.snapshot.parent;
    if (parent) {
      const pn = this.nodes.get(parent);
      if (pn) {
        pn.snapshot.children = pn.snapshot.children.filter((c) => c !== path);
        pn.snapshot.updatedAt = this.now();
      }
    }
    return removed;
  }

  // ── 状态机 ──────────────────────────────────────────────

  /**
   * 迁移状态。非法跃迁抛错；并发超限抛错（调用方应先 `canRun()` 预检）。
   */
  setStatus(path: AgentPath, next: AgentStatus, error?: string): AgentSnapshot {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Agent 不存在: ${path}`);

    const current = node.snapshot.status;
    if (current === next) return structuredClone(node.snapshot);

    if (!TRANSITIONS[current].includes(next)) {
      throw new Error(`非法状态跃迁: ${path} ${current} → ${next}`);
    }

    // 并发闸门（M3 语义）：只在「进入 running 且此前不在 running」时检查。
    // waiting 不占额；waiting→running 一律走 promote()（免检），不走这里。
    const wasRunning = current === 'running';
    const willRun = next === 'running';
    if (!wasRunning && willRun && !this.canRun()) {
      throw new Error(`并发已达上限 ${this.maxConcurrent}，${path} 无法进入 running`);
    }

    node.snapshot.status = next;
    node.snapshot.updatedAt = this.now();
    if (error !== undefined) node.snapshot.lastError = error;
    // 重新激活时清掉上一次的错误，否则 UI 会一直挂着过期的红字。
    if (next === 'idle' || next === 'running') delete node.snapshot.lastError;

    return structuredClone(node.snapshot);
  }

  canRun(): boolean {
    return this.maxConcurrent === 0 || this.activeCount() < this.maxConcurrent;
  }

  /**
   * 免检提升：waiting → running，不查并发闸门（M3 决策 #2）。
   *
   * 免检的正当性来自两句不变式：
   *  - suspended 父：额度就是「它等待的子刚结束」腾出来的，理应还给它（kalo
   *    「resume 跳过信号量避免死锁」的同构语义）；
   *  - parked 排队：只有 `canRun()` 为真时 host 才会从队首调它。
   */
  promote(path: AgentPath): AgentSnapshot {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Agent 不存在: ${path}`);
    if (node.snapshot.status !== 'waiting') {
      throw new Error(`只有 waiting 状态的 Agent 可以 promote: ${path} 当前 ${node.snapshot.status}`);
    }
    node.snapshot.status = 'running';
    node.snapshot.updatedAt = this.now();
    return structuredClone(node.snapshot);
  }

  /**
   * 同步「在等哪些后代」到快照（M4 / MX G4.6）。
   *
   * waits 图的真相在宿主（AxonHost.waits），这里只存一份供 UI 读的映像——
   * 否则渲染层要为了知道「这个 agent 在等谁」额外开一个查询通道。
   */
  setWaitingOn(path: AgentPath, targets: readonly AgentPath[]): void {
    const node = this.nodes.get(path);
    if (!node) return;
    if (targets.length === 0) delete node.snapshot.waitingOn;
    else node.snapshot.waitingOn = [...targets];
    node.snapshot.updatedAt = this.now();
  }

  /** 累加用量。父链同时累加，这样根节点天然是全局总账。 */
  addUsage(path: AgentPath, delta: Partial<UsageTotals>): void {
    let cursor: AgentPath | undefined = path;
    while (cursor) {
      const node = this.nodes.get(cursor);
      if (!node) break;
      node.snapshot.usage.inputTokens += delta.inputTokens ?? 0;
      node.snapshot.usage.outputTokens += delta.outputTokens ?? 0;
      node.snapshot.usage.costUsd += delta.costUsd ?? 0;
      node.snapshot.updatedAt = this.now();
      cursor = node.snapshot.parent;
    }
  }

  /** 终态的 Agent 集合 —— Orchestrator 的 wait 用它判断是否可以继续。 */
  terminalPaths(): AgentPath[] {
    return [...this.nodes.values()]
      .filter((n) => isTerminal(n.snapshot.status))
      .map((n) => n.snapshot.path);
  }

  attachEngine(path: AgentPath, engine: AxonEngine): void {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Agent 不存在: ${path}`);
    node.engine = engine;
  }
}

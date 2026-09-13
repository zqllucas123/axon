/**
 * AxonHost —— 内核宿主。命令的唯一执行者，事件的唯一来源。
 *
 * 它故意**不依赖 electron**：构造时注入一个 `emit` 回调即可。
 * 这样同一个宿主能跑在三个地方 —— Electron 主进程、CLI、单元测试 ——
 * 而 UI 契约（@axon/protocol 的 CommandMap/EventMap）一行都不用变。
 *
 * 反过来说，这里出现 `import ... from "electron"` 就是设计事故，
 * 它会让编排逻辑再也无法 headless 测试。
 */

import {
  ROOT_PATH,
  parseForkMode,
  type AgentPath,
  type AgentSnapshot,
  type CommandMap,
  type EventMap,
  type MessageLike,
  type RoleDefinition,
  type RoleEntry,
  type RoleIssue,
  type SpawnAgentPayload,
} from '@axon/protocol';
import {
  AgentRegistry,
  createAxonEngine,
  forkMessages,
  fromMessageLike,
  intersectTools,
  type AgentEvent,
  type AxonEngine,
  type ModelSource,
} from '@axon/kernel';

export type EmitFn = <E extends keyof EventMap>(
  event: E,
  payload: EventMap[E],
  source: AgentPath,
) => void;

export interface HostOptions {
  emit: EmitFn;
  /** 模型来源。由调用方决定是真 provider 还是 faux —— 宿主不关心。 */
  modelSource: ModelSource;
  roles: RoleDefinition[];
  /** 工具全集。角色的白名单在此之上做交集，只能减不能加。 */
  tools?: unknown[];
  maxConcurrent?: number;
}

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

  constructor(options: HostOptions) {
    this.emit = options.emit;
    this.modelSource = options.modelSource;
    this.tools = options.tools ?? [];
    this.registry = new AgentRegistry({ maxConcurrent: options.maxConcurrent ?? 6 });
    for (const role of options.roles) {
      this.roles.set(role.name, { role, source: 'builtin', errors: [] });
    }
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
    });

    const engine = createAxonEngine({
      systemPrompt: payload.overrides?.instructions ?? role.instructions,
      model: this.modelSource.model,
      streamFn: this.modelSource.streamFn,
      messages: fromMessageLike(inherited),
      tools: this.tools as never,
      sessionId: snapshot.path,
      // 闸门兜底：即使工具在 tools 全集里，未获角色授权也执行不了。
      // 与其指望上游正确裁剪 tools 数组，不如在执行前再拦一道。
      onBeforeTool: async (name) =>
        !allowSet || allowSet.has(name)
          ? { allow: true }
          : { allow: false, reason: `角色 ${role.name} 未获授权使用 ${name}` },
    });

    this.registry.attachEngine(snapshot.path, engine);
    this.wire(snapshot.path, engine);
    this.emit('agent.created', { snapshot }, snapshot.path);

    if (payload.initialPrompt) {
      // 不 await：spawn 要立刻返回快照给 UI，任务在后台跑。
      void this.prompt(snapshot.path, payload.initialPrompt);
    }
    return snapshot;
  }

  async prompt(path: AgentPath, text: string): Promise<void> {
    const node = this.registry.get(path);
    if (!node?.engine) throw new Error(`Agent 无引擎: ${path}`);

    this.setStatus(path, 'running');
    try {
      await node.engine.prompt(text);
      await node.engine.waitForIdle();
      this.setStatus(path, 'done');
    } catch (err) {
      this.setStatus(path, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  interrupt(path: AgentPath): void {
    const node = this.registry.get(path);
    node?.engine?.abort();
    // 状态由 abort 引发的事件流兜住；这里只做乐观标记。
    if (node && node.snapshot.status === 'running') {
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
    if (removed.length) this.emit('agent.removed', { paths: removed }, path);
    return removed;
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 某个 Agent 实际可用的工具名集合。根节点返回 undefined（无限制）。 */
  private toolNamesOf(path: AgentPath): string[] | undefined {
    if (path === ROOT_PATH) return undefined;
    const entry = this.roles.get(this.registry.get(path)?.snapshot.role ?? '');
    return entry?.role.tools;
  }

  private setStatus(path: AgentPath, status: AgentSnapshot['status'], error?: string) {
    try {
      this.registry.setStatus(path, status, error);
    } catch {
      // 非法跃迁不该让整轮崩掉（例如 abort 与 done 竞态）。
      // 状态机的价值在于挡住写入，不在于惩罚调用方。
      return;
    }
    this.emit('agent.status', error ? { path, status, error } : { path, status }, path);
  }

  /** 把 pi 的事件流翻译成 Axon 协议事件。 */
  private wire(path: AgentPath, engine: AxonEngine): void {
    engine.subscribe((event: AgentEvent) => {
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
      default:
        throw new Error(`未实现的命令: ${String(command)}`);
    }
  }
}

/**
 * Claude Code 运行时 —— 把本机的 `claude` 接成一个 `AxonEngine`（M9）。
 *
 * ── 为什么实现 `AxonEngine` 而不是另起一套接口 ──
 *
 * host 的 `wire()` 只认 pi 形状的事件：消息落盘、用量记账、预算熔断、并发闸门、
 * 空闲计时全挂在那一个订阅上。这里产出**同形事件**，那一整套就原样复用；
 * 另起接口意味着把 `wire()` 抄一遍，两份记账逻辑迟早分叉。
 * 代价是本文件要懂 pi 事件的形状 —— 但只懂形状，不 import pi（类型经 `@axon/kernel` 转出）。
 *
 * ── 与 tutti 的对应（`packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts`）──
 *
 * tutti 的 daemon 是 Go，所以要起一个 Node sidecar 去调 `@anthropic-ai/claude-agent-sdk`；
 * Axon 主进程本就是 Node，直接在进程内调 `query()`，省掉 sidecar 与那层 NDJSON 协议。
 * 抄的是三件事：流式输入模式（一个长寿的 `query()`，每轮往输入队列推一条用户消息）、
 * `canUseTool` 接人工审批、`resumeCursor` 的形状。
 *
 * ── 事件序列（对齐 pi 的 agent-loop，渲染层按这个顺序消费）──
 *
 *   turn_start → 用户 message_start/end
 *     → 助手 message_start → message_update* → message_end → tool_execution_start*
 *     → tool_execution_end + toolResult message_start/end   （每个工具结果）
 *     → …（Claude 内部可以循环很多次）
 *   → turn_end（带本轮用量）→ agent_end
 *
 * 一次 `prompt()` = Claude 的一个完整回合（内部可含多次模型调用），所以 `turn_end`
 * 每个 prompt 只发一次 —— 用量按 SDK 的 `result` 帧记，那才是权威数字。
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent, AxonEngine, ToolGateResult } from '@axon/kernel';
import type { MessageLike } from '@axon/protocol';

/** 引擎 id（与 `AgentToolId` 的 'claude' 对应）。 */
export const CLAUDE_ENGINE_ID = 'claude';

/**
 * 恢复游标。形状抄 tutti（`sessionRuntime.ts:1237`），多一个 `totalCostUsd`
 * （本会话在 Claude 上累计花了多少，跨重启；给人看、也给排查对账用）。
 */
export interface ClaudeResumeCursor {
  kind: 'claude-agent-sdk';
  version: 1;
  /** Claude 的会话 id（`query({ resume })` 用）。 */
  resume: string;
  /** 最后一条助手消息的 uuid。只存不传：传错（uuid 不在链上）会让恢复直接失败。 */
  resumeSessionAt?: string;
  /** 已完成的回合数；0 = 会话 id 已分配但 Claude 侧还没有任何记录。 */
  turnCount: number;
  /** 本会话累计成本（各轮增量之和，跨进程、跨重启）。 */
  totalCostUsd: number;
}

export function isClaudeResumeCursor(v: unknown): v is ClaudeResumeCursor {
  const c = v as Partial<ClaudeResumeCursor> | null;
  return (
    !!c &&
    c.kind === 'claude-agent-sdk' &&
    c.version === 1 &&
    typeof c.resume === 'string' &&
    typeof c.turnCount === 'number'
  );
}

// ── SDK 的最小结构类型 ──
//
// 不 import SDK 的类型：它的 .d.ts 牵着 `@anthropic-ai/sdk` / `zod` / MCP 三个 peer 包，
// 那些只是类型依赖、仓库里没装。这里只声明用到的那几个字段，顺带让单测能注入假的 query。

/** SDK 吐出来的一帧（只按 `type` 分流，其余字段用到再取）。 */
export interface SdkMessage {
  type: string;
  [k: string]: unknown;
}

export interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
}

export interface SdkQueryParams {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}

export interface ClaudeSdk {
  query(params: SdkQueryParams): SdkQuery;
}

/** 启动 `claude` 所需的运行环境。解析放在首次 prompt 时做，失败以该轮报错的形式露出。 */
export interface ClaudeRuntime {
  /** `claude` 可执行文件的绝对路径。 */
  executable: string;
  /** 子进程环境（PATH 要含 node：npm 装的 claude 是 `#!/usr/bin/env node` 脚本）。 */
  env: Record<string, string | undefined>;
}

export interface ClaudeEngineSpec {
  cwd: string;
  /** 已落盘的 transcript，只用于回放展示 —— Claude 的上下文由它自己按 cursor 恢复。 */
  messages?: MessageLike[];
  cursor?: ClaudeResumeCursor;
  /** 追加到 Claude Code 预设系统提示之后的文字。 */
  systemPromptAppend?: string;
  /** 解析运行环境；`claude` 没装就抛错（错误文案直接给用户看）。 */
  resolveRuntime: () => Promise<ClaudeRuntime>;
  /** 人工审批闸门（host 的 `approvals.gate`）。 */
  gate: (tool: string, args: unknown) => Promise<ToolGateResult>;
  /** 游标变了就回调（host 落进 SessionRecord）。 */
  onCursor: (cursor: ClaudeResumeCursor) => void;
  /** 注入点（单测）：缺省动态 import 真 SDK。 */
  loadSdk?: () => Promise<ClaudeSdk>;
  newId?: () => string;
}

/**
 * 懒加载 SDK。必须是动态 import：它在 esbuild 的 external 里，
 * 静态 import 会让不用 Claude 的启动也付这次模块加载。
 */
async function loadRealSdk(): Promise<ClaudeSdk> {
  const name = '@anthropic-ai/claude-agent-sdk';
  return (await import(name)) as unknown as ClaudeSdk;
}

/** 推式异步队列：`query()` 的流式输入。close 后迭代结束，SDK 随之收尾。 */
class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

type Block = { type: string; [k: string]: unknown };

/** tool_result 的 content（字符串或内容块数组）→ 一段文本。 */
function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map((b: Block) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : `[${b?.type ?? 'block'}]`))
    .join('\n');
}

/** 从这些环境变量继承会让子 `claude` 以为自己是另一个 Claude Code 的嵌套会话。 */
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'ELECTRON_RUN_AS_NODE',
];

class ClaudeEngine implements AxonEngine {
  readonly externalEngineId = CLAUDE_ENGINE_ID;

  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private readonly transcript: MessageLike[];
  private cursor: ClaudeResumeCursor;

  private query: SdkQuery | null = null;
  private input: InputQueue<unknown> | null = null;
  /** 事件串行投递链：监听器被逐个 await，顺序即产生序。 */
  private chain: Promise<void> = Promise.resolve();

  private turn: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private turnDone: Promise<void> = Promise.resolve();
  private aborted = false;
  private disposed = false;

  /** 正在拼的助手消息（一条 API 消息的内容块分多帧到）。 */
  private pending: { id: string; content: Block[]; started: boolean } | null = null;
  private readonly toolNames = new Map<string, string>();
  private stderrTail = '';
  /**
   * 当前这个 claude 进程报过的累计成本。
   *
   * SDK 的 `total_cost_usd` 是**本次 query() 的累计值**，每轮要差分成增量才能记账。
   * 注意差分的基线是「进程」而不是「会话」：SDK 注释说恢复的会话会从 transcript 存的
   * 总额接着算，但实测（claude 2.1.92 / 2.1.179，`resume` 后首轮）是从 0 重新计 ——
   * 按会话总额差分会把恢复后的头几轮少记甚至记成 0。
   */
  private processCostUsd = 0;

  constructor(private readonly spec: ClaudeEngineSpec) {
    this.transcript = structuredClone(spec.messages ?? []);
    const newId = spec.newId ?? randomUUID;
    // 没跑过任何一轮的游标不可恢复（Claude 侧没有记录），换个新 id 重新开始。
    this.cursor =
      spec.cursor && spec.cursor.turnCount > 0
        ? { ...spec.cursor }
        : { kind: 'claude-agent-sdk', version: 1, resume: newId(), turnCount: 0, totalCostUsd: 0 };
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  messages(): MessageLike[] {
    return structuredClone(this.transcript);
  }

  // 模型与推理深度由 Claude Code 自己的设置决定（各家模型表不通用），这里不接。
  setModel(): void {}
  setThinkingLevel(): void {}

  /** 回合中途追加一条用户消息：流式输入模式下 Claude 会把它并进当前回合。 */
  steer(text: string): void {
    this.input?.push(this.userFrame(text));
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error('会话引擎已释放');
    if (this.turn) throw new Error('Claude Code 正在处理上一条消息');
    this.aborted = false;

    this.turnDone = new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject };
    });
    // 调用方（host.runEngine）先 await prompt 再 await waitForIdle；后者不该二次抛错。
    this.turnDone.catch(() => undefined);

    this.emit({ type: 'turn_start' });
    const user: MessageLike = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
    this.transcript.push(user);
    this.emit({ type: 'message_start', message: user });
    this.emit({ type: 'message_end', message: user });

    try {
      await this.ensureQuery();
      this.input!.push(this.userFrame(text));
    } catch (err) {
      this.failTurn(err instanceof Error ? err : new Error(String(err)));
    }
    await this.turnDone;
    await this.chain;
  }

  async waitForIdle(): Promise<void> {
    await this.turnDone.catch(() => undefined);
    await this.chain;
  }

  abort(): void {
    if (!this.turn) return;
    this.aborted = true;
    // interrupt 之后 SDK 仍会吐一帧 result 收尾，回合在那里结算。
    void this.query?.interrupt().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.input?.close();
    try {
      this.query?.close();
    } catch {
      /* 进程可能已经退了 */
    }
    this.query = null;
    this.input = null;
    this.turn?.reject(new Error('会话引擎已释放'));
    this.turn = null;
  }

  // ── 内部 ──────────────────────────────────────────────

  private userFrame(text: string): unknown {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.cursor.resume,
    };
  }

  private emit(event: unknown): void {
    const ev = event as AgentEvent;
    this.chain = this.chain.then(async () => {
      for (const l of [...this.listeners]) {
        try {
          await l(ev);
        } catch (e) {
          console.warn('[claude-engine] 事件监听器抛错', e);
        }
      }
    });
  }

  private async ensureQuery(): Promise<void> {
    if (this.query) return;
    const runtime = await this.spec.resolveRuntime();
    const sdk = await (this.spec.loadSdk ?? loadRealSdk)();

    const env: Record<string, string | undefined> = { ...runtime.env };
    for (const k of STRIP_ENV) delete env[k];

    this.stderrTail = '';
    this.processCostUsd = 0;
    const resuming = this.cursor.turnCount > 0;
    const input = new InputQueue<unknown>();
    const query = sdk.query({
      prompt: input,
      options: {
        cwd: this.spec.cwd,
        env,
        pathToClaudeCodeExecutable: runtime.executable,
        includePartialMessages: true,
        // 'default'：读操作 Claude 自己放行，写/执行类才回调 canUseTool —— 与在终端里
        // 直接用 Claude Code 的体验一致；再往上的自动放行由 Axon 的审批档决定（gate 里）。
        permissionMode: 'default',
        // 读用户/项目的 Claude 设置与 CLAUDE.md：用户选它，要的就是「自己那个 Claude Code」。
        settingSources: ['user', 'project', 'local'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(this.spec.systemPromptAppend ? { append: this.spec.systemPromptAppend } : {}),
        },
        ...(resuming ? { resume: this.cursor.resume } : { sessionId: this.cursor.resume }),
        canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
          const verdict = await this.spec.gate(toolName, toolInput);
          return verdict.allow
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: verdict.reason };
        },
        stderr: (data: string) => {
          this.stderrTail = (this.stderrTail + data).slice(-2000);
        },
      },
    });
    this.query = query;
    this.input = input;
    if (!resuming) this.spec.onCursor({ ...this.cursor });
    void this.consume(query);
  }

  /** 读 SDK 的消息流直到它结束。结束 = 进程退了；下一次 prompt 会按游标重新拉起。 */
  private async consume(query: SdkQuery): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const msg of query) {
        if (this.query !== query) return; // 已被 dispose 或换代
        this.handle(msg);
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    if (this.query !== query) return;
    this.query = null;
    this.input?.close();
    this.input = null;
    if (this.turn) {
      const tail = this.stderrTail.trim().split('\n').slice(-3).join('\n');
      const base = error?.message ?? 'Claude Code 进程意外退出';
      this.failTurn(new Error(tail ? `${base}\n${tail}` : base));
    }
  }

  private handle(msg: SdkMessage): void {
    // 子代理（Task 工具）内部的帧不进主消息流：它们的结论会作为工具结果回到主线。
    if (msg.parent_tool_use_id) {
      if (msg.type === 'tool_progress') this.progress(msg);
      return;
    }
    switch (msg.type) {
      case 'stream_event':
        this.onStreamEvent(msg.event as { type: string; [k: string]: unknown });
        break;
      case 'assistant':
        this.onAssistant(msg);
        break;
      case 'user':
        this.onUser(msg);
        break;
      case 'tool_progress':
        this.progress(msg);
        break;
      case 'result':
        this.onResult(msg);
        break;
      default:
        break;
    }
  }

  /** 工具进度：host 不渲染它，但每个事件都会刷新空闲计时 —— 长命令靠它不被判成卡死。 */
  private progress(msg: SdkMessage): void {
    this.emit({
      type: 'tool_execution_update',
      toolCallId: msg.tool_use_id,
      toolName: msg.tool_name,
      args: {},
      partialResult: null,
    });
  }

  private openAssistant(id: string): NonNullable<ClaudeEngine['pending']> {
    if (this.pending && this.pending.id !== id) this.flushAssistant();
    if (!this.pending) this.pending = { id, content: [], started: false };
    if (!this.pending.started) {
      this.pending.started = true;
      this.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    }
    return this.pending;
  }

  private onStreamEvent(ev: { type: string; [k: string]: unknown }): void {
    if (ev.type === 'message_start') {
      const id = (ev.message as { id?: string } | undefined)?.id;
      if (id) this.openAssistant(id);
      return;
    }
    if (ev.type === 'content_block_delta') {
      const delta = ev.delta as { type?: string; text?: string; thinking?: string } | undefined;
      const partial = { role: 'assistant', content: this.pending?.content ?? [] };
      if (delta?.type === 'text_delta' && delta.text) {
        this.emit({
          type: 'message_update',
          message: partial,
          assistantMessageEvent: { type: 'text_delta', delta: delta.text },
        });
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.emit({
          type: 'message_update',
          message: partial,
          assistantMessageEvent: { type: 'thinking_delta', delta: delta.thinking },
        });
      }
      return;
    }
    // message_stop：这条 API 消息的内容块已全部到齐（assistant 帧先于它到）。
    if (ev.type === 'message_stop') this.flushAssistant();
  }

  private onAssistant(msg: SdkMessage): void {
    const m = msg.message as { id?: string; content?: Block[] } | undefined;
    if (!m) return;
    const pending = this.openAssistant(m.id ?? `anon-${randomUUID()}`);
    for (const b of m.content ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') {
        pending.content.push({ type: 'text', text: b.text });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        pending.content.push({ type: 'thinking', thinking: b.thinking });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        this.toolNames.set(b.id, name);
        pending.content.push({ type: 'toolCall', id: b.id, name, arguments: b.input ?? {} });
      }
    }
    if (typeof msg.uuid === 'string') this.cursor.resumeSessionAt = msg.uuid;
  }

  /** 收口正在拼的助手消息：落 transcript、发 message_end，再为其中的工具调用发 start。 */
  private flushAssistant(): void {
    const p = this.pending;
    this.pending = null;
    if (!p || !p.started) return;
    const message: MessageLike = { role: 'assistant', content: p.content as MessageLike['content'], timestamp: Date.now() };
    if (p.content.length > 0) this.transcript.push(message);
    this.emit({ type: 'message_end', message });
    for (const b of p.content) {
      if (b.type !== 'toolCall') continue;
      this.emit({ type: 'tool_execution_start', toolCallId: b.id, toolName: b.name, args: b.arguments });
    }
  }

  /** `user` 帧在这里只关心工具结果（用户自己的消息由 prompt() 记，不靠回声）。 */
  private onUser(msg: SdkMessage): void {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Block[]) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      this.flushAssistant();
      const toolName = this.toolNames.get(b.tool_use_id) ?? 'tool';
      const text = textOfToolResult(b.content);
      const isError = b.is_error === true;
      this.emit({
        type: 'tool_execution_end',
        toolCallId: b.tool_use_id,
        toolName,
        result: text,
        isError,
      });
      const message: MessageLike = {
        role: 'toolResult',
        toolCallId: b.tool_use_id,
        toolName,
        content: [{ type: 'text', text }],
        isError,
        timestamp: Date.now(),
      };
      this.transcript.push(message);
      this.emit({ type: 'message_start', message });
      this.emit({ type: 'message_end', message });
    }
  }

  private onResult(msg: SdkMessage): void {
    this.flushAssistant();

    const usage = (msg.usage ?? {}) as Record<string, number | undefined>;
    const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : this.processCostUsd;
    // 累计值 → 增量。比上次还小 = 进程内的累计被重置了（/clear），这时它本身就是新花的钱。
    const cost = total >= this.processCostUsd ? total - this.processCostUsd : total;
    this.processCostUsd = total;
    this.cursor.totalCostUsd += cost;
    this.cursor.turnCount += 1;
    if (typeof msg.session_id === 'string' && msg.session_id) this.cursor.resume = msg.session_id;
    this.spec.onCursor({ ...this.cursor });

    this.emit({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
        usage: {
          // 缓存读写也是进模型的 token，合进 input（Axon 的用量只分 in/out 两栏）。
          input:
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          output: usage.output_tokens ?? 0,
          cost: { total: cost },
        },
      },
      toolResults: [],
    });
    this.emit({ type: 'agent_end', messages: [] });

    const failed = msg.subtype !== 'success' || msg.is_error === true;
    if (failed && !this.aborted) {
      const errors = Array.isArray(msg.errors) ? (msg.errors as string[]).join('\n') : '';
      const detail = errors || (typeof msg.result === 'string' ? msg.result : '') || String(msg.subtype);
      this.failTurn(new Error(`Claude Code 执行失败：${detail}`));
      return;
    }
    const t = this.turn;
    this.turn = null;
    t?.resolve();
  }

  private failTurn(error: Error): void {
    this.pending = null;
    const t = this.turn;
    this.turn = null;
    t?.reject(error);
  }
}

export function createClaudeEngine(spec: ClaudeEngineSpec): AxonEngine {
  return new ClaudeEngine(spec);
}

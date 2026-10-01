import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@axon/kernel';
import {
  createClaudeEngine,
  isClaudeResumeCursor,
  type ClaudeEngineSpec,
  type ClaudeResumeCursor,
  type ClaudeSdk,
  type SdkMessage,
  type SdkQueryParams,
} from './engine-claude.ts';

type Options = Record<string, any>;
/** 一轮的剧本：收到一条用户消息后，Claude 依次吐出哪些帧。 */
type Script = (userText: string, options: Options) => AsyncGenerator<SdkMessage>;

/** 假 SDK：按剧本回放帧；记录每次 query() 的参数；支持 interrupt。 */
function fakeSdk(script: Script) {
  const calls: SdkQueryParams[] = [];
  let interrupted = false;
  const sdk: ClaudeSdk = {
    query(params) {
      calls.push(params);
      const gen = (async function* () {
        for await (const u of params.prompt as AsyncIterable<{ message: { content: string } }>) {
          interrupted = false;
          for await (const frame of script(u.message.content, params.options)) {
            if (interrupted) break;
            yield frame;
          }
          if (interrupted) {
            yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['aborted'], usage: {} };
          }
        }
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          interrupted = true;
        },
        close: () => undefined,
      }) as never;
    },
  };
  return { sdk, calls };
}

const result = (over: Partial<SdkMessage> = {}): SdkMessage => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'sess-1',
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
  ...over,
});

const assistant = (id: string, content: unknown[], uuid = `u-${id}`): SdkMessage => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { id, content },
});

function setup(script: Script, over: Partial<ClaudeEngineSpec> = {}) {
  const { sdk, calls } = fakeSdk(script);
  const cursors: ClaudeResumeCursor[] = [];
  const events: AgentEvent[] = [];
  const engine = createClaudeEngine({
    cwd: '/work',
    resolveRuntime: async () => ({ executable: '/bin/claude', env: { PATH: '/bin', CLAUDECODE: '1' } }),
    gate: async () => ({ allow: true }),
    onCursor: (c) => cursors.push(c),
    loadSdk: async () => sdk,
    newId: () => 'new-id',
    ...over,
  });
  engine.subscribe((e) => {
    events.push(e);
  });
  return { engine, events, cursors, calls };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
/** 测试辅助：读引擎内部游标的累计成本（只为断言，不是公开 API）。 */
const cursorsOf = (engine: unknown) => (engine as { cursor: ClaudeResumeCursor }).cursor.totalCostUsd;

describe('ClaudeEngine：事件翻译', () => {
  it('纯文本一轮：流式增量 → 整条消息 → turn_end，事件序与 pi 对齐', async () => {
    const { engine, events } = setup(async function* () {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } } };
      yield assistant('m1', [{ type: 'text', text: '你好' }]);
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
      yield result();
    });
    await engine.prompt('hi');

    expect(types(events)).toEqual([
      'turn_start',
      'message_start', // 用户
      'message_end',
      'message_start', // 助手
      'message_update',
      'message_update',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    const updates = events.filter((e) => e.type === 'message_update') as any[];
    expect(updates.map((u) => u.assistantMessageEvent)).toEqual([
      { type: 'thinking_delta', delta: '想' },
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
    ]);
    expect(engine.messages()).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
    ]);
  });

  it('工具调用：toolCall 块 → tool start → 结果 → toolResult 消息；同一条 API 消息的多帧合并', async () => {
    const { engine, events } = setup(async function* () {
      yield assistant('m1', [{ type: 'text', text: '我看看' }]);
      yield assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
      yield { type: 'tool_progress', parent_tool_use_id: null, tool_use_id: 't1', tool_name: 'Bash' };
      yield {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] },
      };
      yield assistant('m2', [{ type: 'text', text: '有一个文件' }]);
      yield result();
    });
    await engine.prompt('列目录');

    const msgEnds = events.filter((e) => e.type === 'message_end') as any[];
    expect(msgEnds[1].message).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: '我看看' },
        { type: 'toolCall', id: 't1', name: 'Bash', arguments: { command: 'ls' } },
      ],
    });
    expect(events.find((e) => e.type === 'tool_execution_start')).toMatchObject({
      toolCallId: 't1',
      toolName: 'Bash',
      args: { command: 'ls' },
    });
    expect(events.find((e) => e.type === 'tool_execution_end')).toMatchObject({
      toolCallId: 't1',
      toolName: 'Bash',
      result: 'a.txt',
      isError: false,
    });
    // 工具 start 在助手消息收口之后、结果之前
    const order = types(events);
    expect(order.indexOf('tool_execution_start')).toBeGreaterThan(order.indexOf('message_end', 3));
    expect(order.indexOf('tool_execution_update')).toBeGreaterThan(order.indexOf('tool_execution_start'));
    expect(engine.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  });

  it('子代理（Task）内部的帧不进主消息流', async () => {
    const { engine } = setup(async function* () {
      yield { ...assistant('sub', [{ type: 'text', text: '子代理的话' }]), parent_tool_use_id: 't9' };
      yield assistant('m1', [{ type: 'text', text: '主线' }]);
      yield result();
    });
    await engine.prompt('x');
    expect(engine.messages().filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('ClaudeEngine：审批', () => {
  it('canUseTool 走 gate：放行带回原参数，拒绝带回原因', async () => {
    const verdicts: unknown[] = [];
    const gate = vi
      .fn()
      .mockResolvedValueOnce({ allow: true })
      .mockResolvedValueOnce({ allow: false, reason: '用户拒绝' });
    const { engine } = setup(
      async function* (_text, options) {
        verdicts.push(await options.canUseTool('Bash', { command: 'ls' }, {}));
        verdicts.push(await options.canUseTool('Write', { file_path: '/x' }, {}));
        yield result();
      },
      { gate },
    );
    await engine.prompt('x');
    expect(gate).toHaveBeenNthCalledWith(1, 'Bash', { command: 'ls' });
    expect(verdicts).toEqual([
      { behavior: 'allow', updatedInput: { command: 'ls' } },
      { behavior: 'deny', message: '用户拒绝' },
    ]);
  });
});

describe('ClaudeEngine：用量、游标与恢复', () => {
  it('成本是累计值：按轮差分；缓存 token 并入 input', async () => {
    let n = 0;
    const { engine, events, cursors } = setup(async function* () {
      n += 1;
      yield assistant(`m${n}`, [{ type: 'text', text: 'ok' }]);
      yield result({ total_cost_usd: n === 1 ? 0.01 : 0.025 });
    });
    await engine.prompt('一');
    await engine.prompt('二');

    const usages = (events.filter((e) => e.type === 'turn_end') as any[]).map((e) => e.message.usage);
    expect(usages[0]).toEqual({ input: 110, output: 5, cost: { total: 0.01 } });
    expect(usages[1].cost.total).toBeCloseTo(0.015);
    expect(cursors.at(-1)).toEqual({
      kind: 'claude-agent-sdk',
      version: 1,
      resume: 'sess-1',
      resumeSessionAt: 'u-m2',
      turnCount: 2,
      totalCostUsd: 0.025,
    });
    expect(isClaudeResumeCursor(cursors.at(-1))).toBe(true);
  });

  it('新会话用 sessionId 开局并立刻交出游标；整场只起一个 query（流式输入）', async () => {
    const { engine, calls, cursors } = setup(async function* () {
      yield result({ session_id: 'new-id' });
    });
    await engine.prompt('一');
    await engine.prompt('二');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({
      cwd: '/work',
      pathToClaudeCodeExecutable: '/bin/claude',
      sessionId: 'new-id',
      includePartialMessages: true,
      permissionMode: 'default',
    });
    expect(calls[0]!.options.resume).toBeUndefined();
    // 不把「嵌套在 Claude Code 里」的标记传给子进程
    expect(calls[0]!.options.env).toEqual({ PATH: '/bin' });
    expect(cursors[0]).toMatchObject({ resume: 'new-id', turnCount: 0 });
  });

  it('带游标恢复：用 resume 而不是 sessionId；新进程的成本从 0 起算，会话累计接着加', async () => {
    const cursor: ClaudeResumeCursor = {
      kind: 'claude-agent-sdk',
      version: 1,
      resume: 'old-sess',
      turnCount: 3,
      totalCostUsd: 0.5,
    };
    const { engine, events, calls } = setup(
      async function* () {
        // 实测行为：resume 起的新进程，累计值从 0 重新计
        yield result({ session_id: 'old-sess', total_cost_usd: 0.02 });
      },
      { cursor, messages: [{ role: 'user', content: [{ type: 'text', text: '旧消息' }] }] },
    );
    expect(engine.messages()).toHaveLength(1); // 回放用的旧 transcript
    await engine.prompt('继续');
    expect(calls[0]!.options.resume).toBe('old-sess');
    expect(calls[0]!.options.sessionId).toBeUndefined();
    const end = events.find((e) => e.type === 'turn_end') as any;
    expect(end.message.usage.cost.total).toBeCloseTo(0.02);
    expect(cursorsOf(engine)).toBeCloseTo(0.52);
  });

  it('没跑过一轮的游标不可恢复：换新 id 重新开始', async () => {
    const { engine, calls } = setup(
      async function* () {
        yield result();
      },
      { cursor: { kind: 'claude-agent-sdk', version: 1, resume: 'never-ran', turnCount: 0, totalCostUsd: 0 } },
    );
    await engine.prompt('x');
    expect(calls[0]!.options.sessionId).toBe('new-id');
  });
});

describe('ClaudeEngine：失败与中断', () => {
  it('claude 没装：prompt 以可读的原因拒绝，且用户消息仍留在 transcript', async () => {
    const { engine } = setup(async function* () {}, {
      resolveRuntime: async () => {
        throw new Error('本机未检测到 Claude Code');
      },
    });
    await expect(engine.prompt('x')).rejects.toThrow('本机未检测到 Claude Code');
    expect(engine.messages()).toHaveLength(1);
    await expect(engine.waitForIdle()).resolves.toBeUndefined();
  });

  it('result 报错：prompt 拒绝并带出 SDK 的错误文本', async () => {
    const { engine } = setup(async function* () {
      yield result({ subtype: 'error_during_execution', is_error: true, errors: ['Invalid API key'] });
    });
    await expect(engine.prompt('x')).rejects.toThrow('Invalid API key');
  });

  it('中断：interrupt 后的收尾 result 不算失败；之后还能接着发', async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    let turn = 0;
    const { engine } = setup(async function* () {
      turn += 1;
      if (turn === 1) {
        yield assistant('m1', [{ type: 'text', text: '开始干' }]);
        await gateOpen;
        yield assistant('m2', [{ type: 'text', text: '不该出现' }]);
      }
      yield result();
    });
    const p = engine.prompt('长任务');
    await vi.waitFor(() => expect(engine.messages().length).toBeGreaterThanOrEqual(1));
    engine.abort();
    release();
    await expect(p).resolves.toBeUndefined();
    await expect(engine.prompt('再来')).resolves.toBeUndefined();
  });

  it('进程中途退出：当前轮失败；下一轮按游标重新拉起', async () => {
    let n = 0;
    const calls: SdkQueryParams[] = [];
    const sdk: ClaudeSdk = {
      query(params) {
        calls.push(params);
        n += 1;
        const mine = n;
        const gen = (async function* () {
          for await (const _ of params.prompt as AsyncIterable<unknown>) {
            if (mine === 1) {
              yield result({ session_id: 'sess-1' }); // 第一轮正常
              const it = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
              await it.next(); // 等第二条用户消息
              throw new Error('process exited with code 1');
            }
            yield result({ session_id: 'sess-1', total_cost_usd: 0.03 });
          }
        })();
        return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined }) as never;
      },
    };
    const engine = createClaudeEngine({
      cwd: '/w',
      resolveRuntime: async () => ({ executable: '/bin/claude', env: {} }),
      gate: async () => ({ allow: true }),
      onCursor: () => undefined,
      loadSdk: async () => sdk,
    });
    await engine.prompt('一');
    await expect(engine.prompt('二')).rejects.toThrow('process exited');
    await engine.prompt('三');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.resume).toBe('sess-1');
  });
});

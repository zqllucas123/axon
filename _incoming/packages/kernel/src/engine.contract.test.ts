/**
 * 契约测试 —— 用**真实的 pi 运行产物**锁死 Axon 对上游数据结构的假设。
 *
 * 为什么必须有这一条：fork.ts 的全部逻辑都建立在「toolCall/toolResult 长什么样」
 * 之上。如果只用手写 fixture 测试，fixture 和实现会共享同一个错误假设，
 * 于是测试全绿而线上全坏。这个坑本项目已经踩过一次。
 *
 * 这里用 pi 官方的 faux provider 跑出真实 transcript，再断言它的形状，
 * 顺便把 fork/repair 直接作用在真实数据上验证。
 * 上游一旦改结构，这条测试会红 —— 这正是它存在的意义。
 */

import { describe, expect, it } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from '@earendil-works/pi-ai';
import { createEngine, snapshotMessages } from './engine.ts';
import { forkMessages, groupIntoRounds, repairMessages } from './fork.ts';
import { FORK_ALL, FORK_NONE, forkLastRounds, type MessageLike } from '@axon/protocol';

interface RunResult {
  transcript: MessageLike[];
  blocked: string[];
}

/** 跑一轮真实的 pi agent，返回 transcript。 */
async function runAgent(options: {
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0];
  allowTools?: string[];
}): Promise<RunResult> {
  const faux = fauxProvider({ provider: 'contract', api: 'faux' });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(options.responses);

  const blocked: string[] = [];
  const allow = options.allowTools ? new Set(options.allowTools) : undefined;

  const echo = {
    name: 'echo',
    description: '回显',
    parameters: Type.Object({ v: Type.Number() }),
    execute: async (args: { v: number }) => ({
      content: [{ type: 'text' as const, text: `echo:${args.v}` }],
    }),
  };
  const danger = {
    name: 'danger',
    description: '危险操作',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'boom' }] }),
  };

  const agent = createEngine({
    systemPrompt: 'contract test',
    model: faux.getModel(),
    messages: [],
    tools: [echo, danger] as never,
    streamFn: (m, context, opts) => models.stream(m, context, opts),
    onBeforeTool: async (name) => {
      if (!allow || allow.has(name)) return { allow: true };
      blocked.push(name);
      return { allow: false, reason: `角色未获授权使用 ${name}` };
    },
  });

  await agent.prompt('go');
  await agent.waitForIdle();

  return { transcript: snapshotMessages(agent), blocked };
}

describe('契约：pi transcript 的真实形状', () => {
  it('toolCall 是 assistant 的内容块，标识字段为 id（不是 callId）', async () => {
    const { transcript } = await runAgent({
      responses: [
        fauxAssistantMessage([
          fauxText('先算一下'),
          fauxToolCall('echo', { v: 1 }, { id: 'call-1' }),
        ]),
        fauxAssistantMessage('算完了'),
      ],
    });

    const assistant = transcript.find((m) =>
      m.role === 'assistant' && m.content.some((b) => b.type === 'toolCall'),
    );
    expect(assistant, '应当有一条带 toolCall 的 assistant 消息').toBeDefined();

    const block = assistant!.content.find((b) => b.type === 'toolCall') as Record<
      string,
      unknown
    >;
    expect(block['id']).toBe('call-1');
    expect(block['name']).toBe('echo');
    // 这条断言是护栏：若上游改用 callId，必须让测试红掉而不是静默退化
    expect(block['callId'], 'pi 用的是 id，不是 callId').toBeUndefined();
  });

  it('toolResult 是独立消息，id 在顶层 toolCallId，content 里只是普通文本块', async () => {
    const { transcript } = await runAgent({
      responses: [
        fauxAssistantMessage([fauxToolCall('echo', { v: 7 }, { id: 'call-7' })]),
        fauxAssistantMessage('好'),
      ],
    });

    const tr = transcript.find((m) => m.role === 'toolResult');
    expect(tr, '应当有一条 toolResult 消息').toBeDefined();
    expect(tr!.toolCallId).toBe('call-7');
    expect(tr!.toolName).toBe('echo');
    expect(tr!.isError).toBe(false);
    // 关键：content 里没有 type:'toolResult' 的块
    expect(tr!.content.every((b) => b.type === 'text')).toBe(true);
  });

  it('并行调用产生多条独立 toolResult 消息', async () => {
    const { transcript } = await runAgent({
      responses: [
        fauxAssistantMessage([
          fauxToolCall('echo', { v: 1 }, { id: 'p1' }),
          fauxToolCall('echo', { v: 2 }, { id: 'p2' }),
          fauxToolCall('echo', { v: 3 }, { id: 'p3' }),
        ]),
        fauxAssistantMessage('都好了'),
      ],
    });

    const ids = transcript
      .filter((m) => m.role === 'toolResult')
      .map((m) => m.toolCallId)
      .sort();
    expect(ids).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('契约：真实 transcript 上的 fork 行为', () => {
  it('完整对话经 repair 后原样保留（说明 repair 不会误伤合法历史）', async () => {
    const { transcript } = await runAgent({
      responses: [
        fauxAssistantMessage([
          fauxText('第一步'),
          fauxToolCall('echo', { v: 1 }, { id: 'a1' }),
          fauxToolCall('echo', { v: 2 }, { id: 'a2' }),
        ]),
        fauxAssistantMessage([
          fauxText('第二步'),
          fauxToolCall('echo', { v: 3 }, { id: 'b1' }),
        ]),
        fauxAssistantMessage('收工'),
      ],
    });

    expect(repairMessages(transcript)).toEqual(transcript);
    expect(forkMessages(transcript, FORK_ALL)).toEqual(transcript);
    expect(forkMessages(transcript, FORK_NONE)).toEqual([]);
  });

  it('整段对话属于同一个 round（工具循环不被拆）', async () => {
    const { transcript } = await runAgent({
      responses: [
        fauxAssistantMessage([fauxToolCall('echo', { v: 1 }, { id: 'r1' })]),
        fauxAssistantMessage([fauxToolCall('echo', { v: 2 }, { id: 'r2' })]),
        fauxAssistantMessage('完'),
      ],
    });

    const rounds = groupIntoRounds(transcript);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toEqual(transcript);
    expect(forkMessages(transcript, forkLastRounds(1))).toEqual(transcript);
  });

  it('被工具闸门拦截的调用也有 toolResult 应答，不会留下悬空 call', async () => {
    const { transcript, blocked } = await runAgent({
      responses: [
        fauxAssistantMessage([
          fauxText('我要动手了'),
          fauxToolCall('danger', {}, { id: 'd1' }),
        ]),
        fauxAssistantMessage('被拦了，换个方式'),
      ],
      allowTools: ['echo'],
    });

    expect(blocked).toEqual(['danger']);

    const tr = transcript.find((m) => m.role === 'toolResult');
    expect(tr?.toolCallId).toBe('d1');
    expect(tr?.isError).toBe(true);
    // 拒绝原因要回灌给模型，否则它不知道为什么失败
    expect(JSON.stringify(tr?.content)).toContain('未获授权');

    // 最关键的一条：被拦截不应破坏 transcript 的配对完整性
    expect(repairMessages(transcript)).toEqual(transcript);
  });

  it('用真实结构验证：人为砍掉尾部 result 后，repair 能剥掉悬空 call', async () => {
    const { transcript } = await runAgent({
      responses: [
        fauxAssistantMessage([
          fauxText('正在执行'),
          fauxToolCall('echo', { v: 9 }, { id: 'orphan' }),
        ]),
        fauxAssistantMessage('完'),
      ],
    });

    // 模拟「父 agent 正处于已发调用、结果未回」的瞬间
    const inflight = transcript.filter((m) => m.role !== 'toolResult').slice(0, 2);
    const repaired = repairMessages(inflight);

    const remainingCalls = repaired.flatMap((m) =>
      m.content.filter((b) => b.type === 'toolCall'),
    );
    expect(remainingCalls).toEqual([]);
    // 文本要留下来
    expect(JSON.stringify(repaired)).toContain('正在执行');
    expect(repaired.every((m) => m.content.length > 0)).toBe(true);
  });
});

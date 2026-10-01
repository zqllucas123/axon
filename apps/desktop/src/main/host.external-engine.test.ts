/**
 * 外部引擎会话（M9）的 host 集成测试。
 *
 * 用真的 ClaudeEngine + 假 SDK，跑通 host 这一侧的整条链：建会话 → 审批穿透 →
 * 消息落盘与回放 → 成本进预算 → 游标落进 session.json → 重启后按游标恢复。
 * 不碰真 claude：那一段是 engine-claude.test.ts 与手工验收的事。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventMap } from '@axon/protocol';
import { createFauxSource, fauxAssistantMessage, scriptedSource } from '@axon/kernel';
import { AxonHost, type ExternalEngineProvider } from './host.ts';
import { SessionPersistence, type SessionListItem } from './session-persistence.ts';
import { ALL_ROLES } from './roles.ts';
import {
  createClaudeEngine,
  isClaudeResumeCursor,
  type ClaudeSdk,
  type SdkMessage,
  type SdkQueryParams,
} from './engine-claude.ts';

const roots: string[] = [];
const boots: SessionPersistence[] = [];
afterEach(async () => {
  const ps = boots.splice(0);
  await Promise.all(ps.map((p) => p.flush().catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 25));
  await Promise.all(ps.map((p) => p.flush().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 假 Claude：每条用户消息都先申请一次 Bash 权限，放行就「执行」并回一段话。
 * 累计成本每轮 +0.02（SDK 的 total_cost_usd 是累计值）。
 */
function fakeClaude(costBase = 0) {
  const calls: SdkQueryParams[] = [];
  let total = costBase;
  const sdk: ClaudeSdk = {
    query(params) {
      calls.push(params);
      const opts = params.options as Record<string, any>;
      const sessionId = (opts.resume ?? opts.sessionId) as string;
      const gen = (async function* (): AsyncGenerator<SdkMessage> {
        for await (const u of params.prompt as AsyncIterable<{ message: { content: string } }>) {
          const text = u.message.content;
          yield { type: 'assistant', uuid: `a-${text}`, parent_tool_use_id: null, message: { id: `m-${text}`, content: [{ type: 'tool_use', id: `t-${text}`, name: 'Bash', input: { command: 'ls' } }] } };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
          const verdict = await opts.canUseTool('Bash', { command: 'ls' }, {});
          yield {
            type: 'user',
            parent_tool_use_id: null,
            message: { content: [{ type: 'tool_result', tool_use_id: `t-${text}`, content: verdict.behavior === 'allow' ? 'a.txt' : verdict.message, is_error: verdict.behavior !== 'allow' }] },
          };
          yield { type: 'assistant', uuid: `b-${text}`, parent_tool_use_id: null, message: { id: `n-${text}`, content: [{ type: 'text', text: `做完了：${text}` }] } };
          total += 0.02;
          yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: total, usage: { input_tokens: 100, output_tokens: 20 } };
        }
      })();
      return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined }) as never;
    },
  };
  return { sdk, calls };
}

function providerWith(sdk: ClaudeSdk, installed = true): ExternalEngineProvider {
  return {
    label: () => 'Claude Code',
    unavailableReason: (id) =>
      id !== 'claude' ? `暂不支持用 ${id} 执行会话` : installed ? undefined : '本机未检测到 Claude Code',
    create: (spec) =>
      createClaudeEngine({
        cwd: spec.cwd,
        messages: spec.messages,
        ...(isClaudeResumeCursor(spec.cursor) ? { cursor: spec.cursor } : {}),
        resolveRuntime: async () => ({ executable: '/bin/claude', env: {} }),
        gate: spec.gate,
        onCursor: (c) => spec.onCursor({ ...c }),
        loadSdk: async () => sdk,
      }),
  };
}

type Captured = { event: keyof EventMap; payload: any };

async function boot(root: string, sdk: ClaudeSdk, records?: SessionListItem[], installed = true) {
  const persistence = new SessionPersistence({ root, rollupIntervalMs: 1 });
  boots.push(persistence);
  const events: Captured[] = [];
  const src = await createFauxSource();
  const host = new AxonHost({
    modelSource: scriptedSource(src, {}, (t) => fauxAssistantMessage(`pi:${t}`)),
    roles: [...ALL_ROLES],
    tools: [],
    emit: (event, payload) => events.push({ event, payload }),
    persistence,
    budget: { hardUsd: 10 },
    ...(records ? { records } : {}),
  });
  host.setExternalEngineProvider(providerWith(sdk, installed));
  return { host, persistence, events };
}

/** 自动替用户点「允许」（审批档是 always_ask）。 */
function autoApprove(host: AxonHost, events: Captured[]): () => void {
  const timer = setInterval(() => {
    for (const e of events) {
      if (e.event === 'approval.request' && !e.payload.__done) {
        e.payload.__done = true;
        host.respondApproval(e.payload.requestId, true);
      }
    }
  }, 2);
  return () => clearInterval(timer);
}

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'axon-ext-'));
  roots.push(dir);
  return dir;
}

describe('外部引擎会话', () => {
  it('建会话即由 Claude 执行：审批穿透到 Axon、消息可回放、成本进会话用量', async () => {
    const root = await tempRoot();
    const { sdk, calls } = fakeClaude();
    const { host, events } = await boot(root, sdk);
    const stop = autoApprove(host, events);

    const created = host.createSession({ title: '列目录', executor: 'engine', engineId: 'claude', initialPrompt: '列目录' });
    expect(created.record.engineId).toBe('claude');
    expect(host.get(created.rootPath)?.displayName).toBe('Claude Code');
    await waitFor(() => host.get(created.rootPath)?.status === 'done');
    stop();

    // 跑的是 Claude 不是 pi：cwd 透传给了 SDK
    expect(calls).toHaveLength(1);
    expect((calls[0]!.options as any).cwd).toBe(created.record.cwd);
    // 工具调用走了 Axon 的人工审批
    const req = events.find((e) => e.event === 'approval.request');
    expect(req?.payload).toMatchObject({ tool: 'Bash', origin: created.rootPath });
    // 协议事件与内置引擎同形：工具卡两态 + 回合用量
    expect(events.find((e) => e.event === 'agent.tool.end')?.payload).toMatchObject({ callId: 't-列目录', ok: true });
    expect(events.find((e) => e.event === 'agent.turn.end')?.payload.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.02,
    });
    // 回放：用户 / 助手(工具) / 工具结果 / 助手
    const replay = await host.execute('agent.messages', { path: created.rootPath } as never);
    expect((replay as any[]).map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    // 成本进会话用量与预算视图
    const detail = host.getSession(created.record.id)!;
    expect(detail.usage.costUsd).toBeCloseTo(0.02);
    expect(detail.budget.spentUsd).toBeCloseTo(0.02);
    // 游标落进了会话记录
    expect(detail.record.resumeCursor).toMatchObject({ kind: 'claude-agent-sdk', turnCount: 1, totalCostUsd: 0.02 });
    expect(detail.record.externalSessionId).toBe((detail.record.resumeCursor as any).resume);
    host.dispose();
  });

  it('重启：按游标 resume，历史可回放，成本不重复计', async () => {
    const root = await tempRoot();
    const first = fakeClaude();
    const a = await boot(root, first.sdk);
    let stop = autoApprove(a.host, a.events);
    const created = a.host.createSession({ title: '一', executor: 'engine', engineId: 'claude', initialPrompt: '一' });
    await waitFor(() => a.host.get(created.rootPath)?.status === 'done');
    stop();
    await a.persistence.flush();
    const items = await a.persistence.listRecords();
    a.host.dispose();
    const resumeId = (items[0]!.record.resumeCursor as any).resume;
    expect(resumeId).toBeTruthy();

    // 第二次开机：resume 起的新进程，累计成本从 0 重新计（实测行为）
    const second = fakeClaude();
    const b = await boot(root, second.sdk, items);
    expect(b.host.getSession(created.record.id)?.record.engineId).toBe('claude');
    const replay = await b.host.execute('agent.messages', { path: created.rootPath } as never);
    expect((replay as any[]).length).toBe(4); // 旧 transcript 回来了

    stop = autoApprove(b.host, b.events);
    await b.host.execute('agent.prompt', { path: created.rootPath, text: '二' } as never);
    await waitFor(() => b.host.get(created.rootPath)?.status === 'done');
    stop();

    expect((second.calls[0]!.options as any).resume).toBe(resumeId);
    const turnEnd = b.events.filter((e) => e.event === 'agent.turn.end').at(-1);
    expect(turnEnd?.payload.usage.costUsd).toBeCloseTo(0.02); // 只计新花的
    expect(b.host.getSession(created.record.id)?.usage.costUsd).toBeCloseTo(0.04);
    expect((b.host.getSession(created.record.id)?.record.resumeCursor as any).totalCostUsd).toBeCloseTo(0.04);
    b.host.dispose();
  });

  it('claude 没装：建会话直接失败，不留残缺会话', async () => {
    const root = await tempRoot();
    const { host } = await boot(root, fakeClaude().sdk, undefined, false);
    expect(() =>
      host.createSession({ title: 'x', executor: 'engine', engineId: 'claude', initialPrompt: 'x' }),
    ).toThrow('本机未检测到 Claude Code');
    expect(host.listSessions()).toHaveLength(0);
    host.dispose();
  });

  it('外部引擎不能与团队模式同用；也不能「叫人」升级', async () => {
    const root = await tempRoot();
    const { host } = await boot(root, fakeClaude().sdk);
    expect(() =>
      host.createSession({ title: 'x', executor: 'team', teamId: 'any', engineId: 'claude' }),
    ).toThrow('外部引擎暂只支持单兵会话');
    const s = host.createSession({ title: 'y', executor: 'engine', engineId: 'claude' });
    await expect(
      host.execute('session.escalate', { sessionId: s.record.id, teamId: 'any' } as never),
    ).rejects.toThrow('外部引擎会话暂不支持叫人组队');
    host.dispose();
  });

  it('不带 engineId 的会话照旧走内置引擎（回归）', async () => {
    const root = await tempRoot();
    const { sdk, calls } = fakeClaude();
    const { host } = await boot(root, sdk);
    const s = host.createSession({ title: 'pi', executor: 'engine', initialPrompt: '你好' });
    await waitFor(() => host.get(s.rootPath)?.status === 'done');
    expect(calls).toHaveLength(0);
    expect(s.record.engineId).toBeUndefined();
    host.dispose();
  });
});

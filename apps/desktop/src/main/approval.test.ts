/**
 * ApprovalBroker 单测 —— 父链穿透 / 幂等 / 超时（M4 §5.2）。
 *
 * 这里钉死的是**穿透语义本身**，不涉及引擎：谁能代批、谁必须惊动人、
 * 超时按什么处理、重复响应会不会把同一个门开两次。
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentPath, ApprovalMode, EventMap } from '@axon/protocol';
import { ApprovalBroker } from './approval.ts';

interface Emitted {
  event: keyof EventMap;
  payload: unknown;
  source: AgentPath;
}

function makeBroker(
  modes: Record<string, ApprovalMode | undefined>,
  opts: { timeoutMs?: number } = {},
) {
  const emitted: Emitted[] = [];
  const waitStarts: AgentPath[] = [];
  const waitEnds: AgentPath[] = [];
  const broker = new ApprovalBroker({
    approvalModeOf: (p) => modes[p],
    exists: (p) => p === '/root' || p in modes,
    emit: (event, payload, source) => emitted.push({ event, payload, source }),
    onWaitStart: (p) => waitStarts.push(p),
    onWaitEnd: (p) => waitEnds.push(p),
    timeoutMs: opts.timeoutMs ?? 0,
  });
  return { broker, emitted, waitStarts, waitEnds };
}

const REQ = (e: Emitted[]) =>
  e.find((x) => x.event === 'approval.request')?.payload as
    | EventMap['approval.request']
    | undefined;

describe('ApprovalBroker · 三档行为', () => {
  it('full_access / auto 自己就能放行，不惊动任何人', async () => {
    for (const mode of ['full_access', 'auto'] as const) {
      const { broker, emitted } = makeBroker({ '/root/a-1': mode });
      const r = await broker.gate('/root/a-1', 'shell', {});
      expect(r.allow).toBe(true);
      expect(emitted).toHaveLength(0);
    }
  });

  it('always_ask 且无人可代批 ⇒ 发 approval.request 给人', async () => {
    const { broker, emitted, waitStarts } = makeBroker({ '/root/a-1': 'always_ask' });
    const pending = broker.gate('/root/a-1', 'shell', { cmd: 'rm -rf' });

    const req = REQ(emitted)!;
    expect(req.origin).toBe('/root/a-1');
    expect(req.chain).toEqual(['/root/a-1', '/root']);
    expect(req.tool).toBe('shell');
    expect(req.args).toEqual({ cmd: 'rm -rf' });
    expect(req.approvalMode).toBe('always_ask');
    // 等人批期间要把 agent 挂出看门狗视野，否则会被 idle 判死
    expect(waitStarts).toEqual(['/root/a-1']);

    broker.respond(req.requestId, true);
    expect((await pending).allow).toBe(true);
  });

  it('root 无角色档 ⇒ 不能代批：它代表人，请求必须落到人手上', async () => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    void broker.gate('/root/a-1', 'shell', {});
    expect(REQ(emitted)).toBeDefined();
  });
});

describe('ApprovalBroker · 父链穿透（TabTin subagent-hitl 同构）', () => {
  it('父档为 auto ⇒ 父代批，不惊动人', async () => {
    const { broker, emitted } = makeBroker({
      '/root/planner-1': 'auto',
      '/root/planner-1/tester-1': 'always_ask',
    });
    const r = await broker.gate('/root/planner-1/tester-1', 'shell', {});
    expect(r.allow).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('父也是 always_ask ⇒ 继续向上找', async () => {
    const modes: Record<string, ApprovalMode> = {
      '/root/a-1': 'full_access',
      '/root/a-1/b-1': 'always_ask',
      '/root/a-1/b-1/c-1': 'always_ask',
    };
    const { broker, emitted } = makeBroker(modes);
    const r = await broker.gate('/root/a-1/b-1/c-1', 'shell', {});
    expect(r.allow).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('整条链都 always_ask ⇒ 惊动人，chain 带完整穿透路径', async () => {
    const { broker, emitted } = makeBroker({
      '/root/a-1': 'always_ask',
      '/root/a-1/b-1': 'always_ask',
    });
    void broker.gate('/root/a-1/b-1', 'shell', {});
    expect(REQ(emitted)!.chain).toEqual(['/root/a-1/b-1', '/root/a-1', '/root']);
  });

  it('resolveDelegation 报出是哪个祖先代的批', () => {
    const { broker } = makeBroker({
      '/root/a-1': 'auto',
      '/root/a-1/b-1': 'always_ask',
    });
    expect(broker.resolveDelegation('/root/a-1/b-1')).toEqual({
      allow: true,
      ancestor: '/root/a-1',
    });
    // 自己就有权时不标 ancestor
    expect(broker.resolveDelegation('/root/a-1')).toEqual({ allow: true });
  });
});

describe('ApprovalBroker · D5 编排工具豁免', () => {
  it.each([
    'agent',
    'agent_wait',
    'agent_check',
    'agent_message',
    'agent_resume',
    'agent_interrupt',
    'ledger_adopt',
  ])('%s 不受 HITL 门拦截', async (tool) => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    const r = await broker.gate('/root/a-1', tool, {});
    expect(r.allow).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('叶子工具照拦 —— 豁免只针对编排工具', async () => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    void broker.gate('/root/a-1', 'shell', {});
    expect(REQ(emitted)).toBeDefined();
  });
});

describe('ApprovalBroker · 响应与幂等', () => {
  it('拒绝时把原因回灌给模型', async () => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    const pending = broker.gate('/root/a-1', 'shell', {});
    broker.respond(REQ(emitted)!.requestId, false, '这条命令太危险');
    const r = await pending;
    expect(r).toEqual({ allow: false, reason: '这条命令太危险' });
  });

  it('重复 respond 同一 requestId 不重复 resolve，也不再发 pending.resolved', async () => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    const pending = broker.gate('/root/a-1', 'shell', {});
    const id = REQ(emitted)!.requestId;

    broker.respond(id, true);
    expect(broker.respond(id, false)).toEqual({ accepted: true });
    // 第一次的结果说了算
    expect((await pending).allow).toBe(true);
    expect(emitted.filter((e) => e.event === 'pending.resolved')).toHaveLength(1);
  });

  it('未知 requestId 也返回 accepted —— UI 可能在超时后才点，不该报错', () => {
    const { broker } = makeBroker({});
    expect(broker.respond('nope', true)).toEqual({ accepted: true });
  });

  it('结束时发 pending.resolved，outcome 区分批准与拒绝', async () => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    void broker.gate('/root/a-1', 'shell', {});
    broker.respond(REQ(emitted)!.requestId, false);
    const resolved = emitted.find((e) => e.event === 'pending.resolved')!
      .payload as EventMap['pending.resolved'];
    expect(resolved.outcome).toBe('denied');
  });
});

describe('ApprovalBroker · 超时', () => {
  it('超时按拒绝处理，原因写明是超时', async () => {
    vi.useFakeTimers();
    try {
      const { broker, emitted } = makeBroker(
        { '/root/a-1': 'always_ask' },
        { timeoutMs: 1000 },
      );
      const pending = broker.gate('/root/a-1', 'shell', {});
      vi.advanceTimersByTime(1000);
      const r = await pending;
      expect(r.allow).toBe(false);
      expect((r as { reason: string }).reason).toMatch(/超时/);
      const resolved = emitted.find((e) => e.event === 'pending.resolved')!
        .payload as EventMap['pending.resolved'];
      expect(resolved.outcome).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('请求带 expiresAt，UI 可以倒计时', async () => {
    vi.useFakeTimers();
    try {
      const { broker, emitted } = makeBroker(
        { '/root/a-1': 'always_ask' },
        { timeoutMs: 5000 },
      );
      void broker.gate('/root/a-1', 'shell', {});
      const req = broker.list()[0]!;
      expect(req.expiresAt).toBe(req.at + 5000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ApprovalBroker · 挂起表', () => {
  it('pending.list 返回未回应的请求，回应后摘掉', async () => {
    const { broker, emitted } = makeBroker({ '/root/a-1': 'always_ask' });
    void broker.gate('/root/a-1', 'shell', {});
    expect(broker.list()).toHaveLength(1);
    broker.respond(REQ(emitted)!.requestId, true);
    expect(broker.list()).toHaveLength(0);
  });

  it('cancelFor 连子树一起取消 —— agent 被删后不留幽灵待办', async () => {
    const { broker } = makeBroker({
      '/root/a-1': 'always_ask',
      '/root/a-1/b-1': 'always_ask',
      '/root/z-1': 'always_ask',
    });
    const a = broker.gate('/root/a-1', 'shell', {});
    const b = broker.gate('/root/a-1/b-1', 'shell', {});
    void broker.gate('/root/z-1', 'shell', {});
    expect(broker.size).toBe(3);

    broker.cancelFor('/root/a-1');
    expect(broker.size).toBe(1);
    expect((await a).allow).toBe(false);
    expect((await b).allow).toBe(false);
  });

  it('list() 顺带清掉已消失 agent 的请求', async () => {
    const modes: Record<string, ApprovalMode> = { '/root/a-1': 'always_ask' };
    const emitted: Emitted[] = [];
    let alive = true;
    const broker = new ApprovalBroker({
      approvalModeOf: (p) => modes[p],
      exists: () => alive,
      emit: (event, payload, source) => emitted.push({ event, payload, source }),
      timeoutMs: 0,
    });
    const pending = broker.gate('/root/a-1', 'shell', {});
    alive = false;
    expect(broker.list()).toHaveLength(0);
    expect((await pending).allow).toBe(false);
  });

  it('dispose 作废全部挂起请求，不留悬空 Promise', async () => {
    const { broker } = makeBroker({ '/root/a-1': 'always_ask' });
    const pending = broker.gate('/root/a-1', 'shell', {});
    broker.dispose();
    expect((await pending).allow).toBe(false);
  });
});

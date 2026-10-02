/**
 * QuestionBroker 单元测试（M11 §2）。
 *
 * 覆盖：ask / respond / cancelFor / dispose / list / 超时不中断。
 */

import { describe, expect, it, vi } from 'vitest';
import { QuestionBroker } from './question-broker.ts';
import type { AgentPath, EventMap } from '@axon/protocol';

const path = '/s1' as AgentPath;

function makeEmit() {
  return vi.fn<Parameters<QuestionBrokerOptions['emit']>, ReturnType<QuestionBrokerOptions['emit']>>();
}

type QuestionBrokerOptions = ConstructorParameters<typeof QuestionBroker>[0];

function boot(overrides: Partial<QuestionBrokerOptions> = {}) {
  const emit = vi.fn<[keyof EventMap, EventMap[keyof EventMap], AgentPath?], void>();
  const qb = new QuestionBroker({
    emit: emit as QuestionBrokerOptions['emit'],
    exists: () => true,
    ...overrides,
  });
  return { qb, emit };
}

describe('QuestionBroker', () => {
  it('ask 发出 question.request 事件并挂起，respond 回答后 resolve', async () => {
    const { qb, emit } = boot();
    const promise = qb.ask(path, '你好，这个功能要兼容 Safari 吗？');

    expect(emit).toHaveBeenCalledWith(
      'question.request',
      expect.objectContaining({ message: expect.stringContaining('Safari') }),
      path,
    );
    expect(qb.size).toBe(1);

    const reqId = (emit.mock.calls[0]![1] as { requestId: string }).requestId;
    qb.respond(reqId, '是的，需要兼容到 Safari 16');

    await expect(promise).resolves.toBe('是的，需要兼容到 Safari 16');
    expect(qb.size).toBe(0);
  });

  it('respond 发出 pending.resolved 事件，outcome=answered', async () => {
    const { qb, emit } = boot();
    const promise = qb.ask(path, '测试问题');
    const reqId = (emit.mock.calls[0]![1] as { requestId: string }).requestId;
    qb.respond(reqId, '回答');
    await promise;

    const resolved = emit.mock.calls.find((c) => c[0] === 'pending.resolved');
    expect(resolved?.[1]).toMatchObject({ requestId: reqId, outcome: 'answered' });
  });

  it('respond 幂等：重复调用同一 requestId 直接返回', async () => {
    const { qb, emit } = boot();
    const promise = qb.ask(path, '幂等测试');
    const reqId = (emit.mock.calls[0]![1] as { requestId: string }).requestId;
    qb.respond(reqId, '第一次');
    qb.respond(reqId, '第二次'); // 幂等，不重复 resolve
    await expect(promise).resolves.toBe('第一次');
  });

  it('ask 支持 context 和 choices，message 包含 context', async () => {
    const { qb, emit } = boot();
    void qb.ask(path, '选哪个架构？', { context: '有两种方案', choices: ['方案 A', '方案 B'] });

    const payload = emit.mock.calls[0]![1] as { message: string; requestId: string };
    expect(payload.message).toContain('有两种方案');
  });

  it('cancelFor 取消该 agent 的全部挂起提问并 resolve', async () => {
    const { qb } = boot();
    const p1 = qb.ask(path, '问题一');
    const p2 = qb.ask(path, '问题二');
    expect(qb.size).toBe(2);

    qb.cancelFor(path);

    await expect(p1).resolves.toContain('取消');
    await expect(p2).resolves.toContain('取消');
    expect(qb.size).toBe(0);
  });

  it('list 返回所有挂起提问', () => {
    const { qb } = boot();
    void qb.ask(path, '第一个问题');
    void qb.ask(path, '第二个问题');
    const items = qb.list();
    expect(items).toHaveLength(2);
    expect(items.every((r) => r.kind === 'question')).toBe(true);
    expect(items.every((r) => r.state === 'pending')).toBe(true);
  });

  it('list 会清理已消失 agent 的提问', async () => {
    let alive = true;
    const { qb } = boot({ exists: () => alive });
    const promise = qb.ask(path, '等待中');
    expect(qb.size).toBe(1);

    alive = false;
    const items = qb.list();
    expect(items).toHaveLength(0);
    await expect(promise).resolves.toContain('取消');
  });

  it('dispose 时 resolve 所有挂起提问', async () => {
    const { qb } = boot();
    const p1 = qb.ask(path, '问题 A');
    const p2 = qb.ask(path, '问题 B');
    qb.dispose();
    await expect(p1).resolves.toContain('关闭');
    await expect(p2).resolves.toContain('关闭');
    expect(qb.size).toBe(0);
  });

  it('onWaitStart 和 onWaitEnd 在 ask/respond 时分别调用', async () => {
    const onWaitStart = vi.fn();
    const onWaitEnd = vi.fn();
    const { qb, emit } = boot({ onWaitStart, onWaitEnd });

    const promise = qb.ask(path, '有回调吗？');
    expect(onWaitStart).toHaveBeenCalledWith(path);
    expect(onWaitEnd).not.toHaveBeenCalled();

    const reqId = (emit.mock.calls[0]![1] as { requestId: string }).requestId;
    qb.respond(reqId, '有');
    await promise;
    expect(onWaitEnd).toHaveBeenCalledWith(path);
  });
});

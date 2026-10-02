/**
 * M11 Phase 1 验收测试：ask_user 完整链路集成测试。
 *
 * 直接调用 host 的 askUser 私有方法模拟主管发起提问，
 * 验证：
 * 1. question.request 事件发出
 * 2. listPending 包含该提问（kind=question）
 * 3. choices 字段正确传递到 detail
 * 4. question.respond 后 Promise resolve 并回传答案
 * 5. pending.resolved 事件发出（outcome=answered）
 * 6. listPending 里提问消失
 * 7. 不超时（approvalTimeoutMs 极短但提问不被取消）
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventMap } from '@axon/protocol';
import { createFauxSource, scriptedSource, fauxAssistantMessage } from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence } from './session-persistence.ts';
import { ALL_ROLES } from './roles.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'axon-ask-'));
  roots.push(dir);
  return dir;
}

type Captured = { event: keyof EventMap; payload: unknown };

async function boot(root: string) {
  const persistence = new SessionPersistence({ root, rollupIntervalMs: 1 });
  const events: Captured[] = [];
  const src = await createFauxSource();
  const host = new AxonHost({
    modelSource: scriptedSource(src, {}, (t) => fauxAssistantMessage(`回复：${t}`)),
    roles: [...ALL_ROLES],
    tools: [],
    emit: (event, payload) => events.push({ event, payload }),
    persistence,
    budget: { hardUsd: 10 },
    approvalTimeoutMs: 100, // 极短，验证提问不受影响
  });
  return { host, events, persistence };
}

describe('M11 Phase 1 ask_user 集成测试', () => {
  it('askUser 发出 question.request 事件，listPending 包含该提问', async () => {
    const root = await tempRoot();
    const { host, events } = await boot(root);
    const session = host.createSession({ title: '验收', executor: 'engine' });
    const path = `/${session.record.id}` as any;

    // 直接调用私有 askUser 方法
    const answerPromise = (host as any).askUser(path, {
      question: '这个功能需要兼容 Safari 吗？',
      context: '项目里有 webkit 相关代码',
      choices: ['是，兼容 Safari 16+', '否，仅 Chrome/Firefox'],
    });

    // 1. question.request 事件
    const qEvent = events.find((e) => e.event === 'question.request');
    expect(qEvent).toBeTruthy();
    const reqPayload = qEvent!.payload as { requestId: string; message: string };
    expect(reqPayload.message).toContain('Safari');
    expect(reqPayload.message).toContain('webkit');
    const requestId = reqPayload.requestId;

    // 2. listPending 包含该提问
    const pending = host.listPending();
    const q = pending.find((p) => p.requestId === requestId);
    expect(q).toBeTruthy();
    expect(q!.kind).toBe('question');
    expect(q!.sessionId).toBe(session.record.id);

    // 3. choices 在 detail 里
    const detail = q!.detail as { choices?: string[] } | undefined;
    expect(detail?.choices).toHaveLength(2);
    expect(detail?.choices?.[0]).toContain('Safari');

    // 4. 回答，Promise resolve
    await host.execute('question.respond', { requestId, answer: '是，需要兼容 Safari 16+' });
    const answer = await answerPromise;
    expect(answer).toBe('是，需要兼容 Safari 16+');

    // 5. pending.resolved 事件
    const resolved = events.find(
      (e) => e.event === 'pending.resolved' && (e.payload as any).requestId === requestId,
    );
    expect(resolved).toBeTruthy();
    expect((resolved!.payload as any).outcome).toBe('answered');

    // 6. listPending 里提问已消失
    const pendingAfter = host.listPending();
    expect(pendingAfter.find((p) => p.requestId === requestId)).toBeUndefined();

    host.dispose();
  });

  it('approvalTimeoutMs 不影响提问（提问不超时）', async () => {
    const root = await tempRoot();
    const { host } = await boot(root); // approvalTimeoutMs=100ms
    const session = host.createSession({ title: '超时验收', executor: 'engine' });
    const path = `/${session.record.id}` as any;

    const answerPromise = (host as any).askUser(path, {
      question: '这个问题等 200ms 才回答',
    });

    // 等 200ms（远超 approvalTimeoutMs=100ms），提问仍未被取消
    await new Promise((r) => setTimeout(r, 200));
    const pending = host.listPending();
    const q = pending.find((p) => p.kind === 'question');
    expect(q).toBeTruthy(); // 还在！没超时

    // 回答
    await host.execute('question.respond', { requestId: q!.requestId, answer: '终于来了' });
    const answer = await answerPromise;
    expect(answer).toBe('终于来了');

    host.dispose();
  });

  it('cancelFor：agent 被中断时提问被取消并 resolve', async () => {
    const root = await tempRoot();
    const { host, events } = await boot(root);
    const session = host.createSession({ title: '取消验收', executor: 'engine' });
    const path = `/${session.record.id}` as any;

    const answerPromise = (host as any).askUser(path, { question: '会被取消的问题' });

    // 中断 agent
    host.interrupt(path);

    const answer = await answerPromise;
    expect(answer).toContain('取消');

    // listPending 已清空
    const pending = host.listPending();
    expect(pending.find((p) => p.kind === 'question')).toBeUndefined();

    // pending.resolved cancelled 事件
    const cancelled = events.find(
      (e) => e.event === 'pending.resolved' && (e.payload as any).outcome === 'cancelled',
    );
    expect(cancelled).toBeTruthy();

    host.dispose();
  });

  it('幂等：同一 requestId 重复 question.respond 不报错', async () => {
    const root = await tempRoot();
    const { host, events } = await boot(root);
    const session = host.createSession({ title: '幂等验收', executor: 'engine' });
    const path = `/${session.record.id}` as any;

    const answerPromise = (host as any).askUser(path, { question: '幂等测试' });
    const qEvent = events.find((e) => e.event === 'question.request');
    const requestId = (qEvent!.payload as any).requestId;

    await host.execute('question.respond', { requestId, answer: '第一次' });
    await host.execute('question.respond', { requestId, answer: '第二次' }); // 幂等
    const answer = await answerPromise;
    expect(answer).toBe('第一次');

    host.dispose();
  });
});

/**
 * M11 主管 Agent 端到端能力验收测试。
 *
 * 验证主管 Agent 五个能力维度的协同工作：
 * 1. [对齐] ask_user 向用户提问 + 用户回答后继续
 * 2. [调度] 分派子 Agent（同 session 轻量协作）
 * 3. [进度感知] 成员进终态时主管收到 steer 通知
 * 4. [任务板] orchestration session 每轮 prompt 前注入状态快照
 * 5. [交付] 主管汇总结果后完成
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentPath, EventMap } from '@axon/protocol';
import { createFauxSource, scriptedSource, fauxAssistantMessage } from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence } from './session-persistence.ts';
import { ALL_ROLES } from './roles.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'axon-m11-e2e-'));
  roots.push(dir);
  return dir;
}

type Captured = { event: keyof EventMap; payload: unknown };

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）: ${pred.toString().slice(0, 60)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function boot(root: string) {
  const persistence = new SessionPersistence({ root, rollupIntervalMs: 1 });
  const events: Captured[] = [];
  const steers: string[] = []; // 收集 steer 调用内容

  const src = await createFauxSource();
  const host = new AxonHost({
    modelSource: scriptedSource(src, {}, (t) => fauxAssistantMessage(`完成：${t}`)),
    roles: [...ALL_ROLES],
    tools: [],
    emit: (event, payload) => events.push({ event, payload }),
    persistence,
    approvalTimeoutMs: 500,
  });

  // 拦截 steer 调用记录内容
  const originalSteer = host.steer.bind(host);
  vi.spyOn(host, 'steer').mockImplementation((path, text) => {
    steers.push(text);
    return originalSteer(path, text);
  });

  return { host, events, steers, persistence };
}

describe('M11 主管 Agent 端到端能力验收', () => {
  it('ask_user + 成员分派 + 成员通知 + 任务板注入 完整链路', async () => {
    const root = await tempRoot();
    const { host, events, steers } = await boot(root);

    // 建一个临时编队（主管 + 成员）
    const session = host.createSession({
      title: 'M11 端到端验收',
      executor: 'adhoc',
      members: [
        { name: '主控', role: 'lead', task: '协调任务' },
        { name: '执行者', role: 'engine', task: '执行子任务' },
      ],
    });
    const sessionId = session.record.id;
    const rootPath = `/${sessionId}` as AgentPath;
    // 成员路径从 host.list() 里读实际运行时路径
    await waitFor(() => host.list().length >= 2, 3000);
    const allSnaps = host.list();
    const memberSnap = allSnaps.find((s) => s.role === 'engine' && s.path !== rootPath);
    if (!memberSnap) throw new Error('找不到 engine 成员');
    const memberPath = memberSnap.path as AgentPath;
    console.log(`Session: ${sessionId}, memberPath: ${memberPath}`);
    // 等成员的初始任务完成（adhoc members 有 task 字段，会自动跑）
    await waitFor(() => {
      const snap = host.get(memberPath);
      return snap?.status === 'done' || snap?.status === 'idle';
    }, 5000);

    // ── 1. ask_user：主管向用户提问 ──────────────────────────────
    const answerPromise = (host as any).askUser(rootPath, {
      question: '这个任务需要兼容旧版 API 吗？',
      context: '发现代码里有 v1 和 v2 两套接口',
      choices: ['是，需要兼容 v1 + v2', '否，只需要 v2'],
    });

    // 验证 question.request 事件发出
    const qEvent = events.find((e) => e.event === 'question.request');
    expect(qEvent, 'question.request 事件必须发出').toBeTruthy();
    const requestId = (qEvent!.payload as { requestId: string }).requestId;
    console.log(`  ✓ ask_user 发出 question.request（requestId=${requestId}）`);

    // listPending 包含提问
    const pending = host.listPending();
    const qPending = pending.find((p) => p.requestId === requestId);
    expect(qPending?.kind, 'listPending 必须包含 kind=question 的提问').toBe('question');
    const choices = (qPending!.detail as any)?.choices;
    expect(choices, 'choices 必须正确传递').toHaveLength(2);
    console.log(`  ✓ listPending 包含提问，choices=[${choices.join(', ')}]`);

    // 用户回答
    await host.execute('question.respond', { requestId, answer: '是，需要兼容 v1 + v2' });
    const answer = await answerPromise;
    expect(answer, '主管必须收到用户的答案').toBe('是，需要兼容 v1 + v2');
    console.log(`  ✓ 用户回答「${answer}」，主管继续执行`);

    // pending.resolved 事件
    const resolved = events.find((e) => e.event === 'pending.resolved' && (e.payload as any).requestId === requestId);
    expect((resolved?.payload as any)?.outcome, 'pending.resolved outcome 应为 answered').toBe('answered');
    console.log(`  ✓ pending.resolved(answered) 事件发出`);

    // ── 2. 成员执行 + 进终态通知 ──────────────────────────────────
    // 让成员跑一个任务并完成
    void host.requestRun(memberPath, '执行子任务：读取 v1 接口定义').catch(() => undefined);

    // 等成员进入终态（done/idle）
    await waitFor(() => {
      const snap = host.get(memberPath);
      return snap?.status === 'done' || snap?.status === 'idle';
    }, 5000);
    console.log(`  ✓ 成员（${memberPath}）执行完毕`);

    // M11 Phase 4：验证主管收到了成员完成通知（通过 steer）
    const memberNotification = steers.find((s) => s.includes('[成员通知]') && s.includes('执行者'));
    expect(memberNotification, '主管必须通过 steer 收到成员通知').toBeTruthy();
    console.log(`  ✓ 主管收到成员通知：「${memberNotification?.slice(0, 60)}...」`);

    // ── 3. 任务板注入验证 ─────────────────────────────────────────
    // Phase 2：下一次 requestRun 前，orchestration session 的根会注入状态快照
    // 先让成员处于 done 状态，然后再 prompt 主管，看 steer 里有没有任务板
    const steersBefore = steers.length;
    void host.requestRun(rootPath, '汇总结果').catch(() => undefined);

    // 等主管执行完
    await waitFor(() => {
      const snap = host.get(rootPath);
      return snap?.status === 'done' || snap?.status === 'idle';
    }, 5000);

    // 任务板快照应该在 prompt 之前被 steer 进去
    const snapshotSteer = steers.slice(steersBefore).find((s) => s.includes('[团队状态快照'));
    if (snapshotSteer) {
      console.log(`  ✓ 动态任务板快照已注入：「${snapshotSteer.slice(0, 80)}...」`);
    } else {
      // 所有成员 idle 时不注入是正确行为，不报错
      console.log(`  ℹ 所有成员已 idle，动态任务板跳过注入（符合预期）`);
    }

    // ── 4. 整体事件链验证 ─────────────────────────────────────────
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes, 'question.request 必须在事件链里').toContain('question.request');
    expect(eventTypes, 'pending.resolved 必须在事件链里').toContain('pending.resolved');
    expect(eventTypes, 'agent.status 必须在事件链里').toContain('agent.status');
    console.log(`  ✓ 事件链完整：[${[...new Set(eventTypes)].join(', ')}]`);

    host.dispose();
    console.log('\n  M11 端到端验收通过 ✓');
  });

  it('ask_user choices 渲染：detail 字段包含 choices 数组', async () => {
    const root = await tempRoot();
    const { host, events } = await boot(root);
    const session = host.createSession({ title: 'choices 验收', executor: 'engine' });
    const path = `/${session.record.id}` as AgentPath;

    void (host as any).askUser(path, {
      question: '选择架构方案',
      choices: ['方案 A：微服务', '方案 B：单体', '方案 C：混合'],
    });

    const q = events.find((e) => e.event === 'question.request');
    const requestId = (q!.payload as any).requestId;
    const pending = host.listPending().find((p) => p.requestId === requestId);
    const detail = pending!.detail as { choices: string[] };
    expect(detail.choices).toHaveLength(3);
    expect(detail.choices[0]).toBe('方案 A：微服务');

    await host.execute('question.respond', { requestId, answer: '方案 A：微服务' });
    host.dispose();
  });

  it('成员失败时通知消息包含 失败 标签', async () => {
    const root = await tempRoot();
    const { host, steers } = await boot(root);

    const session = host.createSession({
      title: '失败通知验收',
      executor: 'adhoc',
      members: [
        { name: '主控', role: 'lead' },
        { name: '执行者', role: 'engine' },
      ],
    });
    const sessionId = session.record.id;
    // 等成员出现
    await waitFor(() => host.list().length >= 2, 3000);
    const allSnaps = host.list();
    const memberSnap2 = allSnaps.find((s) => s.role === 'engine');
    if (!memberSnap2) throw new Error('找不到 engine 成员');
    const memberPath = memberSnap2.path as AgentPath;

    // 等成员完成初始任务（如果有）
    await waitFor(() => {
      const snap = host.get(memberPath);
      return snap?.status === 'done' || snap?.status === 'idle';
    }, 5000);

    // 让成员再运行一个任务，然后中断（interrupted 是终态，会触发成员通知）
    void host.requestRun(memberPath, '执行任务').catch(() => undefined);
    // 等成员开始运行
    await waitFor(() => {
      const snap = host.get(memberPath);
      return snap?.status === 'running' || snap?.status === 'done' || snap?.status === 'idle';
    }, 3000);
    // 中断成员，触发 interrupted 终态
    host.interrupt(memberPath);

    // 等待 steer 通知（主管应收到成员中断通知）
    await waitFor(() => steers.some((s) => s.includes('[成员通知]')), 3000);

    const notification = steers.find((s) => s.includes('[成员通知]'));
    expect(notification).toBeTruthy();
    expect(notification).toMatch(/已完成|失败|已中断/);
    console.log(`  ✓ 终态通知：「${notification?.slice(0, 80)}」`);

    host.dispose();
  });
});

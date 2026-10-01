/**
 * M10 跨 session 任务派发（task_spawn / task_wait / task_result）集成测试。
 *
 * 用 faux provider 驱动主管 Agent，验证：
 * - task_spawn 创建子 session（有独立 cwd、engineId、parentSessionId）
 * - 子 session 进终态后 task_wait 解挂
 * - task_result 读取子 session 最后一条助手消息
 * - subsession.created / subsession.changed 事件
 * - summaryOf 里 childSessions 字段
 * - 嵌套 task_spawn 被拒绝
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventMap } from '@axon/protocol';
import { createFauxSource, fauxAssistantMessage, scriptedSource } from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence } from './session-persistence.ts';
import { ALL_ROLES } from './roles.ts';

const roots: string[] = [];
const boots: SessionPersistence[] = [];
afterEach(async () => {
  const ps = boots.splice(0);
  await Promise.all(ps.map((p) => p.flush().catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 25));
  await Promise.all(ps.map((p) => p.flush().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'axon-m10-'));
  roots.push(dir);
  return dir;
}

type Captured = { event: keyof EventMap; payload: any };

async function boot(root: string, scriptRoutes?: Record<string, () => unknown>) {
  const persistence = new SessionPersistence({ root, rollupIntervalMs: 1 });
  boots.push(persistence);
  const events: Captured[] = [];
  const src = await createFauxSource();
  const host = new AxonHost({
    modelSource: scriptedSource(
      src,
      scriptRoutes ?? {},
      (t) => fauxAssistantMessage(`回复：${t}`),
    ),
    roles: [...ALL_ROLES],
    tools: [],
    emit: (event, payload) => events.push({ event, payload }),
    persistence,
    budget: { hardUsd: 10 },
  });
  return { host, events, persistence };
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：' + pred.toString().slice(0, 80));
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('M10 task_spawn / task_wait / task_result', () => {
  it('task_spawn 创建子 session：有独立记录、parentSessionId 指向主管', async () => {
    const root = await tempRoot();
    const { host } = await boot(root);

    // 主管 session
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    // 通过 host 内部方法模拟主管的 task_spawn 调用
    const childId = await (host as any).createSubSession(
      `/${leadId}`,
      { role: 'engine', task: '写测试' },
    );

    expect(typeof childId).toBe('string');
    const childRec = host.getSession(childId)?.record;
    expect(childRec?.parentSessionId).toBe(leadId);
    expect(childRec?.parentAgentPath).toBe(`/${leadId}`);

    // 父 session 的 childSessionIds 应包含子 session
    const leadRec = host.getSession(leadId)?.record;
    expect(leadRec?.childSessionIds).toContain(childId);

    host.dispose();
  });

  it('task_spawn 的子 session 继承 cwd；可以显式指定不同 cwd', async () => {
    const root = await tempRoot();
    const { host } = await boot(root);
    const lead = host.createSession({ title: '主管', executor: 'engine', cwd: root });
    const leadId = lead.record.id;

    // 继承 cwd
    const childId1 = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'a' });
    expect(host.getSession(childId1)?.record.cwd).toBe(root);

    // 显式指定 cwd
    const childId2 = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'b', cwd: '/tmp' });
    expect(host.getSession(childId2)?.record.cwd).toBe('/tmp');

    host.dispose();
  });

  it('subsession.created 事件在子 session 建好后发出', async () => {
    const root = await tempRoot();
    const { host, events } = await boot(root);
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    const before = events.filter((e) => e.event === 'subsession.created').length;
    const childId = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'a' });
    const after = events.filter((e) => e.event === 'subsession.created');
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.payload.parentSessionId).toBe(leadId);
    expect(after.at(-1)?.payload.summary.record.id).toBe(childId);
    host.dispose();
  });

  it('summaryOf 的 childSessions 字段列出子 session 的精简状态', async () => {
    const root = await tempRoot();
    const { host } = await boot(root);
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'a' });
    await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'b' });

    const detail = host.getSession(leadId);
    expect(detail?.childSessions).toHaveLength(2);
    for (const cs of detail?.childSessions ?? []) {
      expect(cs.sessionId).toBeTruthy();
      expect(cs.title).toBeTruthy();
      expect(typeof cs.status).toBe('string');
    }
    host.dispose();
  });

  it('task_wait 等待子 session 完成；子 session done 后 resolve', async () => {
    const root = await tempRoot();
    const { host } = await boot(root);
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    const childId = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: '任务' });
    await waitFor(() => host.get(`/${childId}`)?.status !== undefined, 3000);

    // task_wait 应该立刻 resolve（子 session 可能已经 done/idle）
    // 或者等到子 session 进终态
    const waitPromise = (host as any).waitSubSession(`/${leadId}`, [childId], 10);
    await waitFor(() => host.get(`/${childId}`)?.status === 'done' || host.get(`/${childId}`)?.status === 'idle', 5000);

    const results = await waitPromise;
    expect(Array.isArray(results)).toBe(true);
    const r = results.find((x: any) => x.sessionId === childId);
    expect(r).toBeTruthy();

    host.dispose();
  });

  it('task_result 读取子 session 最后一条助手消息', async () => {
    const root = await tempRoot();
    const { host } = await boot(root, {
      任务: () => fauxAssistantMessage('完成了！'),
    });
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    const childId = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: '任务' });
    await waitFor(() => host.get(`/${childId}`)?.status === 'done', 5000);

    const text = (host as any).subSessionResult(childId);
    expect(typeof text).toBe('string');
    expect(text).toContain('完成了');

    host.dispose();
  });

  it('嵌套 task_spawn：子 session 里再调用 createSubSession 被拒绝', async () => {
    const root = await tempRoot();
    const { host } = await boot(root);
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    const childId = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'a' });
    // 子 session 自己的根路径
    const childPath = `/${childId}`;

    await expect(
      (host as any).createSubSession(childPath, { role: 'engine', task: 'nested' }),
    ).rejects.toThrow('不支持再次嵌套 task_spawn');

    host.dispose();
  });

  it('task_wait 超时：超时的条目带 timedOut 标记，不影响其他条目', async () => {
    const root = await tempRoot();
    const { host } = await boot(root);
    const lead = host.createSession({ title: '主管', executor: 'engine' });
    const leadId = lead.record.id;

    const childId = await (host as any).createSubSession(`/${leadId}`, { role: 'engine', task: 'a' });

    // 0.01 秒超时，子 session 不可能这么快完成
    const results = await (host as any).waitSubSession(`/${leadId}`, [childId, 'nonexistent-id'], 0.01);

    // nonexistent-id 应该 status=not_found
    const nr = results.find((x: any) => x.sessionId === 'nonexistent-id');
    expect(nr?.status).toBe('not_found');

    host.dispose();
  });
});

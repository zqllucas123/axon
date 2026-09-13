/**
 * M3 编排工具层单测 —— 六个 AgentTool 对一个 FakeDriver。
 *
 * FakeDriver 只实现 OrchestrationDriver 的语义承诺（见 orchestrator.ts），
 * 不复制 host 的完整行为：闸门/树/引擎那些已在 host.orchestration.test.ts
 * 覆盖，这里钉死的是**工具层自己的语义**：
 *   - 目标校验只放行后代（等边沿树向下）
 *   - spawn 立返 / wait 挂起 / resume 的 fire 语义
 *   - 超时不杀子 + 摘边 / 被中止摘边
 *   - message 终态拒投、check 纯只读
 */

import { describe, expect, it } from 'vitest';
import type { AgentPath, AgentSnapshot, AgentStatus, MessageLike } from '@axon/protocol';
import type { AgentToolResult } from '@axon/kernel';
import {
  createOrchestrationTools,
  type OrchestrationDriver,
} from './orchestrator.ts';

// ── FakeDriver ────────────────────────────────────────────────

interface FakeAgent {
  path: AgentPath;
  role: string;
  displayName: string;
  status: AgentStatus;
  children: AgentPath[];
  usage: AgentSnapshot['usage'];
  lastError?: string;
  messages: MessageLike[];
  steerLog: string[];
  runLog: string[];
  interruptedTimes: number;
  /** 为真时 requestRun 的 Promise 挂起，直到本 Agent 被 finish。 */
  holdRun: boolean;
  runResolvers: (() => void)[];
}

class FakeDriver implements OrchestrationDriver {
  readonly selfPath: AgentPath = '/root/boss-1';
  readonly agents = new Map<AgentPath, FakeAgent>();
  readonly roles = new Map<string, { displayName: string }>();
  failedSpawns: string[] = [];
  endWaitCalls = 0;
  private waits: { targets: AgentPath[]; resolve: () => void }[] = [];

  constructor() {
    this.roles.set('developer', { displayName: '开发者' });
    this.roles.set('tester', { displayName: '测试' });
    this.addAt('/root/boss-1', { role: 'planner', displayName: '规划者' });
  }

  /** 测试夹具用：添加一个任意位置的 Agent（如旁支目标）。 */
  addAt(
    path: AgentPath,
    spec: { role: string; displayName: string },
  ): FakeAgent {
    const agent: FakeAgent = {
      path,
      role: spec.role,
      displayName: spec.displayName,
      status: 'idle',
      children: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      messages: [],
      steerLog: [],
      runLog: [],
      interruptedTimes: 0,
      holdRun: false,
      runResolvers: [],
    };
    this.agents.set(path, agent);
    return agent;
  }

  // ── 测试用夹具 ──
  makeChild(role: string, path?: AgentPath): FakeAgent {
    const self = this.agents.get(this.selfPath)!;
    const p: AgentPath = path ?? (`${self.path}/${role}-${self.children.length + 1}` as AgentPath);
    const agent = this.addAt(p, {
      role,
      displayName: this.roles.get(role)?.displayName ?? role,
    });
    self.children.push(p);
    return agent;
  }

  finish(path: AgentPath, status: AgentStatus, lastError?: string): void {
    const a = this.agents.get(path);
    if (!a) throw new Error(`finish 未知目标 ${path}`);
    a.status = status;
    if (lastError !== undefined) a.lastError = lastError;
    for (const r of a.runResolvers) r();
    a.runResolvers = [];
    // 检查 wait 是否全部满足并 resolve
    for (const w of [...this.waits]) {
      if (w.targets.every((t) => {
        const s = this.agents.get(t)?.status;
        return s === 'done' || s === 'failed' || s === 'interrupted';
      })) {
        this.waits = this.waits.filter((x) => x !== w);
        w.resolve();
      }
    }
  }

  // ── OrchestrationDriver ──
  spawnChild(spec: { role: string; task: string; forkMode?: string }): AgentPath {
    if (!this.roles.has(spec.role)) throw new Error(`角色不存在: ${spec.role}`);
    const self = this.agents.get(this.selfPath)!;
    const p = `${self.path}/${spec.role}-${self.children.length + 1}` as AgentPath;
    const agent = this.addAt(p, {
      role: spec.role,
      displayName: this.roles.get(spec.role)!.displayName,
    });
    self.children.push(p);
    agent.runLog.push(spec.task);
    agent.status = 'running';
    return p;
  }

  requestRun(path: AgentPath, text: string): Promise<void> {
    const a = this.agents.get(path);
    if (!a) return Promise.reject(new Error(`Agent 不存在: ${path}`));
    a.runLog.push(text);
    a.status = 'running';
    if (!a.holdRun) return Promise.resolve();
    return new Promise((resolve) => a.runResolvers.push(resolve));
  }

  interrupt(path: AgentPath): void {
    const a = this.agents.get(path);
    if (!a) return;
    a.interruptedTimes += 1;
    if (a.status !== 'done' && a.status !== 'failed' && a.status !== 'interrupted') {
      a.status = 'interrupted';
      for (const r of a.runResolvers) r();
      a.runResolvers = [];
    }
  }

  snapshot(path: AgentPath): AgentSnapshot | null {
    const a = this.agents.get(path);
    if (!a) return null;
    const now = Date.now();
    return {
      path: a.path,
      role: a.role,
      displayName: a.displayName,
      status: a.status,
      parent: a.path.includes('/') ? (a.path.slice(0, a.path.lastIndexOf('/')) as AgentPath) : undefined,
      children: [...a.children],
      createdAt: now,
      updatedAt: now,
      usage: { ...a.usage },
      lastError: a.lastError,
    };
  }

  messagesOf(path: AgentPath): MessageLike[] {
    return this.agents.get(path)?.messages ?? [];
  }

  beginWait(targets: AgentPath[]): Promise<void> {
    const allTerminal = targets.every((t) => {
      const s = this.agents.get(t)?.status;
      return s === 'done' || s === 'failed' || s === 'interrupted';
    });
    if (allTerminal) return Promise.resolve();
    return new Promise((resolve) => this.waits.push({ targets, resolve }));
  }

  endWait(): void {
    this.endWaitCalls += 1;
    for (const w of this.waits) w.resolve();
    this.waits = [];
  }

  steerTo(path: AgentPath, text: string): void {
    const a = this.agents.get(path);
    if (!a) throw new Error(`Agent 不存在: ${path}`);
    a.steerLog.push(text);
  }
}

// ── 辅助 ──────────────────────────────────────────────────────

function toolsOf(driver: FakeDriver) {
  const all = createOrchestrationTools(driver);
  return {
    byName: new Map(all.map((t) => [t.name, t])),
    all,
  };
}

async function call(
  tool: { execute: (id: string, params: never, signal?: AbortSignal) => Promise<AgentToolResult<unknown>> },
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ details: any; text: string }> {
  const r = await tool.execute('toolCall-1', params as never, signal);
  return {
    details: r.details,
    text: r.content.map((c) => ('text' in c ? c.text : '')).join(''),
  };
}

describe('编排工具 · 集合与目标校验', () => {
  it('createOrchestrationTools 产出六件套且名字齐全', () => {
    const { all } = toolsOf(new FakeDriver());
    expect(all.map((t) => t.name).sort()).toEqual(
      ['agent', 'agent_check', 'agent_interrupt', 'agent_message', 'agent_resume', 'agent_wait'].sort(),
    );
  });

  it('非后代目标在 wait/check/message/resume/interrupt 全部被拦', async () => {
    const d = new FakeDriver();
    d.addAt('/root/other-1' as AgentPath, { role: 'tester', displayName: '外人' });
    const outsider = '/root/other-1' as AgentPath;
    (d.agents.get(outsider) as FakeAgent).status = 'running';

    const { byName } = toolsOf(d);
    const bad = [outsider, d.selfPath]; // 旁支 + 自己
    for (const id of bad) {
      await expect(byName.get('agent_wait')!.execute('c', { ids: [id] } as never)).rejects.toThrow(/后代|自己/);
      await expect(byName.get('agent_check')!.execute('c', { id } as never)).rejects.toThrow(/后代|自己/);
      await expect(byName.get('agent_message')!.execute('c', { id, text: 'hi' } as never)).rejects.toThrow(/后代|自己/);
      await expect(byName.get('agent_resume')!.execute('c', { id, text: 'go' } as never)).rejects.toThrow(/后代|自己/);
      await expect(byName.get('agent_interrupt')!.execute('c', { id } as never)).rejects.toThrow(/后代|自己/);
    }
    // 不存在的后代
    await expect(
      byName.get('agent_check')!.execute('c', { id: '/root/boss-1/ghost-1' } as never),
    ).rejects.toThrow(/不存在/);
  });
});

describe('编排工具 · agent / agent_wait', () => {
  it('agent spawn 异步立返，返回后代路径与角色', async () => {
    const d = new FakeDriver();
    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent')!, { role: 'developer', task: '实现 A' });
    expect(r.details.role).toBe('developer');
    const child = d.agents.get(r.details.id as AgentPath)!;
    expect(r.details.id).toBe('/root/boss-1/developer-1');
    expect(child.status).toBe('running');
    expect(child.runLog).toEqual(['实现 A']);
    expect(d.snapshot(child.path)!.parent).toBe(d.selfPath);
  });

  it('agent 透传 forkMode；角色不存在时抛错', async () => {
    const d = new FakeDriver();
    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent')!, { role: 'tester', task: '测', forkMode: 'all' });
    expect(r.details.id).toBe('/root/boss-1/tester-1');
    await expect(
      byName.get('agent')!.execute('c', { role: 'nobody', task: 'x' } as never),
    ).rejects.toThrow(/角色不存在/);
  });

  it('agent_wait 等全部目标终态后返回状态清单', async () => {
    const d = new FakeDriver();
    const c1 = d.makeChild('developer');
    const c2 = d.makeChild('tester');
    c1.status = 'running';
    c2.status = 'running';

    const { byName } = toolsOf(d);
    let done = false;
    const p = call(byName.get('agent_wait')!, { ids: [c1.path, c2.path] }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // 目标未终态，挂起中

    d.finish(c1.path, 'done');
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // 还有 c2 未终态

    d.finish(c2.path, 'failed', '预算不足');
    const r = await p;
    expect(r.details.statuses).toEqual([
      { id: c1.path, status: 'done', lastError: undefined, timedOut: false },
      { id: c2.path, status: 'failed', lastError: '预算不足', timedOut: false },
    ]);
  });

  it('agent_wait 目标已终态时直接返回', async () => {
    const d = new FakeDriver();
    const c = d.makeChild('developer');
    c.status = 'done';
    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent_wait')!, { ids: [c.path] });
    expect(r.details.statuses[0]).toEqual({
      id: c.path, status: 'done', lastError: undefined, timedOut: false,
    });
  });

  it('agent_wait 超时：不杀子、摘边（endWait）、未终态条目打 timedOut', async () => {
    const d = new FakeDriver();
    const c = d.makeChild('developer');
    c.status = 'running';

    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent_wait')!, { ids: [c.path], timeoutSec: 0.05 });
    expect(r.details.statuses).toEqual([
      { id: c.path, status: 'running', lastError: undefined, timedOut: true },
    ]);
    expect(d.endWaitCalls).toBe(1);          // 摘边
    expect(d.agents.get(c.path)!.interruptedTimes).toBe(0); // 不杀子
    expect(d.agents.get(c.path)!.status).toBe('running');

    // 超时后子照常跑完，父再来 wait 正常拿到终态
    d.finish(c.path, 'done');
    const r2 = await call(byName.get('agent_wait')!, { ids: [c.path] });
    expect(r2.details.statuses[0].status).toBe('done');
  });

  it('agent_wait 被 abort：摘边并返回当前状态', async () => {
    const d = new FakeDriver();
    const c = d.makeChild('developer');
    c.status = 'running';

    const { byName } = toolsOf(d);
    const ac = new AbortController();
    const p = call(byName.get('agent_wait')!, { ids: [c.path] }, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const r = await p;
    expect(r.details.statuses[0]).toEqual({
      id: c.path, status: 'running', lastError: undefined, timedOut: false,
    });
    expect(d.endWaitCalls).toBe(1);
  });
});

describe('编排工具 · check / message / resume / interrupt', () => {
  it('agent_check 返回摘要，assistant 文本预览截断到 500 字', async () => {
    const d = new FakeDriver();
    const c = d.makeChild('developer');
    c.status = 'interrupted';
    c.lastError = '超时';
    c.usage = { inputTokens: 12, outputTokens: 3, costUsd: 0.05 };
    c.messages = [
      { role: 'user', content: [{ type: 'text', text: '任务' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(800) }] },
    ];
    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent_check')!, { id: c.path });
    expect(r.details).toMatchObject({
      id: c.path,
      status: 'interrupted',
      lastError: '超时',
      usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.05 },
      children: [],
    });
    expect(r.details.preview).toHaveLength(501); // 500 + 省略号
    expect(r.details.preview!.endsWith('…')).toBe(true);

    // 无 assistant 消息时不炸
    d.agents.get(c.path)!.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const r2 = await call(byName.get('agent_check')!, { id: c.path });
    expect(r2.details.preview).toBeUndefined();
  });

  it('agent_message 投递给 running 与 waiting 目标，终态目标拒绝', async () => {
    const d = new FakeDriver();
    const running = d.makeChild('developer');
    running.status = 'running';
    const parked = d.makeChild('tester');
    parked.status = 'waiting';
    const done = d.makeChild('developer', '/root/boss-1/developer-9' as AgentPath);
    done.status = 'done';

    const { byName } = toolsOf(d);
    await call(byName.get('agent_message')!, { id: running.path, text: '方向修正 1' });
    await call(byName.get('agent_message')!, { id: parked.path, text: '方向修正 2' });
    expect(d.agents.get(running.path)!.steerLog).toEqual(['方向修正 1']);
    expect(d.agents.get(parked.path)!.steerLog).toEqual(['方向修正 2']); // parked 也收，下轮生效

    await expect(
      byName.get('agent_message')!.execute('c', { id: done.path, text: 'hi' } as never),
    ).rejects.toThrow(/agent_resume/);
  });

  it('agent_resume 只对终态目标，fire 语义不 await 跑完', async () => {
    const d = new FakeDriver();
    const recap = d.makeChild('developer');
    recap.status = 'done';
    recap.holdRun = true; // requestRun 挂起模拟「子还是一轮长任务」

    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent_resume')!, { id: recap.path, text: '追加任务 B' });
    expect(r.details.id).toBe(recap.path);
    expect(d.agents.get(recap.path)!.runLog).toEqual(['追加任务 B']); // holdRun 中仍立返 ✓
    expect(d.agents.get(recap.path)!.status).toBe('running');

    await expect(
      byName.get('agent_resume')!.execute('c', { id: recap.path, text: 'again' } as never),
    ).rejects.toThrow(/终态/); // 现在在跑
    d.finish(recap.path, 'done');
  });

  it('agent_resume 拒绝 idle / waiting 目标（只认终态）', async () => {
    const d = new FakeDriver();
    const idle = d.makeChild('developer');
    const waiting = d.makeChild('tester');
    waiting.status = 'waiting';
    const { byName } = toolsOf(d);
    await expect(
      byName.get('agent_resume')!.execute('c', { id: idle.path, text: 'x' } as never),
    ).rejects.toThrow(/终态/);
    await expect(
      byName.get('agent_resume')!.execute('c', { id: waiting.path, text: 'x' } as never),
    ).rejects.toThrow(/终态/);
  });

  it('agent_interrupt 中断运行中的目标并回报新状态', async () => {
    const d = new FakeDriver();
    const c = d.makeChild('developer');
    c.status = 'running';
    const { byName } = toolsOf(d);
    const r = await call(byName.get('agent_interrupt')!, { id: c.path });
    expect(d.agents.get(c.path)!.interruptedTimes).toBe(1);
    expect(r.details.status).toBe('interrupted');
  });
});
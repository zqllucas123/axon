/**
 * AxonHost M3 编排语义测试 —— parked 队列 / 退位-解挂 / 预算熔断 / 看门狗。
 *
 * 这些测的全是 M3 决策拍板后的新语义：
 *   #2 闸门重构：running-only 计数，waiting 分 parked（排队）与 suspended（父等后代）
 *   #4 预算：软线 warning / 硬线 frozen 拒新起点，不杀在跑
 *   #5 活性：看门狗按空闲计时，wait 超时不杀子（超时路径的 host 语义见 endWait）
 *
 * 确定性来源：scriptedSource —— 回复按「最近一条 user 消息文本」路由，
 * 永不耗尽。故意**不用** faux 的 setResponses 队列：它的消费语义是每轮
 * LLM 调用 shift 一条，多 Agent 交错时会被引擎异步启动竞态打乱配对
 * （这就是本文件第一版全红的原因，经验教训见 M3 里程碑文档）。
 */

import { describe, expect, it } from 'vitest';
import { ROOT_PATH, type EventMap, type RoleDefinition } from '@axon/protocol';
import {
  createFauxSource,
  fauxAssistantMessage,
  lastUserText,
  scriptedSource,
  withTurnCost,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost, type HostOptions } from './host.ts';

const ROLES: RoleDefinition[] = [
  {
    name: 'boss',
    displayName: '主管',
    description: '',
    instructions: '你是主管。',
    defaultForkMode: 'none',
  },
];

interface HarnessOpts {
  maxConcurrent?: number;
  budget?: HostOptions['budget'];
  idleTimeoutMs?: number;
  routes?: Record<string, () => unknown>;
  /** 按最近一条 user 文本计价的成本注水（预算测试用）。 */
  costByText?: Record<string, number>;
}

async function harness(opts: HarnessOpts = {}) {
  const src = await createFauxSource();
  let modelSource: ModelSource = scriptedSource(
    src,
    opts.routes ?? {},
    (text) => fauxAssistantMessage(`${text} 的答复`),
  );
  if (opts.costByText) {
    modelSource = withTurnCost(modelSource, (ctx) => opts.costByText![lastUserText(ctx)] ?? 0);
  }
  const events: { event: keyof EventMap; source: string }[] = [];
  const host = new AxonHost({
    modelSource,
    roles: ROLES,
    emit: (event, _payload, source) => events.push({ event, source }),
    maxConcurrent: opts.maxConcurrent,
    budget: opts.budget,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  return { host, events };
}

/** 一个可控「何时放行」的回复门。 */
function gate(reply: string) {
  let release!: () => void;
  const lock = new Promise<void>((res) => {
    release = () => res();
  });
  return {
    factory: () => lock.then(() => fauxAssistantMessage(reply)),
    release,
  };
}

/** 小轮询辅助（无 sleep 竞态，只等事件驱动的状态落定）。 */
async function viWaitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('viWaitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('M3 闸门：requestRun / parked / drain', () => {
  it('额满时新任务 parked（waiting 排队），空出后 FIFO 补位', async () => {
    const h = await harness({ maxConcurrent: 1 });
    const a = h.host.spawn({ role: 'boss' });
    const b = h.host.spawn({ role: 'boss' });

    const pa = h.host.requestRun(a.path, '任务 A');
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');

    const pb = h.host.requestRun(b.path, '任务 B'); // 额满 → parked
    expect(h.host.get(b.path)?.status).toBe('waiting');

    await pa; // A 完成 → drain → B 补位
    await pb;
    expect(h.host.get(a.path)?.status).toBe('done');
    expect(h.host.get(b.path)?.status).toBe('done');
  });

  it('requestRun 拒绝正在运行与已排队的 Agent（同步抛错）', async () => {
    const h = await harness({ maxConcurrent: 1 });
    const a = h.host.spawn({ role: 'boss' });
    const b = h.host.spawn({ role: 'boss' });
    const pa = h.host.requestRun(a.path, '1');
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');
    expect(() => h.host.requestRun(a.path, '2')).toThrow(/正在运行/);

    h.host.requestRun(b.path, '2'); // b parked
    expect(() => h.host.requestRun(b.path, '3')).toThrow(/排队任务/);
    await pa; // a 结束 → b 补位跑完，队列排空
  });

  it('终态 Agent 可直接追加任务（归位 idle 再启动）', async () => {
    const h = await harness();
    const a = h.host.spawn({ role: 'boss' });
    await h.host.requestRun(a.path, '1');
    expect(h.host.get(a.path)?.status).toBe('done');
    await h.host.requestRun(a.path, '追加'); // done → idle → running → done
    expect(h.host.get(a.path)?.status).toBe('done');
  });
});

describe('M3 wait：退位-解挂', () => {
  it('父等子时退位让额，子终态解挂父并归还额度', async () => {
    const gc = gate('子的答复');
    const gp = gate('父的答复');
    const h = await harness({
      maxConcurrent: 2,
      routes: { 子任务: gc.factory, 父任务: gp.factory },
    });

    const parent = h.host.spawn({ role: 'boss' });
    const child = h.host.spawn({ role: 'boss', parent: parent.path });

    void h.host.requestRun(child.path, '子任务');
    await viWaitFor(() => h.host.get(child.path)?.status === 'running');

    const parentRun = h.host.requestRun(parent.path, '父任务');
    await viWaitFor(() => h.host.get(parent.path)?.status === 'running');

    const waitP = h.host.beginWait(parent.path, [child.path]);
    expect(h.host.get(parent.path)?.status).toBe('waiting'); // 退位让出额度

    gc.release(); // 子完成 → drain 解挂父
    await waitP;
    await viWaitFor(() => h.host.get(parent.path)?.status === 'running');

    gp.release();
    await parentRun;
    expect(h.host.get(parent.path)?.status).toBe('done');
    expect(h.host.get(child.path)?.status).toBe('done');
  });

  it('等待的目标已终态时直接 resolve，不挂起', async () => {
    const h = await harness();
    const parent = h.host.spawn({ role: 'boss' });
    const child = h.host.spawn({ role: 'boss', parent: parent.path });
    await h.host.requestRun(child.path, 't');
    expect(h.host.get(child.path)?.status).toBe('done');

    await h.host.beginWait(parent.path, [child.path]); // 立即 resolve
    expect(h.host.get(parent.path)?.status).toBe('idle'); // 未挂起过
  });

  it('endWait（超时/中断路径）把 suspended 父恢复 running', async () => {
    const gp = gate('父答复');
    const h = await harness({ routes: { 父任务: gp.factory } });

    const parent = h.host.spawn({ role: 'boss' });
    const child = h.host.spawn({ role: 'boss', parent: parent.path });

    const parentRun = h.host.requestRun(parent.path, '父任务');
    await viWaitFor(() => h.host.get(parent.path)?.status === 'running');

    void h.host.beginWait(parent.path, [child.path]); // 子一直 idle 未终态
    expect(h.host.get(parent.path)?.status).toBe('waiting');

    h.host.endWait(parent.path); // 模拟 wait 工具超时后的 finally
    expect(h.host.get(parent.path)?.status).toBe('running');

    gp.release();
    await parentRun;
  });

  it('parked 中的子被 beginWait 的退位腾出的额度补位（核心无死锁场景）', async () => {
    const gp = gate('父答复');
    const h = await harness({ maxConcurrent: 1, routes: { 父任务: gp.factory } });

    const parent = h.host.spawn({ role: 'boss' });
    const child = h.host.spawn({ role: 'boss', parent: parent.path });

    const parentRun = h.host.requestRun(parent.path, '父任务'); // 父占满唯一额度
    await viWaitFor(() => h.host.get(parent.path)?.status === 'running');
    const childRun = h.host.requestRun(child.path, '子任务'); // parked
    expect(h.host.get(child.path)?.status).toBe('waiting');

    // 父等子 → 退位 → drain 立刻补位 parked 的子
    const waitP = h.host.beginWait(parent.path, [child.path]);
    await viWaitFor(() => h.host.get(child.path)?.status === 'running');
    expect(h.host.get(parent.path)?.status).toBe('waiting');

    // 子完成 → 解挂父
    await viWaitFor(() => h.host.get(child.path)?.status === 'done');
    await waitP;
    await viWaitFor(() => h.host.get(parent.path)?.status === 'running');

    gp.release();
    await parentRun;
    await childRun;
    expect(h.host.get(child.path)?.status).toBe('done');
  });
});

describe('M3 预算熔断', () => {
  it('越软线发 warning、越硬线发 frozen，且只挡新起点', async () => {
    const h = await harness({
      budget: { hardUsd: 0.02 },
      costByText: { 1: 0.018, 2: 0.03 },
    });
    const a = h.host.spawn({ role: 'boss' });

    await h.host.requestRun(a.path, '1'); // 0.018 ≥ 0.016 软线
    expect(h.events.filter((e) => e.event === 'budget.warning')).toHaveLength(1);
    expect(h.events.some((e) => e.event === 'budget.frozen')).toBe(false);

    await h.host.requestRun(a.path, '2'); // 累计 0.048 ≥ 0.02 硬线
    expect(h.events.some((e) => e.event === 'budget.frozen')).toBe(true);
    expect(h.host.budgetState()).toBe('frozen');

    // 只挡新起点：spawn / requestRun 都拒绝
    expect(() => h.host.spawn({ role: 'boss' })).toThrow(/预算已冻结/);
    expect(() => h.host.requestRun(a.path, '3')).toThrow(/预算已冻结/);
  });

  it('硬线冻结不杀在跑 Agent（撞线由他人完成，在跑者继续到收尾）', async () => {
    const gb = gate('B 的长活');
    const h = await harness({
      budget: { hardUsd: 0.01 },
      costByText: { 撞线: 0.02 },
      routes: { 'B 长活': gb.factory },
    });

    const a = h.host.spawn({ role: 'boss' });
    const b = h.host.spawn({ role: 'boss' });

    const pb = h.host.requestRun(b.path, 'B 长活'); // B 先开跑（gate 挂着 = 长任务中）
    await viWaitFor(() => h.host.get(b.path)?.status === 'running');

    await h.host.requestRun(a.path, '撞线'); // A 一轮就撞穿硬线 → frozen
    expect(h.host.budgetState()).toBe('frozen');
    expect(h.events.some((e) => e.event === 'budget.frozen')).toBe(true);
    expect(h.host.get(b.path)?.status).toBe('running'); // 在跑者不受影响

    // frozen 只挡新起点
    expect(() => h.host.spawn({ role: 'boss' })).toThrow(/预算已冻结/);

    gb.release(); // B 收尾自然完成
    await pb;
    expect(h.host.get(b.path)?.status).toBe('done');
  });
});

describe('M3 idle 看门狗', () => {
  it('running 且超时无任何事件 → 中断（按空闲计时，不按总时长）', async () => {
    const g = gate('很慢');
    const h = await harness({ idleTimeoutMs: 100, routes: { 慢活: g.factory } });
    const a = h.host.spawn({ role: 'boss' });

    const pa = h.host.requestRun(a.path, '慢活');
    void pa.catch(() => undefined); // 中断后 requestRun 的 Promise 走异常路径
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');

    // 真空闲 100ms 后看门狗 interrupt
    await viWaitFor(() => h.host.get(a.path)?.status === 'interrupted', 2000);
    expect(h.host.get(ROOT_PATH)!.children.length).toBe(1);
  });
});
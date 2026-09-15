/**
 * AxonHost M4 协作账本与审批穿透 —— 宿主装配层的集成测试。
 *
 * 与 orchestrator.test.ts 的分工：那边用 FakeDriver 钉「工具层自己的语义」
 * （哪个工具落什么动作），这边跑**真引擎**，钉宿主把它们接起来之后的行为：
 *   - 落账 → 目标终态 → 自动结算（usage 增量 + 摘要）
 *   - 删除目标时结算，不留悬空 open 记录
 *   - AutoAdoption 的派发、资格校验、幂等
 *   - HITL 门接进 onBeforeTool 后的真实挂起/放行
 *   - 预算事件的 spent 与 limits 是两个不同的数（MX G9.1 回归）
 *
 * 确定性来源同 M3：scriptedSource 按「最近一条 user 文本」路由，永不耗尽。
 */

import { describe, expect, it } from 'vitest';
import {
  sessionIdOfPath,
  type AgentPath,
  type EventMap,
  type LedgerRecord,
  type RoleDefinition,
  type SpawnAgentPayload,
} from '@axon/protocol';
import {
  Type,
  createFauxSource,
  fauxAssistantMessage,
  fauxToolCall,
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
    approval: 'auto',
  },
  {
    name: 'worker',
    displayName: '工人',
    description: '',
    instructions: '你是工人。',
    defaultForkMode: 'none',
    approval: 'auto',
  },
  {
    name: 'aligner',
    displayName: '对齐者',
    description: '',
    instructions: '你负责裁决。',
    defaultForkMode: 'none',
    approval: 'auto',
  },
  {
    name: 'cautious',
    displayName: '谨慎者',
    description: '',
    instructions: '你动手前要问人。',
    defaultForkMode: 'none',
    approval: 'always_ask',
  },
];

interface Rec {
  event: keyof EventMap;
  payload: unknown;
  source: AgentPath | undefined;
}

interface HarnessOpts {
  routes?: Record<string, (ctx: Record<string, unknown>, callIndex: number) => unknown>;
  costByText?: Record<string, number>;
  budget?: HostOptions['budget'];
  adoptionPolicy?: HostOptions['adoptionPolicy'];
  approvalTimeoutMs?: number;
  tools?: unknown[];
}

async function harness(opts: HarnessOpts = {}) {
  const src = await createFauxSource();
  let modelSource: ModelSource = scriptedSource(src, opts.routes ?? {}, (text) =>
    fauxAssistantMessage(`${text} 的答复`),
  );
  if (opts.costByText) {
    modelSource = withTurnCost(modelSource, (ctx) => opts.costByText![lastUserText(ctx)] ?? 0);
  }
  const events: Rec[] = [];
  const host = new AxonHost({
    modelSource,
    roles: ROLES,
    tools: opts.tools,
    emit: (event, payload, source) => events.push({ event, payload, source }),
    budget: opts.budget,
    adoptionPolicy: opts.adoptionPolicy,
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 0,
    idleTimeoutMs: 0,
  });
  // MU-1：先开会话 —— 多根下没有「总是存在的根」，账本也以会话为主键。
  const root = host.createSession({ title: '测试会话', executor: 'engine' }).rootPath;
  return {
    host,
    root,
    spawn: (spec: Omit<SpawnAgentPayload, 'parent'> & { parent?: AgentPath }) =>
      host.spawn({ parent: root, ...spec }),
    events,
    ledgerEvents: () =>
      events.filter((e) => e.event === 'ledger.recorded' || e.event === 'ledger.updated'),
    records: () => host.queryLedger({}).records,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 让 agent 在收到某句话时 spawn 一个子 agent，**仅第一轮**。
 *
 * callIndex 卫兵不能省：工具返回后引擎会拿同一句 user 文本再要一轮，
 * 无卫兵则无限 spawn（这正是本文件第一版挂死的原因）。
 * stopReason 也不能省：否则引擎不认为这一轮是工具调用。
 */
function spawnScript(role: string, task: string, forkMode?: string) {
  return (_ctx: unknown, callIndex: number) =>
    callIndex === 0
      ? fauxAssistantMessage(
          [fauxToolCall('agent', forkMode ? { role, task, forkMode } : { role, task })],
          { stopReason: 'toolUse' },
        )
      : fauxAssistantMessage('已安排完毕');
}

/** 单次叶子工具调用脚本（同样需要 callIndex 卫兵）。 */
function leafCallScript(tool: string) {
  return (_ctx: unknown, callIndex: number) =>
    callIndex === 0
      ? fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage('收工');
}

describe('M4 落账：delegate 的完整生命周期', () => {
  it('spawn → open/pending → 子终态 → settled（带 usage 增量与摘要）', async () => {
    const h = await harness({
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('干完了') },
      costByText: { 干活: 0.02 },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');

    const child = `${h.root}/boss-1/worker-1` as AgentPath;
    await waitFor(() => h.host.get(child)?.status === 'done');
    await waitFor(() => h.records()[0]?.status === 'settled');

    const r = h.records()[0]!;
    expect(r.action).toBe('delegate');
    expect(r.from).toBe(boss.path);
    expect(r.to).toBe(child);
    expect(r.mention).toBe(`mention://agent-session${child}`);
    expect(r.adoption).toBe('pending');
    expect(r.summary).toBe('干完了');
    expect(r.usage?.costUsd).toBeCloseTo(0.02, 6);
  });

  it('落账与结算各发一次事件，UI 按 id upsert 即可', async () => {
    const h = await harness({
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.status === 'settled');

    const evs = h.ledgerEvents();
    expect(evs.filter((e) => e.event === 'ledger.recorded')).toHaveLength(1);
    expect(evs.filter((e) => e.event === 'ledger.updated')).toHaveLength(1);
    const ids = new Set(evs.map((e) => (e.payload as { record: LedgerRecord }).record.id));
    expect(ids.size).toBe(1);
  });

  it('forkMode=all ⇒ 记 fork，且 adoption 直接 not_applicable（无需裁决）', async () => {
    const h = await harness({
      routes: {
        派活: spawnScript('worker', '干活', 'all'),
        干活: () => fauxAssistantMessage('ok'),
      },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records().length === 1);

    const r = h.records()[0]!;
    expect(r.action).toBe('fork');
    expect(r.adoption).toBe('not_applicable');
    expect(r.contextScope).toBe('all');
  });

  it('快照带 forkMode / sessionId —— 与账本 contextScope 同源（MX G4.1/G4.4）', async () => {
    const h = await harness();
    const boss = h.spawn({ role: 'boss', forkMode: '3' });
    // MU-1：sessionId 从「自己的路径」变成了**会话主键**（账本/审批/用量都按它切片）。
    // 还是「与账本同源」那个意思，只是那把钥匙换成了会话 id。
    expect(boss.sessionId).toBe(sessionIdOfPath(h.root));
    expect(boss.sessionId).toBe(h.host.get(h.root)!.sessionId);
    expect(boss.forkMode).toBe('3');
  });
});

describe('M4 结算的边界情况', () => {
  it('目标被删时结算，不留悬空 open 记录', async () => {
    const gateLock = new Promise<never>(() => {});
    const h = await harness({
      routes: { 派活: spawnScript('worker', '慢活'), 慢活: () => gateLock },
    });
    const boss = h.spawn({ role: 'boss' });
    void h.host.requestRun(boss.path, '派活');
    const child = `${h.root}/boss-1/worker-1` as AgentPath;
    await waitFor(() => h.records().length === 1);
    expect(h.records()[0]!.status).toBe('open');

    h.host.remove(child);
    expect(h.records()[0]!.status).toBe('settled');
    expect(h.records()[0]!.summary).toBe('目标已被删除');
  });

  it('同一目标的多笔 open 记录一次全结算', async () => {
    const h = await harness({
      routes: {
        派活: spawnScript('worker', '干活'),
        干活: () => fauxAssistantMessage('第一轮'),
        再干: () => fauxAssistantMessage('第二轮'),
      },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records().every((r) => r.status === 'settled'));
    expect(h.records()).toHaveLength(1);
  });

  it('ledger.query 支持子树过滤与按 adoption 过滤', async () => {
    const h = await harness({
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records().length === 1);

    expect(h.host.queryLedger({ agent: boss.path, subtree: true }).total).toBe(1);
    expect(h.host.queryLedger({ agent: `${h.root}/nobody-9`, subtree: true }).total).toBe(0);
    expect(h.host.queryLedger({ adoption: ['pending'] }).total).toBe(1);
    expect(h.host.queryLedger({ adoption: ['adopted'] }).total).toBe(0);
  });
});

describe('M4 裁决：人工（默认）', () => {
  it('ledger.adopt 写入 human 署名并广播 ledger.updated', async () => {
    const h = await harness({
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.status === 'settled');

    const id = h.records()[0]!.id;
    const before = h.ledgerEvents().length;
    const r = h.host.adoptByHuman(id, 'adopted', '结论可用');

    expect(r.adoption).toBe('adopted');
    expect(r.adoptedBy).toEqual({ kind: 'human' });
    expect(r.adoptedNote).toBe('结论可用');
    expect(h.ledgerEvents().length).toBe(before + 1);
  });

  it('默认策略下不会向任何 Agent 派发裁决请求', async () => {
    const h = await harness({
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.status === 'settled');

    expect(h.host.getAdoptionPolicy()).toEqual({ mode: 'human' });
    expect(h.host.list().map((a) => a.path)).toEqual([
      h.root,
      `${h.root}/boss-1`,
      `${h.root}/boss-1/worker-1`,
    ]);
  });

  it('裁决不存在的记录抛错', async () => {
    const h = await harness();
    expect(() => h.host.adoptByHuman('nope', 'adopted')).toThrow(/不存在/);
  });
});

describe('M4 裁决：AutoAdoption 委派（决策 D2）', () => {
  it('结算后向 arbiter 投递裁决请求，arbiter 用 ledger_adopt 表态并留 agent 署名', async () => {
    const h = await harness({
      adoptionPolicy: { mode: 'delegate', arbiterRole: 'aligner' },
      routes: {
        派活: spawnScript('worker', '干活'),
        干活: () => fauxAssistantMessage('干完了'),
      },
    });
    const aligner = h.spawn({ role: 'aligner' });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.status === 'settled');

    // 裁决请求以 prompt 形式投给 aligner
    await waitFor(() =>
      h.host.messagesOf(aligner.path).some((m) =>
        m.content?.some((b) => b.type === 'text' && String(b.text).includes('[协作裁决]')),
      ),
    );
    const prompt = h.host
      .messagesOf(aligner.path)
      .flatMap((m) => (m.content ?? []).map((b) => (b.type === 'text' ? String(b.text) : '')))
      .find((t) => t.includes('[协作裁决]'))!;
    expect(prompt).toContain(h.records()[0]!.id);
    expect(prompt).toContain('干完了');
  });

  it('arbiter 是被裁决方 ⇒ 回落人工，原因写进账，记录保持 pending', async () => {
    const h = await harness({
      adoptionPolicy: { mode: 'delegate', arbiterRole: 'worker' },
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.status === 'settled');
    await waitFor(() => h.records()[0]?.adoptedNote !== undefined);

    const r = h.records()[0]!;
    expect(r.adoption).toBe('pending');
    expect(r.adoptedNote).toMatch(/被裁决方/);
    expect(r.adoptedBy).toBeUndefined();
  });

  it('arbiter 角色无实例 ⇒ 回落人工并写明原因', async () => {
    const h = await harness({
      adoptionPolicy: { mode: 'delegate', arbiterRole: 'aligner' },
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.adoptedNote !== undefined);
    expect(h.records()[0]!.adoptedNote).toMatch(/找不到角色/);
  });

  it('fork/handoff 不触发裁决请求（它们无需裁决）', async () => {
    const h = await harness({
      adoptionPolicy: { mode: 'delegate', arbiterRole: 'aligner' },
      routes: {
        派活: spawnScript('worker', '干活', 'all'),
        干活: () => fauxAssistantMessage('ok'),
      },
    });
    const aligner = h.spawn({ role: 'aligner' });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '派活');
    await waitFor(() => h.records()[0]?.status === 'settled');

    expect(h.records()[0]!.adoption).toBe('not_applicable');
    expect(h.host.messagesOf(aligner.path)).toHaveLength(0);
  });

  it('setAdoptionPolicy 广播 policyChanged 并即时生效', async () => {
    const h = await harness();
    expect(h.host.getAdoptionPolicy()).toEqual({ mode: 'human' });
    const next = { mode: 'delegate', arbiterRole: 'aligner' } as const;
    expect(h.host.setAdoptionPolicy(next)).toEqual(next);
    expect(h.host.getAdoptionPolicy()).toEqual(next);
    expect(h.events.some((e) => e.event === 'ledger.policyChanged')).toBe(true);
  });
});

describe('M4 审批穿透接线', () => {
  /** 一个会被 HITL 门拦住的叶子工具。 */
  function leafTool(calls: string[]) {
    return {
      name: 'danger',
      description: 'danger',
      parameters: Type.Object({}),
      execute: async () => {
        calls.push('danger');
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    };
  }

  it('always_ask 角色调叶子工具 ⇒ 挂起等人批；批准后工具才执行', async () => {
    const calls: string[] = [];
    const h = await harness({
      tools: [leafTool(calls)],
      routes: {
        动手: leafCallScript('danger'),
      },
    });
    const agent = h.spawn({ role: 'cautious' });
    void h.host.requestRun(agent.path, '动手');

    await waitFor(() => h.host.listPending().length === 1);
    expect(calls).toHaveLength(0);

    const req = h.host.listPending()[0]!;
    expect(req.origin).toBe(agent.path);
    expect(req.chain).toEqual([agent.path, h.root]);
    expect(req.tool).toBe('danger');
    expect(req.approvalMode).toBe('always_ask');

    h.host.respondApproval(req.requestId, true);
    await waitFor(() => calls.length === 1);
    expect(h.host.listPending()).toHaveLength(0);
  });

  it('拒绝时工具不执行，原因回灌给模型', async () => {
    const calls: string[] = [];
    const h = await harness({
      tools: [leafTool(calls)],
      routes: {
        动手: leafCallScript('danger'),
      },
    });
    const agent = h.spawn({ role: 'cautious' });
    void h.host.requestRun(agent.path, '动手');
    await waitFor(() => h.host.listPending().length === 1);
    h.host.respondApproval(h.host.listPending()[0]!.requestId, false, '太危险');

    await waitFor(() =>
      h.host
        .messagesOf(agent.path)
        .some((m) => m.role === 'toolResult' && JSON.stringify(m).includes('太危险')),
    );
    expect(calls).toHaveLength(0);
  });

  it('父档为 auto ⇒ 父代批，人完全不被惊动', async () => {
    const calls: string[] = [];
    const h = await harness({
      tools: [leafTool(calls)],
      routes: {
        动手: leafCallScript('danger'),
      },
    });
    const boss = h.spawn({ role: 'boss' }); // approval: auto
    const child = h.spawn({ role: 'cautious', parent: boss.path });
    await h.host.requestRun(child.path, '动手');

    expect(calls).toEqual(['danger']);
    expect(h.host.listPending()).toHaveLength(0);
    expect(h.events.some((e) => e.event === 'approval.request')).toBe(false);
  });

  it('编排工具豁免 HITL 门（D5）—— 否则 always_ask 角色一 spawn 就卡死', async () => {
    const h = await harness({
      routes: { 派活: spawnScript('worker', '干活'), 干活: () => fauxAssistantMessage('ok') },
    });
    const agent = h.spawn({ role: 'cautious' });
    await h.host.requestRun(agent.path, '派活');
    expect(h.host.listPending()).toHaveLength(0);
    expect(h.host.get(`${h.root}/cautious-1/worker-1`)).not.toBeNull();
  });

  it('白名单拦截优先于 HITL —— 未获授权的工具不该惊动人', async () => {
    const calls: string[] = [];
    const h = await harness({
      tools: [leafTool(calls)],
      routes: {
        动手: leafCallScript('danger'),
      },
    });
    // 把 cautious 改成空白名单：它既是 always_ask（会惊动人）
    // 又没有 danger 的授权（应该被白名单先拦下）。
    h.host.updateRoles(
      [{ role: { ...ROLES[3]!, tools: [] }, source: 'builtin', errors: [] }],
      [],
    );
    const restricted = h.spawn({ role: 'cautious' });
    await h.host.requestRun(restricted.path, '动手');

    expect(calls).toHaveLength(0);
    // 关键断言：没有任何审批请求——未获授权的工具不该拿去烦人
    expect(h.host.listPending()).toHaveLength(0);
    expect(h.events.some((e) => e.event === 'approval.request')).toBe(false);
  });

  it('agent 被删 ⇒ 其挂起审批一并作废，收件箱不留幽灵', async () => {
    const calls: string[] = [];
    const h = await harness({
      tools: [leafTool(calls)],
      routes: {
        动手: leafCallScript('danger'),
      },
    });
    const agent = h.spawn({ role: 'cautious' });
    void h.host.requestRun(agent.path, '动手');
    await waitFor(() => h.host.listPending().length === 1);

    h.host.remove(agent.path);
    expect(h.host.listPending()).toHaveLength(0);
  });
});

describe('M4 预算修订（MX G9.1 回归）', () => {
  it('事件里的 spentUsd 与 hardUsd 是两个不同的数', async () => {
    const h = await harness({
      budget: { hardUsd: 1, softUsd: 0.1 },
      costByText: { 烧钱: 0.5 },
      routes: { 烧钱: () => fauxAssistantMessage('花完了') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '烧钱');

    const warn = h.events.find((e) => e.event === 'budget.warning')!
      .payload as EventMap['budget.warning'];
    expect(warn.spentUsd).toBeCloseTo(0.5, 6);
    expect(warn.hardUsd).toBe(1);
    expect(warn.softUsd).toBe(0.1);
    expect(warn.spentUsd).not.toBe(warn.hardUsd);
  });

  it('budget.get 可随时拉档位 —— frozen 是终态，UI 刷新后靠它恢复', async () => {
    const h = await harness({
      budget: { hardUsd: 0.3 },
      costByText: { 烧钱: 0.5 },
      routes: { 烧钱: () => fauxAssistantMessage('花完了') },
    });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '烧钱');

    const snap = h.host.budgetSnapshot();
    expect(snap.state).toBe('frozen');
    expect(snap.spentUsd).toBeCloseTo(0.5, 6);
    expect(snap.hardUsd).toBe(0.3);
    expect(snap.disabled).toBe(false);
  });

  it('熔断关闭时 disabled=true 且永不跃迁', async () => {
    const h = await harness({ budget: { hardUsd: 0 }, costByText: { 烧钱: 99 },
      routes: { 烧钱: () => fauxAssistantMessage('花完了') } });
    const boss = h.spawn({ role: 'boss' });
    await h.host.requestRun(boss.path, '烧钱');
    expect(h.host.budgetSnapshot().disabled).toBe(true);
    expect(h.host.budgetSnapshot().state).toBe('ok');
  });
});

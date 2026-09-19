/**
 * AxonHost 会话层集成测试（MU-1 §八「集成」）。
 *
 * 覆盖四件事，每件都对应一条本里程碑的设计决定：
 *  1. 三种执行方式（engine / team / adhoc）都落到**同一棵以会话为根的树**上；
 *  2. escalate 换的是引擎不是会话（transcript 能留住）；
 *  3. 会话级并发闸门与「父等子退位让额」在限 1 下不死锁；
 *  4. 三层预算的 scope 与代批留痕（修②）真的会播事件。
 *
 * 用 scriptedSource 而不是 faux 的响应队列：后者按 LLM 调用顺序 shift，
 * 多 Agent 交错时会被引擎的异步启动竞态打乱配对（M3 的教训，见
 * host.orchestration.test.ts 头注）。
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_MEMBER_MAX,
  SESSION_TITLE_MAX,
  type AgentPath,
  type EventMap,
  type RoleDefinition,
  type SpawnAgentPayload,
  type TeamDefinition,
  type TeamEntry,
} from '@axon/protocol';
import {
  createFauxSource,
  fauxAssistantMessage,
  fauxToolCall,
  lastUserText,
  scriptedSource,
  withTurnCost,
  Type,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost, type HostOptions } from './host.ts';
import { ALL_ROLES } from './roles.ts';
import { BUILTIN_TEAMS } from './teams.ts';

/**
 * 测试角色：两个能碰假工具的档位。
 *
 * 工具的**名字**必须真在角色白名单里 —— 否则白名单先拦（它优先于 HITL），
 * 审批门永远不会被触发，测试会以「没有事件」的形式假通过。
 */
const TEST_ROLES: RoleDefinition[] = [
  {
    name: 'boss',
    displayName: '主管',
    description: '',
    instructions: '你是主管。',
    tools: ['peek', 'poke'],
    approval: 'auto',
    defaultForkMode: 'none',
  },
  {
    name: 'worker',
    displayName: '干活的',
    description: '',
    instructions: '你干活。',
    tools: ['poke'],
    approval: 'always_ask',
    defaultForkMode: 'none',
  },
];

function makeTools(calls: string[]) {
  const mk = (name: string) => ({
    name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => {
      calls.push(name);
      return { content: [{ type: 'text' as const, text: `${name} ok` }] };
    },
  });
  return [mk('peek'), mk('poke')];
}

interface Emitted {
  event: keyof EventMap;
  payload: unknown;
  source: AgentPath | undefined;
}

interface HarnessOpts {
  budget?: HostOptions['budget'];
  maxConcurrent?: number;
  costByText?: Record<string, number>;
  routes?: Record<string, () => unknown>;
}

interface Harness {
  host: AxonHost;
  events: Emitted[];
  calls: string[];
  teams: TeamEntry[];
  spawn: (spec: Omit<SpawnAgentPayload, 'parent'> & { parent?: AgentPath }) => ReturnType<
    AxonHost['spawn']
  >;
  /** 某事件的全部载荷（按顺序）。 */
  payloads: <E extends keyof EventMap>(event: E) => EventMap[E][];
}

async function harness(opts: HarnessOpts = {}): Promise<Harness> {
  const src = await createFauxSource();
  let modelSource: ModelSource = scriptedSource(
    src,
    opts.routes ?? {},
    (text) => fauxAssistantMessage(`${text} 的答复`),
  );
  if (opts.costByText) {
    modelSource = withTurnCost(modelSource, (ctx) => opts.costByText![lastUserText(ctx)] ?? 0);
  }
  const events: Emitted[] = [];
  const calls: string[] = [];
  const host = new AxonHost({
    modelSource,
    roles: [...ALL_ROLES, ...TEST_ROLES],
    tools: makeTools(calls),
    emit: (event, payload, source) => events.push({ event, payload, source }),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
  });
  const teams: TeamEntry[] = BUILTIN_TEAMS.map((team: TeamDefinition) => ({
    team,
    source: 'builtin',
    errors: [],
  }));
  host.updateTeams(teams, []);
  return {
    host,
    events,
    calls,
    teams,
    spawn: (spec) => host.spawn(spec as SpawnAgentPayload),
    payloads: <E extends keyof EventMap>(event: E) =>
      events.filter((e) => e.event === event).map((e) => e.payload as EventMap[E]),
  };
}

/** 小轮询辅助（只等事件驱动的状态落定，不睡固定时间）。 */
async function viWaitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('viWaitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─────────────────────────────────────────────────────────────
// 一、三种执行方式
// ─────────────────────────────────────────────────────────────

describe('session.create · 三种执行方式', () => {
  it('engine：会话根就是全部（没有子节点），团队引用缺省', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '改个错别字', executor: 'engine' });

    expect(s.rootPath).toBe(`/${s.record.id}`);
    expect(s.record.executor).toBe('engine');
    expect(s.record.teamId).toBeUndefined();
    expect(s.counts.members).toBe(0);
    expect(s.status).toBe('idle');
    expect(s.team).toBeUndefined();
    // 树里只有根
    expect(h.host.list().map((a) => a.path)).toEqual([s.rootPath]);
  });

  it('engine：根拿不到编排工具 —— 模型喊 agent 也建不出人（一个人管一支不存在的队伍是幻觉）', async () => {
    // 路由要**有状态**：脚本化源按「最近一条 user 文本」配对，若永远返回同一个
    // 工具调用，引擎会在「调工具 → 失败 → 再问模型」之间无限转（踩过一次）。
    let n = 0;
    const h = await harness({
      routes: {
        单兵派活: () =>
          n++ === 0
            ? fauxAssistantMessage([fauxToolCall('agent', { role: 'developer', task: '子任务' })], {
                stopReason: 'toolUse',
              })
            : fauxAssistantMessage('好，我自己来。'),
      },
    });
    const s = h.host.createSession({ title: '单兵', executor: 'engine' });
    await h.host.prompt(s.rootPath, '单兵派活').catch(() => undefined);

    // 引擎的工具表里没有 agent 这一件 —— 树不会长出新节点，也不会有 delegate 账
    expect(h.host.list().map((a) => a.path)).toEqual([s.rootPath]);
    expect(h.host.queryLedger({ sessionId: s.record.id }).records).toEqual([]);
  });

  it('team：主控的 agent 工具真的能派人（编排工具按会话形状发放）', async () => {
    let n = 0;
    const h = await harness({
      routes: {
        分派: () =>
          n++ === 0
            ? fauxAssistantMessage([fauxToolCall('agent', { role: 'developer', task: '写实现' })], {
                stopReason: 'toolUse',
              })
            : fauxAssistantMessage('已派人，等它回话。'),
      },
    });
    const s = h.host.createSession({ title: '组队', executor: 'team', teamId: '测试双人' });
    await h.host.prompt(s.rootPath, '分派');
    await viWaitFor(() => h.host.list().length === 4); // 根 + 2 名成员 + 主控派的那位

    // 派活落了 delegate 账，且带本会话 id
    const records = h.host.queryLedger({ sessionId: s.record.id }).records;
    expect(records.some((r) => r.action === 'delegate' && r.from === s.rootPath)).toBe(true);
  });

  it('team：整队实例化到会话根下，成员带 sessionId，根拿编排工具', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '跨层改动', executor: 'team', teamId: '全栈小队' });

    // 全栈小队 4 人：主控是根，其余 3 个是成员
    expect(s.counts.members).toBe(3);
    expect(s.team).toMatchObject({ id: '全栈小队', memberCount: 4 });
    expect(s.record.maxConcurrent).toBe(3); // 团队闸门已实例化到会话

    const paths = h.host.list().map((a) => a.path);
    expect(paths).toHaveLength(4);
    expect(paths).toContain(s.rootPath); // 根就是 /<sessionId>（没有尾段）
    for (const p of paths) {
      expect(p === s.rootPath || p.startsWith(`/${s.record.id}/`)).toBe(true);
      expect(h.host.get(p)?.sessionId).toBe(s.record.id);
    }
    // 星形编队：成员都挂在根下
    const members = paths.filter((p) => p !== s.rootPath);
    for (const p of members) expect(h.host.get(p)?.parent).toBe(s.rootPath);

    // 主控的引擎拿到了编排工具（roster 已注入）
    expect(h.host.orchestrationToolsFor(s.rootPath).map((t) => t.name).length).toBeGreaterThan(0);
  });

  it('team：会话根是 lead 角色（权限交集链的上限）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: 't', executor: 'team', teamId: '测试双人' });
    expect(h.host.get(s.rootPath)?.role).toBe('lead');
  });

  it('adhoc：临时编队走同一条实例化路径，成员表进记录', async () => {
    const h = await harness();
    const members = [
      { role: 'lead', task: '先拆解' },
      { role: 'developer', name: '后端' },
    ];
    const s = h.host.createSession({ title: '临时组队', executor: 'adhoc', members });

    expect(s.counts.members).toBe(1);
    expect(s.record.executor).toBe('adhoc');
    expect(s.record.members).toEqual(members);
    // 临时编队的第一个成员按约定叫「主控」（不落盘，名字来自 adhocTeam）
    expect(h.host.list().map((a) => a.displayName).sort()).toEqual(['主控', '后端']);
    expect(h.host.get(h.host.list()[0]!.path)?.role).toBe('lead');
  });

  it('缺 teamId / 团队不存在 / 成员数越界 / 空标题都会被拦', async () => {
    const h = await harness();
    expect(() => h.host.createSession({ title: 'x', executor: 'team' })).toThrow(/teamId/);
    expect(() => h.host.createSession({ title: 'x', executor: 'team', teamId: '幽灵' })).toThrow(
      /团队不存在/,
    );
    expect(() =>
      h.host.createSession({ title: 'x', executor: 'adhoc', members: [{ role: 'lead' }] }),
    ).toThrow(new RegExp(`2~${SESSION_MEMBER_MAX}`));
    expect(() => h.host.createSession({ title: '', executor: 'engine' })).toThrow(/标题不能为空/);
  });

  it('项目会话：以项目工作空间为 cwd 并固化 projectId；无效项目报错', async () => {
    const h = await harness();
    h.host.setProjectCwdResolver((id) => (id === 'p-1' ? '/works/proj-1' : undefined));

    // 传 projectId：cwd 用项目工作空间，即便同时传了别的 cwd 也以项目为准。
    const s = h.host.createSession({
      title: '项目里干活',
      executor: 'engine',
      projectId: 'p-1',
      cwd: '/somewhere/else',
    });
    expect(s.record.projectId).toBe('p-1');
    expect(s.record.cwd).toBe('/works/proj-1');

    // 无效项目：拒绝创建（不静默落到默认目录）。
    expect(() =>
      h.host.createSession({ title: 'x', executor: 'engine', projectId: 'p-ghost' }),
    ).toThrow(/项目不存在/);

    // 不传 projectId：保持原行为（无归属、走默认 cwd）。
    const free = h.host.createSession({ title: '自由会话', executor: 'engine', cwd: '/free' });
    expect(free.record.projectId).toBeUndefined();
    expect(free.record.cwd).toBe('/free');
  });

  it('标题从首条任务截断（S0 的「例如：把 apps/api 的…」）', async () => {
    const h = await harness();
    const long = '把 apps/api 的支付回调改成幂等。'.repeat(10);
    const s = h.host.createSession({ title: long, executor: 'engine' });
    expect(s.record.title.length).toBe(SESSION_TITLE_MAX + 1);
    expect(s.record.title.endsWith('…')).toBe(true);
  });

  it('initialPrompt 立即交给会话根（不 await：建会话是下单不是等交付）', async () => {
    const h = await harness();
    const s = h.host.createSession({
      title: '带任务',
      executor: 'engine',
      initialPrompt: '干活',
    });
    await viWaitFor(() => h.host.get(s.rootPath)?.status === 'done');
    expect(h.host.messagesOf(s.rootPath).length).toBeGreaterThan(0);
  });

  it('建会话播 session.created（左栏据此出现一行）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '播报', executor: 'engine' });
    const created = h.payloads('session.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.summary.record.id).toBe(s.record.id);
  });
});
// ─────────────────────────────────────────────────────────────
// 二、会话读侧：get / list / rename / remove
// ─────────────────────────────────────────────────────────────

describe('session.get / list / rename', () => {
  it('session.get 返回摘要 + 本会话成员（扁平数组，前端自己组树）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '组队', executor: 'team', teamId: '评审小队' });
    const detail = h.host.getSession(s.record.id);

    expect(detail?.record.id).toBe(s.record.id);
    expect(detail?.members).toHaveLength(3); // 主控 + 2 名评审
    expect(detail?.members.every((m) => m.sessionId === s.record.id)).toBe(true);
    expect(h.host.getSession('ghost')).toBeNull();
  });

  it('list 按创建时间倒序，可按状态过滤', async () => {
    const h = await harness();
    const a = h.host.createSession({ title: 'A', executor: 'engine' });
    const b = h.host.createSession({ title: 'B', executor: 'engine' });
    // 同一毫秒创建的会话按 id（含随机后缀）兜底排序，所以这里只断言**集合**；
    // 「创建时间倒序」这条语义在 session-store.test.ts 里用注入时钟钉死。
    const ids = h.host.listSessions().map((s) => s.record.id);
    expect(new Set(ids)).toEqual(new Set([a.record.id, b.record.id]));
    expect(h.host.listSessions({ limit: 1 }).map((x) => x.record.id)).toEqual([ids[0]]);
    // MU-1 还没有「归档」入口（M5 才有），所以 closed 过滤暂时恒空
    expect(h.host.listSessions({ status: 'closed' })).toEqual([]);
  });

  it('rename 改标题并播 session.changed；未知 id 报错', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '旧名', executor: 'engine' });
    const renamed = h.host.renameSession(s.record.id, '  新名字  ');
    expect(renamed.record.title).toBe('新名字');
    expect(h.payloads('session.changed').at(-1)?.summary.record.title).toBe('新名字');
    expect(() => h.host.renameSession('ghost', 'x')).toThrow(/不存在/);
    expect(() => h.host.renameSession(s.record.id, '   ')).toThrow(/不能为空/);
  });

  it('remove 删树 + 删记录 + 清挂起审批，并播 session.removed', async () => {
    // 让一个 always_ask 的叶子触发审批门（挂在门上等人批）
    const h = await harness({
      routes: {
        动手试试: () =>
          fauxAssistantMessage([fauxToolCall('poke', {})], { stopReason: 'toolUse' }),
      },
    });
    const s = h.host.createSession({ title: '待批', executor: 'engine' });
    const leaf = h.spawn({ role: 'worker', parent: s.rootPath });
    void h.host.prompt(leaf.path, '动手试试').catch(() => undefined);
    await viWaitFor(() => h.host.listPending().length === 1);
    expect(h.host.listPending()[0]?.sessionId).toBe(s.record.id);

    const { removedPaths } = h.host.removeSession(s.record.id);
    expect(removedPaths.length).toBe(2); // 根 + 叶子
    expect(h.host.list()).toEqual([]); // 树没了
    expect(h.host.getSession(s.record.id)).toBeNull(); // 记录没了
    expect(h.host.listPending()).toEqual([]); // 挂起审批作废（否则界面上是个点不开的待办）

    const removed = h.payloads('session.removed');
    expect(removed.at(-1)?.sessionId).toBe(s.record.id);
  });

  it('删会话不影响别的会话（账本就是按会话切的）', async () => {
    const h = await harness();
    const a = h.host.createSession({ title: 'A', executor: 'engine' });
    const b = h.host.createSession({ title: 'B', executor: 'engine' });
    h.host.removeSession(a.record.id);
    expect(h.host.listSessions().map((s) => s.record.id)).toEqual([b.record.id]);
    expect(h.host.list().map((n) => n.path)).toEqual([b.rootPath]);
  });

  it('删不存在的会话是幂等的（返回空）', async () => {
    const h = await harness();
    expect(h.host.removeSession('ghost')).toEqual({ removedPaths: [] });
  });
});

// ────────────────────────────────────────────────────────────
// 三、escalate：换引擎不换会话
// ────────────────────────────────────────────────────────────

describe('session.escalate · 单兵 → 团队', () => {
  it('换根角色 + 加成员 + 保留 transcript（会话 id 不变）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '单干', executor: 'engine' });
    await h.host.prompt(s.rootPath, '先看看');
    const before = h.host.messagesOf(s.rootPath);
    expect(before.length).toBeGreaterThan(0);

    const detail = h.host.escalateSession({ sessionId: s.record.id, teamId: '测试双人' });

    expect(detail.record.id).toBe(s.record.id); // 还是同一个会话
    expect(detail.record.executor).toBe('team');
    expect(detail.record.teamId).toBe('测试双人');
    expect(detail.record.maxConcurrent).toBe(2); // 团队闸门实例化进来
    expect(h.host.get(s.rootPath)?.role).toBe('lead'); // 根换身份
    expect(detail.counts.members).toBe(2);

    const after = h.host.messagesOf(s.rootPath);
    // 旧消息灌回新引擎（等价 fork: all，但只作用于主控）
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(JSON.stringify(after)).toContain('先看看');
  });

  it('carryMessages=false：只换角色不带历史（逃生门）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '单干', executor: 'engine' });
    await h.host.prompt(s.rootPath, '先看看');

    h.host.escalateSession({ sessionId: s.record.id, teamId: '测试双人', carryMessages: false });
    expect(h.host.messagesOf(s.rootPath)).toEqual([]);
  });

  it('收尾任务：升级后立刻交给新主控', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '单干', executor: 'engine' });
    h.host.escalateSession({ sessionId: s.record.id, teamId: '测试双人', task: '接着干' });
    await viWaitFor(() => h.host.get(s.rootPath)?.status === 'done');
    expect(JSON.stringify(h.host.messagesOf(s.rootPath))).toContain('接着干');
  });

  it('三条前置条件：会话存在 / 根不在跑 / 还没组过队', async () => {
    const h = await harness();
    expect(() => h.host.escalateSession({ sessionId: 'ghost', teamId: '测试双人' })).toThrow(
      /会话不存在/,
    );

    const s = h.host.createSession({ title: '组过队', executor: 'team', teamId: '测试双人' });
    expect(() => h.host.escalateSession({ sessionId: s.record.id, teamId: '全栈小队' })).toThrow(
      /已经有成员/,
    );

    const solo = h.host.createSession({ title: '单干', executor: 'engine' });
    h.spawn({ role: 'worker', parent: solo.rootPath });
    expect(() => h.host.escalateSession({ sessionId: solo.record.id, teamId: '测试双人' })).toThrow(
      /已经有成员/,
    );
  });

  it('未知团队 / 成员数越界一样拦', async () => {
    const h = await harness();
    const solo = h.host.createSession({ title: '单干', executor: 'engine' });
    expect(() => h.host.escalateSession({ sessionId: solo.record.id, teamId: '幽灵' })).toThrow(
      /团队不存在/,
    );
    expect(() =>
      h.host.escalateSession({ sessionId: solo.record.id, members: [{ role: 'lead' }] }),
    ).toThrow(/2~6/);
  });
});

// ─────────────────────────────────────────────────────────────
// 四、会话级并发：限 1 + 父等子退位让额
// ─────────────────────────────────────────────────────────────

describe('会话级并发闸门', () => {
  /** 会话级限额 1（团队档 0 + 会话档 1 ⇒ 取更严）。 */
  async function soloSession(routes: HarnessOpts['routes'] = {}) {
    const h = await harness({ routes });
    const s = h.host.createSession({ title: '限一', executor: 'engine', maxConcurrent: 1 });
    const a = h.spawn({ role: 'worker', parent: s.rootPath });
    const b = h.spawn({ role: 'worker', parent: a.path }); // b 是 a 的子（父等子场景）
    return { h, s, a, b };
  }

  it('一个会话同时只放 1 个 running：第二个任务 parked，跑完自动补位', async () => {
    let release!: () => void;
    const lock = new Promise<void>((res) => {
      release = () => res();
    });
    const { h, a, b } = await soloSession({ '甲任务': () => lock.then(() => fauxAssistantMessage('甲完成')) });

    const pa = h.host.requestRun(a.path, '甲任务');
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');

    const pb = h.host.requestRun(b.path, '乙任务'); // 额满 → parked
    expect(h.host.get(b.path)?.status).toBe('waiting');

    release();
    await pa; // 甲跑完 → drain → 乙补位
    await pb;
    expect(h.host.get(a.path)?.status).toBe('done');
    expect(h.host.get(b.path)?.status).toBe('done');
  });

  it('会话额满时 parked 而不是报错', async () => {
    const { h, a, b } = await soloSession();
    void h.host.requestRun(a.path, '甲').catch(() => undefined);
    expect(h.host.get(a.path)?.status).toBe('running');
    // 第二个被会话闸门挡住：不抛错，排队
    const pb = h.host.requestRun(b.path, '乙');
    expect(h.host.get(b.path)?.status).toBe('waiting');
    await pb;
  });

  it('父等子（beginWait）：父退位让额，被挡住的子立刻补位 —— 限 1 也不死锁', async () => {
    let release!: () => void;
    const lock = new Promise<void>((res) => {
      release = () => res();
    });
    const { h, a, b } = await soloSession({ '父任务': () => lock.then(() => fauxAssistantMessage('父完成')) });

    const parentRun = h.host.requestRun(a.path, '父任务'); // 父占住唯一额度
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');

    const childRun = h.host.requestRun(b.path, '子任务'); // parked
    expect(h.host.get(b.path)?.status).toBe('waiting');

    // 父开始等子 → 退位 → drain 立刻把额度给子
    const waitP = h.host.beginWait(a.path, [b.path]);
    await viWaitFor(() => h.host.get(b.path)?.status === 'running');
    expect(h.host.get(a.path)?.status).toBe('waiting');
    expect(h.host.get(a.path)?.waitingOn).toEqual([b.path]); // 摘要据此算 suspended

    // 子完事 → 父恢复 running（此时子已终态，额度不冲突）
    await viWaitFor(() => h.host.get(b.path)?.status === 'done');
    await waitP;
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');

    release();
    await parentRun;
    await childRun;
  });

  it('摘要把两种 waiting 分开数：parked 与 suspended', async () => {
    let release!: () => void;
    const lock = new Promise<void>((res) => {
      release = () => res();
    });
    const h = await harness({ routes: { 占住: () => lock.then(() => fauxAssistantMessage('完')) } });
    const s = h.host.createSession({ title: '限一', executor: 'engine', maxConcurrent: 1 });
    const a = h.spawn({ role: 'worker', parent: s.rootPath });
    const b = h.spawn({ role: 'worker', parent: a.path });
    const c = h.spawn({ role: 'worker', parent: s.rootPath });

    void h.host.requestRun(a.path, '占住'); // 占住唯一额度
    await viWaitFor(() => h.host.get(a.path)?.status === 'running');
    void h.host.requestRun(b.path, '排队'); // parked
    void h.host.requestRun(c.path, '排队'); // parked

    const summary = h.host.getSession(s.record.id)!;
    expect(summary.counts.running).toBe(1);
    expect(summary.counts.parked).toBe(2);
    expect(summary.counts.suspended).toBe(0);

    release();
    await viWaitFor(
      () => h.host.get(b.path)?.status === 'done' && h.host.get(c.path)?.status === 'done',
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 五、三层预算：scope 与「谁的线告诉我」
// ─────────────────────────────────────────────────────────────

describe('三层预算 · 会话档事件只在会话**自带**限额时播', () => {
  it('没有会话档/团队档 ⇒ 只有全局事件（否则 UI 上叠两个一样的 banner）', async () => {
    const h = await harness({ budget: { hardUsd: 1 }, costByText: { 烧钱: 0.9 } });
    const s = h.host.createSession({ title: '单兵', executor: 'engine' });
    await h.host.prompt(s.rootPath, '烧钱');

    const warns = h.payloads('budget.warning');
    expect(warns.map((w) => w.scope)).toEqual(['global']);
    expect(h.payloads('budget.frozen')).toEqual([]);
    // 预算快照（全局口径）还是 ok/warning，不是 frozen
    expect(h.host.budgetSnapshot().state).toBe('warning');
  });

  it('会话档比全局更严 ⇒ 事件带 scope=session + sessionId + limitedBy', async () => {
    const h = await harness({ budget: { hardUsd: 10 }, costByText: { 烧钱: 0.25 } });
    const s = h.host.createSession({
      title: '省着点',
      executor: 'engine',
      budget: { hardUsd: 0.3 },
    });
    await h.host.prompt(s.rootPath, '烧钱');

    const warnings = h.payloads('budget.warning').filter((w) => w.scope === 'session');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.sessionId).toBe(s.record.id);
    expect(warnings[0]!.limitedBy).toBe('session');
    expect(warnings[0]!.hardUsd).toBe(0.3); // 生效硬线来自会话档
    expect(warnings[0]!.softUsd).toBeCloseTo(0.24); // 0.3 × 0.8
    // 全局档还很宽松：这条事件只属于这个会话
    expect(h.payloads('budget.warning').filter((w) => w.scope === 'global')).toEqual([]);
  });

  it('会话冻结只冻会话：全局照常，别的会话照常开工', async () => {
    const h = await harness({ budget: { hardUsd: 10 }, costByText: { 烧钱: 0.4 } });
    const tight = h.host.createSession({
      title: '紧',
      executor: 'engine',
      budget: { hardUsd: 0.3 },
    });
    const loose = h.host.createSession({ title: '松', executor: 'engine' });

    await h.host.prompt(tight.rootPath, '烧钱');
    expect(h.payloads('budget.frozen').filter((f) => f.scope === 'session')[0]?.sessionId).toBe(
      tight.record.id,
    );
    expect(h.host.getSession(tight.record.id)?.budget.tier).toBe('frozen');

    // ① 这个会话的新起点被拒（错误信息说清是谁的线）
    expect(() => h.host.spawn({ role: 'worker', parent: tight.rootPath })).toThrow(/已到硬线/);
    expect(() => h.host.spawn({ role: 'worker', parent: tight.rootPath })).toThrow(/会话预算/);

    // ② 全局没冻，别的会话不受影响
    expect(h.host.budgetSnapshot().state).toBe('ok');
    expect(h.host.getSession(loose.record.id)?.budget.tier).toBe('ok');
    const ok = h.host.spawn({ role: 'worker', parent: loose.rootPath });
    expect(ok.path.startsWith(loose.rootPath)).toBe(true);
  });

  it('团队档参与取严：团队硬线比全局严时 limitedBy=team', async () => {
    const h = await harness({ budget: { hardUsd: 10 }, costByText: { 烧钱: 0.4 } });
    // 评审小队：团队硬线 0.5（软线 0.3）
    const s = h.host.createSession({ title: '评审', executor: 'team', teamId: '评审小队' });
    await h.host.prompt(s.rootPath, '烧钱');

    const sessionEvents = h.payloads('budget.warning').filter((w) => w.scope === 'session');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]!.limitedBy).toBe('team');
    expect(sessionEvents[0]!.hardUsd).toBe(0.5);
  });

  it('会话档只能比团队档更严（min 天然满足「可下调不可上调」）', async () => {
    const h = await harness();
    const s = h.host.createSession({
      title: '想上调',
      executor: 'team',
      teamId: '测试双人', // 团队硬线 0.8
      budget: { hardUsd: 5 }, // 想放宽 → 不生效
    });
    expect(h.host.getSession(s.record.id)?.budget.effectiveHardUsd).toBe(0.8);
    expect(h.host.getSession(s.record.id)?.budget.limitedBy).toBe('team');
  });
});

// ─────────────────────────────────────────────────────────────
// 六、代批留痕（修②）：HITL 不再静默失效
// ─────────────────────────────────────────────────────────────

describe('审批穿透 · 代批必须留痕', () => {
  /**
   * 一次工具调用后转入普通回复。
   *
   * 必须**有状态**：脚本化源按「最近一条 user 文本」配对回复，恒返回工具调用
   * 会让引擎在「调工具 → 拿结果 → 再问模型」之间无限转（本文件第一版就这么挂的）。
   */
  function pokeOnce(after = '好。') {
    let n = 0;
    return () =>
      n++ === 0
        ? fauxAssistantMessage([fauxToolCall('poke', {})], { stopReason: 'toolUse' })
        : fauxAssistantMessage(after);
  }

  it('祖先代批：放行 + 播 approval.delegated（谁替你批的看得见）', async () => {
    const h = await harness({ routes: { 动手: pokeOnce() } });
    const s = h.host.createSession({ title: '干活', executor: 'engine' });
    const boss = h.spawn({ role: 'boss', parent: s.rootPath }); // auto
    const worker = h.spawn({ role: 'worker', parent: boss.path }); // always_ask

    await h.host.prompt(worker.path, '动手');

    const delegated = h.payloads('approval.delegated');
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ origin: worker.path, approver: boss.path, mode: 'auto' });
    expect(delegated[0]!.tool).toBe('poke');
    expect(delegated[0]!.chain).toEqual([worker.path, boss.path, s.rootPath]);
    // 工具真的执行了（代批是放行而不是拦下）
    expect(h.calls).toContain('poke');
    // 没人被惊动：没有挂起的审批
    expect(h.host.listPending()).toEqual([]);
  });

  it('自批不算代批：agent 自己有 auto 档时不发留痕事件', async () => {
    const h = await harness({ routes: { 动手: pokeOnce() } });
    const s = h.host.createSession({ title: '干活', executor: 'engine' });
    const boss = h.spawn({ role: 'boss', parent: s.rootPath }); // auto 自己就能放行

    await h.host.prompt(boss.path, '动手');

    expect(h.payloads('approval.delegated')).toEqual([]);
    expect(h.calls).toContain('poke');
  });

  it('链上无人代批 ⇒ 落到人手上（挂起 + 会话归属写对）', async () => {
    const h = await harness({ routes: { 动手: pokeOnce() } });
    const s = h.host.createSession({ title: '干活', executor: 'engine' });
    const strict = h.spawn({ role: 'worker', parent: s.rootPath }); // always_ask
    const leaf = h.spawn({ role: 'worker', parent: strict.path });

    void h.host.prompt(leaf.path, '动手').catch(() => undefined);
    await viWaitFor(() => h.host.listPending().length === 1);

    const pending = h.host.listPending()[0]!;
    expect(pending.origin).toBe(leaf.path);
    expect(pending.sessionId).toBe(s.record.id); // S5 收件箱按会话切片
    expect(pending.chain).toEqual([leaf.path, strict.path, s.rootPath]);
    expect(h.payloads('approval.delegated')).toEqual([]); // 没人代批，不做留痕

    // 人批准后放行
    h.host.respondApproval(pending.requestId, true);
    await viWaitFor(() => h.calls.includes('poke'));
  });

  it('内置角色也守这条规矩：lead 一律 always_ask（validateTeam 已挡，角色定义也写死）', async () => {
    const h = await harness();
    const lead = ALL_ROLES.find((r) => r.name === 'lead')!;
    expect(lead.approval).toBe('always_ask');
    const engine = ALL_ROLES.find((r) => r.name === 'engine')!;
    expect(engine.approval).toBe('always_ask');
    // 会话根拿到的是引擎角色的档位（不是 undefined —— 那会走全局缺省，
    // 全局一旦被设成 auto，单兵会话就静默免问了）
    const s = h.host.createSession({ title: '单兵', executor: 'engine' });
    expect(h.host.get(s.rootPath)?.role).toBe('engine');
  });
});

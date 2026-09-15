/**
 * AgentRegistry 单测 —— 覆盖多根树、状态机、树操作、并发闸门、用量汇总。
 *
 * 这些看起来都很"显然"，但多 Agent 场景下它们出错的症状极具迷惑性：
 * 状态错乱表现为「UI 说在跑其实早死了」，级联删除顺序错了表现为
 * 「树上留下孤儿节点」，用量不向上汇总表现为「根节点永远是 0」。
 * 三种都不会抛异常，只会让人怀疑人生。所以逐条钉死。
 *
 * MU-1 起树不再挂在唯一的 `/root` 上：注册中心可以同时持有多棵会话树，
 * 「根」是建出来的（createRoot），不是开箱就有的 —— 所以本文件的第一个
 * 断言从「根开箱即在」变成了「没建就没有」。这不是退让，而是把
 * 「会话是一等公民」这句话钉进测试。
 */

import { describe, expect, it } from 'vitest';
import { sessionRootPath, type AgentSnapshot } from '@axon/protocol';
import type { AxonEngine } from './engine.ts';
import { AgentRegistry, type RegisterSpec } from './registry.ts';

/**
 * 造一个注册中心 + 一个会话（s1），并给出「挂到 s1 根下」的注册便捷函数。
 *
 * 多根之后几乎每条测试都要「先有会话」，所以把这两步收进 mk()：
 * 逐条测试里重复三行样板，会让真正的断言淹没在噪音里。
 */
const mk = (opts?: ConstructorParameters<typeof AgentRegistry>[0]) => {
  let t = 1000;
  const registry = new AgentRegistry({ now: () => t++, ...opts });
  const root = sessionRootPath('s1');
  registry.createRoot('s1', { role: 'root', displayName: '会话根' });
  const add = (spec: Omit<RegisterSpec, 'parent'> & { parent?: string }) =>
    registry.register({ parent: root, ...spec });
  return { registry, root, add };
};

describe('AgentRegistry —— 多根树结构', () => {
  it('没有建根就没有节点（多根：注册中心开箱为空）', () => {
    let t = 1000;
    const r = new AgentRegistry({ now: () => t++ });
    expect(r.list()).toEqual([]);
    expect(r.totalUsage().inputTokens).toBe(0);
  });

  it('createRoot 建会话根；同 id 再建抛错', () => {
    const { registry, root } = mk();
    expect(registry.has(root)).toBe(true);
    expect(registry.snapshot(root)?.role).toBe('root');
    expect(registry.snapshot(root)?.sessionId).toBe('s1');
    expect(registry.depthOf(root)).toBe(0);
    expect(() => registry.createRoot('s1', { role: 'x', displayName: 'X' })).toThrow(/已存在/);
  });

  it('同角色多次注册产生不冲突的路径', () => {
    const { add } = mk();
    const a = add({ role: 'dev', displayName: 'D' });
    const b = add({ role: 'dev', displayName: 'D' });
    expect(a.path).toBe('/s1/dev-1');
    expect(b.path).toBe('/s1/dev-2');
  });

  it('不同父节点下的序号互不干扰', () => {
    const { registry, root, add } = mk();
    const p = add({ role: 'planner', displayName: 'P' });
    const a = add({ role: 'dev', displayName: 'D' });
    const b = registry.register({ role: 'dev', displayName: 'D', parent: p.path });
    expect(a.path).toBe('/s1/dev-1');
    // 换了父节点就重新从 1 开始 —— 路径的唯一性由完整路径保证，不靠全局序号
    expect(b.path).toBe(`${p.path}/dev-1`);
    expect(root).toBe('/s1');
  });

  it('父节点的 children 同步更新', () => {
    const { registry, root, add } = mk();
    const c = add({ role: 'dev', displayName: 'D' });
    expect(registry.snapshot(root)?.children).toEqual([c.path]);
  });

  it('深度相对会话根计算（根为 0）', () => {
    const { registry, add } = mk({ maxDepth: 2 });
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: a.path });
    expect(registry.depthOf(a.path)).toBe(1);
    expect(registry.depthOf(b.path)).toBe(2);
    expect(() => registry.register({ role: 'c', displayName: 'C', parent: b.path })).toThrow(
      /超出最大深度/,
    );
  });

  it('父子必须同一个会话：跨会话挂载抛错', () => {
    const { registry, add } = mk();
    registry.createRoot('s2', { role: 'root', displayName: '另一个会话' });
    const a = add({ role: 'a', displayName: 'A' });
    // registry.register 只认路径；跨会话由 host.resolveParent 拦（见 host 单测）。
    // 这里钉的是「路径前缀决定归属」这条不变量本身。
    const stray = registry.register({ role: 'x', displayName: 'X', parent: '/s2' });
    expect(registry.sessionIdOf(stray.path)).toBe('s2');
    expect(registry.listOf('s1').map((n) => n.path)).toEqual(['/s1', a.path]);
  });

  it('父节点不存在时拒绝注册', () => {
    const { registry } = mk();
    expect(() => registry.register({ role: 'x', displayName: 'X', parent: '/s1/ghost' })).toThrow(
      /父 Agent 不存在/,
    );
  });

  it('两个会话的树互不干扰（listOf / activeCount 按会话切片）', () => {
    const { registry, add } = mk({ maxConcurrent: 0 });
    registry.createRoot('s2', { role: 'root', displayName: '另一个会话' });
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: '/s2' });
    registry.setStatus(a.path, 'running');

    expect(registry.listOf('s1').map((n) => n.path).sort()).toEqual(['/s1', a.path].sort());
    expect(registry.listOf('s2').map((n) => n.path)).toEqual(['/s2', b.path]);
    expect(registry.activeCount('s1')).toBe(1);
    expect(registry.activeCount('s2')).toBe(0);
    expect(registry.sessionIdOf(b.path)).toBe('s2');
  });
});
describe('AgentRegistry —— 级联删除', () => {
  it('删除返回整棵子树，且子先父后', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: a.path });

    const removed = registry.remove(a.path);
    // 顺序是契约的一部分：UI 按此逐个摘节点，父先删会留下孤儿渲染
    expect(removed).toEqual([b.path, a.path]);
    expect(registry.has(a.path)).toBe(false);
    expect(registry.has(b.path)).toBe(false);
  });

  it('删除后从父节点的 children 中摘除', () => {
    const { registry, root, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    registry.remove(a.path);
    expect(registry.snapshot(root)?.children).toEqual([]);
  });

  it('删会话根 = 删整棵树，且不抛错（MU-1：根不再受保护）', () => {
    const { registry, root, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: a.path });
    const removed = registry.remove(root);
    expect(removed).toEqual([b.path, a.path, root]);
    expect(registry.has(root)).toBe(false);
    expect(registry.listOf('s1')).toEqual([]);
    // 会话没了，限额与序号也该清干净：M5 恢复同一会话时不该接着旧序号数
    expect(registry.sessionLimit('s1')).toBe(0);
    const fresh = registry.createRoot('s1', { role: 'root', displayName: '会话根' });
    expect(fresh.path).toBe('/s1');
    expect(add({ role: 'a', displayName: 'A' }).path).toBe('/s1/a-1');
  });

  it('removeRoot 是同一件事的另一个入口', () => {
    const { registry, root, add } = mk();
    add({ role: 'a', displayName: 'A' });
    expect(registry.removeRoot('s1').length).toBe(2);
    expect(registry.has(root)).toBe(false);
    expect(registry.removeRoot('s1')).toEqual([]); // 幂等
  });

  it('删不存在的节点是 no-op 而非抛错', () => {
    // 幂等很重要：UI 可能因事件重放而重复请求删除
    expect(mk().registry.remove('/s1/ghost')).toEqual([]);
  });
});

describe('AgentRegistry —— 状态机', () => {
  it('允许的跃迁能过', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    expect(registry.setStatus(a.path, 'running').status).toBe('running');
    expect(registry.setStatus(a.path, 'waiting').status).toBe('waiting');
    expect(registry.setStatus(a.path, 'done').status).toBe('done');
  });

  it('非法跃迁抛错', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    // idle 不能直接到 done：没跑过怎么会完成
    expect(() => registry.setStatus(a.path, 'done')).toThrow(/非法状态跃迁/);
  });

  it('终态可回 idle —— 这是 followup 的落点', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    registry.setStatus(a.path, 'running');
    registry.setStatus(a.path, 'done');
    expect(registry.setStatus(a.path, 'idle').status).toBe('idle');
    // 能再跑一轮，不必重建实例
    expect(registry.setStatus(a.path, 'running').status).toBe('running');
  });

  it('中断后可恢复', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    registry.setStatus(a.path, 'running');
    registry.setStatus(a.path, 'interrupted');
    expect(registry.setStatus(a.path, 'idle').status).toBe('idle');
  });

  it('同状态重复设置是 no-op', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    expect(registry.setStatus(a.path, 'idle').status).toBe('idle');
  });

  it('失败信息在重新激活时被清掉', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    registry.setStatus(a.path, 'failed', '炸了');
    expect(registry.snapshot(a.path)?.lastError).toBe('炸了');
    registry.setStatus(a.path, 'idle');
    // 留着会让 UI 一直挂着过期的红字
    expect(registry.snapshot(a.path)?.lastError).toBeUndefined();
  });
});
describe('AgentRegistry —— 并发闸门', () => {
  it('达到上限后拒绝新的 running', () => {
    const { registry, add } = mk({ maxConcurrent: 2 });
    const a = add({ role: 'a', displayName: 'A' });
    const b = add({ role: 'b', displayName: 'B' });
    const c = add({ role: 'c', displayName: 'C' });

    registry.setStatus(a.path, 'running');
    registry.setStatus(b.path, 'running');
    expect(registry.canRun()).toBe(false);
    expect(() => registry.setStatus(c.path, 'running')).toThrow(/并发已达上限/);
  });

  it('全局额度是**跨会话**的（多根不等于多份额度）', () => {
    const { registry, add } = mk({ maxConcurrent: 2 });
    registry.createRoot('s2', { role: 'root', displayName: '另一个会话' });
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: '/s2' });
    registry.setStatus(a.path, 'running');
    registry.setStatus(b.path, 'running');
    // 两个会话各跑一个：全局上限 2 已满，s1 里的第二个必须排队
    expect(registry.canRun('s1')).toBe(false);
    expect(registry.canRun('s2')).toBe(false);
  });

  it('会话限额只收本会话（setSessionLimit）', () => {
    const { registry, add } = mk({ maxConcurrent: 6 });
    registry.createRoot('s2', { role: 'root', displayName: '另一个会话' });
    registry.setSessionLimit('s1', 1);
    const a = add({ role: 'a', displayName: 'A' });
    const b = add({ role: 'b', displayName: 'B' });
    const c = registry.register({ role: 'c', displayName: 'C', parent: '/s2' });

    registry.setStatus(a.path, 'running');
    expect(registry.canRun('s1')).toBe(false); // s1 额满（自己只给 1）
    expect(registry.canRun('s2')).toBe(true); // s2 不受影响
    expect(() => registry.setStatus(b.path, 'running')).toThrow(/会话并发已达上限/);
    expect(() => registry.setStatus(c.path, 'running')).not.toThrow();
  });

  it('会话限额 0 = 不限（与 maxConcurrent 同义）', () => {
    const { registry, add } = mk({ maxConcurrent: 0 });
    registry.setSessionLimit('s1', 0);
    for (let i = 0; i < 8; i++) registry.setStatus(add({ role: `r${i}`, displayName: 'X' }).path, 'running');
    expect(registry.activeCount('s1')).toBe(8);
    expect(registry.sessionLimit('s1')).toBe(0);
  });

  it('闸门拦的是新占额度；waiting→running 走 promote 免检（M3 语义）', () => {
    const { registry, add } = mk({ maxConcurrent: 1 });
    const a = add({ role: 'a', displayName: 'A' });
    const b = add({ role: 'b', displayName: 'B' });
    registry.setStatus(a.path, 'running');
    registry.setStatus(a.path, 'waiting'); // 退位让额
    expect(registry.activeCount()).toBe(0); // waiting 不占额度
    registry.setStatus(b.path, 'running'); // b 拿走了额度
    // a 的提升走免检通道——额度本来自它等待的对象（kalo resume 免信号量同理）
    expect(() => registry.promote(a.path)).not.toThrow();
    expect(registry.snapshot(a.path)?.status).toBe('running');
  });

  it('promote 越过会话限额（额度来自「它等的子刚结束」）', () => {
    const { registry, add } = mk({ maxConcurrent: 0 });
    registry.setSessionLimit('s1', 1);
    const a = add({ role: 'a', displayName: 'A' });
    const b = add({ role: 'b', displayName: 'B' });
    registry.setStatus(a.path, 'running');
    registry.setStatus(a.path, 'waiting');
    registry.setStatus(b.path, 'running'); // 占了唯一的名额
    expect(registry.canRun('s1')).toBe(false);
    expect(() => registry.promote(a.path)).not.toThrow();
  });

  it('parked（idle→waiting）排队本身不受闸门阻挡', () => {
    const { registry, add } = mk({ maxConcurrent: 1 });
    const a = add({ role: 'a', displayName: 'A' });
    const b = add({ role: 'b', displayName: 'B' });
    registry.setStatus(a.path, 'running'); // 满员
    expect(() => registry.setStatus(b.path, 'waiting')).not.toThrow(); // 排队成功
    expect(registry.activeCount()).toBe(1); // 只有 running 在燃烧额度
    expect(registry.snapshot(b.path)?.status).toBe('waiting');
  });

  it('promote 只接受 waiting 状态的 Agent', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    expect(() => registry.promote(a.path)).toThrow(/只有 waiting/);
    registry.setStatus(a.path, 'running');
    expect(() => registry.promote(a.path)).toThrow(/只有 waiting/);
  });

  it('释放额度后可再启动', () => {
    const { registry, add } = mk({ maxConcurrent: 1 });
    const a = add({ role: 'a', displayName: 'A' });
    const b = add({ role: 'b', displayName: 'B' });
    registry.setStatus(a.path, 'running');
    registry.setStatus(a.path, 'done');
    expect(() => registry.setStatus(b.path, 'running')).not.toThrow();
  });

  it('maxConcurrent=0 表示不限制', () => {
    const { registry, add } = mk({ maxConcurrent: 0 });
    for (let i = 0; i < 20; i++) {
      registry.setStatus(add({ role: `r${i}`, displayName: 'X' }).path, 'running');
    }
    expect(registry.activeCount()).toBe(20);
  });

  it('改闸门参数立刻生效（setMaxConcurrent / setMaxDepth）', () => {
    const { registry, add } = mk({ maxConcurrent: 1, maxDepth: 1 });
    registry.setMaxConcurrent(3);
    registry.setMaxDepth(3);
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: a.path });
    registry.register({ role: 'c', displayName: 'C', parent: b.path }); // 深度 3，仍放行
    for (const n of [a, b]) registry.setStatus(n.path, 'running');
    expect(registry.activeCount()).toBe(2);
  });

  it('spawn 不受并发限制，只有 running 受限', () => {
    // 允许建 10 个摆在树上（这是编排的表达），但同时烧 token 的不能超限
    const { add } = mk({ maxConcurrent: 1 });
    for (let i = 0; i < 10; i++) {
      expect(() => add({ role: `r${i}`, displayName: 'X' })).not.toThrow();
    }
  });
});
describe('AgentRegistry —— 用量汇总', () => {
  it('沿父链累加，会话根是本会话的总账', () => {
    const { registry, root, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    const b = registry.register({ role: 'b', displayName: 'B', parent: a.path });

    registry.addUsage(b.path, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    registry.addUsage(a.path, { inputTokens: 3, outputTokens: 1, costUsd: 0.002 });

    expect(registry.snapshot(b.path)?.usage.inputTokens).toBe(10);
    expect(registry.snapshot(a.path)?.usage.inputTokens).toBe(13);
    expect(registry.snapshot(root)?.usage.inputTokens).toBe(13);
    expect(registry.snapshot(root)?.usage.costUsd).toBeCloseTo(0.012);
  });

  it('totalUsage 是全部会话根之和（多根模型下的「全局账」）', () => {
    const { registry, add } = mk();
    registry.createRoot('s2', { role: 'root', displayName: '另一个会话' });
    registry.addUsage(add({ role: 'a', displayName: 'A' }).path, { costUsd: 0.01 });
    registry.addUsage('/s2', { costUsd: 0.02 });
    expect(registry.totalUsage().costUsd).toBeCloseTo(0.03);
  });

  it('缺省字段按 0 处理', () => {
    const { registry, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    registry.addUsage(a.path, { inputTokens: 7 });
    expect(registry.snapshot(a.path)?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});

describe('AgentRegistry —— 快照隔离', () => {
  it('返回的快照改不动内部状态', () => {
    const { registry, root, add } = mk();
    const a = add({ role: 'a', displayName: 'A' });
    const snap = registry.snapshot(a.path)!;
    snap.status = 'failed';
    snap.children.push('/s1/fake');
    // 拿到的是拷贝 —— 否则 IPC 序列化前的任何改动都会污染真相
    expect(registry.snapshot(a.path)?.status).toBe('idle');
    expect(registry.snapshot(a.path)?.children).toEqual([]);
    expect(registry.snapshot(a.path)?.parent).toBe(root);
  });

  it('list() 返回全部会话的扁平表；listOf() 只给一个会话', () => {
    const { registry, add } = mk();
    registry.createRoot('s2', { role: 'root', displayName: '另一个会话' });
    add({ role: 'a', displayName: 'A' });
    expect(registry.list().length).toBe(3);
    expect(registry.listOf('s1').length).toBe(2);
  });
});

describe('AgentRegistry —— restoreNodes（M5 落盘恢复）', () => {
  const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const snap = (path: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
    path,
    role: 'dev',
    displayName: 'D',
    status: 'idle',
    children: [],
    createdAt: 1,
    updatedAt: 1,
    usage: { ...ZERO },
    sessionId: 's1',
    ...over,
  });
  const fresh = () => new AgentRegistry({ now: () => 1_000 });

  it('按深度重建（乱序也能建起来），并保留 children', () => {
    const r = fresh();
    const root = snap('/s1', { role: 'root', children: ['/s1/dev-1'] });
    const child = snap('/s1/dev-1', { parent: '/s1' });
    const res = r.restoreNodes([child, root]); // 故意乱序

    expect(res.restored).toEqual(['/s1', '/s1/dev-1']);
    expect(res.skipped).toEqual([]);
    expect(r.snapshot('/s1/dev-1')?.parent).toBe('/s1');
    expect(r.snapshot('/s1')?.children).toEqual(['/s1/dev-1']);
    expect(r.depthOf('/s1/dev-1')).toBe(1);
  });

  it('序号重建：恢复后新成员不会与旧路径重名', () => {
    const r = fresh();
    r.restoreNodes([
      snap('/s1', { role: 'root' }),
      snap('/s1/dev-3', { parent: '/s1', role: 'dev' }),
    ]);
    const next = r.register({ parent: '/s1', role: 'dev', displayName: 'D2' });
    expect(next.path).toBe('/s1/dev-4');
  });

  it('父缺失 → 跳过并报出来（不把孤儿挂到会话根上）', () => {
    const r = fresh();
    const res = r.restoreNodes([
      snap('/s1', { role: 'root' }),
      snap('/s1/dev-1', { parent: '/s1/dev-9' }),
    ]);
    expect(res.restored).toEqual(['/s1']);
    expect(res.skipped).toEqual(['/s1/dev-1']);
    expect(r.has('/s1/dev-1')).toBe(false);
  });

  it('悬空 children 被清理并报出来（磁盘树与内存树不一致要能解释）', () => {
    const r = fresh();
    const res = r.restoreNodes([
      snap('/s1', { role: 'root', children: ['/s1/dev-1', '/s1/gone-2'] }),
      snap('/s1/dev-1', { parent: '/s1' }),
    ]);
    expect(res.dangling).toEqual(['/s1/gone-2']);
    expect(r.snapshot('/s1')?.children).toEqual(['/s1/dev-1']);
  });

  it('重复路径跳过；引擎按 engines 注入（懒加载时才有实例）', () => {
    const r = fresh();
    const engine = { kind: 'fake' } as unknown as AxonEngine;
    const res = r.restoreNodes([snap('/s1', { role: 'root' })], {
      engines: new Map([['/s1', engine]]),
    });
    expect(res.restored).toEqual(['/s1']);
    expect(r.get('/s1')?.engine).toBe(engine);

    const again = r.restoreNodes([snap('/s1', { role: 'root' })]);
    expect(again.skipped).toEqual(['/s1']);
  });
});

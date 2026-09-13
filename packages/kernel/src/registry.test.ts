/**
 * AgentRegistry 单测 —— 覆盖状态机、树操作、并发闸门、用量汇总。
 *
 * 这些看起来都很"显然"，但多 Agent 场景下它们出错的症状极具迷惑性：
 * 状态错乱表现为「UI 说在跑其实早死了」，级联删除顺序错了表现为
 * 「树上留下孤儿节点」，用量不向上汇总表现为「根节点永远是 0」。
 * 三种都不会抛异常，只会让人怀疑人生。所以逐条钉死。
 */

import { describe, expect, it } from 'vitest';
import { ROOT_PATH } from '@axon/protocol';
import { AgentRegistry } from './registry.ts';

const mk = (opts?: ConstructorParameters<typeof AgentRegistry>[0]) => {
  let t = 1000;
  return new AgentRegistry({ now: () => t++, ...opts });
};

describe('AgentRegistry —— 树结构', () => {
  it('根节点开箱即在', () => {
    const r = mk();
    expect(r.has(ROOT_PATH)).toBe(true);
    expect(r.snapshot(ROOT_PATH)?.role).toBe('root');
    expect(r.depthOf(ROOT_PATH)).toBe(0);
  });

  it('同角色多次注册产生不冲突的路径', () => {
    const r = mk();
    const a = r.register({ role: 'dev', displayName: 'D' });
    const b = r.register({ role: 'dev', displayName: 'D' });
    expect(a.path).toBe('/root/dev-1');
    expect(b.path).toBe('/root/dev-2');
  });

  it('不同父节点下的序号互不干扰', () => {
    const r = mk();
    const p = r.register({ role: 'planner', displayName: 'P' });
    const a = r.register({ role: 'dev', displayName: 'D' });
    const b = r.register({ role: 'dev', displayName: 'D', parent: p.path });
    expect(a.path).toBe('/root/dev-1');
    // 换了父节点就重新从 1 开始 —— 路径的唯一性由完整路径保证，不靠全局序号
    expect(b.path).toBe('/root/planner-1/dev-1');
  });

  it('父节点的 children 同步更新', () => {
    const r = mk();
    const c = r.register({ role: 'dev', displayName: 'D' });
    expect(r.snapshot(ROOT_PATH)?.children).toEqual([c.path]);
  });

  it('深度超限时拒绝注册', () => {
    const r = mk({ maxDepth: 2 });
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B', parent: a.path });
    expect(() => r.register({ role: 'c', displayName: 'C', parent: b.path })).toThrow(
      /超出最大深度/,
    );
  });

  it('父节点不存在时拒绝注册', () => {
    const r = mk();
    expect(() => r.register({ role: 'x', displayName: 'X', parent: '/root/ghost' })).toThrow(
      /父 Agent 不存在/,
    );
  });
});

describe('AgentRegistry —— 级联删除', () => {
  it('删除返回整棵子树，且子先父后', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B', parent: a.path });

    const removed = r.remove(a.path);
    // 顺序是契约的一部分：UI 按此逐个摘节点，父先删会留下孤儿渲染
    expect(removed).toEqual([b.path, a.path]);
    expect(r.has(a.path)).toBe(false);
    expect(r.has(b.path)).toBe(false);
  });

  it('删除后从父节点的 children 中摘除', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    r.remove(a.path);
    expect(r.snapshot(ROOT_PATH)?.children).toEqual([]);
  });

  it('不能删根节点', () => {
    const r = mk();
    expect(() => r.remove(ROOT_PATH)).toThrow(/不能删除根/);
  });

  it('删不存在的节点是 no-op 而非抛错', () => {
    // 幂等很重要：UI 可能因事件重放而重复请求删除
    expect(mk().remove('/root/ghost')).toEqual([]);
  });
});

describe('AgentRegistry —— 状态机', () => {
  it('允许的跃迁能过', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    expect(r.setStatus(a.path, 'running').status).toBe('running');
    expect(r.setStatus(a.path, 'waiting').status).toBe('waiting');
    expect(r.setStatus(a.path, 'done').status).toBe('done');
  });

  it('非法跃迁抛错', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    // idle 不能直接到 done：没跑过怎么会完成
    expect(() => r.setStatus(a.path, 'done')).toThrow(/非法状态跃迁/);
  });

  it('终态可回 idle —— 这是 followup 的落点', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    r.setStatus(a.path, 'running');
    r.setStatus(a.path, 'done');
    expect(r.setStatus(a.path, 'idle').status).toBe('idle');
    // 能再跑一轮，不必重建实例
    expect(r.setStatus(a.path, 'running').status).toBe('running');
  });

  it('中断后可恢复', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    r.setStatus(a.path, 'running');
    r.setStatus(a.path, 'interrupted');
    expect(r.setStatus(a.path, 'idle').status).toBe('idle');
  });

  it('同状态重复设置是 no-op', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    expect(r.setStatus(a.path, 'idle').status).toBe('idle');
  });

  it('失败信息在重新激活时被清掉', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    r.setStatus(a.path, 'failed', '炸了');
    expect(r.snapshot(a.path)?.lastError).toBe('炸了');
    r.setStatus(a.path, 'idle');
    // 留着会让 UI 一直挂着过期的红字
    expect(r.snapshot(a.path)?.lastError).toBeUndefined();
  });
});

describe('AgentRegistry —— 并发闸门', () => {
  it('达到上限后拒绝新的 running', () => {
    const r = mk({ maxConcurrent: 2 });
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B' });
    const c = r.register({ role: 'c', displayName: 'C' });

    r.setStatus(a.path, 'running');
    r.setStatus(b.path, 'running');
    expect(r.canRun()).toBe(false);
    expect(() => r.setStatus(c.path, 'running')).toThrow(/并发已达上限/);
  });

  it('闸门拦的是新占额度；waiting→running 走 promote 免检（M3 语义）', () => {
    const r = mk({ maxConcurrent: 1 });
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B' });
    r.setStatus(a.path, 'running');
    r.setStatus(a.path, 'waiting'); // 退位让额
    expect(r.activeCount()).toBe(0); // waiting 不占额度
    r.setStatus(b.path, 'running'); // b 拿走了额度
    // a 的提升走免检通道——额度本来自它等待的对象（kalo resume 免信号量同理）
    expect(() => r.promote(a.path)).not.toThrow();
    expect(r.snapshot(a.path)?.status).toBe('running');
  });

  it('parked（idle→waiting）排队本身不受闸门阻挡', () => {
    const r = mk({ maxConcurrent: 1 });
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B' });
    r.setStatus(a.path, 'running'); // 满员
    expect(() => r.setStatus(b.path, 'waiting')).not.toThrow(); // 排队成功
    expect(r.activeCount()).toBe(1); // 只有 running 在燃烧额度
    expect(r.snapshot(b.path)?.status).toBe('waiting');
  });

  it('promote 只接受 waiting 状态的 Agent', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    expect(() => r.promote(a.path)).toThrow(/只有 waiting/);
    r.setStatus(a.path, 'running');
    expect(() => r.promote(a.path)).toThrow(/只有 waiting/);
  });

  it('释放额度后可再启动', () => {
    const r = mk({ maxConcurrent: 1 });
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B' });
    r.setStatus(a.path, 'running');
    r.setStatus(a.path, 'done');
    expect(() => r.setStatus(b.path, 'running')).not.toThrow();
  });

  it('maxConcurrent=0 表示不限制', () => {
    const r = mk({ maxConcurrent: 0 });
    for (let i = 0; i < 20; i++) {
      const n = r.register({ role: `r${i}`, displayName: 'X' });
      r.setStatus(n.path, 'running');
    }
    expect(r.activeCount()).toBe(20);
  });

  it('spawn 不受并发限制，只有 running 受限', () => {
    // 允许建 10 个摆在树上（这是编排的表达），但同时烧 token 的不能超限
    const r = mk({ maxConcurrent: 1 });
    for (let i = 0; i < 10; i++) {
      expect(() => r.register({ role: `r${i}`, displayName: 'X' })).not.toThrow();
    }
  });
});

describe('AgentRegistry —— 用量汇总', () => {
  it('沿父链累加，根节点是全局总账', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    const b = r.register({ role: 'b', displayName: 'B', parent: a.path });

    r.addUsage(b.path, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    r.addUsage(a.path, { inputTokens: 3, outputTokens: 1, costUsd: 0.002 });

    expect(r.snapshot(b.path)?.usage.inputTokens).toBe(10);
    expect(r.snapshot(a.path)?.usage.inputTokens).toBe(13);
    expect(r.snapshot(ROOT_PATH)?.usage.inputTokens).toBe(13);
    expect(r.snapshot(ROOT_PATH)?.usage.costUsd).toBeCloseTo(0.012);
  });

  it('缺省字段按 0 处理', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    r.addUsage(a.path, { inputTokens: 7 });
    expect(r.snapshot(a.path)?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});

describe('AgentRegistry —— 快照隔离', () => {
  it('返回的快照改不动内部状态', () => {
    const r = mk();
    const a = r.register({ role: 'a', displayName: 'A' });
    const snap = r.snapshot(a.path)!;
    snap.status = 'failed';
    snap.children.push('/root/fake');
    // 拿到的是拷贝 —— 否则 IPC 序列化前的任何改动都会污染真相
    expect(r.snapshot(a.path)?.status).toBe('idle');
    expect(r.snapshot(a.path)?.children).toEqual([]);
  });
});

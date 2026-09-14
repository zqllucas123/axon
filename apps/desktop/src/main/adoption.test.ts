/**
 * AutoAdoption 资格校验单测（M4 决策 D2 的两条硬约束）。
 *
 * 这组用例是「把决策权交给 Agent」这个开关的安全底线：
 * 只要有一条失守，账本上的 adopted 就不再代表任何东西。
 */

import { describe, expect, it } from 'vitest';
import type { AdoptionPolicy, AgentSnapshot } from '@axon/protocol';
import { arbiterIneligibleReason, findArbiterByRole, resolveArbiter } from './adoption.ts';

function snap(path: string, role: string, createdAt: number): AgentSnapshot {
  return {
    path,
    role,
    displayName: role,
    status: 'idle',
    children: [],
    createdAt,
    updatedAt: createdAt,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    sessionId: path,
  };
}

function ctxOf(agents: AgentSnapshot[]) {
  return {
    agents: () => agents,
    exists: (p: string) => agents.some((a) => a.path === p),
  };
}

const RECORD = { from: '/root/planner-1', to: '/root/planner-1/developer-1' };

describe('arbiterIneligibleReason · 两条硬约束', () => {
  it('裁决者就是被裁决方 ⇒ 不合格（自己给自己发合格证）', () => {
    expect(arbiterIneligibleReason('/root/planner-1/developer-1', RECORD)).toMatch(
      /被裁决方/,
    );
  });

  it('裁决者是被裁决方的后代 ⇒ 不合格（下属给上级背书）', () => {
    expect(
      arbiterIneligibleReason('/root/planner-1/developer-1/helper-1', RECORD),
    ).toMatch(/后代/);
  });

  it('裁决者是发起方 ⇒ 合格：发起方判断成果好不好是正当的编排语义', () => {
    expect(arbiterIneligibleReason('/root/planner-1', RECORD)).toBeUndefined();
  });

  it('第三方裁决者 ⇒ 合格，且最干净', () => {
    expect(arbiterIneligibleReason('/root/aligner-1', RECORD)).toBeUndefined();
  });

  it('被裁决方的祖先（非 from）⇒ 合格', () => {
    expect(arbiterIneligibleReason('/root', RECORD)).toBeUndefined();
  });
});

describe('resolveArbiter · 策略解析', () => {
  const agents = [
    snap('/root/planner-1', 'planner', 100),
    snap('/root/planner-1/developer-1', 'developer', 200),
    snap('/root/aligner-1', 'aligner', 300),
  ];

  it('默认 human 策略直接回落人工', () => {
    expect(resolveArbiter({ mode: 'human' }, RECORD, ctxOf(agents))).toEqual({
      kind: 'human',
    });
  });

  it('按 path 指定且合格 ⇒ 交给该 Agent', () => {
    const policy: AdoptionPolicy = { mode: 'delegate', arbiter: '/root/aligner-1' };
    expect(resolveArbiter(policy, RECORD, ctxOf(agents))).toEqual({
      kind: 'agent',
      path: '/root/aligner-1',
    });
  });

  it('指定的 Agent 已不存在 ⇒ 回落人工并写明原因，不静默放过', () => {
    const policy: AdoptionPolicy = { mode: 'delegate', arbiter: '/root/ghost-1' };
    const r = resolveArbiter(policy, RECORD, ctxOf(agents));
    expect(r.kind).toBe('human');
    expect((r as { reason: string }).reason).toMatch(/不存在/);
  });

  it('指定的 Agent 不合格（就是被裁决方）⇒ 回落人工并写明原因', () => {
    const policy: AdoptionPolicy = {
      mode: 'delegate',
      arbiter: '/root/planner-1/developer-1',
    };
    const r = resolveArbiter(policy, RECORD, ctxOf(agents));
    expect(r.kind).toBe('human');
    expect((r as { reason: string }).reason).toMatch(/被裁决方/);
  });

  it('按角色指定 ⇒ 解析到该角色的实例', () => {
    const policy: AdoptionPolicy = { mode: 'delegate', arbiterRole: 'aligner' };
    expect(resolveArbiter(policy, RECORD, ctxOf(agents))).toEqual({
      kind: 'agent',
      path: '/root/aligner-1',
    });
  });

  it('角色无存活实例 ⇒ 回落人工并写明原因', () => {
    const policy: AdoptionPolicy = { mode: 'delegate', arbiterRole: 'reviewer' };
    const r = resolveArbiter(policy, RECORD, ctxOf(agents));
    expect(r.kind).toBe('human');
    expect((r as { reason: string }).reason).toMatch(/找不到角色/);
  });
});

describe('findArbiterByRole · 挑最早创建的实例', () => {
  it('多个同角色实例取最早的 —— 裁决者不该随每次 spawn 悄悄换人', () => {
    const agents = [
      snap('/root/aligner-3', 'aligner', 300),
      snap('/root/aligner-1', 'aligner', 100),
      snap('/root/aligner-2', 'aligner', 200),
    ];
    expect(findArbiterByRole(ctxOf(agents), 'aligner')).toBe('/root/aligner-1');
  });

  it('createdAt 相同时按 path 稳定排序，不靠 Map 顺序', () => {
    const agents = [snap('/root/b-1', 'aligner', 100), snap('/root/a-1', 'aligner', 100)];
    expect(findArbiterByRole(ctxOf(agents), 'aligner')).toBe('/root/a-1');
  });

  it('无匹配返回 undefined', () => {
    expect(findArbiterByRole(ctxOf([]), 'aligner')).toBeUndefined();
  });
});

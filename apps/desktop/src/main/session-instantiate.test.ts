/**
 * 团队 → 实例化计划 （MU-1 §八「纯函数/单测」）。
 *
 * 这里钉死三条规则（每一条都对应一个真实踩过的坑）：
 *  1. 覆写**只减不增**：工具求交、审批取更严；
 *  2. **父先于子**：拓扑排序在计划层做完，宿主不必二次判断；
 *  3. 覆写用复制而非原地改：角色定义是跨会话共享的常量。
 */

import { describe, expect, it } from 'vitest';
import type { AdhocMemberSpec, RoleDefinition, TeamDefinition } from '@axon/protocol';
import {
  adhocTasks,
  adhocTeam,
  effectiveMemberRole,
  planTeam,
  resolveParentNames,
  rosterPrompt,
  stricterApproval,
} from './session-instantiate.ts';

const LEAD: RoleDefinition = {
  name: 'lead',
  displayName: '团队主控',
  description: '',
  instructions: '你是主控。',
  tools: ['read', 'edit', 'agent_spawn'],
  approval: 'always_ask',
  defaultForkMode: 'all',
};

const DEV: RoleDefinition = {
  name: 'developer',
  displayName: '开发者',
  description: '',
  instructions: '你写代码。',
  tools: ['read', 'edit', 'bash'],
  approval: 'auto',
  defaultForkMode: 'none',
};

const ROLES = new Map([LEAD, DEV].map((r) => [r.name, r]));

function team(over: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    name: '全栈小队',
    description: '',
    members: [
      { name: '主控', role: 'lead', lead: true, description: '拆解与汇总' },
      { name: '开发者', role: 'developer' },
    ],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// 审批严格度
// ─────────────────────────────────────────────────────────────

describe('stricterApproval —— 只减不增', () => {
  it('always_ask > auto > full_access', () => {
    expect(stricterApproval('auto', 'always_ask')).toBe('always_ask');
    expect(stricterApproval('always_ask', 'auto')).toBe('always_ask');
    expect(stricterApproval('full_access', 'auto')).toBe('auto');
    expect(stricterApproval('auto', 'full_access')).toBe('auto');
  });

  it('同档返回自身', () => {
    expect(stricterApproval('auto', 'auto')).toBe('auto');
  });
});

// ─────────────────────────────────────────────────────────────
// 成员生效角色
// ─────────────────────────────────────────────────────────────

describe('effectiveMemberRole —— 覆写只能减能', () => {
  it('无覆写时就是角色定义（审批档落到全局缺省）', () => {
    const eff = effectiveMemberRole(DEV, { name: '开发者', role: 'developer' });
    expect(eff.tools).toEqual(['read', 'edit', 'bash']);
    expect(eff.approval).toBe('auto');
  });

  it('工具覆写与角色白名单求交（多出来的被吃掉）', () => {
    const eff = effectiveMemberRole(DEV, {
      name: '开发者',
      role: 'developer',
      overrides: { tools: ['read', 'bash', 'rm_rf'] },
    });
    expect(eff.tools).toEqual(['read', 'bash']);
  });

  it('审批覆写取更严者：想放宽也放不宽', () => {
    const looser = effectiveMemberRole(DEV, {
      name: '开发者',
      role: 'developer',
      overrides: { approval: 'full_access' },
    });
    expect(looser.approval).toBe('auto'); // DEV 自己就是 auto

    const stricter = effectiveMemberRole(DEV, {
      name: '开发者',
      role: 'developer',
      overrides: { approval: 'always_ask' },
    });
    expect(stricter.approval).toBe('always_ask');
  });

  it('角色没写审批档时用全局缺省，再与覆写取严', () => {
    const bare: RoleDefinition = { ...DEV, approval: undefined };
    expect(effectiveMemberRole(bare, { name: '开发者', role: 'developer' }).approval).toBe(
      'always_ask', // 没有 defaultApproval 时的兜底
    );
    expect(
      effectiveMemberRole(bare, { name: '开发者', role: 'developer' }, 'full_access').approval,
    ).toBe('full_access');
    expect(
      effectiveMemberRole(
        bare,
        { name: '开发者', role: 'developer', overrides: { approval: 'auto' } },
        'full_access',
      ).approval,
    ).toBe('auto');
  });

  it('覆写是复制：原角色定义不被污染（跨会话共享的常量）', () => {
    const before = { ...DEV };
    effectiveMemberRole(DEV, {
      name: '开发者',
      role: 'developer',
      overrides: { tools: ['read'], approval: 'always_ask', displayName: '临时工' },
    });
    expect(DEV).toEqual(before);
    // 原始数组也没被就地改
    expect(DEV.tools).toEqual(['read', 'edit', 'bash']);
  });

  it('forkMode 覆写落到 defaultForkMode', () => {
    const eff = effectiveMemberRole(DEV, {
      name: '开发者',
      role: 'developer',
      overrides: { forkMode: 'all' },
    });
    expect(eff.defaultForkMode).toBe('all');
  });
});

// ─────────────────────────────────────────────────────────────
// 编队 → 父子关系
// ─────────────────────────────────────────────────────────────

describe('resolveParentNames —— 形状决定父子', () => {
  it('star：除主控外全员挂会话根', () => {
    const m = resolveParentNames(team());
    expect(m.get('主控')).toBeUndefined();
    expect(m.get('开发者')).toBeUndefined();
  });

  it('chain：每人挂在前一个成员下（编队顺序即父子顺序）', () => {
    const m = resolveParentNames(
      team({
        formation: 'chain',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer' },
          { name: '测试', role: 'developer' },
        ],
      }),
    );
    expect(m.get('主控')).toBeUndefined();
    expect(m.get('开发者')).toBe('主控');
    expect(m.get('测试')).toBe('开发者');
  });

  it('custom：用成员自己写的 parent', () => {
    const m = resolveParentNames(
      team({
        formation: 'custom',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer' },
          { name: '测试', role: 'developer', parent: '开发者' },
        ],
      }),
    );
    expect(m.get('开发者')).toBeUndefined();
    expect(m.get('测试')).toBe('开发者');
  });
});

// ─────────────────────────────────────────────────────────────
// 计划
// ─────────────────────────────────────────────────────────────

describe('planTeam —— 计划与拓扑序', () => {
  it('主控单独拿出来（它是会话根，不是根的子节点）', () => {
    const plan = planTeam(team(), { roles: ROLES });
    expect(plan.lead.name).toBe('主控');
    expect(plan.lead.lead).toBe(true);
    expect(plan.members.map((m) => m.name)).toEqual(['开发者']);
    expect(plan.members[0]?.parentName).toBeUndefined();
  });

  it('parentName 用的是**成员名**（路径由宿主分配，计划层不臆测）', () => {
    const plan = planTeam(
      team({
        formation: 'custom',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer' },
          { name: '测试', role: 'developer', parent: '开发者' },
          { name: '文档', role: 'developer', parent: '测试' },
        ],
      }),
      { roles: ROLES },
    );
    // 必须先父后子
    expect(plan.members.map((m) => m.name)).toEqual(['开发者', '测试', '文档']);
    expect(plan.members.find((m) => m.name === '测试')?.parentName).toBe('开发者');
    expect(plan.members.find((m) => m.name === '文档')?.parentName).toBe('测试');
  });

  it('成员乱序也能排出正确的拓扑序（父先于子）', () => {
    const plan = planTeam(
      team({
        formation: 'custom',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '文档', role: 'developer', parent: '测试' },
          { name: '测试', role: 'developer', parent: '开发者' },
          { name: '开发者', role: 'developer' },
        ],
      }),
      { roles: ROLES },
    );
    expect(plan.members.map((m) => m.name)).toEqual(['开发者', '测试', '文档']);
  });

  it('角色不存在 ⇒ 抛（调用方应已用 validateTeam 拦过）', () => {
    expect(() =>
      planTeam(team({ members: [{ name: '主控', role: 'ghost', lead: true }] }), { roles: ROLES }),
    ).toThrow(/不存在的角色/);
  });

  it('tasks 表按成员名注入首条任务', () => {
    const plan = planTeam(team(), {
      roles: ROLES,
      tasks: new Map([['开发者', '把支付回调改成幂等']]),
    });
    expect(plan.members[0]?.task).toBe('把支付回调改成幂等');
    expect(plan.lead.task).toBeUndefined();
  });

  it('displayName 覆写优先于成员名；forkMode 来自生效角色', () => {
    const plan = planTeam(
      team({
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer', overrides: { displayName: '后端一号' } },
        ],
      }),
      { roles: ROLES },
    );
    expect(plan.members[0]?.displayName).toBe('后端一号');
    // lead 的 defaultForkMode 是 all（角色定义）
    expect(plan.lead.forkMode).toBe('all');
  });

  it('roles 传数组也行（角色表的两种形状都支持）', () => {
    const plan = planTeam(team(), { roles: [LEAD, DEV] });
    expect(plan.members).toHaveLength(1);
  });

  it('team 原样带出（摘要/UI 要引用它的 name 与 budget）', () => {
    const t = team();
    expect(planTeam(t, { roles: ROLES }).team).toBe(t);
  });
});

// ─────────────────────────────────────────────────────────────
// 临时编队
// ─────────────────────────────────────────────────────────────

describe('adhocTeam —— 临时编队转团队定义', () => {
  it('第一个成员当主控（没有显式 lead 字段）', () => {
    const t = adhocTeam([
      { role: 'lead' },
      { role: 'developer', name: '后端' },
      { role: 'developer', name: '测试' },
    ]);
    expect(t.members[0]).toMatchObject({ role: 'lead', lead: true, name: '主控' });
    expect(t.members[1]?.name).toBe('后端');
    expect(t.formation).toBe('star');
    expect(t.name).toBe('临时编队');
  });

  it('可跑同一条 planTeam 路径（两种执行方式共用实例化语义）', () => {
    const plan = planTeam(
      adhocTeam([{ role: 'lead' }, { role: 'developer', name: '后端' }]),
      { roles: ROLES },
    );
    expect(plan.lead.role.name).toBe('lead');
    expect(plan.members.map((m) => m.name)).toEqual(['后端']);
  });

  it('forkMode 覆写落成成员覆写（只减能那一套照旧）', () => {
    const t = adhocTeam([{ role: 'lead' }, { role: 'developer', forkMode: 'none' }]);
    expect(t.members[1]?.overrides?.forkMode).toBe('none');
  });

  it('adhocTasks 按「与 adhocTeam 同一套命名规则」生成任务表', () => {
    const specs: AdhocMemberSpec[] = [
      { role: 'lead', task: '先拆解' },
      { role: 'developer', name: '后端', task: '实现' },
      { role: 'developer' },
    ];
    const nameOf = (m: AdhocMemberSpec, i: number) => m.name ?? (i === 0 ? '主控' : m.role);
    const tasks = adhocTasks(specs, nameOf);
    expect(tasks.get('主控')).toBe('先拆解');
    expect(tasks.get('后端')).toBe('实现');
    expect(tasks.size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// roster
// ─────────────────────────────────────────────────────────────

describe('rosterPrompt —— 主控的运行期事实', () => {
  it('列出成员名、角色显示名与**实际路径**', () => {
    const plan = planTeam(team(), { roles: ROLES });
    const text = rosterPrompt('s1', [
      { plan: plan.lead, path: '/s1' },
      { plan: plan.members[0]!, path: '/s1/developer-1' },
    ]);
    expect(text).toContain('开发者（开发者）路径 /s1/developer-1');
    expect(text).toContain('会话 s1');
    // 成员带的 description 追加在路径之后（让主控知道谁能干什么）
    expect(text).toContain('主控（团队主控）路径 /s1 —— 拆解与汇总');
  });

  it('没有成员时只有抬头与尾注（单兵会话不注入它）', () => {
    const text = rosterPrompt('s1', []);
    expect(text.split('\n')).toHaveLength(2);
  });
});
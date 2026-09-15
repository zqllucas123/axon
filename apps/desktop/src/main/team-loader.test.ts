/**
 * TeamLoader 单测 —— 校验 / 合并 / IO 三条腿分开钉死（MU-1 §八）。
 *
 * 团队比角色多一层**结构**（lead、父子、权限交集链），所以这里有两组新守卫：
 *  - `lead-approval-too-loose`（修②）：主控不得是 auto/full_access ——
 *    它坐在穿透链顶端，宽一档等于把整队的 HITL 关掉；
 *  - `lead-tools-insufficient`：主控白名单必须是成员的超集，否则成员会被
 *    **悄悄**裁成只读（权限沿树求交），那是最难查的失败方式。
 */

import { describe, expect, it } from 'vitest';
import type { ApprovalMode, RoleDefinition, TeamDefinition } from '@axon/protocol';
import {
  TEAM_NAME_PATTERN,
  TeamLoader,
  hasBlockingIssue,
  mergeTeamFiles,
  resolvedApproval,
  resolvedTools,
  validateTeam,
  type TeamLoaderIO,
} from './team-loader.ts';

const LEAD: RoleDefinition = {
  name: 'lead',
  displayName: '团队主控',
  description: '',
  instructions: '你是主控。',
  tools: ['read', 'edit', 'bash'],
  approval: 'always_ask',
  defaultForkMode: 'all',
};

const DEV: RoleDefinition = {
  name: 'developer',
  displayName: '开发者',
  description: '',
  instructions: '你写代码。',
  tools: ['read', 'edit'],
  approval: 'auto',
  defaultForkMode: 'none',
};

const ROLES = [LEAD, DEV];
const ctx = { roles: ROLES };

const OK_TEAM: TeamDefinition = {
  name: '小队',
  description: '',
  members: [
    { name: '主控', role: 'lead', lead: true },
    { name: '开发者', role: 'developer' },
  ],
  formation: 'star',
};

const codes = (team: unknown, roles: RoleDefinition[] = ROLES) =>
  validateTeam(team, { roles }).map((i) => i.code);

// ─────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────

describe('validateTeam —— 形状与字段', () => {
  it('合法团队零问题', () => {
    expect(validateTeam(OK_TEAM, ctx)).toEqual([]);
  });

  it('非对象 / 空成员表直接返回', () => {
    expect(codes(null)).toEqual(['name-required']);
    expect(codes({ name: 'x', members: [] })).toEqual(['members-empty']);
    expect(codes({ name: 'x' })).toEqual(['members-empty']);
  });

  it('名字必填、不得含路径字符、不超 40 字', () => {
    expect(codes({ ...OK_TEAM, name: '' })).toContain('name-required');
    for (const bad of ['a/b', 'a\\b', 'a:b', 'x'.repeat(41)]) {
      expect(codes({ ...OK_TEAM, name: bad })).toContain('name-invalid');
    }
    expect(TEAM_NAME_PATTERN.test('全栈小队')).toBe(true);
  });

  it('成员数必须在 2~6 之间', () => {
    expect(codes({ ...OK_TEAM, members: [{ name: '主控', role: 'lead' }] })).toContain('member-limit');
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `m${i}`, role: 'developer' }));
    expect(codes({ ...OK_TEAM, members: seven })).toContain('member-limit');
  });

  it('成员名必填、不得含 "/"、不得重复', () => {
    expect(codes({ ...OK_TEAM, members: [{ name: '', role: 'lead' }, { name: 'a', role: 'dev' }] }))
      .toContain('member-name-invalid');
    expect(codes({ ...OK_TEAM, members: [{ name: 'a/b', role: 'lead' }, { name: 'c', role: 'developer' }] }))
      .toContain('member-name-invalid');
    expect(codes({ ...OK_TEAM, members: [{ name: '同', role: 'lead' }, { name: '同', role: 'developer' }] }))
      .toContain('member-name-duplicate');
  });

  it('角色不存在 ⇒ error 并定位到成员', () => {
    const issues = validateTeam(
      { ...OK_TEAM, members: [{ name: '主控', role: 'lead' }, { name: '幽灵', role: 'ghost' }] },
      ctx,
    );
    const issue = issues.find((i) => i.code === 'role-not-found');
    expect(issue?.level).toBe('error');
    expect(issue?.member).toBe('幽灵');
  });
});

describe('validateTeam —— 权限只减不增', () => {
  it('覆写工具越出类型白名单 ⇒ member-tools-escalation', () => {
    const issues = validateTeam(
      {
        ...OK_TEAM,
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer', overrides: { tools: ['read', 'edit', 'bash'] } },
        ],
      },
      ctx,
    );
    const issue = issues.find((i) => i.code === 'member-tools-escalation');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('bash');
  });

  it('覆写审批档更松 ⇒ approval-not-stricter', () => {
    // developer 是 auto，覆写 full_access 更松
    expect(
      codes({
        ...OK_TEAM,
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer', overrides: { approval: 'full_access' } },
        ],
      }),
    ).toContain('approval-not-stricter');
  });

  it('覆写更严 / 同等都合法', () => {
    for (const approval of ['always_ask', 'auto'] as ApprovalMode[]) {
      expect(
        codes({
          ...OK_TEAM,
          members: [
            { name: '主控', role: 'lead', lead: true },
            { name: '开发者', role: 'developer', overrides: { approval } },
          ],
        }),
      ).toEqual([]);
    }
  });

  it('forkMode 覆写要能被解析', () => {
    expect(
      codes({
        ...OK_TEAM,
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer', overrides: { forkMode: 'nope' as never } },
        ],
      }),
    ).toContain('invalid-value');
  });
});

describe('validateTeam —— 主控两条新规矩（修②）', () => {
  it('多个 lead ⇒ multiple-leads；没有 lead ⇒ warn 并用第一个兜底', () => {
    expect(
      validateTeam(
        {
          ...OK_TEAM,
          members: [
            { name: 'a', role: 'lead', lead: true },
            { name: 'b', role: 'developer', lead: true },
          ],
        },
        ctx,
      ).map((i) => i.code),
    ).toContain('multiple-leads');

    const warn = validateTeam(
      {
        ...OK_TEAM,
        members: [
          { name: '甲', role: 'lead' },
          { name: '乙', role: 'developer' },
        ],
      },
      ctx,
    );
    const issue = warn.find((i) => i.code === 'no-lead');
    expect(issue?.level).toBe('warn'); // 兜底能开工，不该拦人
    expect(issue?.message).toContain('甲');
  });

  it('主控解析为 auto / full_access ⇒ error（否则后代被静默代批）', () => {
    for (const approval of ['auto', 'full_access'] as ApprovalMode[]) {
      const issues = validateTeam(
        {
          ...OK_TEAM,
          members: [
            { name: '主控', role: 'developer', lead: true, overrides: { approval } },
            { name: '同行', role: 'developer' },
          ],
        },
        ctx,
      );
      expect(issues.find((i) => i.code === 'lead-approval-too-loose')?.level).toBe('error');
    }
  });

  it('主控白名单不含成员的能力 ⇒ lead-tools-insufficient', () => {
    const narrowLead: RoleDefinition = { ...LEAD, tools: ['read'] };
    const issues = validateTeam(OK_TEAM, { roles: [narrowLead, DEV] });
    const issue = issues.find((i) => i.code === 'lead-tools-insufficient');
    expect(issue?.level).toBe('error');
    expect(issue?.member).toBe('开发者');
    expect(issue?.message).toContain('edit');
  });

  it('主控不写工具白名单（= 不限制）时不报这条', () => {
    const wideLead: RoleDefinition = { ...LEAD, tools: undefined };
    expect(validateTeam(OK_TEAM, { roles: [wideLead, DEV] }).map((i) => i.code)).not.toContain(
      'lead-tools-insufficient',
    );
  });
});

describe('validateTeam —— 编队形状', () => {
  it('formation 非法值', () => {
    expect(codes({ ...OK_TEAM, formation: 'mesh' as never })).toContain('invalid-value');
  });

  it('custom 下 parent 不存在 / 指向自己 / 成环', () => {
    const base = (parent?: string, name = '开发者') => ({
      ...OK_TEAM,
      formation: 'custom' as const,
      members: [
        { name: '主控', role: 'lead', lead: true },
        { name, role: 'developer', ...(parent !== undefined ? { parent } : {}) },
      ],
    });
    expect(codes(base('ghost'))).toContain('parent-not-found');
    expect(codes(base('开发者'))).toContain('parent-cycle');

    // 成环：甲 → 乙 → 甲
    expect(
      codes({
        ...OK_TEAM,
        formation: 'custom',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '甲', role: 'developer', parent: '乙' },
          { name: '乙', role: 'developer', parent: '甲' },
        ],
      }),
    ).toContain('parent-cycle');
  });

  it('custom 下没写 parent ⇒ warn（挂会话根，不拦）', () => {
    const issues = validateTeam(
      {
        ...OK_TEAM,
        formation: 'custom',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer' },
        ],
      },
      ctx,
    );
    expect(issues.find((i) => i.code === 'formation-mismatch')?.level).toBe('warn');
  });

  it('非 custom 编队写了 parent ⇒ warn（明说它不生效，别让用户以为起作用了）', () => {
    const issues = validateTeam(
      {
        ...OK_TEAM,
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer', parent: '主控' },
        ],
      },
      ctx,
    );
    expect(issues.find((i) => i.code === 'formation-mismatch')?.level).toBe('warn');
  });

  it('chain 编队第一个不是主控 ⇒ warn（链头会挂空）', () => {
    const issues = validateTeam(
      {
        ...OK_TEAM,
        formation: 'chain',
        members: [
          { name: '开发者', role: 'developer' },
          { name: '主控', role: 'lead', lead: true },
        ],
      },
      ctx,
    );
    expect(issues.find((i) => i.code === 'formation-mismatch')?.message).toContain('第一个成员应是主控');
  });
});

describe('validateTeam —— 闸门与预算', () => {
  it('maxConcurrent 必须是 0~6 的数字', () => {
    expect(codes({ ...OK_TEAM, maxConcurrent: 3 })).toEqual([]);
    expect(codes({ ...OK_TEAM, maxConcurrent: 0 })).toEqual([]);
    for (const bad of [-1, 7, 'x' as never, Number.NaN]) {
      expect(codes({ ...OK_TEAM, maxConcurrent: bad })).toContain('invalid-value');
    }
  });

  it('预算非负；软线不得大于硬线', () => {
    expect(codes({ ...OK_TEAM, budget: { softUsd: 0.5, hardUsd: 1 } })).toEqual([]);
    expect(codes({ ...OK_TEAM, budget: { softUsd: -1 } })).toContain('invalid-value');
    expect(codes({ ...OK_TEAM, budget: { softUsd: 2, hardUsd: 1 } })).toContain('invalid-value');
    // hard=0 表示不设限，此时软线大于它不算错
    expect(codes({ ...OK_TEAM, budget: { softUsd: 2, hardUsd: 0 } })).toEqual([]);
  });

  it('defaultForkMode 要能被解析', () => {
    expect(codes({ ...OK_TEAM, defaultForkMode: 'none' })).toEqual([]);
    expect(codes({ ...OK_TEAM, defaultForkMode: 'bogus' as never })).toContain('invalid-value');
  });

  it('hasBlockingIssue 只认 error（warn 不拦）', () => {
    expect(hasBlockingIssue([{ level: 'warn', code: 'no-lead', message: '' }])).toBe(false);
    expect(hasBlockingIssue([{ level: 'error', code: 'no-lead', message: '' }])).toBe(true);
  });
});

describe('resolvedApproval / resolvedTools —— 生效值口径', () => {
  it('审批档：覆写 > 角色 > 全局缺省 > always_ask', () => {
    const m = { name: 'x', role: 'developer' };
    expect(resolvedApproval(DEV, m)).toBe('auto');
    expect(resolvedApproval(DEV, { ...m, overrides: { approval: 'always_ask' } })).toBe('always_ask');
    expect(resolvedApproval(undefined, m, 'auto')).toBe('auto');
    expect(resolvedApproval(undefined, m)).toBe('always_ask');
  });

  it('工具：覆写与角色求交；单边缺省时按另一边（不放大）', () => {
    expect(resolvedTools(DEV, { name: 'x', role: 'developer' })).toEqual(['read', 'edit']);
    expect(
      resolvedTools(DEV, { name: 'x', role: 'developer', overrides: { tools: ['edit', 'bash'] } }),
    ).toEqual(['edit']);
    expect(
      resolvedTools(undefined, { name: 'x', role: 'x', overrides: { tools: ['read'] } }),
    ).toEqual(['read']);
    expect(resolvedTools(undefined, { name: 'x', role: 'x' })).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 合并
// ─────────────────────────────────────────────────────────────

describe('mergeTeamFiles —— 内置 + 用户', () => {
  const builtin: TeamDefinition[] = [{ ...OK_TEAM, name: 'built-a', description: '内置' }];

  it('用户文件覆盖内置同名（带 overridesBuiltin）', () => {
    const { entries } = mergeTeamFiles(builtin, [
      { name: 'built-a', content: JSON.stringify({ ...OK_TEAM, name: 'built-a', description: '用户改的' }) },
    ], ctx);
    const e = entries.find((x) => x.team.name === 'built-a')!;
    expect(e.source).toBe('user');
    expect(e.overridesBuiltin).toBe(true);
    expect(e.team.description).toBe('用户改的');
  });

  it('坏 JSON ⇒ 一条 parse_error，其余照常生效', () => {
    const { entries, issues } = mergeTeamFiles(
      builtin,
      [{ name: 'broken', content: '{ nope' }, { name: 'good', content: JSON.stringify({ ...OK_TEAM, name: 'good' }) }],
      ctx,
    );
    expect(issues.some((i) => i.code === 'parse_error' && i.filePath === 'broken')).toBe(true);
    expect(entries.map((e) => e.team.name).sort()).toEqual(['built-a', 'good']);
  });

  it('半支队伍（有 error）不生效 —— 半个团队比没有团队更危险', () => {
    const { entries, issues } = mergeTeamFiles(
      builtin,
      [{ name: 'half', content: JSON.stringify({ ...OK_TEAM, name: 'half', members: [{ name: '主控', role: 'ghost' }] }) }],
      ctx,
    );
    expect(entries.find((e) => e.team.name === 'half')).toBeUndefined();
    expect(issues.some((i) => i.code === 'role-not-found' && i.filePath === 'half')).toBe(true);
  });

  it('文件名与文件内 name 不一致 ⇒ 跳过（文件名即身份）', () => {
    const { entries, issues } = mergeTeamFiles(
      builtin,
      [{ name: 'a', content: JSON.stringify({ ...OK_TEAM, name: 'b' }) }],
      ctx,
    );
    expect(entries.map((e) => e.team.name)).toEqual(['built-a']);
    expect(issues.some((i) => i.code === 'name-invalid' && i.filePath === 'a')).toBe(true);
  });

  it('内置团队自己的问题也报（坏了就是我们的 bug）', () => {
    const { issues } = mergeTeamFiles([{ ...OK_TEAM, name: 'bad-builtin', members: [] }], [], ctx);
    expect(issues.some((i) => i.filePath === '(内置)' && i.code === 'members-empty')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────────

/** 内存盘 IO；额外记录 rename 的来源（用来证明「先写临时文件再改名」）。 */
function memIO() {
  const files = new Map<string, string>();
  const renames: [string, string][] = [];
  const io: TeamLoaderIO = {
    readDir: async () => [...files.keys()].filter((n) => n.endsWith('.json')),
    readFile: async (p) => files.get(p.split('/').pop()!) ?? '',
    writeFile: async (p, data) => {
      files.set(p.split('/').pop()!, data);
    },
    rename: async (from, to) => {
      const content = files.get(from.split('/').pop()!);
      renames.push([from.split('/').pop()!, to.split('/').pop()!]);
      if (content === undefined) return;
      files.delete(from.split('/').pop()!);
      files.set(to.split('/').pop()!, content);
    },
    unlink: async (p) => {
      files.delete(p.split('/').pop()!);
    },
    mkdir: async () => undefined,
    watchDir: (_dir, cb) => cb, // 不需要真 watch：这里只测 IO 面
  };
  return {
    files,
    renames,
    io,
    drop: (name: string, content: string) => files.set(name, content),
  };
}

describe('TeamLoader —— IO 注入', () => {
  const builtin: TeamDefinition[] = [{ ...OK_TEAM, name: 'built-a' }];

  const makeLoader = (m: ReturnType<typeof memIO>, roles: RoleDefinition[] = ROLES) =>
    new TeamLoader({ dir: '/mem/teams', builtin, io: m.io, rolesProvider: () => roles });

  it('load 合并内存盘上的用户团队', async () => {
    const m = memIO();
    m.drop('my-team.json', JSON.stringify({ ...OK_TEAM, name: 'my-team' }));
    const loader = makeLoader(m);
    await loader.load();
    expect(loader.current().entries.map((e) => e.team.name).sort()).toEqual(['built-a', 'my-team']);
    expect(loader.get('my-team')?.name).toBe('my-team');
    expect(loader.get('ghost')).toBeUndefined();
  });

  it('save 先写临时文件再改名（原子写），并带 version 外箱', async () => {
    const m = memIO();
    const loader = makeLoader(m);
    await loader.load();

    const res = await loader.save({ ...OK_TEAM, name: 'ops' });
    expect(res.accepted).toBe(true);
    expect(m.renames).toHaveLength(1);
    const [from, to] = m.renames[0]!;
    expect(from).toMatch(/^ops\.json\.tmp-/);
    expect(to).toBe('ops.json');
    expect(JSON.parse(m.files.get('ops.json')!).version).toBe(1);
    // 临时文件不留在盘上
    expect([...m.files.keys()].filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(loader.get('ops')).toBeTruthy();
  });

  it('save 校验失败 ⇒ 不落盘（一个字节都不写）', async () => {
    const m = memIO();
    const loader = makeLoader(m);
    await loader.load();
    const res = await loader.save({ ...OK_TEAM, name: 'bad', members: [{ name: '主控', role: 'ghost' }] });
    expect(res.accepted).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(m.files.size).toBe(0);
  });

  it('save 名字非法（无法落盘）⇒ 拒', async () => {
    const m = memIO();
    const loader = makeLoader(m);
    const res = await loader.save({ ...OK_TEAM, name: 'a/b' });
    expect(res.accepted).toBe(false);
    expect(m.files.size).toBe(0);
  });

  it('remove 幂等（不存在也算已删除）', async () => {
    const m = memIO();
    const loader = makeLoader(m);
    await loader.load();
    await loader.save({ ...OK_TEAM, name: 'ops' });
    expect((await loader.remove('ops')).deleted).toBe(true);
    expect(loader.get('ops')).toBeUndefined();
    expect((await loader.remove('ops')).deleted).toBe(true);
  });

  it('目录读不了 ⇒ 退回内置（永不 throw）', async () => {
    const m = memIO();
    const loader = new TeamLoader({
      dir: '/mem/teams',
      builtin,
      rolesProvider: () => ROLES,
      io: { ...m.io, readDir: async () => Promise.reject(new Error('boom')) },
    });
    await loader.load();
    expect(loader.current().entries.map((e) => e.team.name)).toEqual(['built-a']);
  });

  it('rolesProvider 每次现取（角色热重载后团队校验用新表）', async () => {
    const m = memIO();
    m.drop('needs-dev.json', JSON.stringify({ ...OK_TEAM, name: 'needs-dev' }));
    let roles: RoleDefinition[] = [];
    const loader = new TeamLoader({
      dir: '/mem/teams',
      builtin: [],
      rolesProvider: () => roles,
      io: m.io,
    });
    await loader.load();
    // 角色表空 ⇒ 成员引用的类型都不存在 ⇒ 不生效
    expect(loader.current().entries).toEqual([]);
    expect(loader.current().issues.some((i) => i.code === 'role-not-found')).toBe(true);

    roles = ROLES;
    await loader.load();
    expect(loader.current().entries.map((e) => e.team.name)).toEqual(['needs-dev']);
  });
});
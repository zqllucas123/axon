/**
 * AxonHost 集成测试 —— 从「创建分身」到「级联删除」的完整闭环。
 *
 * 这一层测的是**三个维度的合成顺序**：角色 → 权限 → 上下文。
 * 单测 registry/fork 各自都对，但合起来顺序错了照样出错
 * （典型：先切上下文再算权限，导致子 Agent 拿到了父级不该给的工具）。
 *
 * 用 faux provider，所以零成本、无需 API key、结果确定。
 */

import { describe, expect, it } from 'vitest';
import { ROOT_PATH, type EventMap, type RoleDefinition } from '@axon/protocol';
import {
  createFauxSource,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  Type,
} from '@axon/kernel';
import { AxonHost } from './host.ts';

const ROLES: RoleDefinition[] = [
  {
    name: 'boss',
    displayName: '主管',
    description: '',
    instructions: '你是主管。',
    tools: ['peek', 'poke'],
    defaultForkMode: 'none',
  },
  {
    name: 'reader',
    displayName: '只读员',
    description: '',
    instructions: '你只能看。',
    tools: ['peek'],
    defaultForkMode: 'none',
  },
  {
    name: 'heir',
    displayName: '继承者',
    description: '',
    instructions: '你继承全部上下文。',
    tools: ['peek'],
    defaultForkMode: 'all',
  },
];

/** 两个可观测的工具：peek 无害，poke 代表有副作用的那类。 */
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

interface Harness {
  host: AxonHost;
  events: { event: keyof EventMap; source: string }[];
  calls: string[];
  setResponses: (r: unknown[]) => void;
}

async function harness(): Promise<Harness> {
  const src = await createFauxSource();
  const events: Harness['events'] = [];
  const calls: string[] = [];
  const host = new AxonHost({
    modelSource: src,
    roles: ROLES,
    tools: makeTools(calls),
    emit: (event, _payload, source) => events.push({ event, source }),
  });
  return { host, events, calls, setResponses: (r) => src.setResponses(r as never) };
}

describe('AxonHost —— 分身创建', () => {
  it('按角色创建，displayName 与状态正确', async () => {
    const h = await harness();
    const s = h.host.spawn({ role: 'boss' });
    expect(s.path).toBe('/root/boss-1');
    expect(s.displayName).toBe('主管');
    expect(s.status).toBe('idle');
    expect(s.parent).toBe(ROOT_PATH);
  });

  it('overrides 能改 displayName 而不落盘到角色', async () => {
    const h = await harness();
    h.host.spawn({ role: 'boss', overrides: { displayName: '临时主管' } });
    expect(h.host.list().find((s) => s.role === 'boss')?.displayName).toBe('临时主管');
    // 角色定义本身不受影响
    expect(h.host.listRoles().find((r) => r.role.name === 'boss')?.role.displayName).toBe('主管');
  });

  it('未知角色报错', async () => {
    const h = await harness();
    expect(() => h.host.spawn({ role: 'ghost' })).toThrow(/角色不存在/);
  });

  it('发出 agent.created 事件', async () => {
    const h = await harness();
    h.host.spawn({ role: 'boss' });
    expect(h.events.map((e) => e.event)).toContain('agent.created');
  });

  it('updateRoles 整表替换：用户角色可覆盖内置，且发 roles.changed', async () => {
    const h = await harness();
    const builtinBoss = ROLES.find((r) => r.name === 'boss')!;
    const builtinReader = ROLES.find((r) => r.name === 'reader')!;
    h.host.updateRoles([
      { role: builtinBoss, source: 'builtin' as const, errors: [] },
      {
        role: {
          ...builtinReader,
          displayName: '披着只读外套的主管',
          instructions: '覆盖后的指令',
          tools: ['poke'],
        },
        source: 'user' as const,
        overridesBuiltin: true,
        errors: [],
      },
    ]);

    const changed = h.events.filter((e) => e.event === 'roles.changed');
    expect(changed.length).toBe(1);

    // 覆盖生效：spawn 出来后指令/白名单用的是用户版本
    const reader = h.host.spawn({ role: 'reader' });
    expect(reader.displayName).toBe('披着只读外套的主管');
    expect(h.host.listRoles().find((r) => r.role.name === 'reader')?.overridesBuiltin).toBe(true);

    // 被新表替换掉的角色（heir 未在表中）不再可 spawn
    expect(() => h.host.spawn({ role: 'heir' })).toThrow(/角色不存在/);
  });

  it('内置角色条目默认 source=builtin 且 overridesBuiltin 缺省', async () => {
    const h = await harness();
    const boss = h.host.listRoles().find((r) => r.role.name === 'boss')!;
    expect(boss.source).toBe('builtin');
    expect(boss.overridesBuiltin).toBeUndefined();
    expect(boss.errors).toEqual([]);
  });

  it('updateRoles 后，已在跑的 Agent 不受影响', async () => {
    const h = await harness();
    h.setResponses([fauxAssistantMessage('首答')]);

    const boss = h.host.spawn({ role: 'boss' });
    await h.host.prompt(boss.path, 'x');

    // 换表之后，旧实例照常能继续跑（引擎/白名单都已快照在 spawn 时）
    h.host.updateRoles([]);
    h.setResponses([fauxAssistantMessage('次答')]);
    await expect(h.host.prompt(boss.path, 'y')).resolves.toBeUndefined();
    expect(h.host.list().find((s) => s.path === boss.path)?.status).toBe('done');
  });
});

describe('AxonHost —— 权限只能减不能加', () => {
  it('角色白名单外的工具被闸门拦下', async () => {
    const h = await harness();
    h.setResponses([
      fauxAssistantMessage([fauxText('我试试'), fauxToolCall('poke', {}, { id: 'c1' })]),
      fauxAssistantMessage('被拦了'),
    ]);

    const reader = h.host.spawn({ role: 'reader' });
    await h.host.prompt(reader.path, '去 poke 一下');

    // reader 只有 peek 权限，poke 的 execute 绝不该被调到
    expect(h.calls).not.toContain('poke');
  });

  it('白名单内的工具正常执行', async () => {
    const h = await harness();
    h.setResponses([
      fauxAssistantMessage([fauxText('看一眼'), fauxToolCall('peek', {}, { id: 'c1' })]),
      fauxAssistantMessage('看完了'),
    ]);

    const reader = h.host.spawn({ role: 'reader' });
    await h.host.prompt(reader.path, '看一眼');
    expect(h.calls).toContain('peek');
  });

  it('子角色不能越过父角色的权限', async () => {
    const h = await harness();
    h.setResponses([
      fauxAssistantMessage([fauxText('试试'), fauxToolCall('poke', {}, { id: 'c1' })]),
      fauxAssistantMessage('不行'),
    ]);

    // reader(只有 peek) 下挂一个 boss(声称要 peek+poke)
    const reader = h.host.spawn({ role: 'reader' });
    const child = h.host.spawn({ role: 'boss', parent: reader.path });
    await h.host.prompt(child.path, 'poke');

    // 交集后只剩 peek —— 角色配置里写了 poke 也不作数
    expect(h.calls).not.toContain('poke');
  });
});

describe('AxonHost —— 上下文分身语义', () => {
  it('默认 none：子 Agent 拿不到父的消息', async () => {
    const h = await harness();
    h.setResponses([fauxAssistantMessage('父的回答')]);

    const boss = h.host.spawn({ role: 'boss' });
    await h.host.prompt(boss.path, '父级的问题');
    expect(h.host.messagesOf(boss.path).length).toBeGreaterThan(0);

    const child = h.host.spawn({ role: 'reader', parent: boss.path });
    expect(h.host.messagesOf(child.path)).toEqual([]);
  });

  it('forkMode=all：子 Agent 继承父的消息', async () => {
    const h = await harness();
    h.setResponses([fauxAssistantMessage('父的回答')]);

    const boss = h.host.spawn({ role: 'boss' });
    await h.host.prompt(boss.path, '父级的问题');
    const parentLen = h.host.messagesOf(boss.path).length;

    const heir = h.host.spawn({ role: 'heir', parent: boss.path });
    expect(h.host.messagesOf(heir.path).length).toBe(parentLen);
  });

  it('显式 forkMode 覆盖角色默认值', async () => {
    const h = await harness();
    h.setResponses([fauxAssistantMessage('父的回答')]);

    const boss = h.host.spawn({ role: 'boss' });
    await h.host.prompt(boss.path, '父级的问题');

    // heir 默认 all，这里强制 none
    const heir = h.host.spawn({ role: 'heir', parent: boss.path, forkMode: 'none' });
    expect(h.host.messagesOf(heir.path)).toEqual([]);
  });

  it('继承是深拷贝：子的后续消息不污染父', async () => {
    const h = await harness();
    h.setResponses([
      fauxAssistantMessage('父的回答'),
      fauxAssistantMessage('子的回答'),
    ]);

    const boss = h.host.spawn({ role: 'boss' });
    await h.host.prompt(boss.path, '父级的问题');
    const before = h.host.messagesOf(boss.path).length;

    const heir = h.host.spawn({ role: 'heir', parent: boss.path });
    await h.host.prompt(heir.path, '子级追问');

    expect(h.host.messagesOf(heir.path).length).toBeGreaterThan(before);
    expect(h.host.messagesOf(boss.path).length).toBe(before);
  });
});

describe('AxonHost —— 生命周期', () => {
  it('prompt 成功后状态为 done，用量汇总到根', async () => {
    const h = await harness();
    h.setResponses([fauxAssistantMessage('好')]);

    const boss = h.host.spawn({ role: 'boss' });
    await h.host.prompt(boss.path, '问题');

    expect(h.host.get(boss.path)?.status).toBe('done');
    expect(h.host.get(ROOT_PATH)!.usage.inputTokens).toBeGreaterThan(0);
  });

  it('级联删除返回子先父后的路径', async () => {
    const h = await harness();
    const a = h.host.spawn({ role: 'boss' });
    const b = h.host.spawn({ role: 'reader', parent: a.path });
    expect(h.host.remove(a.path)).toEqual([b.path, a.path]);
    expect(h.host.list().map((s) => s.path)).toEqual([ROOT_PATH]);
  });

  it('execute 分发未知命令时报错', async () => {
    const h = await harness();
    await expect(h.host.execute('nope' as never, {} as never)).rejects.toThrow(
      /未实现的命令/,
    );
  });

  it('execute agent.prompt 立刻返回（不等模型）', async () => {
    const h = await harness();
    h.setResponses([fauxAssistantMessage('好')]);
    const boss = h.host.spawn({ role: 'boss' });
    // UI 不能被一轮模型调用卡住
    await expect(
      h.host.execute('agent.prompt', { path: boss.path, text: 'x' }),
    ).resolves.toEqual({ accepted: true });
  });
});

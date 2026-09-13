/**
 * RoleBridge 集成测试 —— 角色层 ↔ 宿主的接线逻辑（headless）。
 *
 * 钉住两条行为契约：
 * 1. save 后**立即**同步（不等 watch 防抖）—— UI 点保存要立刻看到。
 * 2. 相同状态去重 —— save 写盘会触发一次 watch，那次到达的状态
 *    与刚同步过的全等，必须被吞掉，否则 UI 收到双份 roles.changed。
 */

import { describe, expect, it } from 'vitest';
import type { RoleDefinition } from '@axon/protocol';
import type { RoleLoaderIO } from './role-loader.ts';
import { RoleBridge } from './role-bridge.ts';
import { AxonHost } from './host.ts';
import { createFauxSource } from '@axon/kernel';

const BUILTIN: RoleDefinition[] = [
  {
    name: 'tester',
    displayName: '官方测试员',
    description: 'x',
    instructions: '你是官方测试员，负责验证交付。',
  },
];

function memIO() {
  const files = new Map<string, string>();
  let watchCb: (() => void) | null = null;
  const io: RoleLoaderIO = {
    readDir: async () => [...files.keys()],
    readFile: async (p) => files.get(p.split('/').pop()!) ?? '',
    writeFile: async (p, data) => {
      files.set(p.split('/').pop()!, data);
    },
    rename: async (from, to) => {
      const content = files.get(from.split('/').pop()!);
      if (content !== undefined) {
        files.delete(from.split('/').pop()!);
        files.set(to.split('/').pop()!, content);
      }
    },
    unlink: async (p) => {
      files.delete(p.split('/').pop()!);
    },
    mkdir: async () => undefined,
    watchDir: (_dir, cb) => {
      watchCb = cb;
      return () => {
        watchCb = null;
      };
    },
  };
  return { files, io, trigger: () => watchCb?.() };
}

async function setup() {
  const events: string[] = [];
  const source = await createFauxSource();
  source.setResponses([]);
  const host = new AxonHost({
    modelSource: source,
    roles: BUILTIN,
    emit: (event) => {
      events.push(event);
    },
  });
  return { host, events };
}

describe('RoleBridge —— 初始化', () => {
  it('init 后内存盘的用户角色并入 host', async () => {
    const m = memIO();
    m.files.set(
      'ops.json',
      JSON.stringify({
        role: {
          name: 'ops',
          displayName: '运维',
          description: 'x',
          instructions: '你是运维分身，负责部署与诊断。',
          tools: ['bash'],
        },
      }),
    );
    const { host } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io });
    await bridge.init();

    const { entries, issues } = host.listRoles();
    expect(issues).toEqual([]);
    expect(entries.map((e) => e.role.name).sort()).toEqual(['ops', 'tester']);
    expect(entries.find((e) => e.role.name === 'ops')?.source).toBe('user');
  });
});

describe('RoleBridge —— 保存与去重', () => {
  it('save 成功后立即同步宿主（不等防抖）', async () => {
    const m = memIO();
    const { host, events } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io });
    await bridge.init();
    events.length = 0;

    const res = await bridge.save({
      name: 'dev',
      displayName: '开发',
      description: 'x',
      instructions: '你是开发分身，负责实现需求。',
      tools: ['bash', 'edit'],
    });
    expect(res.accepted).toBe(true);
    // 没有任何 timer 的情况下，save 返回后 host 已经可见 —— 这是「立即」的证明
    expect(host.listRoles().entries.some((e) => e.role.name === 'dev')).toBe(true);
    expect(events).toEqual(['roles.changed']);
  });

  it('save 触发的 watch 重载被去重吞掉（不产生第二份事件）', async () => {
    const m = memIO();
    const { host, events } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io });
    await bridge.init();
    events.length = 0;

    await bridge.save({
      name: 'dev',
      displayName: '开发',
      description: 'x',
      instructions: '你是开发分身，负责实现需求。',
    });

    // 模拟 save 写盘后 fs watch 触发的重载：状态与刚同步的全等
    await new Promise((r) => setTimeout(r, 0));
    m.trigger();
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e === 'roles.changed').length).toBe(1);
  });

  it('外部编辑（watch 路径）状态变化后照常同步', async () => {
    const m = memIO();
    const { host, events } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io, debounceMs: 1 });
    await bridge.init();
    events.length = 0;

    m.files.set(
      'hot.json',
      JSON.stringify({
        role: { name: 'hot', displayName: '热改', description: 'x', instructions: '热改进来的角色，负责临时任务。' },
      }),
    );
    m.trigger();
    await new Promise((r) => setTimeout(r, 20));

    expect(host.listRoles().entries.some((e) => e.role.name === 'hot')).toBe(true);
    expect(events).toContain('roles.changed');
  });

  it('save 校验失败：accepted=false 且不 sync、不落盘', async () => {
    const m = memIO();
    const { host, events } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io });
    await bridge.init();
    events.length = 0;

    const res = await bridge.save({
      name: 'Bad Name',
      displayName: '坏',
      description: 'x',
      instructions: '坏角色。',
    });
    expect(res.accepted).toBe(false);
    expect(events).toEqual([]);
    expect(host.listRoles().entries.length).toBe(1); // 只有内置
    expect([...m.files.keys()]).toEqual([]);
  });

  it('remove 后内置复活（覆盖撤销语义）', async () => {
    const m = memIO();
    const { host } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io });
    await bridge.init();

    await bridge.save({
      name: 'tester',
      displayName: '自定义测试员',
      description: 'x',
      instructions: '你是自定义测试员。',
    });
    expect(
      host.listRoles().entries.find((e) => e.role.name === 'tester')?.overridesBuiltin,
    ).toBe(true);

    await bridge.remove('tester');
    const tester = host.listRoles().entries.find((e) => e.role.name === 'tester')!;
    expect(tester.source).toBe('builtin');
    expect(tester.role.displayName).toBe('官方测试员');
  });

  it('dispose 后 watch 不再触发同步', async () => {
    const m = memIO();
    const { host, events } = await setup();
    const bridge = new RoleBridge({ dir: '/mem/roles', builtinRoles: BUILTIN, host, io: m.io, debounceMs: 1 });
    await bridge.init();

    bridge.dispose();
    events.length = 0;
    m.files.set(
      'late.json',
      JSON.stringify({
        role: { name: 'late', displayName: '迟', description: 'x', instructions: '迟到的角色，负责收尾事务。' },
      }),
    );
    m.trigger();
    await new Promise((r) => setTimeout(r, 20));
    expect(host.listRoles().entries.some((e) => e.role.name === 'late')).toBe(false);
    expect(events).toEqual([]);
  });
});
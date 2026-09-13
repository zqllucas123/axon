/**
 * RoleLoader 单测 —— 校验 / 合并 / IO 三条腿分开钉死。
 *
 * 核心保护对象是「坏文件隔离」：用户手写 JSON 必然出错，
 * 一个坏文件的任何错误形态（烂 JSON / 缺字段 / 非法枚举值）
 * 都只能换来一条 RoleIssue，绝不能把加载流程炸掉。
 * 这是 M2 验收标准里「坏 JSON 不影响其它角色」的回归守卫。
 */

import { describe, expect, it } from 'vitest';
import type {
  ApprovalMode,
  RoleDefinition,
  RoleEntry,
  RoleIssue,
} from '@axon/protocol';
import {
  mergeRoleFiles,
  validateRole,
  RoleLoader,
  type RoleFile,
  type RoleLoaderIO,
} from './role-loader.ts';

const BASE: RoleDefinition = {
  name: 'heir',
  displayName: '继承人',
  description: '继承一切的分身',
  instructions: '你是继承一切的分身，延续之前的工作。',
  tools: ['read', 'peek'],
  approval: 'always_ask',
  defaultForkMode: 'none',
};

describe('validateRole —— 校验纯函数', () => {
  it('合法角色零问题', () => {
    expect(validateRole(BASE)).toEqual([]);
  });

  it('可选字段全缺也是合法（内置兜底语义）', () => {
    expect(
      validateRole({
        name: 'mini',
        displayName: '迷你',
        description: 'x',
        instructions: '你是一个迷你角色。',
      }),
    ).toEqual([]);
  });

  it('name 必须小写字母开头', () => {
    for (const bad of ['Tester', 'test er', 'a/b', '', 3, '-lead']) {
      expect(validateRole({ ...BASE, name: bad as never }).length > 0).toBe(true);
    }
    expect(validateRole({ ...BASE, name: 'dev-ops_2' })).toEqual([]);
  });

  it('非对象直接一条问题返回', () => {
    expect(validateRole('nope')[0]?.code).toBe('validation');
    expect(validateRole(null)[0]?.code).toBe('validation');
  });

  it('必填字段空串非法', () => {
    for (const field of ['displayName', 'description', 'instructions'] as const) {
      expect(validateRole({ ...BASE, [field]: '' }).length > 0).toBe(true);
    }
  });

  it('approval 只认三个枚举值', () => {
    expect(validateRole({ ...BASE, approval: 'auto' as ApprovalMode })).toEqual([]);
    for (const bad of ['never', 'yes', '']) {
      expect(validateRole({ ...BASE, approval: bad as never }).length > 0).toBe(true);
    }
  });

  it('defaultForkMode 用 parseForkMode 校验：非法值报错，合法全过', () => {
    for (const bad of ['inherit', '0', '1.5', '3abc']) {
      expect(validateRole({ ...BASE, defaultForkMode: bad }).length > 0).toBe(true);
    }
    for (const ok of ['none', 'all', '3', 5, undefined, null]) {
      expect(validateRole({ ...BASE, defaultForkMode: ok as never })).toEqual([]);
    }
  });

  it('tools / shellAllow 必须是字符串数组', () => {
    expect(validateRole({ ...BASE, tools: [1, 'read'] as never }).length > 0).toBe(true);
    expect(validateRole({ ...BASE, tools: 'read' as never }).length > 0).toBe(true);
    expect(validateRole({ ...BASE, shellAllow: ['git'] })).toEqual([]);
  });
});

describe('mergeRoleFiles —— 合并纯函数', () => {
  const builtin: RoleDefinition[] = [
    { ...BASE, name: 'tester', displayName: '官方测试员' },
  ];

  it('坏 JSON 只出一行 issue，好文件不受牵连', () => {
    const files: RoleFile[] = [
      { name: 'broken', content: '{ oops' },
      { name: 'heir', content: JSON.stringify({ role: BASE }) },
    ];
    const { entries, issues } = mergeRoleFiles(builtin, files);
    expect(issues[0]?.code).toBe('parse_error');
    expect(issues[0]?.file).toBe('broken');
    expect(entries.find((e) => e.role.name === 'heir')?.source).toBe('user');
    expect(entries.find((e) => e.role.name === 'tester')).toBeTruthy();
  });

  it('校验失败的文件被跳过，不产生条目', () => {
    const files: RoleFile[] = [
      { name: 'bad', content: JSON.stringify({ role: { ...BASE, approval: 'never' } }) },
    ];
    const { entries, issues } = mergeRoleFiles(builtin, files);
    expect(entries.find((e) => e.role.name === 'bad')).toBeUndefined();
    expect(issues.some((i) => i.file === 'bad')).toBe(true);
  });

  it('支持不带 version 外壳的裸 role 对象（前向容忍）', () => {
    const files: RoleFile[] = [
      { name: 'heir', content: JSON.stringify({ role: BASE }) },
      { name: 'bare', content: JSON.stringify({ ...BASE, name: 'bare' }) },
    ];
    const { entries } = mergeRoleFiles([], files);
    expect(entries.map((e) => e.role.name).sort()).toEqual(['bare', 'heir']);
  });

  it('用户覆盖内置：overridesBuiltin=true，内容换成用户版', () => {
    const files: RoleFile[] = [
      {
        name: 'tester',
        content: JSON.stringify({
          role: { ...BASE, name: 'tester', displayName: '自定义测试员' },
        }),
      },
    ];
    const { entries } = mergeRoleFiles(builtin, files);
    const tester = entries.find((e) => e.role.name === 'tester')!;
    expect(tester.source).toBe('user');
    expect(tester.overridesBuiltin).toBe(true);
    expect(tester.role.displayName).toBe('自定义测试员');
  });

  it('文件名与文件内 name 不一致 → 跳过 + issue（文件名即身份）', () => {
    const files: RoleFile[] = [
      { name: 'alien', content: JSON.stringify({ role: { ...BASE, name: 'heir' } }) },
    ];
    const { entries, issues } = mergeRoleFiles([], files);
    expect(entries).toEqual([]);
    expect(issues.some((i) => i.file === 'alien')).toBe(true);
  });

  it('文件名与文件内 name 不一致 → 跳过 + issue（文件名即身份）', () => {
    const files: RoleFile[] = [
      { name: 'alien', content: JSON.stringify({ role: { ...BASE, name: 'heir' } }) },
    ];
    const { entries, issues } = mergeRoleFiles([], files);
    expect(entries).toEqual([]);
    expect(issues.some((i) => i.file === 'alien')).toBe(true);
  });

  it('两个不同文件不可能产生重名条目（文件名=身份 的不变量）', () => {
    // dup.json 里 role.name=dup、dup2.json 里 role.name=dup2，各自合法；
    // 若 dup2.json 里写 name=dup，会被「文件名不一致」规则跳过。
    const files: RoleFile[] = [
      { name: 'dup', content: JSON.stringify({ role: { ...BASE, name: 'dup' } }) },
      { name: 'dup2', content: JSON.stringify({ role: { ...BASE, name: 'dup' } }) },
    ];
    const { entries, issues } = mergeRoleFiles([], files);
    expect(entries.map((e) => e.role.name)).toEqual(['dup']);
    expect(issues.some((i) => i.file === 'dup2')).toBe(true);
  });
});

describe('RoleLoader —— IO 注入', () => {
  /** 内存文件系统 + 事件触发的 watch。 */
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
    return {
      files,
      io,
      trigger: () => watchCb?.(),
      /** 直接往内存盘塞一个文件（模拟外部编辑器保存）。 */
      drop: (name: string, content: string) => files.set(name, content),
    };
  }

  const builtin: RoleDefinition[] = [{ ...BASE, name: 'built-a', displayName: '内置A' }];

  it('load 合并内存盘文件', async () => {
    const m = memIO();
    m.drop(
      'user-a.json',
      JSON.stringify({ role: { ...BASE, name: 'user-a', displayName: '用户A' } }),
    );
    const loader = new RoleLoader({ dir: '/mem/roles', builtin, io: m.io });
    await loader.load();
    const names = loader.current().entries.map((e) => e.role.name).sort();
    expect(names).toEqual(['built-a', 'user-a']);
  });

  it('save 落盘 version=1 外箱 + 重载', async () => {
    const m = memIO();
    const loader = new RoleLoader({ dir: '/mem/roles', builtin, io: m.io });
    await loader.load();

    const custom: RoleDefinition = { ...BASE, name: 'ops', displayName: '运维' };
    const res = await loader.save(custom);
    expect(res.accepted).toBe(true);
    expect([...m.files.keys()]).toContain('ops.json');
    const raw = JSON.parse(m.files.get('ops.json')!);
    expect(raw.version).toBe(1);
    expect(raw.role.name).toBe('ops');
    expect(loader.current().entries.find((e) => e.role.name === 'ops')).toBeTruthy();
  });

  it('save 校验失败不落盘', async () => {
    const m = memIO();
    const loader = new RoleLoader({ dir: '/mem/roles', builtin, io: m.io });
    await loader.load();
    const res = await loader.save({ ...BASE, name: 'Bad Name' });
    expect(res.accepted).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect([...m.files.keys()]).toEqual([]);
  });

  it('remove 幂等：不存在也 deleted:true', async () => {
    const m = memIO();
    const loader = new RoleLoader({ dir: '/mem/roles', builtin, io: m.io });
    await loader.load();
    const res = await loader.remove('ghost');
    expect(res.deleted).toBe(true);
  });

  it('目录读失败退化为内置（兜底不崩）', async () => {
    const { files, io } = memIO();
    const broken: RoleLoaderIO = { ...io, readDir: async () => Promise.reject(new Error('boom')) };
    void files;
    const loader = new RoleLoader({ dir: '/mem/roles', builtin, io: broken });
    await loader.load();
    expect(loader.current().entries[0]?.role.displayName).toBe('内置A');
  });

  it('watch 防抖后触发 onChange（用假 IO 直接踢回调）', async () => {
    const m = memIO();
    const loader = new RoleLoader({
      dir: '/mem/roles',
      builtin,
      io: m.io,
      debounceMs: 1,
    });
    await loader.load();
    const seen: string[] = [];
    const dispose = loader.watch((state) => seen.push(state.entries.length.toString()));

    m.drop('extra.json', JSON.stringify({ role: { ...BASE, name: 'extra', displayName: 'E' } }));
    m.trigger();
    await new Promise((r) => setTimeout(r, 15));
    expect(seen).toEqual(['2']);
    dispose();
    m.trigger();
    await new Promise((r) => setTimeout(r, 15));
    expect(seen).toEqual(['2']);
  });
});
/**
 * ProjectStore 单测 —— 创建 / 重载 / 坏文件隔离 / 空项目（项目模块 §验证）。
 *
 * 用可注入 IO 的内存实现（照 team-loader.test 的做法），不碰真盘：
 * 项目的排序、id≠文件名的拒绝、坏 JSON 隔离这些边界靠穷举验证最稳。
 */

import { describe, expect, it } from 'vitest';
import { mergeProjectFiles, ProjectStore, type ProjectStoreIO } from './project-store.ts';

/** 内存 IO：一个 Map 当磁盘（key = 文件名，value = 内容）。 */
function memIO(files: Record<string, string> = {}): ProjectStoreIO & { files: Map<string, string> } {
  const disk = new Map<string, string>(Object.entries(files));
  return {
    files: disk,
    readDir: async () => [...disk.keys()],
    readFile: async (p) => {
      const name = p.split('/').pop()!;
      const v = disk.get(name);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (p, data) => {
      disk.set(p.split('/').pop()!, data);
    },
    rename: async (from, to) => {
      const f = from.split('/').pop()!;
      const t = to.split('/').pop()!;
      disk.set(t, disk.get(f)!);
      disk.delete(f);
    },
    mkdir: async () => {},
    watchDir: () => () => {},
  };
}

describe('ProjectStore · 创建与重载', () => {
  it('创建项目返回稳定 id + 保留 name/cwd，重载后仍在', async () => {
    const io = memIO();
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    const res = await s.create({ name: 'Axon 桌面端', cwd: '/works/axon' });
    expect(res.accepted).toBe(true);
    expect(res.project?.id).toMatch(/^p-/);
    expect(res.project?.name).toBe('Axon 桌面端');
    expect(res.project?.cwd).toBe('/works/axon');

    // 用同一份磁盘新建 store 重载：项目还在（持久化）。
    const s2 = new ProjectStore({ dir: '/projects', io });
    await s2.load();
    expect(s2.current().entries.map((p) => p.name)).toEqual(['Axon 桌面端']);
    expect(s2.get(res.project!.id)?.cwd).toBe('/works/axon');
  });

  it('空名/空工作空间被拒，不落盘', async () => {
    const io = memIO();
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    const bad = await s.create({ name: '  ', cwd: '/x' });
    expect(bad.accepted).toBe(false);
    expect(bad.errors.some((e) => e.level === 'error')).toBe(true);
    expect(io.files.size).toBe(0);

    const bad2 = await s.create({ name: 'ok', cwd: '   ' });
    expect(bad2.accepted).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it('同 cwd 的多个项目可共存（id 区分身份）', async () => {
    const io = memIO();
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    const a = await s.create({ name: '前端', cwd: '/works/mono' });
    const b = await s.create({ name: '后端', cwd: '/works/mono' });
    expect(a.project!.id).not.toBe(b.project!.id);
    expect(s.current().entries.length).toBe(2);
  });

  it('空项目（零会话）始终在列表里（与会话无关）', async () => {
    const io = memIO();
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    await s.create({ name: '空项目', cwd: '/works/empty' });
    expect(s.current().entries.map((p) => p.name)).toEqual(['空项目']);
  });
});

describe('mergeProjectFiles · 坏文件隔离', () => {
  it('坏 JSON 转一条 issue，不打瘸其它项目', () => {
    const good = JSON.stringify({
      version: 1,
      project: { id: 'p-good', name: '好项目', cwd: '/w', createdAt: 1, updatedAt: 1 },
    });
    const state = mergeProjectFiles([
      { name: 'p-good', content: good },
      { name: 'p-bad', content: '{ nope' },
    ]);
    expect(state.entries.map((p) => p.id)).toEqual(['p-good']);
    expect(state.issues.some((i) => i.code === 'parse-error' && i.filePath === 'p-bad')).toBe(true);
  });

  it('文件名与项目 id 不一致时拒绝（文件名即身份）', () => {
    const content = JSON.stringify({
      project: { id: 'p-real', name: 'x', cwd: '/w', createdAt: 1, updatedAt: 1 },
    });
    const state = mergeProjectFiles([{ name: 'p-other', content }]);
    expect(state.entries).toEqual([]);
    expect(state.issues.some((i) => i.code === 'invalid-project')).toBe(true);
  });

  it('按 createdAt 升序稳定排序', () => {
    const mk = (id: string, at: number) =>
      JSON.stringify({ project: { id, name: id, cwd: '/w', createdAt: at, updatedAt: at } });
    const state = mergeProjectFiles([
      { name: 'p-b', content: mk('p-b', 200) },
      { name: 'p-a', content: mk('p-a', 100) },
    ]);
    expect(state.entries.map((p) => p.id)).toEqual(['p-a', 'p-b']);
  });
});

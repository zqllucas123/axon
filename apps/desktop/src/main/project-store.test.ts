/**
 * ProjectStore 单测 —— 创建 / 重载 / 坏文件隔离 / 空项目（项目模块 §验证）。
 *
 * 用可注入 IO 的内存实现（照 team-loader.test 的做法），不碰真盘：
 * 项目的排序、id≠文件名的拒绝、坏 JSON 隔离这些边界靠穷举验证最稳。
 */

import { describe, expect, it } from 'vitest';
import { basename, join } from 'node:path';
import { mergeProjectFiles, ProjectStore, type ProjectStoreIO } from './project-store.ts';

/**
 * 内存 IO：一个 Map 当「项目目录」磁盘（key = 文件名，value = 内容）。
 *
 * `existingPaths` 是**另一套**东西 —— 模拟项目目录**之外**的真实文件系统，
 * 目前只有 git 校验要看的那一个路径（`<cwd>/.git`）。与 disk 分开是因为
 * 两者根目录不同：项目文件在 `/projects` 下，git 仓库在用户自己的工作目录下。
 */
function memIO(
  files: Record<string, string> = {},
  existingPaths: string[] = [],
): ProjectStoreIO & { files: Map<string, string> } {
  const disk = new Map<string, string>(Object.entries(files));
  const realFs = new Set(existingPaths);
  return {
    files: disk,
    readDir: async () => [...disk.keys()],
    // 文件名一律用 basename 取，**不要用 `p.split('/')`**：store 内部拼路径走的是
    // `join(dir, name)`，在 Windows 上那产生的是反斜杠路径，按 '/' 切会整段留下来，
    // 于是磁盘里永远查不到 —— 本文件三个重载用例原先就是这么一路红着的。
    readFile: async (p) => {
      const v = disk.get(basename(p));
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (p, data) => {
      disk.set(basename(p), data);
    },
    rename: async (from, to) => {
      const f = basename(from);
      const t = basename(to);
      disk.set(t, disk.get(f)!);
      disk.delete(f);
    },
    mkdir: async () => {},
    exists: async (p) => realFs.has(p),
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

  it('类别缺省是 local，且不校验 .git', async () => {
    const io = memIO(); // existingPaths 空 = 磁盘上哪儿都没有 .git
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    const res = await s.create({ name: '普通项目', cwd: '/works/plain' });
    expect(res.accepted).toBe(true);
    expect(res.project?.kind).toBe('local');
  });

  it('git 项目：目录不含 .git 时拒绝创建，不落盘', async () => {
    const io = memIO();
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    const res = await s.create({ name: 'GIT 项目', cwd: '/works/plain', kind: 'git' });
    expect(res.accepted).toBe(false);
    expect(res.errors.some((e) => e.code === 'invalid-project' && e.message.includes('git init'))).toBe(true);
    expect(io.files.size).toBe(0);
  });

  it('git 项目：目录含 .git 时创建成功，kind 落盘并可重载', async () => {
    // 用 join 拼而不是写死 '/works/repo/.git'：create() 里查的是 join(cwd, '.git')，
    // 在 Windows 上那是反斜杠路径，写死正斜杠会永远对不上（同文件里那几个
    // 既有的重载用例就栽在这上面）。
    const io = memIO({}, [join('/works/repo', '.git')]);
    const s = new ProjectStore({ dir: '/projects', io });
    await s.load();
    const res = await s.create({ name: 'GIT 项目', cwd: '/works/repo', kind: 'git' });
    expect(res.accepted).toBe(true);
    expect(res.project?.kind).toBe('git');

    const s2 = new ProjectStore({ dir: '/projects', io });
    await s2.load();
    expect(s2.current().entries[0]?.kind).toBe('git');
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

  it('老项目文件没有 kind：补 local，**不当坏数据**', () => {
    // 这是升级路径的关键一条：kind 是后加的字段，已有用户的
    // ~/.axon/projects/*.json 全都没有它。若按「缺字段 = 坏数据」处理，
    // 升级后项目列表会整个变空 —— 比不显示分支严重得多。
    const content = JSON.stringify({
      version: 1,
      project: { id: 'p-old', name: '老项目', cwd: '/w', createdAt: 1, updatedAt: 1 },
    });
    const state = mergeProjectFiles([{ name: 'p-old', content }]);
    expect(state.entries.map((p) => p.kind)).toEqual(['local']);
    expect(state.issues).toEqual([]);
  });

  it('kind 写了非法值才算坏数据', () => {
    const content = JSON.stringify({
      project: { id: 'p-x', name: 'x', cwd: '/w', kind: 'svn', createdAt: 1, updatedAt: 1 },
    });
    const state = mergeProjectFiles([{ name: 'p-x', content }]);
    expect(state.entries).toEqual([]);
    expect(state.issues.some((i) => i.code === 'invalid-project' && i.message.includes('项目类别'))).toBe(true);
  });
});

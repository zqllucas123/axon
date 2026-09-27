/**
 * 叶子工具单测（M8）—— 注入内存版假 ops，验证纯逻辑：
 * cwd 收敛越权拒绝、read 截断/区间、edit 唯一匹配、grep/glob 过滤、bash 退出码。
 */

import { describe, expect, it } from 'vitest';
import type { AgentTool } from '../index.ts';
import { createLeafTools } from './index.ts';
import type { BashExecOptions, BashResult, LeafOperations } from './ops.ts';
import { PathEscapeError } from './path-utils.ts';

const CWD = '/work/session';

/** 内存文件系统 + 可编排的 exec，绝对路径为键。 */
function fakeOps(
  files: Record<string, string>,
  execImpl?: (cmd: string, o: BashExecOptions) => BashResult,
): LeafOperations {
  const store = new Map<string, string>(Object.entries(files));
  const isDir = (p: string) => [...store.keys()].some((k) => k.startsWith(p.replace(/\/?$/, '/')));
  return {
    readFile: async (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return Buffer.from(v, 'utf-8');
    },
    writeFile: async (p, data) => {
      store.set(p, data);
    },
    access: async (p) => {
      if (!store.has(p)) throw new Error('ENOENT');
    },
    stat: async (p) => {
      const v = store.get(p);
      if (v !== undefined) return { isFile: true, isDirectory: false, size: v.length };
      if (isDir(p)) return { isFile: false, isDirectory: true, size: 0 };
      throw new Error('ENOENT');
    },
    readdir: async (p) => {
      const base = p.replace(/\/?$/, '/');
      const seen = new Map<string, boolean>();
      for (const k of store.keys()) {
        if (!k.startsWith(base)) continue;
        const rest = k.slice(base.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, false);
        else seen.set(rest.slice(0, slash), true);
      }
      if (seen.size === 0 && !isDir(p)) throw new Error('ENOTDIR');
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    exec: async (cmd, o) =>
      execImpl?.(cmd, o) ?? { stdout: '', stderr: '', exitCode: 0, killed: false },
  };
}

type LeafName = 'read' | 'edit' | 'write' | 'ls' | 'glob' | 'grep' | 'bash';

function toolMap(tools: AgentTool[]): Record<LeafName, AgentTool> {
  return Object.fromEntries(tools.map((t) => [t.name, t])) as Record<LeafName, AgentTool>;
}

/** 取第一段文本内容（叶子工具只回文本），非文本则空串，兼顾 tsc 收窄。 */
function txt(r: { content: Array<{ type: string; text?: string }> }): string {
  const c = r.content[0];
  return c && c.type === 'text' ? (c.text ?? '') : '';
}

describe('createLeafTools —— 装配', () => {
  it('造出 read/ls/glob/grep/edit/write/bash 七件', () => {
    const names = createLeafTools(CWD, fakeOps({})).map((t) => t.name).sort();
    expect(names).toEqual(['bash', 'edit', 'glob', 'grep', 'ls', 'read', 'write']);
  });
});

describe('cwd 收敛 —— 越权一律拒绝', () => {
  it('read/edit/write/ls 对 ../ 逃逸抛 PathEscapeError', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps({ '/work/session/a.txt': 'x' })));
    await expect(t.read.execute('1', { path: '../secret' })).rejects.toBeInstanceOf(PathEscapeError);
    await expect(
      t.edit.execute('1', { path: '../../etc/passwd', old_string: 'a', new_string: 'b' }),
    ).rejects.toBeInstanceOf(PathEscapeError);
    await expect(t.write.execute('1', { path: '/etc/evil', content: 'x' })).rejects.toBeInstanceOf(
      PathEscapeError,
    );
    await expect(t.ls.execute('1', { path: '..' })).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe('read', () => {
  it('读全文', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps({ '/work/session/a.txt': 'hello\nworld' })));
    const r = await t.read.execute('1', { path: 'a.txt' });
    expect(txt(r)).toBe('hello\nworld');
  });

  it('offset/limit 取行区间', async () => {
    const t = toolMap(
      createLeafTools(CWD, fakeOps({ '/work/session/a.txt': 'l1\nl2\nl3\nl4\nl5' })),
    );
    const r = await t.read.execute('1', { path: 'a.txt', offset: 2, limit: 2 });
    expect(txt(r)).toBe('l2\nl3');
  });

  it('文件不存在报错', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps({})));
    await expect(t.read.execute('1', { path: 'nope.txt' })).rejects.toThrow(/不存在/);
  });
});

describe('edit', () => {
  it('唯一匹配替换', async () => {
    const ops = fakeOps({ '/work/session/a.txt': 'foo bar baz' });
    const t = toolMap(createLeafTools(CWD, ops));
    const r = await t.edit.execute('1', { path: 'a.txt', old_string: 'bar', new_string: 'BAR' });
    expect(r.details).toMatchObject({ replaced: 1 });
    expect((await ops.readFile('/work/session/a.txt')).toString()).toBe('foo BAR baz');
  });

  it('多匹配且未 replace_all 报错、不改盘', async () => {
    const ops = fakeOps({ '/work/session/a.txt': 'x x x' });
    const t = toolMap(createLeafTools(CWD, ops));
    await expect(
      t.edit.execute('1', { path: 'a.txt', old_string: 'x', new_string: 'y' }),
    ).rejects.toThrow(/非唯一/);
    expect((await ops.readFile('/work/session/a.txt')).toString()).toBe('x x x');
  });

  it('replace_all 放开多匹配', async () => {
    const ops = fakeOps({ '/work/session/a.txt': 'x x x' });
    const t = toolMap(createLeafTools(CWD, ops));
    const r = await t.edit.execute('1', {
      path: 'a.txt',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    });
    expect(r.details).toMatchObject({ replaced: 3 });
    expect((await ops.readFile('/work/session/a.txt')).toString()).toBe('y y y');
  });

  it('零匹配报错', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps({ '/work/session/a.txt': 'foo' })));
    await expect(
      t.edit.execute('1', { path: 'a.txt', old_string: 'zzz', new_string: 'y' }),
    ).rejects.toThrow(/未找到/);
  });
});

describe('write', () => {
  it('写入并报字节数', async () => {
    const ops = fakeOps({});
    const t = toolMap(createLeafTools(CWD, ops));
    const r = await t.write.execute('1', { path: 'new.txt', content: 'héllo' });
    expect(txt(r)).toMatch(/6 字节/); // é = 2 字节
    expect((await ops.readFile('/work/session/new.txt')).toString()).toBe('héllo');
  });
});

describe('ls', () => {
  it('目录在前、按名排序', async () => {
    const t = toolMap(
      createLeafTools(
        CWD,
        fakeOps({
          '/work/session/b.txt': '',
          '/work/session/a.txt': '',
          '/work/session/sub/c.txt': '',
        }),
      ),
    );
    const r = await t.ls.execute('1', {});
    expect(txt(r)).toBe('sub/\na.txt\nb.txt');
  });
});

describe('glob', () => {
  it('** 递归匹配 .ts', async () => {
    const t = toolMap(
      createLeafTools(
        CWD,
        fakeOps({
          '/work/session/src/a.ts': '',
          '/work/session/src/deep/b.ts': '',
          '/work/session/src/c.js': '',
        }),
      ),
    );
    const r = await t.glob.execute('1', { pattern: 'src/**/*.ts' });
    expect(txt(r).split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });
});

describe('grep', () => {
  const files = {
    '/work/session/a.ts': 'const TODO = 1\nother',
    '/work/session/b.js': 'todo lower',
    '/work/session/c.ts': 'nothing here',
  };

  it('正则命中，返回 文件:行号:内容', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps(files)));
    const r = await t.grep.execute('1', { pattern: 'TODO' });
    expect(txt(r)).toBe('a.ts:1:const TODO = 1');
    expect(r.details).toMatchObject({ matches: 1 });
  });

  it('ignore_case + include 过滤', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps(files)));
    const r = await t.grep.execute('1', { pattern: 'todo', ignore_case: true, include: '*.js' });
    expect(txt(r)).toBe('b.js:1:todo lower');
  });

  it('无匹配', async () => {
    const t = toolMap(createLeafTools(CWD, fakeOps(files)));
    const r = await t.grep.execute('1', { pattern: 'zzz' });
    expect(txt(r)).toBe('（无匹配）');
  });
});

describe('bash', () => {
  it('cwd 固定为会话目录', async () => {
    let seen = '';
    const t = toolMap(
      createLeafTools(CWD, fakeOps({}, (_c, o) => {
        seen = o.cwd;
        return { stdout: '/work/session', stderr: '', exitCode: 0, killed: false };
      })),
    );
    const r = await t.bash.execute('1', { command: 'pwd' });
    expect(seen).toBe(CWD);
    expect(txt(r)).toBe('/work/session');
    expect(r.details).toMatchObject({ exitCode: 0 });
  });

  it('非零退出码与 stderr 都体现', async () => {
    const t = toolMap(
      createLeafTools(CWD, fakeOps({}, () => ({
        stdout: '',
        stderr: 'boom',
        exitCode: 2,
        killed: false,
      }))),
    );
    const r = await t.bash.execute('1', { command: 'false' });
    expect(txt(r)).toMatch(/\[stderr\]\nboom/);
    expect(txt(r)).toMatch(/\[退出码 2\]/);
  });

  it('被杀（超时/取消）给出提示', async () => {
    const t = toolMap(
      createLeafTools(CWD, fakeOps({}, () => ({
        stdout: '',
        stderr: '',
        exitCode: null,
        killed: true,
      }))),
    );
    const r = await t.bash.execute('1', { command: 'sleep 999' });
    expect(txt(r)).toMatch(/被终止/);
    expect(r.details).toMatchObject({ killed: true });
  });

  it('timeout 限制在上限内', async () => {
    let seenTimeout = -1;
    const t = toolMap(
      createLeafTools(CWD, fakeOps({}, (_c, o) => {
        seenTimeout = o.timeoutMs ?? -1;
        return { stdout: '', stderr: '', exitCode: 0, killed: false };
      })),
    );
    await t.bash.execute('1', { command: 'x', timeout: 9_999_999 });
    expect(seenTimeout).toBe(600_000);
  });
});

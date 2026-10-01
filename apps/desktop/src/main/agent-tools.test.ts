import { describe, expect, it, vi } from 'vitest';
import type { DetectedAgentTool } from '@axon/protocol';
import {
  AgentToolsRegistry,
  detectAgentTools,
  parseCache,
  parseVersion,
  type CacheIO,
  type DetectIO,
} from './agent-tools.ts';

function fakeIO(over: Partial<DetectIO> & { files?: string[] } = {}): DetectIO {
  const files = new Set(over.files ?? []);
  return {
    platform: 'darwin',
    home: '/Users/me',
    env: { PATH: '/usr/bin:/bin' },
    loginShellPath: async () => null,
    listDir: async () => [],
    isExecutable: async (p) => files.has(p),
    runVersion: async () => null,
    ...over,
  };
}

function memCache(initial: string | null = null): CacheIO & { data: string | null; writes: number } {
  const c = {
    data: initial,
    writes: 0,
    read: async () => c.data,
    write: async (_p: string, d: string) => {
      c.data = d;
      c.writes += 1;
    },
  };
  return c;
}

const CLAUDE: DetectedAgentTool = {
  id: 'claude',
  label: 'Claude Code',
  installed: true,
  path: '/x/claude',
  version: '2.1.0',
  runnable: true,
};
const missing = (id: DetectedAgentTool['id'], label: string): DetectedAgentTool => ({
  id,
  label,
  installed: false,
  path: null,
  version: null,
  runnable: false,
});
/** 只装了 Claude 时的全量结果。 */
const ONLY_CLAUDE: DetectedAgentTool[] = [
  CLAUDE,
  missing('codex', 'Codex'),
  missing('gemini', 'Gemini CLI'),
  missing('opencode', 'Opencode'),
  missing('hermes', 'Hermes'),
];
const installed = (tools: DetectedAgentTool[]) => tools.filter((t) => t.installed);

describe('parseVersion', () => {
  it('从常见输出里抠出 semver', () => {
    expect(parseVersion('2.1.3 (Claude Code)\n')).toBe('2.1.3');
    expect(parseVersion('codex-cli 0.46.0')).toBe('0.46.0');
    expect(parseVersion('\n  v1.2.3-beta.1\n')).toBe('1.2.3-beta.1');
  });
  it('没有版本号就取首行；空输出为 null', () => {
    expect(parseVersion('dev build')).toBe('dev build');
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
});

describe('detectAgentTools', () => {
  it('登录 shell 的 PATH 优先；没装的也有条目（installed: false）', async () => {
    const io = fakeIO({
      loginShellPath: async () => '/Users/me/.nvm/bin:/usr/bin',
      files: ['/Users/me/.nvm/bin/claude', '/usr/bin/claude', '/usr/bin/codex'],
      runVersion: async (p) => (p.endsWith('claude') ? '2.0.1 (Claude Code)' : 'codex-cli 0.40.0'),
    });
    const tools = await detectAgentTools(io);
    expect(tools).toEqual([
      { id: 'claude', label: 'Claude Code', installed: true, path: '/Users/me/.nvm/bin/claude', version: '2.0.1', runnable: true },
      // 装了但 Axon 还没接入 ⇒ 不可选
      { id: 'codex', label: 'Codex', installed: true, path: '/usr/bin/codex', version: '0.40.0', runnable: false },
      missing('gemini', 'Gemini CLI'),
      missing('opencode', 'Opencode'),
      missing('hermes', 'Hermes'),
    ]);
  });

  it('GUI 启动 PATH 极简时，靠常见安装目录兜底', async () => {
    const io = fakeIO({ files: ['/Users/me/.local/bin/claude', '/opt/homebrew/bin/opencode'] });
    const ids = installed(await detectAgentTools(io)).map((t) => t.id);
    expect(ids).toEqual(['claude', 'opencode']);
  });

  it('登录 shell 拿不到 PATH 时，仍能找到 nvm 版本目录里的工具（取最新版本）', async () => {
    const io = fakeIO({
      listDir: async (p) => (p === '/Users/me/.nvm/versions/node' ? ['v9.0.0', 'v24.1.0', 'v18.2.0'] : []),
      files: ['/Users/me/.nvm/versions/node/v18.2.0/bin/codex', '/Users/me/.nvm/versions/node/v24.1.0/bin/codex'],
    });
    expect(installed(await detectAgentTools(io)).map((t) => t.path)).toEqual([
      '/Users/me/.nvm/versions/node/v24.1.0/bin/codex',
    ]);
  });

  it('--version 跑不出来不影响「已安装」判定', async () => {
    const io = fakeIO({
      files: ['/bin/gemini'],
      runVersion: async () => {
        throw new Error('boom');
      },
    });
    expect(installed(await detectAgentTools(io))).toEqual([
      { id: 'gemini', label: 'Gemini CLI', installed: true, path: '/bin/gemini', version: null, runnable: false },
    ]);
  });

  it('跑 --version 时带上合并后的 PATH（node 脚本要能找到 node）', async () => {
    const runVersion = vi.fn(async () => '1.0.0');
    const io = fakeIO({ loginShellPath: async () => '/nvm/bin', files: ['/nvm/bin/claude'], runVersion });
    await detectAgentTools(io);
    expect(runVersion).toHaveBeenCalledWith('/nvm/bin/claude', expect.stringMatching(/^\/nvm\/bin:\/usr\/bin:\/bin:/));
  });

  it('Windows 按 PATHEXT 补扩展名', async () => {
    const io = fakeIO({
      platform: 'win32',
      env: { Path: 'C:/npm', PATHEXT: '.EXE;.CMD' },
      files: ['C:/npm/codex.cmd'],
    });
    expect(installed(await detectAgentTools(io)).map((t) => t.path)).toEqual(['C:/npm/codex.cmd']);
  });
});

describe('parseCache', () => {
  it('形状 / 版本不对一律当作没缓存', () => {
    expect(parseCache(null)).toBeNull();
    expect(parseCache('not json')).toBeNull();
    expect(parseCache(JSON.stringify({ schema: 999, detectedAt: 1, tools: [] }))).toBeNull();
    expect(parseCache(JSON.stringify({ schema: 2, detectedAt: 1, tools: [{ id: 'nope', path: '/x' }] }))).toBeNull();
    // 旧版缓存（schema 1，只存已装的）作废重探。
    expect(parseCache(JSON.stringify({ schema: 1, detectedAt: 1, tools: [] }))).toBeNull();
  });
  it('按代码里的清单重建：展示名以代码为准，缓存里没有的工具记为未安装', () => {
    const raw = JSON.stringify({ schema: 2, detectedAt: 5, tools: [{ ...CLAUDE, label: '旧名字' }] });
    expect(parseCache(raw)).toEqual({ detectedAt: 5, tools: ONLY_CLAUDE });
  });
});

describe('AgentToolsRegistry', () => {
  it('有缓存：直接就绪，不探测', async () => {
    const detect = vi.fn(async () => []);
    const cache = memCache(JSON.stringify({ schema: 2, detectedAt: 7, tools: ONLY_CLAUDE }));
    const reg = new AgentToolsRegistry({ cachePath: '/c.json', detect, cacheIO: cache });
    await reg.init();
    expect(reg.snapshot()).toEqual({ status: 'ready', detectedAt: 7, tools: ONLY_CLAUDE });
    expect(detect).not.toHaveBeenCalled();
  });

  it('首次启动：后台探测 → 广播 → 落盘；下次启动读缓存', async () => {
    const cache = memCache();
    const seen: string[] = [];
    let finish!: (t: DetectedAgentTool[]) => void;
    const reg = new AgentToolsRegistry({
      cachePath: '/c.json',
      detect: () => new Promise((r) => (finish = r)),
      cacheIO: cache,
      now: () => 42,
      onChange: (s) => seen.push(s.status),
    });
    await reg.init();
    expect(reg.snapshot().status).toBe('detecting');
    finish(ONLY_CLAUDE);
    await vi.waitFor(() => expect(cache.writes).toBe(1));
    expect(reg.snapshot()).toEqual({ status: 'ready', detectedAt: 42, tools: ONLY_CLAUDE });
    expect(seen).toEqual(['detecting', 'ready']);

    const detect2 = vi.fn(async () => []);
    const reg2 = new AgentToolsRegistry({ cachePath: '/c.json', detect: detect2, cacheIO: cache });
    await reg2.init();
    expect(reg2.snapshot().tools).toEqual(ONLY_CLAUDE);
    expect(detect2).not.toHaveBeenCalled();
  });

  it('redetect 并发调用共享同一次探测', async () => {
    const detect = vi.fn(async () => [CLAUDE]);
    const reg = new AgentToolsRegistry({ cachePath: '/c.json', detect, cacheIO: memCache() });
    const [a, b] = await Promise.all([reg.redetect(), reg.redetect()]);
    expect(a).toBe(b);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('探测抛错不会卡在 detecting，保留旧结果', async () => {
    const cache = memCache(JSON.stringify({ schema: 2, detectedAt: 1, tools: ONLY_CLAUDE }));
    const reg = new AgentToolsRegistry({
      cachePath: '/c.json',
      detect: async () => {
        throw new Error('boom');
      },
      cacheIO: cache,
    });
    await reg.init();
    const snap = await reg.redetect();
    expect(snap.status).toBe('ready');
    expect(snap.tools).toEqual(ONLY_CLAUDE);
  });
});

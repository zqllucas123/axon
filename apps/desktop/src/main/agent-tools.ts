/**
 * 本机外部 Agent 工具探测（Claude Code / Codex / Gemini / Opencode / Hermes）。
 *
 * 回答「装没装、在哪、什么版本、Axon 能不能用它跑会话」，供新建会话的「执行引擎」popover
 * （探测方法对齐 tutti 的 runtimecmd/resolver.go + userShellEnv.ts）。
 * 真正拉起它跑会话在 engine-claude.ts。
 *
 * ── 为什么只探测一次 ──
 *
 * 探测要起一个登录 shell 拿 PATH、再对每个命中的工具跑 `--version`，冷启动
 * 动辄一两秒。装没装 Agent 工具是「几周变一次」的事实，没理由每次启动都付这笔账。
 * 所以结果落盘（默认 ~/.axon/agent-tools.json），之后启动直接读；用户装了新工具
 * 就点「重新检测」（`redetect`）。缓存坏了 / 不存在 ⇒ 当作首次启动，后台重探。
 *
 * ── 为什么要起登录 shell 拿 PATH ──
 *
 * 从 Finder / Dock 启动的 GUI 应用继承的是 launchd 的极简 PATH
 * （/usr/bin:/bin:/usr/sbin:/sbin），nvm、Homebrew、~/.local/bin 全都不在里面 ——
 * 而 `claude`、`codex` 恰恰多半装在这些地方。只查 `process.env.PATH` 会在开发态
 * （从终端起）一切正常、打包后「什么都没探到」。登录 shell 的 PATH 再兜一层常见目录。
 *
 * 本模块不依赖 electron（与 host.ts 同一纪律），IO 全部可注入，单测不碰真文件系统。
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AgentToolId, AgentToolsSnapshot, DetectedAgentTool } from '@axon/protocol';

/** 认得的工具：id → 展示名 + 可执行文件名。顺序即 popover 里的展示顺序。 */
export const KNOWN_AGENT_TOOLS: ReadonlyArray<{
  id: AgentToolId;
  label: string;
  bin: string;
  /** Axon 已接入它的运行时（能用它执行会话）。接一个新引擎 = 这里置 true + 实现它的 AxonEngine。 */
  supported?: boolean;
}> = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', supported: true },
  { id: 'codex', label: 'Codex', bin: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini' },
  { id: 'opencode', label: 'Opencode', bin: 'opencode' },
  { id: 'hermes', label: 'Hermes', bin: 'hermes' },
];

/** 缓存文件的格式版本：改了形状就加一，旧缓存自动作废重探。 */
const CACHE_SCHEMA = 2;

/** 登录 shell / `--version` 的超时：卡住的 rc 文件或工具不能把探测吊死。 */
const SHELL_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5000;

/**
 * PATH 之外再兜的常见安装目录（相对 home）。清单对齐 tutti 的
 * `runtimecmd/resolver.go`：登录 shell 取 PATH 失败（rc 文件卡住 / 超时）时，
 * 靠这一层仍能找到装在版本管理器目录里的工具。
 */
const EXTRA_DIRS_POSIX = [
  '.local/bin',
  'bin',
  '.claude/local',
  '.opencode/bin',
  '.bun/bin',
  '.npm-global/bin',
  '.n/bin',
  'n/bin',
  '.volta/bin',
  '.asdf/shims',
  '.mise/shims',
  'Library/pnpm',
  '.cargo/bin',
];
const EXTRA_ABS_DIRS_POSIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
/** 版本管理器的「每个 node 版本一个 bin」目录：<home>/<root>/<版本>/<suffix>。 */
const NODE_VERSION_ROOTS = [
  { root: '.nvm/versions/node', suffix: 'bin' },
  { root: '.fnm/node-versions', suffix: 'installation/bin' },
];

/** 探测用到的全部外部能力（单测注入假的）。 */
export interface DetectIO {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** 登录 shell 的 PATH；拿不到返回 null。 */
  loginShellPath(): Promise<string | null>;
  /** 列目录下的条目名；目录不存在返回空数组。 */
  listDir(path: string): Promise<string[]>;
  /** 路径是可执行的普通文件。 */
  isExecutable(path: string): Promise<boolean>;
  /** 跑 `<path> --version`，返回 stdout；失败返回 null。 */
  runVersion(path: string, pathEnv: string): Promise<string | null>;
}

const run = (
  file: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv; shell?: boolean },
): Promise<string | null> =>
  new Promise((res) => {
    execFile(file, args, { ...opts, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      res(err ? null : String(stdout));
    });
  });

/** 包住 PATH 的哨兵：交互式 rc 文件可能往 stdout 打印欢迎语，靠哨兵把 PATH 抠出来。 */
const PATH_MARK = '__AXON_PATH__';

export const nodeDetectIO: DetectIO = {
  platform: process.platform,
  home: homedir(),
  env: process.env,
  async loginShellPath() {
    if (process.platform === 'win32') return null; // Windows GUI 进程本就继承完整用户 PATH
    const shell = process.env.SHELL || '/bin/zsh';
    const cmd = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`;
    // -i：nvm 之类常写在 .zshrc/.bashrc（只有交互式才读）；-l：读 profile。
    // 按 shell 取参数（抄 tutti userShellEnv.ts）：fish 不认合写的 -lic；
    // 其余不认识的 shell 不敢加 -i（可能直接进交互挂住），只用 -lc。
    const name = basename(shell);
    const args =
      name === 'zsh' || name === 'bash'
        ? ['-lic', cmd]
        : name === 'fish'
          ? ['-l', '-i', '-c', cmd]
          : ['-lc', cmd];
    const out = await run(shell, args, { timeout: SHELL_TIMEOUT_MS });
    const m = out?.match(new RegExp(`${PATH_MARK}(.*?)${PATH_MARK}`, 's'));
    return m?.[1] ?? null;
  },
  async listDir(path) {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
  async isExecutable(path) {
    try {
      const st = await stat(path);
      if (!st.isFile()) return false;
      if (process.platform !== 'win32') await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  runVersion(path, pathEnv) {
    // 工具多是 `#!/usr/bin/env node` 脚本：PATH 里没有 node 就跑不起来，所以带上合并后的 PATH。
    // Windows 上 npm 装出来的是 .cmd，execFile 不经 shell 跑不了 .cmd。
    const win = process.platform === 'win32';
    return run(win ? `"${path}"` : path, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      env: { ...process.env, PATH: pathEnv },
      shell: win,
    });
  },
};

/** 从 `--version` 输出里抠版本号：优先 semver 样式，抠不到就取首行（截断）。 */
export function parseVersion(stdout: string | null): string | null {
  if (!stdout) return null;
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const m = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  if (m) return m[0];
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** PATH 分隔符按目标平台取（不用 node:path 的 delimiter：单测要能在 mac 上模拟 Windows）。 */
const pathSep = (io: DetectIO): string => (io.platform === 'win32' ? ';' : ':');

/** 版本管理器下各 node 版本的 bin 目录，新版本在前（装了多个版本时取最新的那份）。 */
async function nodeVersionBinDirs(io: DetectIO): Promise<string[]> {
  const out: string[] = [];
  for (const { root, suffix } of NODE_VERSION_ROOTS) {
    const base = join(io.home, root);
    const versions = (await io.listDir(base)).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    out.push(...versions.map((v) => join(base, v, suffix)));
  }
  return out;
}

/** 合并后的搜索目录：登录 shell PATH → 进程 PATH → 常见目录，去重保序。 */
async function searchDirs(io: DetectIO, shellPath: string | null): Promise<string[]> {
  const parts: string[] = [];
  const sep = pathSep(io);
  if (shellPath) parts.push(...shellPath.split(sep));
  const envPath = io.env.PATH ?? io.env.Path ?? '';
  parts.push(...envPath.split(sep));
  if (io.platform !== 'win32') {
    parts.push(
      ...EXTRA_DIRS_POSIX.map((d) => join(io.home, d)),
      ...(await nodeVersionBinDirs(io)),
      ...EXTRA_ABS_DIRS_POSIX,
    );
  }
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}

/** 一个工具在某目录下可能的文件名（Windows 要按 PATHEXT 补扩展名）。 */
function binNames(io: DetectIO, bin: string): string[] {
  if (io.platform !== 'win32') return [bin];
  const exts = (io.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...exts.map((e) => `${bin}${e}`), `${bin}.ps1`];
}

/** 探测一遍，返回**全量**已知工具（没装的 `installed: false`）。永不抛错：任何一步失败都只是「少探到一个」。 */
export async function detectAgentTools(io: DetectIO = nodeDetectIO): Promise<DetectedAgentTool[]> {
  const shellPath = await io.loginShellPath().catch(() => null);
  const dirs = await searchDirs(io, shellPath);
  const pathEnv = dirs.join(pathSep(io));

  return Promise.all(
    KNOWN_AGENT_TOOLS.map(async (t): Promise<DetectedAgentTool> => {
      for (const dir of dirs) {
        for (const name of binNames(io, t.bin)) {
          const p = join(dir, name);
          if (await io.isExecutable(p)) {
            const version = parseVersion(await io.runVersion(p, pathEnv).catch(() => null));
            return { id: t.id, label: t.label, installed: true, path: p, version, runnable: t.supported === true };
          }
        }
      }
      return { id: t.id, label: t.label, installed: false, path: null, version: null, runnable: false };
    }),
  );
}

let userPathMemo: Promise<string> | null = null;

/**
 * 用户在终端里拿到的那条 PATH（登录 shell + 常见安装目录兜底），本进程算一次。
 *
 * 拉起外部 Agent 工具时要用：从 Dock 启动的 Axon 继承的是极简 PATH，而 npm 装的
 * `claude` 是 `#!/usr/bin/env node` 脚本 —— 子进程里找不到 node 就起不来。
 */
export function userSearchPath(io: DetectIO = nodeDetectIO): Promise<string> {
  if (io === nodeDetectIO && userPathMemo) return userPathMemo;
  const p = (async () => {
    const shellPath = await io.loginShellPath().catch(() => null);
    return (await searchDirs(io, shellPath)).join(pathSep(io));
  })();
  if (io === nodeDetectIO) userPathMemo = p;
  return p;
}

/** 缓存文件读写（单测注入内存版）。 */
export interface CacheIO {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
}

export const nodeCacheIO: CacheIO = {
  async read(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async write(path, data) {
    // tmp + rename：写到一半崩掉不会留下半截 JSON（那会让下次启动当成坏缓存重探，
    // 不致命，但没必要）。
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${Date.now()}`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  },
};

const KNOWN_IDS = new Set<string>(KNOWN_AGENT_TOOLS.map((t) => t.id));

/** 解析缓存；形状不对 / 版本不对一律返回 null（= 当作没缓存）。 */
export function parseCache(raw: string | null): { detectedAt: number; tools: DetectedAgentTool[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { schema?: unknown; detectedAt?: unknown; tools?: unknown };
    if (v.schema !== CACHE_SCHEMA || typeof v.detectedAt !== 'number' || !Array.isArray(v.tools)) return null;
    const byId = new Map<string, { path: string; version: string | null }>();
    for (const t of v.tools as Array<Record<string, unknown>>) {
      if (typeof t?.id !== 'string' || !KNOWN_IDS.has(t.id)) return null;
      if (typeof t.path === 'string') {
        byId.set(t.id, { path: t.path, version: typeof t.version === 'string' ? t.version : null });
      }
    }
    // 按代码里的清单重建：展示名与顺序以代码为准；缓存之后才加进清单的工具记为未安装
    // （用户点「重新检测」即可刷新），不为此作废整份缓存。
    const tools = KNOWN_AGENT_TOOLS.map((k): DetectedAgentTool => {
      const hit = byId.get(k.id);
      // runnable 不信缓存：它取决于**这一版** Axon 接入了谁，升级后要立刻生效。
      return hit
        ? { id: k.id, label: k.label, installed: true, ...hit, runnable: k.supported === true }
        : { id: k.id, label: k.label, installed: false, path: null, version: null, runnable: false };
    });
    return { detectedAt: v.detectedAt, tools };
  } catch {
    return null;
  }
}

export interface AgentToolsRegistryOptions {
  cachePath: string;
  detect?: () => Promise<DetectedAgentTool[]>;
  cacheIO?: CacheIO;
  now?: () => number;
  /** 快照变化（开始探测 / 探测完成）时回调；index.ts 用它广播 `agentTools.changed`。 */
  onChange?: (snapshot: AgentToolsSnapshot) => void;
}

/**
 * 探测结果的唯一持有者。
 *
 * `init()` 只读缓存、不等探测：首次启动的探测在后台跑，窗口照常起来，
 * popover 先显示「检测中」，探测完靠 `onChange` 推过去。
 */
export class AgentToolsRegistry {
  private state: AgentToolsSnapshot = { status: 'detecting', detectedAt: null, tools: [] };
  private inflight: Promise<AgentToolsSnapshot> | null = null;
  private readonly detect: () => Promise<DetectedAgentTool[]>;
  private readonly cacheIO: CacheIO;
  private readonly now: () => number;

  constructor(private readonly opts: AgentToolsRegistryOptions) {
    this.detect = opts.detect ?? (() => detectAgentTools());
    this.cacheIO = opts.cacheIO ?? nodeCacheIO;
    this.now = opts.now ?? Date.now;
  }

  /** 有缓存 ⇒ 直接就绪，不探测；没有 ⇒ 后台发起首次探测（不等它）。 */
  async init(): Promise<void> {
    const cached = parseCache(await this.cacheIO.read(this.opts.cachePath));
    if (cached) {
      this.state = { status: 'ready', ...cached };
      return;
    }
    void this.redetect();
  }

  snapshot(): AgentToolsSnapshot {
    return this.state;
  }

  /** 重新探测并落盘。并发调用共享同一次探测。 */
  redetect(): Promise<AgentToolsSnapshot> {
    if (this.inflight) return this.inflight;
    this.set({ ...this.state, status: 'detecting' });
    this.inflight = (async () => {
      let tools: DetectedAgentTool[];
      try {
        tools = await this.detect();
      } catch (e) {
        // detectAgentTools 本身不抛；注入的实现抛了也不能让状态卡在 detecting。
        console.warn('[desktop] agent 工具探测失败', e);
        tools = this.state.tools;
      }
      const detectedAt = this.now();
      this.set({ status: 'ready', detectedAt, tools });
      try {
        await this.cacheIO.write(
          this.opts.cachePath,
          JSON.stringify({ schema: CACHE_SCHEMA, detectedAt, tools }, null, 2),
        );
      } catch (e) {
        // 落盘失败只意味着下次启动会再探一次，不影响本次结果。
        console.warn('[desktop] agent 工具缓存写入失败', e);
      }
      return this.state;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private set(next: AgentToolsSnapshot): void {
    this.state = next;
    this.opts.onChange?.(next);
  }
}

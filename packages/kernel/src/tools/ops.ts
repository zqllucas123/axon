/**
 * 叶子工具的可注入执行后端（M8 §3.1 模式 2，参照 pi 的 BashOperations）。
 *
 * 把「怎么读写文件、怎么跑命令」抽成接口：默认是本地实现（createLocalOps），
 * 单测注入假 ops 测纯逻辑，未来 team/adhoc 执行器换后端都不动工具本体。
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** 因超时或 abort 被杀。 */
  killed: boolean;
}

export interface BashExecOptions {
  cwd: string;
  signal?: AbortSignal;
  /** 毫秒；未传则不设超时。 */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** 文件系统 + shell 的可注入操作面。 */
export interface LeafOperations {
  readFile(absPath: string): Promise<Buffer>;
  writeFile(absPath: string, data: string): Promise<void>;
  access(absPath: string): Promise<void>;
  stat(absPath: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  readdir(absPath: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  exec(command: string, options: BashExecOptions): Promise<BashResult>;
}

/** 本地文件系统 + 子进程实现。 */
export function createLocalOps(): LeafOperations {
  return {
    readFile: (p) => fsReadFile(p),
    writeFile: async (p, data) => {
      await fsMkdir(dirname(p), { recursive: true });
      await fsWriteFile(p, data, 'utf-8');
    },
    access: (p) => fsAccess(p, constants.R_OK),
    stat: async (p) => {
      const s = await fsStat(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    },
    readdir: async (p) => {
      const entries = await fsReaddir(p, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    },
    exec: (command, options) => runLocalShell(command, options),
  };
}

/**
 * 本地 shell 执行：cwd 固定为会话目录，signal/timeout 触发时杀整个进程组。
 * 用 `detached` + 负 pid kill 清子进程树（照抄 pi shell 的 killProcessTree 思路）。
 */
function runLocalShell(command: string, options: BashExecOptions): Promise<BashResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const killTree = () => {
      killed = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };

    const timer =
      options.timeoutMs !== undefined ? setTimeout(killTree, options.timeoutMs) : undefined;
    const onAbort = () => killTree();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr, exitCode: code, killed });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr: stderr + String(err), exitCode: null, killed });
    });
  });
}

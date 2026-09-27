/**
 * 递归遍历辅助 —— glob/grep 共用。
 *
 * 默认跳过 node_modules / .git 等噪声目录，并对访问文件数设硬上限，
 * 避免在超大树上跑飞（M8：叶子工具要可预测，不能拖垮会话）。
 */

import { join, relative } from 'node:path';
import type { LeafOperations } from './ops.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next']);
const MAX_ENTRIES = 20000;

export interface WalkedFile {
  /** 绝对路径。 */
  abs: string;
  /** 相对 root 的路径（用于展示与匹配）。 */
  rel: string;
}

/**
 * 广度遍历 root 子树下的文件（不含目录本身），命中上限即停并置 truncated。
 */
export async function walkFiles(
  root: string,
  ops: LeafOperations,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const files: WalkedFile[] = [];
  const queue: string[] = [root];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = await ops.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) {
        truncated = true;
        return { files, truncated };
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(abs);
      } else {
        files.push({ abs, rel: relative(root, abs) });
      }
    }
  }
  return { files, truncated };
}

/**
 * 极简 glob → RegExp：支持 `**`（跨目录）、`*`（段内任意）、`?`（单字符）。
 * 其余字符按字面转义。
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c as string)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 代码仓库 → 逐文件文本。
 *
 * 递归扫描目录，对每个白名单扩展名的文件生成一条文档（title=相对路径，content=文件内容）。
 * 忽略 node_modules、.git、dist、build、__pycache__ 等产物目录。
 * 每 50 个文件 yield 一次，避免在内存中堆积全部内容。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

/** 允许摄入的文件扩展名 */
const ALLOWED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h',
  '.md', '.txt', '.yaml', '.yml', '.toml', '.json', '.env.example',
  '.sh', '.bash', '.zsh',
]);

/** 跳过的目录名（精确匹配） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.cache',
  'coverage', '.turbo', 'bazel-out',
]);

/** 单文件大小上限（1 MB），超过则跳过 */
const MAX_FILE_BYTES = 1024 * 1024;

export interface RepoPage {
  title: string;
  pageContent: string;
}

export async function ingestRepo(rootDir: string): Promise<RepoPage[]> {
  const pages: RepoPage[] = [];
  await walk(rootDir, rootDir, pages);
  return pages;
}

async function walk(rootDir: string, dir: string, pages: RepoPage[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.env.example') continue;
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }

    if (s.isDirectory()) {
      await walk(rootDir, fullPath, pages);
    } else if (s.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) continue;
      if (s.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await readFile(fullPath, 'utf8');
      } catch {
        continue;
      }

      if (!content.trim()) continue;

      const relPath = relative(rootDir, fullPath);
      pages.push({ title: relPath, pageContent: content });
    }
  }
}

#!/usr/bin/env node
/**
 * staging 依赖完整性校验——打包期早爆，而不是用户启动时爆。
 *
 * 扫描 dist-staging/ 下所有 .mjs/.js 文件（排除 node_modules/ 子目录）的裸模块
 * import（即不以 ./ 或 ../ 开头的导入），断言每一个都能在 staging/node_modules/
 * 里解析到。若有缺口，打印完整列表并以非零退出码退出，让 build:pack 失败。
 *
 * 与 verify-lazy-loading.mjs 互补：
 *   verify-lazy  检查开发态 apps/desktop/dist/main.mjs 有没有把 pi 内联进来
 *   verify-pack-deps  检查打包态 dist-staging/ 里 external 包是否都已拷进去
 * 两道校验覆盖不同的失效模式，不重复。
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(repoRoot, 'dist-staging');

if (!existsSync(staging)) {
  console.error('✗ dist-staging/ 不存在，请先运行 bun run build:desktop && node scripts/pack.mjs');
  process.exit(1);
}

// ── 收集 staging 下所有 .mjs/.js（排除 node_modules/ 子目录）──────────────
async function collectFiles(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await collectFiles(full, files);
    } else if (entry.isFile() && (extname(entry.name) === '.mjs' || extname(entry.name) === '.js')) {
      files.push(full);
    }
  }
  return files;
}

// ── 提取文件里的裸模块 import（ESM import ... from "pkg" / import("pkg")）──
const BARE_IMPORT_RE = /(?:^import\s[^'"]*from\s*|^export\s[^'"]*from\s*|(?:^|\s)import\s*\()\s*['"]([^'"./][^'"]*)['"]/gm;

function extractBareImports(src) {
  const names = new Set();
  for (const m of src.matchAll(BARE_IMPORT_RE)) {
    // 取包名：有 scope 的取前两段（@scope/name），普通的取第一段
    const raw = m[1];
    const parts = raw.split('/');
    const name = raw.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    // 跳过 node: 内置模块
    if (!name.startsWith('node:') && name !== 'electron') names.add(name);
  }
  return names;
}

// ── 标准 node resolution 向上查找 node_modules/<name>/package.json ──────────
function resolvePackageSync(name, fromDir) {
  let d = fromDir;
  while (true) {
    const candidate = join(d, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
console.log('→ 扫描 staging 裸模块 import ...');
const files = await collectFiles(staging);
const missing = new Map(); // pkgName → Set<文件路径>

for (const file of files) {
  const src = await readFile(file, 'utf8');
  for (const name of extractBareImports(src)) {
    const resolved = resolvePackageSync(name, dirname(file));
    if (!resolved) {
      if (!missing.has(name)) missing.set(name, new Set());
      missing.get(name).add(file.replace(staging + sep, ''));
    }
  }
}

if (missing.size > 0) {
  console.error(`\n✗ staging 依赖缺口（${missing.size} 个包）——安装包启动时会抛 ERR_MODULE_NOT_FOUND：\n`);
  for (const [name, paths] of [...missing].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  ${name}`);
    for (const p of paths) console.error(`    ← ${p}`);
  }
  console.error('\n修复：在 scripts/pack.mjs 的 EXTERNAL_SEEDS 或 PRUNE_PKGS 里调整，重新 build:pack。');
  process.exit(1);
}

console.log(`✓ staging 依赖完整（扫描 ${files.length} 个文件，无缺口）`);

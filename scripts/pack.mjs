#!/usr/bin/env node
/**
 * M7 打包编排脚本。
 *
 * 核心设计：自建 staging 目录，完全控制进包内容，规避 bun workspace symlink 问题。
 *
 * 问题背景：
 *   bun 的 isolated linker 把 workspace 内部包（@axon/kernel / @axon/protocol）
 *   以 symlink 形式放在 apps/desktop/node_modules/ 里，指向 ../../packages/*。
 *   若直接用 apps/desktop/ 作为 electron-builder 的 app 根，builder 在 asar 阶段
 *   跟随 symlink 后发现路径逃逸出 appDir，直接报错（filter.ts:32 getRelativePath）。
 *
 * 解法：
 *   1. mkdirp dist-staging/
 *   2. cp apps/desktop/dist/** → dist-staging/（esbuild 产物，已内联 workspace 源码）
 *   3. cp pi external 包（从 .bun store 真实路径）→ dist-staging/node_modules/
 *   4. 生成最小 package.json（只含 main / name / version）→ dist-staging/
 *   5. 调用 electron-builder，appDir = dist-staging/，output = dist-pack/
 *
 * 为什么只需三个 pi 包？
 *   @axon/kernel / @axon/protocol 的 TypeScript 源码已被 esbuild 内联进 main.mjs，
 *   不需要运行时解析。只有 electron / pi-ai / pi-agent-core / chord 是 external 的。
 *   electron 由 electron-builder 自己处理（不进 node_modules）。
 */

import { cp, mkdir, rm, realpath, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDist = join(repoRoot, 'apps/desktop/dist');
const staging = join(repoRoot, 'dist-staging');
const repoNodeModules = join(repoRoot, 'node_modules');

// ── 1. 确认 dist/ 存在（必须先跑 build:desktop）──────────────────────────
if (!existsSync(join(desktopDist, 'main.mjs'))) {
  console.error('✗ apps/desktop/dist/main.mjs 不存在，请先运行 bun run build:desktop');
  process.exit(1);
}

// ── 2. 清理并重建 staging 目录（幂等）────────────────────────────────────
console.log('→ 准备 staging 目录 ...');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

// ── 3. 复制 esbuild 产物 ──────────────────────────────────────────────────
await cp(desktopDist, staging, {
  recursive: true,
  // 不跟随 symlink：staging 里不应出现任何 symlink
  dereference: true,
  // 跳过已有的 node_modules（我们在下面单独处理）
  filter: (src) => !src.includes(`${desktopDist}${sep}node_modules`),
});
console.log('  ✓ esbuild 产物已复制');

// ── 4. 复制 pi external 包（解引用 bun symlink）──────────────────────────
const PI_PACKAGES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
];

const stagingNodeModules = join(staging, 'node_modules');
await mkdir(stagingNodeModules, { recursive: true });

for (const pkg of PI_PACKAGES) {
  const symlink = join(repoNodeModules, pkg);
  if (!existsSync(symlink)) {
    console.error(`✗ 包不存在：${symlink}`);
    process.exit(1);
  }
  const src = await realpath(symlink);
  const dest = join(stagingNodeModules, pkg);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, dereference: true });
  console.log(`  ✓ 已复制 ${pkg}`);
}

// chord：与 pi-agent-core 同在一个 .bun store 条目的 @earendil-works/ 目录下
const piCoreReal = await realpath(join(repoNodeModules, '@earendil-works/pi-agent-core'));
const chordSrc = join(dirname(piCoreReal), 'chord');
if (!existsSync(chordSrc)) {
  console.error(`✗ chord 包不存在：${chordSrc}`);
  process.exit(1);
}
const chordDest = join(stagingNodeModules, '@earendil-works/chord');
await mkdir(dirname(chordDest), { recursive: true });
await cp(chordSrc, chordDest, { recursive: true, dereference: true });
console.log('  ✓ 已复制 @earendil-works/chord');

console.log(`\n✓ staging/node_modules/ 拼装完成（${PI_PACKAGES.length + 1} 个包）`);

// ── 5. 生成最小 package.json ────────────────────────────────────────────
// electron-builder 读 appDir 下的 package.json 获取 main / name / version。
// apps/desktop/package.json 无 description / author（builder 会警告但不报错），
// main 路径是 ./dist/main.mjs，但 staging/ 就是 dist 的内容，所以 main = ./main.mjs。
const desktopPkg = JSON.parse(
  await readFile(join(repoRoot, 'apps/desktop/package.json'), 'utf8')
);
const rootPkg = JSON.parse(
  await readFile(join(repoRoot, 'package.json'), 'utf8')
);
const stagingPkg = {
  name: 'axon',
  version: rootPkg.version,
  description: 'Axon — 多子 Agent 协作桌面客户端',
  author: 'Axon',
  main: './main.mjs',  // staging/ 根就是 dist/，main.mjs 直接在根
  private: true,
};
await writeFile(
  join(staging, 'package.json'),
  JSON.stringify(stagingPkg, null, 2),
  'utf8'
);
console.log('  ✓ staging/package.json 已生成');

// ── 6. 调用 electron-builder ─────────────────────────────────────────────
console.log('\n→ 启动 electron-builder ...\n');

// electron-builder shebang 需要 node；nvm 下有 Node v22
const nodeBin = '/Users/lucaszhou/.nvm/versions/node/v22.20.0/bin/node';
const builderMain = join(repoNodeModules, 'electron-builder/out/cli/cli.js');

execFileSync(
  nodeBin,
  [builderMain, '--config', 'electron-builder.yml'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  }
);

console.log('\n✓ 打包完成 → dist-pack/');

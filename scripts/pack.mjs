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
 *   3. 递归解析 external 依赖闭包 → 复制到 dist-staging/node_modules/
 *   4. 生成最小 package.json（只含 main / name / version）→ dist-staging/
 *   5. 调用 electron-builder，appDir = dist-staging/，output = dist-pack/
 *   6. 运行 verify-pack-deps.mjs，验证 staging 里所有裸 import 均可解析
 *
 * 为什么用依赖闭包而不是手写包名？
 *   手写枚举只覆盖了 4 个顶层包，漏掉了 undici（main.mjs 顶层静态 import）
 *   和 pi-ai/pi-agent-core 的传递依赖（openai、yaml、diff 等），导致安装包
 *   启动时抛 ERR_MODULE_NOT_FOUND。依赖闭包解析器跟随 package.json.dependencies
 *   递归展开，并用 PRUNE_PKGS 裁掉 Axon 走不到的重型 SDK（Bedrock/Google GenAI/
 *   @anthropic-ai/sdk），整体 43 MB vs 全量 101 MB。
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

// ── 4. 递归解析 external 依赖闭包，复制进 staging ─────────────────────────
//
// 旧实现手写了一张包名枚举，只覆盖了顶层 4 个包，漏掉 undici 和所有传递依赖，
// 导致安装包启动时抛 ERR_MODULE_NOT_FOUND。
//
// 新实现：以 esbuild EXTERNAL 列表（去掉 electron）为种子，走标准 node resolution
// 向上逐级查找 node_modules/<name>/package.json，递归展开每个包的 dependencies。
// bun 的 isolated linker 把传递依赖放在各自 store 条目内的 node_modules/ 里，
// 所以必须从已解引用的真实目录向上搜索，而不是只看 repo 根。
//
// PRUNE_PKGS：只在懒加载路径被引用的重型 SDK——Axon 只走 openai-completions，
// 裁掉 Bedrock / Google GenAI / @anthropic-ai/sdk 三套，约 58 MB / 74 个包。
// 也裁掉纯类型包（运行时不需要）。若将来要支持其他 provider，从此列表移除对应条目。
// 这张表必须与 apps/desktop/scripts/build.mjs 的 EXTERNAL 保持同步（减去 electron）：
// esbuild 标 external 的包不进 bundle，运行时由 Node 从 node_modules 解析，
// 所以每一个都得进 staging。漏一个就是启动时 ERR_MODULE_NOT_FOUND。
const EXTERNAL_SEEDS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/chord',
  '@anthropic-ai/claude-agent-sdk',
  'undici',
  // M12 知识库：lancedb 含 native addon，mammoth/cheerio 体积大且依赖 node 内置模块
  '@lancedb/lancedb',
  'mammoth',
  'cheerio',
];
const PRUNE_PKGS = new Set([
  // 懒加载 provider SDK——Axon 未注册，打进包是浪费
  '@aws-sdk/client-bedrock-runtime',
  '@google/genai',
  '@anthropic-ai/sdk',
  '@smithy/node-http-handler',
  // 纯类型包，运行时无用
  '@types/node',
  'undici-types',
  'ts-algebra',
  'json-schema-to-ts',
]);

/** 从 fromDir 向上逐级查找 node_modules/<name>/package.json，返回第一个匹配的目录。 */
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

/**
 * 递归解析依赖闭包，返回 Map<packageName, realPath>。
 *
 * optionalDependencies 也要跟进：@lancedb/lancedb 把 native addon 拆成 8 个
 * 平台包（@lancedb/lancedb-darwin-arm64 等）全列在 optionalDependencies 里，
 * 只有当前平台那一个会被真正安装。不跟进就少拷 .node 文件，运行时 lancedb
 * 加载 addon 时失败；而缺失的那 7 个必须容错跳过，不能像必选依赖那样 exit 1。
 */
async function buildClosure(seeds, prune) {
  const seen = new Map();
  async function walk(name, fromDir, optional = false) {
    if (seen.has(name) || prune.has(name)) return;
    const link = resolvePackageSync(name, fromDir);
    if (!link) {
      // 非当前平台的 optional 原生包未安装，属正常情况
      if (optional) return;
      console.error(`✗ 无法解析依赖：${name}（从 ${fromDir} 向上未找到）`);
      process.exit(1);
    }
    const dir = await realpath(link);
    seen.set(name, dir);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      await walk(dep, dir, false);
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      await walk(dep, dir, true);
    }
  }
  for (const seed of seeds) await walk(seed, repoRoot);
  return seen;
}

console.log('→ 解析 external 依赖闭包 ...');
const closure = await buildClosure(EXTERNAL_SEEDS, PRUNE_PKGS);

const stagingNodeModules = join(staging, 'node_modules');
await mkdir(stagingNodeModules, { recursive: true });

let totalBytes = 0;
for (const [name, srcDir] of closure) {
  const dest = join(stagingNodeModules, name);
  await mkdir(dirname(dest), { recursive: true });
  await cp(srcDir, dest, { recursive: true, dereference: true });
  const size = Number(
    execFileSync('du', ['-sk', dest]).toString().split('\t')[0],
  );
  totalBytes += size * 1024;
}

const mb = (totalBytes / (1024 * 1024)).toFixed(1);
console.log(`\n✓ staging/node_modules/ 拼装完成（${closure.size} 个包，${mb} MB）`);

// ── 5. 生成最小 package.json ────────────────────────────────────────────
// electron-builder 读 appDir 下的 package.json 获取 main / name / version。
// main 路径是 ./dist/main.mjs，但 staging/ 就是 dist 的内容，所以 main = ./main.mjs。
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

// ── 7. 验证 staging 依赖完整性 ──────────────────────────────────────────
// 扫描 staging 里所有裸模块 import，断言每一个都能在 staging/node_modules 里解析到。
// 这一步放在 electron-builder 之后：若 staging 有缺口，错误已在步骤 4 暴露（exit 1）；
// 这里额外扫一遍是为了捕捉 esbuild 产物里的新增 external import 与 EXTERNAL_SEEDS 不同步的情况。
const verifyScript = join(repoRoot, 'scripts/verify-pack-deps.mjs');
execFileSync(nodeBin, [verifyScript], { cwd: repoRoot, stdio: 'inherit' });

console.log('\n✓ 打包完成 → dist-pack/');

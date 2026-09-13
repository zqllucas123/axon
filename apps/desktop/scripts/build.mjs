#!/usr/bin/env node
/**
 * Electron 三段式构建：main / preload / renderer。
 *
 * ── 这个脚本最重要的一行是 `external` ──
 *
 * `@earendil-works/pi-ai` 的 44 个 provider 里，`@aws-sdk/client-bedrock-runtime`、
 * `@google/genai`、`@anthropic-ai/sdk`、`openai` 都是**硬依赖**，
 * 但运行时靠动态 import 懒加载（`pi-ai/dist/index.js:2` → `api/lazy.js:46-49`）。
 *
 * 如果让 esbuild 把 pi-ai 打进 bundle，动态 import 会被静态提升，
 * 四套 SDK 连同 protobufjs / google-auth-library 一起进主进程包体，
 * 体积从几 MB 变几十 MB，且丧失懒加载。
 *
 * 所以 pi 相关包必须 external，由 Electron 在运行时从 node_modules 解析。
 * `verify-lazy` 这个 npm script 就是为了让这条规则**可验证而非口头约定**。
 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '../..');
const out = join(appRoot, 'dist');

/** 必须留给运行时解析的包。 */
const EXTERNAL = [
  'electron',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/chord',
];

/** workspace 内部包走别名，源码直接参与打包（它们是纯 TS，无副作用）。 */
const alias = {
  '@axon/protocol': join(repoRoot, 'packages/protocol/src/index.ts'),
  '@axon/kernel': join(repoRoot, 'packages/kernel/src/index.ts'),
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  alias,
  external: EXTERNAL,
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// ── main / preload 必须是 ESM ──
//
// pi 的两个包都是 **ESM-only**：package.json 的 `exports` 里只有 `import`
// 条件，没有 `require`。若输出 cjs，运行时会直接死在：
//   ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in .../pi-agent-core
// 而且因为它们是 external，这个错误 **构建期沉默，只在启动时爆**。
//
// Electron 自 28 起支持 ESM 入口，但文件名必须是 `.mjs`；
// ESM preload 额外要求 `sandbox: false`（我们已设）。
await build({
  ...common,
  entryPoints: [join(appRoot, 'src/main/index.ts')],
  outfile: join(out, 'main.mjs'),
  format: 'esm',
});

await build({
  ...common,
  entryPoints: [join(appRoot, 'src/preload/index.ts')],
  outfile: join(out, 'preload.mjs'),
  format: 'esm',
});

// renderer 走浏览器目标：它绝不该碰到 node 内置模块，
// platform: 'browser' 会在误引入时直接报错——这是想要的。
// React 19：jsx 'automatic' 免掉每文件 import React。
await build({
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  alias,
  jsx: 'automatic',
  minify: true, // React 体系不压缩会从 ~180KB 膨胀到 1.2MB
  entryPoints: [join(appRoot, 'src/renderer/main.tsx')],
  outfile: join(out, 'renderer/renderer.js'),
  format: 'esm',
});

await cp(join(appRoot, 'src/renderer/index.html'), join(out, 'renderer/index.html'));

console.log('\n✓ 构建完成 → apps/desktop/dist');

#!/usr/bin/env node
/**
 * 打包冒烟验证 —— 把「provider 懒加载有没有被打包器破坏」变成一条可执行断言。
 *
 * ── 为什么需要这个脚本 ──
 *
 * 架构复核发现：`pi-ai@0.85.1` 的 dependencies 里有 4 套完整厂商 SDK
 * （`@anthropic-ai/sdk` / `openai` / `@google/genai` /
 * `@aws-sdk/client-bedrock-runtime`），实际安装闭包约 150 个包。
 * 它们在运行时是**懒加载**的（`pi-ai/dist/index.js:2` 只导出 `api/lazy.js`，
 * `lazy.js:46-49` 用动态 import），所以「装了但不进内存」。
 *
 * 但这个性质**极易被打包器悄悄破坏**：一旦 esbuild 把 pi-ai 打进 bundle，
 * 动态 import 会被静态提升，四套 SDK 连同 protobufjs / google-auth-library
 * 全部进入主进程包体。症状是安装包体积暴涨、启动变慢，
 * 而且**不会有任何报错** —— 功能完全正常，只是胖了几十 MB。
 *
 * 没有这条断言，这种回退会在某次「顺手把 external 去掉试试」之后静默发生。
 * 详见 `docs/02-调研补充与结论复核.md` §4 风险 B。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/desktop/dist');
const errors = [];
const notes = [];

/** 绝不允许出现在主进程 bundle 里的重量级依赖。 */
const FORBIDDEN = [
  ['@aws-sdk/client-bedrock-runtime', 'AWS Bedrock SDK'],
  ['@google/genai', 'Google GenAI SDK'],
  ['@anthropic-ai/sdk', 'Anthropic SDK'],
  ['protobufjs', 'protobufjs'],
  ['google-auth-library', 'google-auth-library'],
  // 自真模型接入（走 openai-completions API）后，`openai` 成了最可能被内联的那个：
  // provider.ts 引的是 `api/openai-completions.lazy`，它背后才是 `openai` SDK。
  // 一旦有人把 external 去掉，这条会先炸。
  ['openai', 'OpenAI SDK'],
];

/** 必须保持为运行时 require 的包（即 external 生效的证据）。 */
const MUST_BE_EXTERNAL = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  // 真 provider 走的懒 API 子路径。它与主包分开断言：external 对子路径的
  // 前缀匹配是 esbuild 的行为细节，不是显式契约，值得单独钉住。
  '@earendil-works/pi-ai/api/openai-completions.lazy',
];

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

if (!existsSync(dist)) {
  console.error('✗ 未找到 apps/desktop/dist，请先 bun run build:desktop');
  process.exit(1);
}

const mainFile = join(dist, 'main.mjs');
const main = readFileSync(mainFile, 'utf8');

// ── ① 体积 ────────────────────────────────────────────────
const size = statSync(mainFile).size;
notes.push(`main.mjs 体积 ${kb(size)}`);
// 阈值给得宽松（1 MB）：它要拦的是「胖了 30 倍」这种量级的回退，
// 不是几十 KB 的正常增长。定太紧会变成天天要改的噪音。
if (size > 1024 * 1024) {
  errors.push(
    `main.mjs 达 ${kb(size)}，超过 1 MB 阈值 —— 很可能有重量级依赖被打进来了`,
  );
}

// ── ② 禁止内联的依赖 ──────────────────────────────────────
for (const [pkg, label] of FORBIDDEN) {
  // 只在"被打进来"的形态下报错：源码里出现字符串（如 provider 名单）是正常的，
  // 真正被内联的标志是出现它的模块内容或 require 解析残留。
  const inlined =
    main.includes(`node_modules/${pkg}/`) ||
    new RegExp(`__commonJS\\s*\\(\\{[^}]*${pkg.replace(/[/@.]/g, '\\$&')}`).test(main);
  if (inlined) errors.push(`${label} (${pkg}) 被打进了 main.mjs`);
}

// ── ③ external 是否生效 ───────────────────────────────────
for (const pkg of MUST_BE_EXTERNAL) {
  // ESM 产物里 external 的形态是顶层 import 语句，不是 require()
  if (!new RegExp(`from\\s*["']${pkg.replace(/[/@.]/g, '\\$&')}["']`).test(main)) {
    errors.push(
      `main.mjs 里找不到 import ... from "${pkg}" —— external 可能失效，pi 被内联了`,
    );
  }
}

// ── ④ 渲染进程不得碰到 node/pi ────────────────────────────
const rendererFile = join(dist, 'renderer/renderer.js');
if (existsSync(rendererFile)) {
  const renderer = readFileSync(rendererFile, 'utf8');
  notes.push(`renderer.js 体积 ${kb(statSync(rendererFile).size)}`);
  for (const pkg of MUST_BE_EXTERNAL) {
    if (renderer.includes(pkg)) {
      errors.push(`渲染进程 bundle 引用了 ${pkg} —— 内核绝不能进渲染层`);
    }
  }
  if (/from\s*["']node:|require\(["']node:/.test(renderer)) {
    errors.push('渲染进程 bundle 出现 node: 内置模块引用');
  }
}

// ── 报告 ──────────────────────────────────────────────────
console.log('打包冒烟验证…');
for (const n of notes) console.log(`  · ${n}`);

if (errors.length) {
  console.error('\n✗ 验证未通过：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n✓ provider 懒加载完好，内核未泄漏到渲染层');

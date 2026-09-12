#!/usr/bin/env node
/**
 * 工程纪律守门人。五项检查，任一失败即 exit(1)。
 *
 * 为什么要机器检查而不是靠自觉：
 *  - 锁文件回流：任何人手滑跑一次 npm install，package-lock.json 就进仓，
 *    之后两套解析结果会静默分叉。
 *  - electron 空壳：bun 默认阻止依赖的 postinstall，包装上了但 dist 是空的，
 *    直到运行时才炸。
 *  - kernel 被 electron 污染：一旦 kernel 依赖 electron，就再也无法 headless 测试。
 *  - pi import 散落：pi 未到 1.0，最近 5 个 minor 里 4 个有破坏性变更，
 *    AgentOptions 被动过 3 次。import 一旦散落，升级就从「改一个文件」
 *    变成「全仓掘土」。而且上游正在往 lane-based harness 迁，这层隔离
 *    是将来能「换实现而不换设计」的前提。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function check(label, fn) {
  try {
    const msg = fn();
    if (msg) errors.push(`${label}: ${msg}`);
    else console.log(`  ✓ ${label}`);
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

console.log('检查工程约定…');

check('bun.lock 存在', () =>
  existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
    ? null
    : '未找到 bun.lock，请先执行 bun install'
);

check('无外来锁文件', () => {
  const alien = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].filter((f) =>
    existsSync(join(root, f))
  );
  return alien.length ? `发现 ${alien.join(', ')}，bun 是唯一包管理器` : null;
});

check('scripts 不含 npm 命令', () => {
  const pkg = readJson(join(root, 'package.json'));
  const bad = Object.entries(pkg.scripts ?? {}).filter(([, v]) =>
    /\b(npm|yarn|pnpm)\b/.test(v)
  );
  return bad.length ? `${bad.map(([k]) => k).join(', ')} 使用了非 bun 包管理器` : null;
});

check('kernel 不依赖 electron', () => {
  const p = join(root, 'packages/kernel/package.json');
  if (!existsSync(p)) return null;
  const pkg = readJson(p);
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  return Object.keys(all).some((d) => d === 'electron' || d.startsWith('electron-'))
    ? 'packages/kernel 必须保持 headless，禁止依赖 electron'
    : null;
});

check('electron 二进制已落地', () => {
  const dist = join(root, 'node_modules/electron/dist');
  if (!existsSync(join(root, 'node_modules/electron'))) return null; // 尚未安装，跳过
  const pkg = readJson(join(root, 'package.json'));
  if (!(pkg.trustedDependencies ?? []).includes('electron'))
    return 'electron 已安装但不在 trustedDependencies，postinstall 会被 bun 阻止';
  if (!existsSync(dist) || readdirSync(dist).length === 0)
    return 'node_modules/electron/dist 为空，需 rm -rf node_modules && bun install';
  return null;
});

check('pi import 收敛在边界层', () => {
  // 白名单：只有边界层和契约测试/示例可以直接碰 pi。
  // 契约测试必须碰，它的职责就是用真实 pi 产物锁死我们对上游的假设。
  const allow = new Set([
    'packages/kernel/src/engine.ts',
    'packages/kernel/src/engine.contract.test.ts',
    'packages/kernel/src/provider.ts',
  ]);
  const roots = ['packages', 'apps', 'examples'];
  const offenders = [];

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mts)$/.test(name)) {
        const rel = relative(root, full).split('\\').join('/');
        if (allow.has(rel)) continue;
        if (/from\s+['"]@earendil-works\//.test(readFileSync(full, 'utf8'))) {
          offenders.push(rel);
        }
      }
    }
  };
  for (const r of roots) walk(join(root, r));

  return offenders.length
    ? `以下文件直接 import 了 pi，请改走 kernel/src/engine.ts：\n      ${offenders.join('\n      ')}`
    : null;
});

if (errors.length) {
  console.error('\n✗ 工程约定检查未通过：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n✓ 全部通过');

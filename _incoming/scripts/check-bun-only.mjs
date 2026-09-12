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
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

if (errors.length) {
  console.error('\n✗ 工程约定检查未通过：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n✓ 全部通过');

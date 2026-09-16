#!/usr/bin/env bun
/**
 * UI 截图工具 —— 拉起真窗口 → 跑一段可选 init JS → 逐屏截 PNG。
 *
 * 与 ui-smoke 的分工：smoke 验「接线」（DOM 断言，机器判定）；shot 验「长相」
 * （PNG，人眼判定）。MU-2 的逐值对齐靠后者 —— DOM 断言说不出「间距差 2px」。
 *
 * 用法（shots 每项 `名字=data-smoke值`，即「点这个钩子再截」）：
 *   bun scripts/ui-shot.mjs --shots s0=nav-s0,s3=nav-s3
 *   bun scripts/ui-shot.mjs --shots s2=session-row,s2-ledger=view-ledger --init "$(cat seed.js)"
 * 连已启动实例：--no-launch --port 9223。输出默认 apps/desktop/dist/shots（dist 已 gitignore）。
 */
import { execSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const port = arg('--port', '9333');
const launch = !args.includes('--no-launch');
const initJs = arg('--init', null);
const shots = arg('--shots', 's0=nav-s0').split(',').filter(Boolean);
const outDir = arg('--out', join(import.meta.dirname, '../apps/desktop/dist/shots'));

let proc = null;
const dirs = launch
  ? {
      AXON_ROLES_DIR: await mkdtemp(join(tmpdir(), 'axon-shot-roles-')),
      AXON_SESSIONS_DIR: await mkdtemp(join(tmpdir(), 'axon-shot-sessions-')),
      AXON_TEAMS_DIR: await mkdtemp(join(tmpdir(), 'axon-shot-teams-')),
    }
  : {};

if (launch) {
  proc = spawn(join(import.meta.dirname, '../node_modules/.bin/electron'),
    [`--remote-debugging-port=${port}`, 'apps/desktop/dist/main.mjs'], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined, // 宿主（kalo）可能注入，必须剥掉
        ...dirs,
        AXON_PROVIDER: 'faux', // 绝不碰真网关
        AXON_SMOKE_SCRIPT: '1', // 魔术前缀：协作→派子 agent；动手→触发审批门
        AXON_SMOKE_BUDGET_HARD: '5',
      },
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let nextId = 1;
const pending = new Map();
let evalJs;

function cleanup(code) {
  try { ws?.close(); } catch { /* ignore */ }
  // 按入口路径清场：只 kill 壳会留下孤儿 Electron 占着调试端口（下一次假绿）。
  try { execSync('pkill -9 -f "apps/desktop/dist/main.mjs"', { stdio: 'ignore' }); } catch { /* ignore */ }
  if (proc) proc.kill('SIGKILL');
  process.exit(code);
}

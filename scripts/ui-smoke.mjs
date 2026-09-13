#!/usr/bin/env bun
/**
 * UI 端到端冒烟 —— CDP 驱动真实 Electron 窗口验证完整链路：
 *   window.axon.invoke → preload → IPC → RoleBridge → 写盘 → watch 去重
 *   → roles.changed 事件 → React 重渲染 → DOM 出现卡片 → delete 回落。
 *
 * 默认自己拉起应用（AXON_ROLES_DIR 指向隔离临时目录）；也可只连已启动的
 * 调试端口：`bun scripts/ui-smoke.mjs --port 9223 --no-launch`。
 *
 * 单测覆盖不了「每一环拼起来的形态」，只能真窗口验。M2 验收证据，M3+ 复用。
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const port = getArg('--port', '9223');
const launch = !args.includes('--no-launch');
const roleName = 'smoke-role';

let proc = null;
if (launch) {
  const rolesDir = await mkdtemp(join(tmpdir(), 'axon-roles-'));
  const electron = join(import.meta.dirname, '../node_modules/.bin/electron');
  proc = spawn(
    electron,
    [`--remote-debugging-port=${port}`, 'apps/desktop/dist/main.mjs'],
    {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined, // 宿主（kalo）可能注入，必须剥掉
        ELECTRON_ENABLE_LOGGING: '1',
        AXON_ROLES_DIR: rolesDir,
        // 冒烟绝不允许碰真网关：开发机上 ~/.axon/config.json 往往配了真 key，
        // 而 AXON_SMOKE_SCRIPT 只替换 streamFn —— 靠它「恰好不发请求」是巧合不是保证。
        AXON_PROVIDER: 'faux',
        // 冒烟钩子：脚本化回复永不耗尽 + 每轮固定成本 0.05（软线 0.048 / 硬线 0.06），
        // 恰好两轮 prompt 走完 warning → frozen 两段 UI。
        AXON_SMOKE_SCRIPT: '1',
        AXON_SMOKE_BUDGET_COST: '0.05',
        AXON_SMOKE_BUDGET_HARD: '0.06',
      },
    },
  );
}

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      /* 窗口还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('等不到 CDP 页面目标');
}

const log = (ok, msg) => console.log(`${ok ? '✓' : '✗'} ${msg}`);

function exit(code) {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  if (proc) proc.kill('SIGTERM');
  console.log(code === 0 ? '\n✓ UI 端到端冒烟通过' : '\n✗ UI 端到端冒烟失败');
  process.exit(code);
}

let ws;
try {
  const page = await getPageTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        '页面求值异常: ' + JSON.stringify(r.exceptionDetails.exception?.description),
      );
    }
    return r.result.value;
  };

  // ── 1. 桥接 + 初始角色数（等 preload 挂桥，CDP evaluate 不保证页面就绪）
  let before;
  for (let i = 0; i < 40; i++) {
    before = await evalJs(
      `typeof window.axon?.invoke === 'function' ? window.axon.invoke('role.list', {}).then(r => r.entries.length) : null`,
    );
    if (typeof before === 'number') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (typeof before !== 'number') {
    log(false, `window.axon 桥接不可用（等拉 10s：${JSON.stringify(before)}）`);
    exit(1);
  }
  log(true, `window.axon 桥接可用，初始 ${before} 个角色`);

  // ── 2. 保存新用户角色
  const saveRes = await evalJs(`window.axon.invoke('role.save', { role: ${JSON.stringify({
    name: roleName,
    displayName: '冒烟角色',
    description: 'UI 端到端冒烟专用角色',
    instructions: '你是冒烟角色，用于验证角色的新建与热更新链路。',
    tools: ['read'],
    approval: 'always_ask',
    defaultForkMode: 'none',
  })} }).then(r => r.accepted)`);
  if (saveRes !== true) {
    log(false, `角色保存未通过 bridge 校验（accepted=${JSON.stringify(saveRes)}）`);
    exit(1);
  }
  log(true, '页面 invoke role.save 成功（preload→IPC→bridge→写盘）');

  // ── 3. 等事件 → React 重渲染 → DOM 出现该角色
  let found = false;
  for (let i = 0; i < 40; i++) {
    const names = await evalJs(
      `[...document.querySelectorAll('.role .name')].map(el => el.textContent).join('|')`,
    );
    if (String(names).includes('冒烟角色')) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(found, 'DOM 出现「冒烟角色」卡片（事件 → React 重渲染闭环）');

  // ── 4. 清理：删除后 DOM 回落
  await evalJs(`window.axon.invoke('role.delete', { name: '${roleName}' })`);
  let gone = false;
  for (let i = 0; i < 20; i++) {
    const names = await evalJs(
      `[...document.querySelectorAll('.role .name')].map(el => el.textContent).join('|')`,
    );
    if (!String(names).includes('冒烟角色')) {
      gone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(gone, '删除后 DOM 回落（清理成功）');
  if (!found || !gone) exit(1);

  // ── 5. 预算熔断（M3 切片 6）：AI-agent prompt×2 走完 warning → frozen
  const spawned = await evalJs(
    `window.axon.invoke('agent.spawn', { role: 'blank', parent: '/root' }).then(r => r.path)`,
  );
  if (!spawned) {
    log(false, '冒烟 Agent 创建失败');
    exit(1);
  }
  log(true, `冒烟 Agent 已创建（${spawned}）`);

  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '第一轮' })`);
  let warned = false;
  for (let i = 0; i < 40; i++) {
    warned = await evalJs(`!!document.querySelector('.budget.warning')`);
    if (warned) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  log(warned, '第一轮 prompt 后出现预算警告 banner（budget.warning → React 重渲染）');
  if (!warned) exit(1);

  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '第二轮' })`);
  let frozen = false;
  for (let i = 0; i < 40; i++) {
    frozen = await evalJs(
      `!!document.querySelector('.budget.frozen') && document.querySelector('footer input')?.disabled === true`,
    );
    if (frozen) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  log(frozen, '第二轮 prompt 后预算冻结：banner 变红 + 输入框禁用（budget.frozen → React 重渲染）');
  if (!frozen) exit(1);

  exit(0);
} catch (err) {
  console.error('冒烟异常:', err);
  exit(1);
}
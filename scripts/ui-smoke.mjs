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
import { execSync, spawn } from 'node:child_process';
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
const rolesDir = launch ? await mkdtemp(join(tmpdir(), 'axon-roles-')) : null;
// M5：会话落盘根也要隔离（绝不碰 ~/.axon）—— 重启幕必须落在同一个根上。
const sessionsDir = launch ? await mkdtemp(join(tmpdir(), 'axon-sessions-')) : null;

/** 拉起应用（第一次开机与重启幕共用；重启 = 同一份 env 再 spawn 一次）。 */
function launchApp() {
  const electron = join(import.meta.dirname, '../node_modules/.bin/electron');
  proc = spawn(electron, [`--remote-debugging-port=${port}`, 'apps/desktop/dist/main.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined, // 宿主（kalo）可能注入，必须剥掉
      ELECTRON_ENABLE_LOGGING: '1',
      AXON_ROLES_DIR: rolesDir,
      AXON_SESSIONS_DIR: sessionsDir,
      // 冒烟绝不允许碰真网关：开发机上 ~/.axon/config.json 往往配了真 key，
      // 而 AXON_SMOKE_SCRIPT 只替换 streamFn —— 靠它「恰好不发请求」是巧合不是保证。
      AXON_PROVIDER: 'faux',
      // 冒烟钩子：脚本化回复永不耗尽 + 每轮固定成本 0.05（软线 0.048 / 硬线 0.06），
      // 恰好两轮 prompt 走完 warning → frozen 两段 UI。
      AXON_SMOKE_SCRIPT: '1',
      AXON_SMOKE_BUDGET_COST: '0.05',
      AXON_SMOKE_BUDGET_HARD: '0.06',
    },
  });
}
if (launch) launchApp();

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
  // 按入口路径清场：只 kill 壳会留下孤儿 Electron（下一次冒烟会连到它身上，假绿）。
  try {
    execSync('pkill -9 -f "apps/desktop/dist/main.mjs"', { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  if (proc) proc.kill('SIGKILL');
  console.log(code === 0 ? '\n✓ UI 端到端冒烟通过' : '\n✗ UI 端到端冒烟失败');
  process.exit(code);
}

let ws;
let nextId = 1;
let pending = new Map();
/** 页面求值 —— connect() 每次重生（重启后是另一个页面目标，句柄全得换）。 */
let evalJs;

/** 杀掉当前应用（含 cli.js 壳拉起的 Electron 本体）并等它真退出。
 *
 * `node_modules/.bin/electron` 只是个壳，真正的 Electron 是它的子进程 ——
 * 只给壳发 SIGTERM，应用会变孤儿继续占着调试端口（第二次开机就起不来）。
 * 所以直接按入口路径 pkill（-9：卡在退出路径上的实例不理 SIGTERM）。 */
async function killApp(timeoutMs = 8000) {
  if (!proc || proc.exitCode !== null) return true;
  try {
    execSync('pkill -9 -f "apps/desktop/dist/main.mjs"', { stdio: 'ignore' });
  } catch {
    /* 没有匹配 */
  }
  const deadline = Date.now() + timeoutMs;
  while (proc.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return proc.exitCode !== null;
}

/** 连上当前窗口的 CDP（第一次开机与重启幕共用）。 */
async function connect() {
  const page = await getPageTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  nextId = 1;
  pending = new Map();
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
  evalJs = async (expression) => {
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
}

try {
  await connect();

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

  // 小工具：轮询一个表达式直到它真（DOM 是事件驱动的，必然有延迟）。
  const until = async (expr, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      if (await evalJs(expr)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  // ── 4.5 会话容器（MU-1）：建会话 → 左栏出现会话行 → 树以会话根为根
  //     多根模型（§4.1）下没有「总是存在的 /root」，一切寻址从会话根出发。
  const session = await evalJs(
    `window.axon.invoke('session.create', { title: '冒烟会话', executor: 'engine' })
      .then(s => ({ id: s.record.id, root: s.rootPath }))`,
  );
  if (!session?.root || session.root !== `/${session.id}`) {
    log(false, `会话创建失败（${JSON.stringify(session)}）`);
    exit(1);
  }
  log(true, `会话已创建（session.create → ${session.root}）`);

  // 渲染壳冷启动时会自己补一个「调试会话」（无会话可用则没树可挂），
  // 所以这里显式把当前会话点到冒烟自己这个 —— 否则断言会跟着竞态飘。
  await until(`!!document.querySelector('[data-smoke="session-row"][data-session="${session.id}"]')`);
  await evalJs(`document.querySelector('[data-smoke="session-row"][data-session="${session.id}"]').click()`);
  const sessionRow = await until(`!!document.querySelector('.session.sel[data-session="${session.id}"]')`);
  log(sessionRow, '左栏选中冒烟会话（session.created → React 重渲染 → 点击选中）');
  if (!sessionRow) exit(1);

  const rootNode = await until(
    `[...document.querySelectorAll('.tree .node')].some(el => el.title.startsWith('${session.root} '))`,
  );
  log(rootNode, `Agent 树以会话根为根（${session.root}）`);
  if (!rootNode) exit(1);

  const spawned = await evalJs(
    `window.axon.invoke('agent.spawn', { role: 'blank', parent: '${session.root}' }).then(r => r.path)`,
  );
  if (!spawned || !String(spawned).startsWith(`${session.root}/`)) {
    log(false, `冒烟 Agent 创建失败或没挂在会话根下（${JSON.stringify(spawned)}）`);
    exit(1);
  }
  log(true, `冒烟 Agent 已创建（${spawned}）`);

  // ── 5. 协作账本（M4 / UX S4）：发一句话 → Agent 用 agent 工具派活
  //     → 落 delegate 账 → 子终态后结算 → 人点「采纳」。
  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '协作冒烟' })`);
  const recorded = await until(`!!document.querySelector('[data-smoke="ledger-row"]')`);
  log(recorded, '账本面板出现协作记录（ledger.recorded → React upsert）');
  if (!recorded) exit(1);

  // 等结算：只有 settled + pending 的行才给「采纳」按钮
  const adoptable = await until(`!!document.querySelector('[data-smoke="ledger-adopt"]')`);
  log(adoptable, '子 Agent 终态后记录自动结算，出现「采纳」按钮（ledger.updated）');
  if (!adoptable) exit(1);

  await evalJs(`document.querySelector('[data-smoke="ledger-adopt"]').click()`);
  const adopted = await until(
    `!!document.querySelector('[data-smoke="ledger-row"][data-adoption="adopted"]')`,
  );
  log(adopted, '点击「采纳」后记录转 adopted（ledger.adopt → 人工署名落账）');
  if (!adopted) exit(1);

  // ── 6. 审批穿透（M4 / UX S5）：blank 角色是 always_ask，父链到 root 无人代批
  //     ⇒ 叶子工具必须停下来等人。编排工具豁免（D5）已由上一幕反证：
  //     刚才那次 agent 工具调用没有弹审批就直接成功了。
  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '动手试试' })`);
  const asked = await until(`!!document.querySelector('[data-smoke="approval-banner"]')`);
  log(asked, '叶子工具触发 HITL 门，审批 banner 弹出（approval.request 穿透到人）');
  if (!asked) exit(1);

  await evalJs(`document.querySelector('[data-smoke="approval-approve"]').click()`);
  const cleared = await until(`!document.querySelector('[data-smoke="approval-banner"]')`);
  log(cleared, '点「批准」后 banner 消失，工具放行（pending.resolved）');
  if (!cleared) exit(1);

  // ── 7. 预算熔断（M3 切片 6）：含「烧钱」的 prompt×2 走完 warning → frozen
  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '烧钱第一轮' })`);
  let warned = false;
  for (let i = 0; i < 40; i++) {
    warned = await evalJs(`!!document.querySelector('.budget.warning')`);
    if (warned) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  log(warned, '第一轮 prompt 后出现预算警告 banner（budget.warning → React 重渲染）');
  if (!warned) exit(1);

  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '烧钱第二轮' })`);
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

  // ── 8. 重启恢复（M5 §4.5/§4.6）：同一个落盘根、第二次开机
  //     这一幕验的是「接线的形态」，单测（host.restart.test.ts）验的是语义：
  //     index.ts 是否真的把根接上、listRecords 是否真的先读 session.json、
  //     窗口重开时左栏是否重新列出上次的会话。
  await new Promise((r) => setTimeout(r, 800)); // 让 500ms 的汇总窗口先收口
  // 硬杀：这一幕验的是「盘上的东西能不能装回来」，不是退出路径本身；
  // graceful 的退出收口由 host.restart.test.ts + index.ts 的 will-quit flush 覆盖。
  const quit = await killApp();
  log(quit, '第一次开机已退出（第二次开机用同一个落盘根）');
  if (!quit) exit(1);
  launchApp();
  await connect();

  let status = null;
  for (let i = 0; i < 40; i++) {
    status = await evalJs(
      `typeof window.axon?.invoke === 'function' ? window.axon.invoke('storage.status', {}) : null`,
    );
    if (status && typeof status.root === 'string') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  log(status?.root === sessionsDir, `重启后接的是同一个落盘根（storage.status.root）`);
  // 懒加载的验收线：列表读的是 session.json + rollup，loadedCount 必须还是 0
  const lazy = status?.sessionCount >= 1 && status?.loadedCount === 0;
  log(
    lazy,
    `重启后列表秒开：${status?.sessionCount} 个会话、已加载 ${status?.loadedCount}（list 不读树）`,
  );
  if (status?.root !== sessionsDir || !lazy) exit(1);

  const detail = await evalJs(
    `window.axon.invoke('session.get', { sessionId: '${session.id}' })
      .then(s => ({ root: s.rootPath, members: s.members.length, counts: s.counts.members }))`,
  );
  log(
    detail?.root === session.root && detail?.members >= 2,
    `点开会话后树回来了（${detail?.members} 个节点，成员 ${detail?.counts}）`,
  );
  const msgs = await evalJs(
    `window.axon.invoke('agent.messages', { path: '${session.root}' }).then(m => m.length)`,
  );
  log(msgs > 0, `主控 transcript 读回来了（${msgs} 条消息）`);
  const rowBack = await until(
    `!!document.querySelector('[data-smoke="session-row"][data-session="${session.id}"]')`,
  );
  log(rowBack, '重启后左栏重新列出这个会话（session.list → 懒加载摘要）');
  if (detail?.members < 2 || !(msgs > 0) || !rowBack) exit(1);

  exit(0);
} catch (err) {
  console.error('冒烟异常:', err);
  exit(1);
}
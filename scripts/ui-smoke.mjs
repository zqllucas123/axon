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
// 项目库同样隔离（绝不碰真用户的 ~/.axon/projects）。
const projectsDir = launch ? await mkdtemp(join(tmpdir(), 'axon-projects-')) : null;

/** 拉起应用（第一次开机与重启幕共用；重启 = 同一份 env 再 spawn 一次）。 */
function launchApp() {
  // Windows 上 .bin 里没有无后缀的 shim，只有 electron.exe —— 直接 spawn 'electron'
  // 会 ENOENT，而 spawn 的失败是异步的，表现为「脚本一声不吭地卡死」，
  // 离真因很远。两个平台各取各的。
  const electron = join(
    import.meta.dirname,
    process.platform === 'win32' ? '../node_modules/.bin/electron.exe' : '../node_modules/.bin/electron',
  );
  proc = spawn(electron, [`--remote-debugging-port=${port}`, 'apps/desktop/dist/main.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined, // 宿主（kalo）可能注入，必须剥掉
      ELECTRON_ENABLE_LOGGING: '1',
      AXON_ROLES_DIR: rolesDir,
      AXON_SESSIONS_DIR: sessionsDir,
      AXON_PROJECTS_DIR: projectsDir,
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
  // spawn 失败（路径不对、没装 electron）是**异步**报的：不接这个监听就会表现为
  // 「脚本什么都不打印，一直等 CDP」，排查成本极高。
  proc.on('error', (e) => {
    console.error(`[smoke] 启动应用失败：${e.message}`);
    process.exit(1);
  });
  // stderr 走 pipe 就必须有人读：没人消费的话缓冲区一满就把子进程堵死
  // （ELECTRON_ENABLE_LOGGING=1 下日志量不小）。这里只求流动，不打印。
  proc.stderr.resume();
}
if (launch) launchApp();

/**
 * 找一个 CDP 页面目标。
 *
 * 只按 `index.html` 找就够了：设置曾经是**第二个窗口**（共用同一份 `index.html`、
 * 靠 `#settings` 分叉），那时这里必须排掉它 —— 否则会随机选中一个没有侧栏、
 * 没有 nav-sN 的窗口，下一句 `querySelector(...).click()` 报 null 且离真因很远。
 * 设置改为主窗内的一屏之后，页面目标只剩一个，那段过滤连同 `countSettingsWindows`
 * / `attach` 一起下线。
 */
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
  const dead = () => !proc || proc.exitCode !== null || proc.signalCode !== null;
  if (dead()) return true;
  try {
    execSync('pkill -9 -f "apps/desktop/dist/main.mjs"', { stdio: 'ignore' });
  } catch {
    /* 没有匹配 */
  }
  const deadline = Date.now() + timeoutMs;
  while (!dead() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return dead();
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

  // 小工具：轮询一个表达式直到它真（DOM 是事件驱动的，必然有延迟）。
  const until = async (expr, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      if (await evalJs(expr)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
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

  // ── 1.5 Windows 自绘标题栏（平台门控：macOS 的菜单在系统顶栏，窗口里没有这一行，
  //      不门控就会在 mac 上弄出一片红）
  if (process.platform === 'win32') {
    const platform = await evalJs(`window.axon.platform`);
    log(platform === 'win32', `preload 暴露的平台为 win32（实际 ${platform}）`);
    if (platform !== 'win32') exit(1);

    const titlebar = await until(
      `document.querySelectorAll('[data-smoke="titlebar"]').length === 1`,
    );
    log(titlebar, '自绘标题栏渲染且全页唯一');
    if (!titlebar) exit(1);

    // 渲染出来的菜单按钮数 === 主进程真装了几项。
    // 这条是「菜单名从主进程读」那个设计的守卫：哪天真加了一项菜单而渲染层跟不上，
    // 这里会红，而不是静默少一个按钮。
    // 用 until 而不是一次性求值：菜单名是**异步**拉来的（挂载后才 invoke），
    // 冷启动时渲染进程还在忙（实测 1.5s 时按钮常常还没进 DOM），一次性求值会假红。
    const menuAligned = await until(`(async () => {
      const { items } = await window.axon.invoke('menu.list', {});
      const drawn = document.querySelectorAll('.titlebar [data-menu-id]');
      return items.length > 0 && drawn.length === items.length;
    })()`);
    log(menuAligned, '标题栏菜单按钮数与应用菜单项数一致');
    if (!menuAligned) exit(1);

    // 不存在的菜单 id 必须走错误路径（不弹任何窗口）。
    // 这里**不点真菜单**：原生 popup 会抢走输入，后面所有 CDP 断言都会变得难查。
    const popupRejected = await evalJs(`window.axon
      .invoke('menu.popup', { menuId: '__smoke_nope__' })
      .then(() => false)
      .catch(() => true)`);
    log(popupRejected, 'menu.popup 对未知 id 报错（不静默）');
    if (!popupRejected) exit(1);
  } else {
    // 反方向也要钉住：非 Windows 上这一行必须**不在**，否则 macOS 的窗口里会多一条。
    const absent = await evalJs(`document.querySelectorAll('[data-smoke="titlebar"]').length === 0`);
    log(absent, `非 Windows 平台不渲染自绘标题栏（${process.platform}）`);
    if (!absent) exit(1);
  }

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

  // ── 3. 等事件 → React 重渲染 → DOM 出现该类型
  //     MU-2 起类型的编辑面在 S3「Agent 类型」tab（旧 RolePanel 已删）。
  await evalJs(`document.querySelector('[data-smoke="nav-s3"]').click()`);
  await evalJs(`document.querySelector('[data-smoke="tab-types"]').click()`);
  const found = await until(
    `!!document.querySelector('[data-smoke="type-row"][data-role="${roleName}"]')`,
  );
  log(found, 'S3 类型库出现新类型（role.save → roles.changed → React 重渲染闭环）');
  if (!found) exit(1);

  // ─ 4. 清理：删除后 DOM 回落
  await evalJs(`window.axon.invoke('role.delete', { name: '${roleName}' })`);
  const gone = await until(
    `!document.querySelector('[data-smoke="type-row"][data-role="${roleName}"]')`,
  );
  log(gone, '删除后 DOM 回落（清理成功）');
  if (!gone) exit(1);

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
  const sessionRow = await until(
    `!!document.querySelector('.sidebar [data-smoke="session-row"][data-session="${session.id}"].is-active')`,
  );
  log(sessionRow, '左栏选中冒烟会话（session.created → React 重渲染 → 点击选中）');
  if (!sessionRow) exit(1);

  const uniqueFileToggle = await until(
    `document.querySelectorAll('[data-smoke="toggle-files"]').length === 1`,
  );
  log(uniqueFileToggle, '文件切换入口唯一');
  if (!uniqueFileToggle) exit(1);

  await evalJs(`document.querySelector('[data-smoke="toggle-files"]').click()`);
  const fileLayout = await until(
    `!!document.querySelector('.app-layout.has-right-panel .topbar-side') && !!document.querySelector('.screen-side .ws-panel')`,
  );
  log(fileLayout, '文件右顶栏与文件面板同时出现');
  if (!fileLayout) exit(1);
  const aligned = await evalJs(`(() => {
    const top = document.querySelector('.topbar-side')?.getBoundingClientRect();
    const body = document.querySelector('.screen-side')?.getBoundingClientRect();
    return !!top && !!body && Math.abs(top.left - body.left) <= 1 && Math.abs(top.right - body.right) <= 1 && Math.abs(top.bottom - body.top) <= 1;
  })()`);
  log(aligned, '右顶栏与右面板共享同一列边界');
  if (!aligned) exit(1);
  await evalJs(`document.querySelector('[data-smoke="toggle-files"]').click()`);
  const fileClosed = await until(`!document.querySelector('.screen-side .ws-panel')`);
  log(fileClosed, '文件面板可关闭');
  if (!fileClosed) exit(1);

  // 右栏默认收起（rightPanel='none'）：属性面板（含成员树 / 账本）从顶栏会话操作菜单显式打开。
  const actionsReady = await until(`!!document.querySelector('[data-smoke="session-actions"]')`);
  log(actionsReady, '会话操作入口出现');
  if (!actionsReady) exit(1);
  await evalJs(`document.querySelector('[data-smoke="session-actions"]').click()`);

  const propsToggled = await until(`!!document.querySelector('[data-smoke="toggle-props"]')`);
  log(propsToggled, '会话操作菜单展开并显示属性入口');
  if (!propsToggled) exit(1);
  await evalJs(`document.querySelector('[data-smoke="toggle-props"]').click()`);

  const menuClosed = await until(`!document.querySelector('[data-smoke="toggle-props"]')`);
  log(menuClosed, '选择属性后会话操作菜单关闭');
  if (!menuClosed) exit(1);

  const rootNode = await until(
    `!!document.querySelector('.inspector [data-smoke="member-row"][data-path="${session.root}"]')`,
  );
  log(rootNode, `右栏成员树以会话根为根（${session.root}）`);
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
  // 右栏迷你账本是 **participant 口径**（只列与当前成员相关的条目，MU-2 §4.6）——
  // 先把焦点点回发起人，否则面板按会话根过滤，看得见会话却看不见这笔 delegate。
  const focusRow = await until(
    `!!document.querySelector('.inspector [data-smoke="member-row"][data-path="${spawned}"]')`,
  );
  await evalJs(
    `document.querySelector('.inspector [data-smoke="member-row"][data-path="${spawned}"]')?.click()`,
  );
  const recorded = await until(`!!document.querySelector('.inspector [data-smoke="ledger-row"]')`);
  log(recorded && focusRow, '右栏账本出现协作记录（ledger.recorded → React upsert，按当前成员过滤）');
  if (!recorded) exit(1);

  // 等结算：只有 settled + pending 的行才给「采纳」按钮
  const adoptable = await until(`!!document.querySelector('.inspector [data-smoke="ledger-adopt"]')`);
  log(adoptable, '子 Agent 终态后记录自动结算，出现「采纳」按钮（ledger.updated）');
  if (!adoptable) exit(1);

  await evalJs(`document.querySelector('.inspector [data-smoke="ledger-adopt"]').click()`);
  const adopted = await until(
    `!!document.querySelector('.inspector [data-smoke="ledger-row"][data-adoption="adopted"]')`,
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

  // ── 6.5 故意留一条**不批**的审批（MU-3 切片 9）
  //     一石三鸟：① S5 收件箱才有真的「待处理」卡可验（否则整屏只剩空态）；
  //     ② 被卡的分身停在 waiting，正是 M5 §4.6 说的「重启前在跑」—— 下面重启幕
  //     的 `rollup.interruptedAt` 与 S7「上次中断于 …」全靠它做标的；
  //     ③ 它必须排在烧钱幕**之前**：预算 frozen 是终态，`assertCanStart` 会把
  //     之后所有 spawn/prompt 一律挡下（packages/kernel/src/budget.ts:94）。
  //     另起一个分身而不复用 `spawned`：同一个分身被审批卡住时发不了新 prompt，
  //     而烧钱那两轮还得用它。
  const parkedAgent = await evalJs(
    `window.axon.invoke('agent.spawn', { role: 'blank', parent: '${session.root}' }).then(r => r.path)`,
  );
  // 文本不能与上一幕重复：脚本答复按**原文**记「第几次」（index.ts:277 的
  // smokeCalls），同一句话的第二次只会得到纯文本答复、不再触发工具调用。
  await evalJs(`window.axon.invoke('agent.prompt', { path: '${parkedAgent}', text: '动手试试第二次' })`);
  // 这里用协议而不是 DOM 做断言：S2 的 banner 只渲染**当前焦点成员**的待批
  // （MessageStream.tsx:190），而焦点还停在 blank-1 上 —— 恰好是 S5 存在的理由：
  // 跨会话/跨成员的待批在会话屏里是看不见的。它的 DOM 形态留给下方 7.6 验。
  const parked = await until(
    `window.axon.invoke('pending.list', {}).then(l => l.some(p => p.origin === '${parkedAgent}'))`,
  );
  log(parked, `故意留一条未批的审批（${parkedAgent} 停在 waiting，充当 S5/S7 的标的）`);
  if (!parked) exit(1);

  // ── 6.7 项目模块：创建项目 → 项目上下文新建会话 → 会话归到项目下。
  //     必须排在烧钱幕**之前**：预算 frozen 是终态，会挡下之后所有 session 创建。
  //     原生目录选择器无法用 CDP 驱动，工作空间走「路径输入」这条路
  //     （project.create 直接 invoke，等价于弹窗里手输路径后点「创建项目」）。
  const projCwd = '/tmp/axon-smoke-project';
  const proj = await evalJs(
    `window.axon.invoke('project.create', { name: '冒烟项目', cwd: '${projCwd}', kind: 'local' })
       .then(r => r.accepted ? r.project : null)`,
  );
  log(!!proj && !!proj.id, `project.create 成功（${proj?.id}）`);
  if (!proj || !proj.id) exit(1);
  log(proj.kind === 'local', `项目类别落盘（kind=${proj.kind}）`);
  if (proj.kind !== 'local') exit(1);

  // projects.changed → React 重渲染 → 左栏出现项目分组（哪怕零会话也在）
  const projGroup = await until(
    `!!document.querySelector('[data-smoke="project-group"][data-project="${proj.id}"]')`,
  );
  log(projGroup, '左栏「项目」分组出现（projects.changed → 重渲染，零会话也显示）');
  if (!projGroup) exit(1);

  // 项目内「新建会话」→ 进 S0，且带项目上下文横幅
  await evalJs(
    `document.querySelector('[data-smoke="project-group"][data-project="${proj.id}"] [data-smoke="project-new-session"]').click()`,
  );
  const projCtx = await until(
    `!!document.querySelector('[data-smoke="project-context"]') &&
     !!document.querySelector('[data-smoke="session-task"]')`,
  );
  log(projCtx, '项目内「新建会话」→ S0 带项目上下文横幅（工作空间 = 项目 cwd）');
  if (!projCtx) exit(1);

  // 工作区 chip 显示的是**项目目录名**（不是临时目录），且项目会话不给换目录的入口。
  const projChip = await until(
    `(() => { const bar = document.querySelector('[data-smoke="session-cwd"]');
       return !!bar && bar.textContent.includes('axon-smoke-project') &&
         !document.querySelector('[data-smoke="session-cwd-add"]'); })()`,
  );
  log(projChip, '项目会话的工作区 chip = 项目目录名，且无「换目录」入口（目录锁在项目上）');
  if (!projChip) exit(1);

  // 填任务并开始 → 创建会话（主进程以项目 cwd 固化 projectId），进 S2。
  // React 受控 textarea：必须用原型上的原生 value setter，否则 React 收不到变更。
  await evalJs(
    `(() => { const t = document.querySelector('[data-smoke="session-task"]');
       const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
       set.call(t, '项目里的第一个任务');
       t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await until(`!document.querySelector('[data-smoke="start-session"]')?.disabled`);
  await evalJs(`document.querySelector('[data-smoke="start-session"]').click()`);

  // 新会话固化 projectId + 项目工作空间（主进程按项目解析 cwd，防伪造归属）
  const projSession = await until(
    `window.axon.invoke('session.list', {}).then(l =>
       l.some(s => s.record.projectId === '${proj.id}' && s.record.cwd === '${projCwd}'))`,
  );
  log(projSession, '项目会话固化 projectId + 项目工作空间（cwd 由主进程按项目解析）');
  if (!projSession) exit(1);

  // 新会话即时出现在项目分组下（session.created → 按 projectId 归组）
  const projSessionRow = await until(
    `!!document.querySelector('[data-smoke="project-group"][data-project="${proj.id}"] [data-smoke="session-row"]')`,
  );
  log(projSessionRow, '新会话即时出现在项目分组下（session.created → 按 projectId 归组）');
  if (!projSessionRow) exit(1);

  // 回到原冒烟会话：烧钱幕要在它的分身 `spawned` 上继续发 prompt。
  await evalJs(
    `document.querySelector('.side-scroll [data-smoke="session-row"][data-session="${session.id}"]')?.click()`,
  );
  await until(`!!document.querySelector('.inspector [data-smoke="member-row"][data-path="${session.root}"]')`);

  // ─ 7. 预算熔断（M3 切片 6 / MU-2 视觉）：含「烧钱」的 prompt×2 走完 warning → frozen。
  //     MU-2 起冻结信号是**顶栏预算 chip 变色**（原型 shell.js:258 的 warn/danger 两档），
  //     旧的 .budget 横幅随 SessionPanel 一起下线 —— 这里断言的是真窗口里的那一枚 chip。
  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '烧钱第一轮' })`);
  const warned = await until(`!!document.querySelector('.status-chips .chip.warn')`);
  log(warned, '第一轮后预算 chip 转 warn（budget.warning → React 重渲染）');
  if (!warned) exit(1);

  await evalJs(`window.axon.invoke('agent.prompt', { path: '${spawned}', text: '烧钱第二轮' })`);
  const frozen = await until(`!!document.querySelector('.status-chips .chip.danger')`);
  log(frozen, '第二轮后预算 chip 转 danger（budget.frozen → 档位终态）');
  if (!frozen) exit(1);

  // ── 7.5 MU-2 三屏（切片 7/8）：渲染 + 导航 + 懒加载反向断言
  //     懒加载的验收线是「反面」的：列表/树渲染只许读内存缓存，绝不许补拉 session.get。
  //     所以这里量 storage.status.loadedCount —— 进屏前后必须一模一样。
  const loadedExpr = `window.axon.invoke('storage.status', {}).then(s => s.loadedCount)`;
  const loadedBefore = await evalJs(loadedExpr);

  await evalJs(`document.querySelector('[data-smoke="nav-s0"]').click()`);
  // 普通会话（无项目上下文）的工作区 chip 应显示**临时目录**名（axon-xxxx），
  // 而不是 config.defaultCwd —— S0 现在每次进屏向主进程领一个临时工作目录。
  const s0 = await until(
    `(() => { const bar = document.querySelector('[data-smoke="session-cwd"]');
       return !!document.querySelector('[data-smoke="session-task"]') &&
         !!document.querySelector('[data-smoke="start-session"]') &&
         !!bar && bar.textContent.includes('axon-'); })()`,
  );
  log(s0, 'S0 新建会话屏渲染（任务输入 + 临时工作区 chip + 出发）');
  if (!s0) exit(1);

  // 执行方式从三张卡折叠成工具栏的一枚按钮：点开应能看到 Single 与指定团队。
  await evalJs(`document.querySelector('[data-smoke="mode-trigger"]').click()`);
  const modePopover = await until(
    `!!document.querySelector('[data-smoke="mode-popover"]') &&
     !!document.querySelector('[data-smoke="mode-engine"]') &&
     !!document.querySelector('[data-smoke="mode-team"]')`,
  );
  log(modePopover, 'S0 执行模式 popover 可展开（Single / 指定团队）');
  if (!modePopover) exit(1);
  // 收起，别把弹层留给后面的断言（它盖在输入区上方）。
  await evalJs(`document.querySelector('[data-smoke="mode-trigger"]').click()`);
  await until(`!document.querySelector('[data-smoke="mode-popover"]')`);

  await evalJs(`document.querySelector('[data-smoke="nav-s1"]').click()`);
  const s1row = await until(
    `!!document.querySelector('.canvas [data-smoke="session-row"][data-session="${session.id}"]')`,
  );
  log(s1row, 'S1 会话总览列出该会话（只读 session.list 摘要）');
  const s1members = await until(
    `document.querySelectorAll('.canvas [data-smoke="member-row"]').length >= 2`,
  );
  log(s1members, 'S1 当前会话的分身列表（只渲染已加载的 details，缺了也不补拉）');
  if (!s1row || !s1members) exit(1);

  const loadedAfterS1 = await evalJs(loadedExpr);
  log(
    loadedAfterS1 === loadedBefore,
    `进 S1 不触发读盘（loadedCount ${loadedBefore} → ${loadedAfterS1}）`,
  );
  if (loadedAfterS1 !== loadedBefore) exit(1);

  await evalJs(`document.querySelector('[data-smoke="stat-ledger"]').click()`);
  const toLedger = await until(
    `!!document.querySelector('[data-smoke="ledger-row"]')`,
  );
  log(toLedger, 'S1 统计卡「协作落账」→ S2 账本视图（发意图，不是 href）');
  if (!toLedger) exit(1);

  await evalJs(`document.querySelector('[data-smoke="nav-s3"]').click()`);
  const s3cards = await until(`document.querySelectorAll('[data-smoke="team-card"]').length >= 3`);
  log(s3cards, 'S3 团队 tab 列出团队卡（内置团队也在这张表里）');
  if (!s3cards) exit(1);
  await evalJs(`document.querySelector('[data-smoke="team-card"]').click()`);
  const s3detail = await until(
    `!!document.querySelector('[data-smoke="team-detail"]') &&
     document.querySelectorAll('[data-smoke="team-detail"] [data-smoke="member-row"]').length >= 2`,
  );
  log(s3detail, '选中团队后出详情卡（成员行 + 编队/并发/预算表单）');
  if (!s3detail) exit(1);
  await evalJs(`document.querySelector('[data-smoke="tab-agents"]').click()`);
  const s3agents = await until(`document.querySelectorAll('[data-smoke="agent-row"]').length >= 2`);
  log(s3agents, 'Agent tab = 跨团队成员清单（拍板④：只读）');
  if (!s3agents) exit(1);
  await evalJs(`document.querySelector('[data-smoke="tab-types"]').click()`);
  const s3types = await until(`document.querySelectorAll('[data-smoke="type-row"]').length >= 8`);
  log(s3types, 'Agent 类型 tab 列出类型库（内置 + 用户，带被引用数）');
  if (!s3types) exit(1);

  const loadedAfterS3 = await evalJs(loadedExpr);
  log(
    loadedAfterS3 === loadedBefore,
    `进 S3 三 tab 不触发读盘（loadedCount ${loadedBefore} → ${loadedAfterS3}）`,
  );
  if (loadedAfterS3 !== loadedBefore) exit(1);

  // ── 7.6 MU-3 四屏（切片 9）：S5 收件箱 / S6 预算 / S7 会话恢复 / S8 设置窗
  //     这四屏在四个并行窗口里写，各自只能跑 typecheck（不允许跑 ui-smoke，
  //     会抢 Electron 实例）—— 所以真窗口的验收全部集中在这里。

  // S5 收件箱：入口从底部「待批 N」进（而不是侧栏 nav）—— 那条在 MU-2 是个
  // 不可点的数字，切片 2.5 接了真落点，这一句同时验了它。
  // 此刻挂着一条未批（6.5 留的）+ 一条已批（审批幕结的），两段都有料。
  const toS5 = await evalJs(
    `(() => { const b = document.querySelector('[data-smoke="foot-pending"]'); if (!b) return false; b.click(); return true; })()`,
  );
  const s5 = toS5 && (await until(`!!document.querySelector('[data-screen="s5"]')`));
  log(s5, 'S5 收件箱：底部「待批 N」可点并跳进收件箱（MU-2 里它是死数字）');
  if (!s5) exit(1);
  // 默认 tab 是「待处理」，它不渲染「本次已处理」段 —— 先量待处理卡，
  // 再切到「全部」量两段共存，顺手验了分段切换这个交互。
  const s5waiting = await until(
    `!!document.querySelector('[data-screen="s5"] [data-smoke="approval-banner"]')`,
  );
  log(s5waiting, 'S5 「待处理」段列出真实审批卡（跨会话聚合，与 S2 共用 ApprovalCard 抽件）');
  if (!s5waiting) exit(1);
  await evalJs(`document.querySelector('[data-smoke="inbox-tab-all"]').click()`);
  const s5feed = await until(
    `!!document.querySelector('[data-smoke="inbox-feed"]') &&
     !!document.querySelector('[data-screen="s5"] [data-smoke="approval-banner"]')`,
  );
  log(
    s5feed,
    'S5「全部」tab：待处理与「本次已处理」流水并存（resolvedFeed 派生自 pending，拍板 P-5）',
  );
  if (!s5feed) exit(1);

  // S6 预算：三指标 + 按会话排行。前面烧钱两轮已经把全局档位推到 frozen，
  // 所以「最严重的会话档位」必须是非 none 的真值（data-tier 把它暴露出来）。
  await evalJs(`document.querySelector('[data-smoke="nav-s6"]').click()`);
  const s6 = await until(
    `!!document.querySelector('[data-smoke="budget-total"]') &&
     !!document.querySelector('[data-smoke="budget-limits"]') &&
     !!document.querySelector('[data-smoke="budget-session-row"]')`,
  );
  log(s6, 'S6 预算与用量：三指标 + 按会话排行（只读 session.list 的 usage）');
  if (!s6) exit(1);
  // 会话档位取真值：全局冻结是事件驱动（即时），而会话 usage 在 turn.end 才聚合，
  // 两者有一拍时差 —— 轮询到会话档位落到 frozen 为止（单次读会撞上 warning 的中间态）。
  const tierFrozen = await until(
    `document.querySelector('[data-smoke="budget-tier"]')?.dataset.tier === 'frozen'`,
  );
  const tier = await evalJs(`document.querySelector('[data-smoke="budget-tier"]')?.dataset.tier ?? null`);
  log(tierFrozen, `S6 最严会话档位取真值（${tier}）`);
  if (!tierFrozen) exit(1);
  // 文案自查（拍板 P-8）：BudgetGuard 无日切，全屏不得出现「今日」。
  const noToday = await evalJs(
    `!(document.querySelector('[data-screen="s6"]')?.textContent ?? '').includes('今日')`,
  );
  log(noToday, 'S6 全屏无「今日」字样（拍板 P-8：BudgetGuard 只有进程内累计，无日切）');
  if (!noToday) exit(1);

  const loadedAfterS6 = await evalJs(loadedExpr);
  log(
    loadedAfterS6 === loadedBefore,
    `进 S6 不触发读盘（loadedCount ${loadedBefore} → ${loadedAfterS6}）`,
  );
  if (loadedAfterS6 !== loadedBefore) exit(1);

  // S7 会话恢复：本次还没重启过，所以「可恢复」段应该是空的 —— 先验会话行
  // 与存储实况卡；真正的「上次中断」在重启幕之后验（下方 8.5）。
  await evalJs(`document.querySelector('[data-smoke="nav-s7"]').click()`);
  const s7 = await until(
    `!!document.querySelector('[data-smoke="s7-row"][data-session="${session.id}"]') &&
     !!document.querySelector('[data-smoke="s7-storage"]')`,
  );
  log(s7, 'S7 会话恢复：会话行 + 存储实况卡（storage.status）');
  if (!s7) exit(1);

  const loadedAfterS7 = await evalJs(loadedExpr);
  log(
    loadedAfterS7 === loadedBefore,
    `进 S7 不触发读盘（loadedCount ${loadedBefore} → ${loadedAfterS7}）`,
  );
  if (loadedAfterS7 !== loadedBefore) exit(1);

  // ── 7.7 S8 设置屏（内嵌主窗，不再是独立 BrowserWindow）
  //     点左栏菜单「设置…」→ go('s8') → 主窗路由到 SettingsScreen；
  //     外观配置改完 → applyAppearance 在同一窗生效。
  //     菜单是条件渲染（menuOpen 为真才在 DOM 里），所以先点账号按钮展开它。
  await evalJs(`document.querySelector('.side-foot .user-btn').click()`);
  await until(`!!document.querySelector('[data-smoke="menu-settings"]')`);
  await evalJs(`document.querySelector('[data-smoke="menu-settings"]').click()`);
  const s8Ready = await until(`!!document.querySelector('[data-smoke="settings-win"]')`);
  log(s8Ready, 'S8 设置屏渲染（主窗内嵌，go(\'s8\') 路由到 SettingsScreen）');
  if (!s8Ready) exit(1);

  // 外观配置改完 → 同一窗 DOM 真生效（R-8）
  await evalJs(
    `window.axon.invoke('config.patch', { patch: { 'ui.density': 'compact', 'ui.fontSize': 18 } })`,
  );
  const applied = await until(
    `document.body.dataset.density === 'compact' &&
     getComputedStyle(document.body).getPropertyValue('--fs-msg').trim() === '18px'`,
  );
  log(applied, '设置屏改外观 → 主窗 DOM 真生效（config.changed → applyAppearance，台账 R-8）');
  if (!applied) exit(1);

  // 重置回缺省
  await evalJs(`window.axon.invoke('config.reset', {})`);
  const resetOk = await until(
    `document.body.dataset.density === undefined &&
     getComputedStyle(document.body).getPropertyValue('--fs-msg').trim() === '15px'`,
  );
  log(resetOk, 'config.reset 后外观回缺省（删白名单叶子，不走 patch）');
  if (!resetOk) exit(1);

  // 回到会话屏：S8 是整屏接管（无侧栏），先按设置屏自己的「← 返回应用」退出，
  // 再点侧栏 nav-s1。重启幕的「左栏重新列出会话」断言要在稳定态上跑。
  await evalJs(`document.querySelector('[data-smoke="settings-back"]').click()`);
  await until(`!!document.querySelector('[data-smoke="nav-s1"]')`);
  await evalJs(`document.querySelector('[data-smoke="nav-s1"]').click()`);

  // ── 8. 重启恢复（M5 §4.5/§4.6）：同一个落盘根、第二次开机
  //     这一幕验的是「接线的形态」，单测（host.restart.test.ts）验的是语义：
  //     index.ts 是否真的把根接上、listRecords 是否真的先读 session.json、
  //     窗口重开时左栏是否重新列出上次的会话。
  //     重启前 6.5 幕已经留下一个停在 waiting 的分身 —— 它就是下方
  //     「上次中断于 …」的标的（每个分身都是终态的话，恢复扫描无痕可留）。
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
  const lazy = status?.sessionCount >= 1 && status?.loadedCount <= 1;
  log(
    lazy,
    `重启后列表秒开：${status?.sessionCount} 个会话、已加载 ${status?.loadedCount}（懒加载：列表来自 rollup）`,
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
    `window.axon.invoke('agent.messages', { path: '${spawned}' }).then(m => m.length)`,
  );
  log(msgs > 0, `主控 transcript 读回来了（${msgs} 条消息）`);
  const rowBack = await until(
    `!!document.querySelector('[data-smoke="session-row"][data-session="${session.id}"]')`,
  );
  log(rowBack, '重启后左栏重新列出这个会话（session.list → 懒加载摘要）');
  if (detail?.members < 2 || !(msgs > 0) || !rowBack) exit(1);

  // ── 8.5 S7 的真正验收点（MU-3 切片 9）：重启后才能验「上次中断」
  //     上一次是硬杀（killApp），而死前有分身处于非终态 ⇒ 恢复扫描会把它们降为
  //     空闲并在 rollup 里落 `interruptedAt`（host.restart.test.ts 验语义）。
  //     这里验的是那个字段**有没有真的走到界面** —— E-1 整条链路的终点。
  //     它也是 P-1（本片含 S7）的理由：不做这一屏，M5 的落盘成果在 UI 上没出口。
  const hasCut = await evalJs(
    `window.axon.invoke('session.list', {}).then(l => l.some(s => typeof s.rollup?.interruptedAt === 'number'))`,
  );
  log(hasCut, '重启后 session.list 的 rollup 带回 interruptedAt（MU-3 E-1 协议扩展）');
  if (!hasCut) exit(1);

  await evalJs(`document.querySelector('[data-smoke="nav-s7"]').click()`);
  const s7cut = await until(
    `!!document.querySelector('[data-smoke="s7-row"] .s7-cut') &&
     !!document.querySelector('[data-smoke="s7-seg-recoverable"]')`,
  );
  log(s7cut, 'S7 把它渲染成「上次中断于 …」并归入「可恢复」分段');
  if (!s7cut) exit(1);

  // 「继续」要真能把人送进 S2（否则恢复屏只是个只读清单）。
  await evalJs(`document.querySelector('[data-smoke="s7-row"] [data-smoke="s7-continue"]').click()`);
  const backInSession = await until(`!!document.querySelector('[data-smoke="composer"]')`);
  log(backInSession, 'S7「继续」→ 回到会话屏（发意图 openSession，不是重新创建）');
  if (!backInSession) exit(1);

  exit(0);
} catch (err) {
  console.error('冒烟异常:', err);
  exit(1);
}
/**
 * Electron 主进程入口。
 *
 * 职责极窄，刻意如此：建窗口 + 把 IPC 转接到 AxonHost。
 * 所有编排逻辑都在 host.ts（不依赖 electron，可 headless 测试）。
 * 这里只要开始出现 if/else 的业务判断，就说明该往 host 里挪了。
 *
 * ── 为什么内核跑在主进程而非渲染进程 ──
 *
 * pi 的 Agent 需要文件系统、子进程、网络，这些在渲染进程里要么被沙箱挡住，
 * 要么得开 nodeIntegration —— 而开了它，任何一个 XSS 就是任意代码执行。
 * 渲染进程只发意图、收事件，不持有 Agent 实例。
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  IPC_COMMAND_CHANNEL,
  ipcEventChannel,
  sessionIdOfPath,
  type AgentPath,
  type CommandMap,
  type EventMap,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@axon/protocol';
import {
  Type,
  createFauxSource,
  createOpenAICompatSource,
  fauxAssistantMessage,
  fauxToolCall,
  lastUserText,
  scriptedSource,
  withTurnCost,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence } from './session-persistence.ts';
import { ALL_ROLES } from './roles.ts';
import { BUILTIN_TEAMS } from './teams.ts';
import { RoleBridge } from './role-bridge.ts';
import { TeamBridge } from './team-bridge.ts';
import { ConfigStore } from './config-store.ts';
import {
  CONFIG_PATH,
  maskKey,
  resolveModelChoice,
  type AxonConfig,
} from './model-config.ts';

/**
 * 构建产物是 ESM（pi 包 ESM-only，见 scripts/build.mjs），所以用 `import.meta.url`
 * 而非 `__dirname` —— 后者在 ESM 下不存在。
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * 用户角色目录。默认 ~/.axon/roles；AXON_ROLES_DIR 供开发/冒烟测试隔离，
 * 防止把真用户的角色目录写脏。
 */
const ROLES_DIR = process.env.AXON_ROLES_DIR || join(homedir(), '.axon', 'roles');

/**
 * 用户团队目录。默认 ~/.axon/teams；AXON_TEAMS_DIR 供开发/冒烟隔离
 * （与 ROLES_DIR 同理：冒烟不该把真用户的团队库写脏）。
 */
const TEAMS_DIR = process.env.AXON_TEAMS_DIR || join(homedir(), '.axon', 'teams');

/** 冒烟模式：只由 ui-smoke 打开，生产路径完全不受影响。 */
const SMOKE = !!process.env.AXON_SMOKE_SCRIPT;

/**
 * 实际生效的内置角色集合。
 *
 * 冒烟下给每个角色的白名单补上 `smoke_echo`——**必须在这里统一改**：
 * RoleBridge 也拿 builtinRoles 去 updateRoles，两处不同源的话
 * 热重载一跑就把补丁冲掉了（第一版就是这么踩的）。
 */
const EFFECTIVE_ROLES = SMOKE
  ? ALL_ROLES.map((r) => (r.tools ? { ...r, tools: [...r.tools, 'smoke_echo'] } : r))
  : ALL_ROLES;

let win: BrowserWindow | null = null;
let host: AxonHost | null = null;
let storage: SessionPersistence | undefined;
let roleBridge: RoleBridge | null = null;
let teamBridge: TeamBridge | null = null;
let configStore: ConfigStore | null = null;

// ── 事件投递与节流 ──────────────────────────────────────
//
// `session.changed` 是高频事件（状态跃迁 / 落账 / 每轮 turn.end 都会发），
// 每次重渲染的代价远高于一次 IPC，所以主进程做尾沿节流：
// 每会话 ≤4Hz，窗口内只保留**最新**一份（旧摘要是过期事实，补发没有意义）。
const SESSION_CHANGED_MIN_MS = 250;
const pendingSessionEvents = new Map<string, EventMap['session.changed']>();
const sessionChangedTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessionChangedAt = new Map<string, number>();

function sendEvent<E extends keyof EventMap>(
  event: E,
  payload: EventMap[E],
  source?: AgentPath,
): void {
  // 窗口可能已关闭（退出时仍有在途事件），静默丢弃。
  if (!win || win.isDestroyed()) return;
  const sessionId = source !== undefined ? sessionIdOfPath(source) : undefined;
  win.webContents.send(ipcEventChannel(event), {
    event,
    payload,
    ...(source !== undefined ? { source } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    at: Date.now(),
  });
}

function flushSessionChanged(sessionId: string): void {
  const latest = pendingSessionEvents.get(sessionId);
  pendingSessionEvents.delete(sessionId);
  if (!latest) return;
  sessionChangedAt.set(sessionId, Date.now());
  sendEvent('session.changed', latest);
}

function queueSessionChanged(payload: EventMap['session.changed']): void {
  const id = payload.summary.record.id;
  pendingSessionEvents.set(id, payload);
  if (sessionChangedTimers.has(id)) return; // 已有定时器：换内容即可
  const last = sessionChangedAt.get(id) ?? 0;
  const wait = Math.max(0, SESSION_CHANGED_MIN_MS - (Date.now() - last));
  const timer = setTimeout(() => {
    sessionChangedTimers.delete(id);
    flushSessionChanged(id);
  }, wait);
  sessionChangedTimers.set(id, timer);
}

function emitBridgeEvent<E extends keyof EventMap>(
  event: E,
  payload: EventMap[E],
  source?: AgentPath,
): void {
  if (event === 'session.changed') {
    queueSessionChanged(payload as EventMap['session.changed']);
    return;
  }
  if (event === 'session.removed') {
    // 会话没了：丢掉还没发的摘要，免得 UI 收到「先删后改」。
    const id = (payload as EventMap['session.removed']).sessionId;
    pendingSessionEvents.delete(id);
    const t = sessionChangedTimers.get(id);
    if (t) {
      clearTimeout(t);
      sessionChangedTimers.delete(id);
    }
    sessionChangedAt.delete(id);
  }
  sendEvent(event, payload, source);
}

/**
 * 选一个 model source：真网关（`~/.axon/config.json` 配好了）或 faux。
 *
 * 降级而非报错，是因为「没配 key 就启动不了」会把整个开发/测试链路绑在
 * 一个外部依赖上；冒烟、CI、以及新克隆的仓库都应该能直接 `bun run dev`。
 */
async function buildModelSource(config: AxonConfig): Promise<{ source: ModelSource; label: string }> {
  const choice = resolveModelChoice(config);

  if (choice.kind === 'openai-compat') {
    const real = createOpenAICompatSource({
      providerId: choice.providerId,
      providerName: choice.providerName,
      baseUrl: choice.baseUrl,
      apiKey: choice.apiKey,
      models: choice.models,
      defaultModel: choice.defaultModel,
      ...(choice.headers ? { headers: choice.headers } : {}),
    });
    return {
      source: real,
      label: `真模型 ${choice.providerId}/${choice.defaultModel} @ ${choice.baseUrl}（key ${maskKey(choice.apiKey)}）`,
    };
  }

  // faux：零成本、无需 API key、可重复。它不是残留物，是测试通道的正式成员。
  const faux = await createFauxSource({ provider: 'axon-dev' });
  faux.setResponses([]);
  return { source: faux, label: `faux（${choice.reason}）` };
}

/**
 * 模型源 + 冒烟包装。config.patch 改 provider 后要重新走一遍，所以抽成函数。
 */
async function createModelSource(config: AxonConfig): Promise<{ source: ModelSource; label: string }> {
  const { source, label } = await buildModelSource(config);
  let modelSource: ModelSource = source;

  // ── 冒烟钩子（只有 ui-smoke 通过 env 打开，生产路径不受影响）──
  // AXON_SMOKE_SCRIPT：任何 user 文本都得到脚本化答复。faux 的响应队列是
  // 「每条消费一个」（pi-ai providers/faux.js:337 shift），普通模式几轮就空；
  // scriptedSource 按文本路由永不耗尽，冒烟可以连发多轮。
  if (SMOKE) {
    modelSource = scriptedSource(modelSource, {}, (text) => smokeReply(text));
  }
  // AXON_SMOKE_BUDGET_COST / _HARD：每轮注入固定成本 + 硬线阈值，
  // 供 ui-smoke 驱动预算熔断的 warning→frozen 两段 UI。
  //
  // 只给含「烧钱」的 prompt 计费：预算冻结是**终态**（一冻就拒所有新任务），
  // 若每轮都计费，M4 的账本/审批幕会把额度烧光，幕次之间隐形耦合。
  if (process.env.AXON_SMOKE_BUDGET_COST) {
    const cost = Number(process.env.AXON_SMOKE_BUDGET_COST);
    modelSource = withTurnCost(modelSource, (ctx) =>
      lastUserText(ctx as never).includes('烧钱') ? cost : 0,
    );
  }
  return { source: modelSource, label };
}

/**
 * 冒烟专用的无害叶子工具。
 *
 * 存在理由只有一个：M4 的审批门只拦叶子工具（决策 D5），
 * 而生产路径的 tools universe 现在只有六件套编排工具，
 * 不注入一个叶子工具就没有任何东西能驱动审批 banner。
 */
function smokeEchoTool() {
  return {
    name: 'smoke_echo',
    description: '冒烟用：原样返回传入的文本。',
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id: string, args: { text?: string }) => ({
      content: [{ type: 'text' as const, text: `echo: ${args?.text ?? ''}` }],
    }),
  };
}

/**
 * 冒烟脚本的回复路由。
 *
 * 魔术前缀驱动工具调用，好过让 ui-smoke 去戳主进程内部：
 * 冒烟只能从「人能做的事」（发一句 prompt）入手，否则验的就不是真链路。
 * 工具调用只在第一轮发（callIndex 卫兵）：工具返回后引擎会拿同一句
 * user 文本再要一轮，不卡会无限递归。
 */
function smokeReply(text: string): unknown {
  const seen = smokeCalls.get(text) ?? 0;
  smokeCalls.set(text, seen + 1);
  if (seen === 0 && text.startsWith('协作')) {
    return fauxAssistantMessage(
      [fauxToolCall('agent', { role: 'blank', task: '冒烟子任务' })],
      { stopReason: 'toolUse' },
    );
  }
  if (seen === 0 && text.startsWith('动手')) {
    return fauxAssistantMessage([fauxToolCall('smoke_echo', { text })], {
      stopReason: 'toolUse',
    });
  }
  return fauxAssistantMessage(`${text}（脚本答复）`);
}
const smokeCalls = new Map<string, number>();

async function createHost(config: AxonConfig): Promise<AxonHost> {
  const { source: modelSource, label } = await createModelSource(config);
  console.log(`[desktop] model source: ${label}`);

  // 预算硬线：冒烟 env 优先，否则读配置。接了真模型之后这行不再是演习——
  // faux 时代 cost 恒为 0（faux.js:147 硬编码），没人会真的花钱。
  const budget = process.env.AXON_SMOKE_BUDGET_HARD
    ? { hardUsd: Number(process.env.AXON_SMOKE_BUDGET_HARD) }
    : config.budgetUsd
      ? {
          hardUsd: config.budgetUsd,
          ...(config.budgetSoftUsd !== undefined ? { softUsd: config.budgetSoftUsd } : {}),
        }
      : undefined;

  // 叶子工具：生产路径下为空（M4 不交付叶子工具）；冒烟下注入一个无害的
  // echo 工具，否则 HITL 门根本无从触发——编排工具按决策 D5 是豁免的。
  // 工具进了 universe 还不够：还得进角色白名单，否则会被白名单先拦
  // （白名单优先于 HITL：未获授权的工具不该拿去烦人）。
  // 会话落盘根（M5 §4.4）：只有接线层知道「东西写哪儿」——宿主拿到的只是一个实例。
  // 冒烟/测试用 AXON_SESSIONS_DIR 指到临时目录，别把垃圾写进用户的 home。
  const root = process.env.AXON_SESSIONS_DIR || join(homedir(), '.axon', 'sessions');
  storage = new SessionPersistence({ root });
  // 启动装载只读 session.json（§4.5）：树与账本等用户点开哪个会话再读哪个。
  const records = await storage.listRecords();
  console.log(`[desktop] sessions: ${root}（装载 ${records.length} 个会话记录）`);

  return new AxonHost({
    modelSource,
    roles: EFFECTIVE_ROLES,
    persistence: storage,
    records,
    ...(budget ? { budget } : {}),
    // 运行期参数全部来自配置文件（设置界面改的就是这些；applyConfig 走同一条路）。
    ...(config.maxConcurrent !== undefined ? { maxConcurrent: config.maxConcurrent } : {}),
    ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
    ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    ...(config.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: config.approvalTimeoutMs }
      : {}),
    ...(config.defaultApproval !== undefined ? { defaultApproval: config.defaultApproval } : {}),
    ...(config.defaultCwd !== undefined ? { defaultCwd: config.defaultCwd } : {}),
    ...(config.defaultExecutor !== undefined ? { defaultExecutor: config.defaultExecutor } : {}),
    ...(SMOKE ? { tools: [smokeEchoTool()] } : {}),
    emit: (event, payload, sourcePath) => emitBridgeEvent(event, payload, sourcePath),
  });
}

/**
 * 配置热应用（`config.patch` 成功后）。
 *
 * 两道：① 运行期参数交给 host.applyConfig（并发/预算/超时/默认档）；
 * ② provider 变了则重建模型源。**已在跑的 Agent 不受影响** —— 引擎在
 * spawn 那一刻就把 model/streamFn 固化了，与角色热重载同一条纪律
 * （中途换脑子对用户是惊吓不是惊喜）。
 */
async function applyConfigPatch(): Promise<void> {
  if (!host || !configStore) return;
  const raw = configStore.rawConfig();
  host.applyConfig(raw);
  const { source, label } = await createModelSource(raw);
  host.setModelSource(source);
  console.log(`[desktop] config applied；model source: ${label}`);
  sendEvent('config.changed', { config: configStore.snapshot() });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#16181d',
    webPreferences: {
      // 三条都不能松：渲染进程绝不碰 Node。
      // preload 用 .mjs：ESM preload 是 Electron 的硬性要求（且需 sandbox:false）。
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 里要用 contextBridge，sandbox 下 require 受限
    },
  });

  void win.loadFile(join(here, 'renderer/index.html'));
  win.webContents.on('did-finish-load', () => {
    // 冒烟探针：窗口起来 + 页面加载完。renderer 启动后会立刻 invoke
    // role.list / agent.list，那一步的成败在「交互」阶段验证。
    console.log('[desktop] window loaded');
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  configStore = new ConfigStore({ configPath: CONFIG_PATH, roleDir: ROLES_DIR, teamDir: TEAMS_DIR });
  await configStore.load();
  const rawConfig = configStore.rawConfig();

  host = await createHost(rawConfig);
  roleBridge = new RoleBridge({ dir: ROLES_DIR, builtinRoles: EFFECTIVE_ROLES, host });
  await roleBridge.init();
  // 团队在角色之后加载：`validateTeam` 要按角色表解 tools/approval，
  // 角色还没就位时会整批报 role-not-found（假红条）。
  teamBridge = new TeamBridge({
    dir: TEAMS_DIR,
    builtinTeams: BUILTIN_TEAMS,
    host,
    rolesProvider: () => host!.listRoles().entries.map((e) => e.role),
    defaultApprovalProvider: () => configStore!.rawConfig().defaultApproval,
  });
  await teamBridge.init();
  // 角色热重载 → 团队重算（角色表变了，原本合法的团队可能变坏）
  roleBridge.onChanged(() => {
    void teamBridge?.revalidate();
  });
  const state = host.listRoles();
  const teams = teamBridge.list();
  console.log(
    `[desktop] roles: ${state.entries.length} 个（用户 ${state.entries.filter((e) => e.source === 'user').length}），issues: ${state.issues.length}，目录 ${ROLES_DIR}`,
  );
  console.log(
    `[desktop] teams: ${teams.entries.length} 个（用户 ${teams.entries.filter((e) => e.source === 'user').length}），issues: ${teams.issues.length}，目录 ${TEAMS_DIR}`,
  );

  ipcMain.handle(
    IPC_COMMAND_CHANNEL,
    async (
      _event,
      request: RequestEnvelope,
    ): Promise<ResponseEnvelope> => {
      try {
        // 角色层三条命令直接路由到 RoleBridge（fs 职责，不属于 host 编排逻辑）。
        if (request.command === 'role.save') {
          const result = await roleBridge!.save(
            (request.payload as { role: never })['role'],
          );
          return { id: request.id, ok: true, result };
        }
        if (request.command === 'role.delete') {
          const result = await roleBridge!.remove(
            (request.payload as { name: string }).name,
          );
          return { id: request.id, ok: true, result };
        }
        if (request.command === 'role.openDir') {
          await shell.openPath(ROLES_DIR);
          return { id: request.id, ok: true, result: { path: ROLES_DIR } };
        }

        // 团队层：同样走 Bridge（文件 IO），list 从 host 读实时表。
        if (request.command === 'team.list') {
          return { id: request.id, ok: true, result: teamBridge!.list() };
        }
        if (request.command === 'team.save') {
          const result = await teamBridge!.save(
            (request.payload as { team: never })['team'],
          );
          return { id: request.id, ok: true, result };
        }
        if (request.command === 'team.delete') {
          const result = await teamBridge!.remove(
            (request.payload as { name: string }).name,
          );
          return { id: request.id, ok: true, result };
        }
        if (request.command === 'team.openDir') {
          await shell.openPath(TEAMS_DIR);
          return { id: request.id, ok: true, result: { path: TEAMS_DIR } };
        }

        // 配置层：ConfigStore 是唯一真相（含未知字段保留与环境变量锁）。
        if (request.command === 'config.get') {
          return { id: request.id, ok: true, result: configStore!.snapshot() };
        }
        if (request.command === 'config.patch') {
          const result = await configStore!.patch(
            (request.payload as { patch: never })['patch'],
          );
          if (result.accepted) await applyConfigPatch();
          return { id: request.id, ok: true, result };
        }

        const result = await host!.execute(
          request.command as keyof CommandMap,
          request.payload as never,
        );
        return { id: request.id, ok: true, result };
      } catch (err) {
        // 错误必须变成正常的 response 回去，不能让 invoke 直接 reject：
        // Electron 会把 Error 序列化成难以辨认的字符串，丢掉 code 与 detail。
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 退出：先把内存里的最后一笔写收口（M5 §五「崩溃点表」要求正常退出不丢数据）。
 *
 * will-quit 是同步的而 flush 是异步的 ⇒ 先 preventDefault 一次，收口完再 quit
 * （`quitting` 卫兵挡住第二次进入，否则死循环）。
 */
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  roleBridge?.dispose();
  teamBridge?.dispose();
  for (const t of sessionChangedTimers.values()) clearTimeout(t);
  sessionChangedTimers.clear();
  pendingSessionEvents.clear();
  // 顺序固定：dispose 会把挂起的审批结算为拒绝（这些 note 也要落盘）⇒ 再 flush。
  host?.dispose();
  // 上限 3s：flush 卡住（磁盘故障、队列里有不肯结束的写）不能让应用关不掉 ——
  // 退出路径的可用性优先于最后一笔写；`Promise.race` 不取消 flush，只是不再等。
  const flushed = storage
    ? Promise.race([storage.flush(), new Promise((r) => setTimeout(r, 3000))])
    : Promise.resolve();
  void flushed.finally(() => app.quit());
});

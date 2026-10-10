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

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir, readFile as fsReadFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { setGlobalDispatcher, ProxyAgent, EnvHttpProxyAgent, Agent as UndiciAgent } from 'undici';
import {
  IPC_COMMAND_CHANNEL,
  ipcEventChannel,
  resolveEmbeddingModels,
  sessionIdOfPath,
  type AgentPath,
  type AxonMenuId,
  type CommandMap,
  type EventMap,
  type OpenPathKind,
  type ProjectKind,
  type ProviderConfig,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@axon/protocol';
import {
  Type,
  createFauxSource,
  createMultiProviderSource,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedSource,
  withDsmlParsing,
  withTurnCost,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence } from './session-persistence.ts';
import { ALL_ROLES } from './roles.ts';
import { BUILTIN_TEAMS } from './teams.ts';
import { RoleBridge } from './role-bridge.ts';
import { TeamBridge } from './team-bridge.ts';
import { KnowledgeBridge, makeKnowledgeManager, type EmbeddingTarget } from './knowledge-bridge.ts';
import { createKbSearchTool, createKbListTool } from './kb-tools.ts';
import { ProjectStore } from './project-store.ts';
import { ConfigStore } from './config-store.ts';
import { AgentToolsRegistry, KNOWN_AGENT_TOOLS, userSearchPath } from './agent-tools.ts';
import { CLAUDE_ENGINE_ID, createClaudeEngine, isClaudeResumeCursor } from './engine-claude.ts';
import {
  describeWorkspace,
  disposeTempWorkspaces,
  inspectWorkspace,
  newTempWorkspace,
  trustPath,
} from './workspace.ts';
import { appMenuItems, installAppMenu, popupAppMenu } from './menu.ts';
import { applyWindowChrome, windowChromeOptions } from './window-chrome.ts';
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

/**
 * 会话落盘根。默认 ~/.axon/sessions；AXON_SESSIONS_DIR 供冒烟隔离。
 * 提到模块级是因为 `shell.openPath` 的枚举要解它（MU-3 E-3）。
 */
const SESSIONS_DIR = process.env.AXON_SESSIONS_DIR || join(homedir(), '.axon', 'sessions');

/**
 * 用户项目目录。默认 ~/.axon/projects；AXON_PROJECTS_DIR 供开发/冒烟隔离
 * （与 roles/teams 同理：冒烟不该把真用户的项目库写脏）。
 */
const PROJECTS_DIR = process.env.AXON_PROJECTS_DIR || join(homedir(), '.axon', 'projects');

/**
 * `shell.openPath` 枚举 → 真路径。写成函数是因为 CONFIG_PATH 受 AXON_CONFIG
 * 影响，而 env 在测试里会被改 —— 延迟求值比模块加载时固化安全。
 */
const OPEN_PATHS: Record<OpenPathKind, () => string> = {
  roles: () => ROLES_DIR,
  teams: () => TEAMS_DIR,
  sessions: () => SESSIONS_DIR,
  config: () => CONFIG_PATH,
};

/**
 * 外部 Agent 工具探测结果的缓存（见 agent-tools.ts：只探一次，之后读缓存）。
 * AXON_AGENT_TOOLS_CACHE 供开发/冒烟隔离。
 */
const AGENT_TOOLS_CACHE =
  process.env.AXON_AGENT_TOOLS_CACHE || join(homedir(), '.axon', 'agent-tools.json');

/** 冒烟模式：只由 ui-smoke 打开，生产路径完全不受影响。 */
const SMOKE = !!process.env.AXON_SMOKE_SCRIPT;

// ── 工作区文件浏览（fs.listDir / fs.readFile）的共享设施 ──

/** 预览文件大小上限：超过只回占位，不把内容塞进 IPC。 */
const FS_PREVIEW_MAX_BYTES = 1024 * 1024;

/** 按扩展名认出图片，供 <img> 直接以 base64 data-uri 渲染。 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/**
 * 把 `relPath` 解析成 cwd 沙箱内的绝对路径；越界即抛。
 *
 * 渲染进程零 Node，`relPath` 是它唯一能influence 的量。若不校验，一个 `../../`
 * 就能让主进程 readdir/readFile 到工作区之外的任意文件。规则：resolve 后必须
 * 等于 cwd 本身，或以 `cwd + sep` 为前缀 —— 与 shell.openPath 的枚举锁同一原则。
 */
function resolveInCwd(cwd: string, relPath: string): string {
  const rootAbs = resolve(cwd);
  const target = resolve(rootAbs, relPath || '.');
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`路径越出工作区：${relPath}`);
  }
  return target;
}

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
let knowledgeBridge: KnowledgeBridge | null = null;
let projectStore: ProjectStore | null = null;
let configStore: ConfigStore | null = null;
let agentTools: AgentToolsRegistry | null = null;

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
  // 收件人只有主窗。这里原本还带一个独立设置窗（MU-3），但设置早已改为主窗内的
  // 一屏（S8）；留着那个窗口的代价是它会订 `config.changed` 却渲染不出任何区别，
  // 连同 `windows.ts` 一起下线。
  const targets = [win].filter((w): w is BrowserWindow => w !== null && !w.isDestroyed());
  // 窗口可能已关闭（退出时仍有在途事件），静默丢弃。
  if (targets.length === 0) return;
  const sessionId = source !== undefined ? sessionIdOfPath(source) : undefined;
  const envelope = {
    event,
    payload,
    ...(source !== undefined ? { source } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    at: Date.now(),
  };
  for (const w of targets) w.webContents.send(ipcEventChannel(event), envelope);
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
 * 把 config.proxy 落地为 undici 全局 dispatcher。
 *
 * 为什么用 undici：openai SDK（openai@6）的底层 fetch 使用 undici；
 * 设置全局 dispatcher 后所有走 undici 的出站请求（含 LLM 调用）都走代理，
 * 无需各处单独注入。
 *
 * 四种情形：
 *  1. 配了 proxy.url        → ProxyAgent，把 noProxy 传给 requestTls/connect 白名单
 *  2. 没配 proxy.url        → 回到裸 Agent（清掉上一轮可能设置的代理）
 *  3. 环境变量 HTTP_PROXY 存在 → EnvHttpProxyAgent（兜底；只在「从未手动配过」时生效）
 *
 * 热更新：`applyConfigPatch` 调用本函数，已在跑的 Agent 连接不受影响
 * （undici 在 socket 被复用前才会走新的 dispatcher），新任务立即生效。
 */
function applyProxyConfig(config: AxonConfig): void {
  const url = config.proxy?.url?.trim();
  if (url) {
    const options: ConstructorParameters<typeof ProxyAgent>[0] = { uri: url };
    const noProxy = config.proxy?.noProxy;
    if (noProxy) {
      // undici ProxyAgent 支持 noProxyHosts 以跳过特定目标。
      (options as unknown as Record<string, unknown>).noProxyHosts = noProxy
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
    }
    setGlobalDispatcher(new ProxyAgent(options));
    console.log(`[desktop] proxy set: ${url}${noProxy ? ` (noProxy: ${noProxy})` : ''}`);
  } else if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
    // 用户未在 UI 配代理，但启动时环境变量存在 —— 遵守系统设置。
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[desktop] proxy: 跟随 HTTP_PROXY/HTTPS_PROXY 环境变量');
  } else {
    // 明确清除：config.patch 把 proxy.url 置 null 时也要能去掉代理。
    setGlobalDispatcher(new UndiciAgent());
    console.log('[desktop] proxy: 无');
  }
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
    const real = createMultiProviderSource(
      choice.providers.map((p) => ({
        providerId: p.providerId,
        providerName: p.providerName,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        models: p.models,
        defaultModel: p.defaultModel,
        ...(p.headers ? { headers: p.headers } : {}),
      })),
      choice.defaultRef,
    );
    // 多网关时日志逐个列出，否则排查「这次到底发到哪个 baseUrl」只能靠猜。
    const detail = choice.providers
      .map((p) => `${p.providerId} @ ${p.baseUrl}（key ${maskKey(p.apiKey)}）`)
      .join('；');
    return {
      // withDsmlParsing：部分网关（未开 tool-call-parser 的 vLLM/SGLang）把
      // DeepSeek 工具调用以 <｜DSML｜calls> special token 吐回明文；这层把它
      // 重建为标准 toolCall 内容块，让 agent-loop 能正常执行工具。
      // 若网关侧修复后可直接把 withDsmlParsing(real) 换回 real。
      source: withDsmlParsing(real),
      label: `真模型 ${choice.defaultRef}（共 ${choice.providers.length} 个提供商：${detail}）`,
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
  // AXON_SMOKE_TURN_COST：给每一轮注入固定成本，让用量屏与顶栏金额有非零数可读。
  //
  // 它前身是 AXON_SMOKE_BUDGET_COST，当时只给含「烧钱」的 prompt 计费 —— 理由是
  // 预算 frozen 是**终态**，每轮都计费会把后面的幕次一起冻住。2026-10-10 熔断下线后
  // 没有终态了，故一律计费。faux 自身 cost 恒为 0（pi-ai providers/faux.js:147），
  // 不注入的话整条用量链路（ledger → 会话摘要 → S6/顶栏）只能验到「结构在」。
  if (process.env.AXON_SMOKE_TURN_COST) {
    const cost = Number(process.env.AXON_SMOKE_TURN_COST);
    modelSource = withTurnCost(modelSource, () => cost);
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

async function createHost(config: AxonConfig, kbManager?: import('@axon/knowledge').KnowledgeManager): Promise<AxonHost> {
  const { source: modelSource, label } = await createModelSource(config);
  console.log(`[desktop] model source: ${label}`);

  // 代理：建宿主之前先把全局 dispatcher 配好，确保后续所有出站请求都走代理。
  applyProxyConfig(config);


  // 叶子工具：生产路径下为空（M4 不交付叶子工具）；冒烟下注入一个无害的
  // echo 工具，否则 HITL 门根本无从触发——编排工具按决策 D5 是豁免的。
  // 工具进了 universe 还不够：还得进角色白名单，否则会被白名单先拦
  // （白名单优先于 HITL：未获授权的工具不该拿去烦人）。
  // 会话落盘根（M5 §4.4）：只有接线层知道「东西写哪儿」——宿主拿到的只是一个实例。
  // 冒烟/测试用 AXON_SESSIONS_DIR 指到临时目录，别把垃圾写进用户的 home。
  const root = SESSIONS_DIR;
  storage = new SessionPersistence({ root });
  // 启动装载只读 session.json（§4.5）：树与账本等用户点开哪个会话再读哪个。
  const records = await storage.listRecords();
  console.log(`[desktop] sessions: ${root}（装载 ${records.length} 个会话记录）`);

  // M6: modelSource 可能携带 selectModel（openai-compat path），套入安全。
  return new AxonHost({
    modelSource,
    roles: EFFECTIVE_ROLES,
    persistence: storage,
    records,
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
    tools: [
      ...(SMOKE ? [smokeEchoTool()] : []),
      ...(kbManager ? [createKbSearchTool(kbManager), createKbListTool(kbManager)] : []),
    ],
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
  applyProxyConfig(raw);
  const { source, label } = await createModelSource(raw);
  host.setModelSource(source);
  console.log(`[desktop] config applied；model source: ${label}`);
  sendEvent('config.changed', { config: configStore.snapshot() });
}

/**
 * 截图钩子 —— MU-2 逐值对齐（设计与实现并排看）用。
 *
 * 为什么放主进程而不是外挂 CDP 脚本：capturePage 在这里只要一句话；
 * 走 CDP 得另起 WebSocket + Runtime.evaluate + 生命周期管理，为几张 PNG 不值。
 * 与 AXON_SMOKE_SCRIPT 同一惯例：只有 env 打开时才生效，生产路径不受影响。
 *
 * 驱动方式（三个 env）：
 *   AXON_SHOT_DIR   —— 输出目录（必需，缺它就是普通启动）
 *   AXON_SHOT_INIT  —— 截图前先跑的页面 JS（造种子数据，可选）
 *   AXON_SHOT_HOOKS —— `名字=data-smoke值` 逗号分隔，逐个点击后截图
 */
async function runShotHook(): Promise<void> {
  const dir = process.env.AXON_SHOT_DIR;
  const w = win;
  if (!dir || !w) return;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await mkdir(dir, { recursive: true });
    await wait(1500);
    const init = process.env.AXON_SHOT_INIT;
    if (init) {
      // 回显 init 的返回值：把它当 DOM 探针用（「这个元素是谁、多宽多高」），
      // 否则量的结论只能靠看图猜。
      const probe = await w.webContents.executeJavaScript(init, true);
      console.log('[shot] init →', JSON.stringify(probe));
      await wait(2500);
    }
    // 菜单栏是原生 views，**不在 capturePage 的 PNG 里** —— 截图上「顶部只剩一行」
    // 不能证明它被藏掉了（原生菜单栏本来就可能被裁在 web contents 之外）。
    // 这两个数才是证据（Windows 上期望 menubar=false；macOS 上恒为 true，无视即可）。
    console.log('[shot] menubar=', w.isMenuBarVisible(), 'maximized=', w.isMaximized());
    const shots = (process.env.AXON_SHOT_HOOKS ?? 's0=nav-s0').split(',').filter(Boolean);
    for (const item of shots) {
      const [name, hookName] = item.split('=');
      const js = `document.querySelector('[data-smoke="${hookName}"]')?.click()`;
      await w.webContents.executeJavaScript(js, true);
      await wait(900);
      const img = await w.webContents.capturePage();
      await writeFile(join(dir, `${name}.png`), img.toPNG());
      console.log(`[shot] ${name} → ${name}.png`);
    }
  } catch (err) {
    console.error('[shot] 失败:', err);
  }
  app.quit();
}
function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#fcfcfb', // = tokens.css --bg-canvas（浅色主题，避免启动瞬间深色闪一下）
    // 顶栏改成贴窗口顶沿的通栏（Codex 式）：hiddenInset 把内容顶到最上沿、交通灯内嵌到
    // 左上角，会话顶栏（标题 / 文件 / 属性 / 叫人）与侧栏品牌区一起构成那条通栏标题栏，
    // 「文件 / 属性 / 叫人」按钮随之贴到窗口右上角。仅 macOS。**Windows 不走这条**：
    // 它的菜单不在系统顶栏，要在窗口里画，于是改走 windowChromeOptions 的
    // titleBarStyle:'hidden' + titleBarOverlay（见 window-chrome.ts 文件头）。
    // Linux 两条都不走：它不支持窗控叠加层，自绘就得自己实现三个窗控按钮，
    // 回退到系统默认边框。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...windowChromeOptions(),
    // 自绘标题栏（「Axon + 文件/编辑/视图/窗口」）第一次让窄窗有硬冲突：品牌字 +
    // 四个菜单名 + 右侧约 138px 的系统窗控叠加层，窗口太窄就会撞在一起。720 与
    // 设置屏内容宽（`settings.css` 的 --st-nav-w + --st-body-w）的下限一致。
    // 仅 Windows —— 别的平台没有这条标题栏，不该被顺带改掉窗口下限。
    ...(process.platform === 'win32' ? { minWidth: 720 } : {}),
    // Windows 的窗口/任务栏图标取自 BrowserWindow 的 icon（macOS 无此项，走 app.dock）。
    // 开发态跑的是 electron.exe，不指这个就显示 Electron 默认图标；打包态改用 exe 内嵌资源
    // （electron-builder 的 win.icon），此项被忽略，但留着无害且保证开发态一致。
    ...(process.platform === 'win32' ? { icon: join(here, 'icon.ico') } : {}),
    webPreferences: {
      // 三条都不能松：渲染进程绝不碰 Node。
      // preload 用 .mjs：ESM preload 是 Electron 的硬性要求（且需 sandbox:false）。
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 里要用 contextBridge，sandbox 下 require 受限
    },
  });

  // 藏原生菜单栏（菜单名改由渲染层画进标题栏，见 window-chrome.ts）。
  // 放在这里而不是只靠 installAppMenu：那一步发生在**装菜单之后**，
  // 覆盖不到「此刻已存在的窗口」之外的情况，两边都调才不漏。
  applyWindowChrome(win);

  void win.loadFile(join(here, 'renderer/index.html'));
  win.webContents.on('did-finish-load', () => {
    // 冒烟探针：窗口起来 + 页面加载完。renderer 启动后会立刻 invoke
    // role.list / agent.list，那一步的成败在「交互」阶段验证。
    console.log('[desktop] window loaded');
    // MU-2 逐值对齐用：AXON_SHOT_DIR 打开时自己截图（见 runShotHook）。
    if (process.env.AXON_SHOT_DIR) void runShotHook();
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  // 开发态（未打包）dock 图标：打包后 electron-builder 会用 icon.icns，dock 自动生效；
  // 开发态直接跑 dist/main.mjs 不经打包，dock 退回默认 Electron 图标，这里手动兜住。
  // Windows 的等价逻辑在 createWindow 的 BrowserWindow icon 选项（Windows 没有 app.dock）。
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(join(here, 'icon.png'));
  }

  configStore = new ConfigStore({ configPath: CONFIG_PATH, roleDir: ROLES_DIR, teamDir: TEAMS_DIR });
  await configStore.load();
  const rawConfig = configStore.rawConfig();

  // M14：在 createHost 之前创建 KnowledgeManager，这样 kb 工具可以在构造时注入
  // host universe（AxonHost.tools 是 readonly，只能在 new 时传入）。
  // 冒烟模式跳过（避免依赖真实 LanceDB 目录）。
  //
  // M17：端点从 `providers[]` 里挑 —— 先前读的是 legacy `config.provider` 单数键，
  // 而 M15 的迁移会把它删掉（config-store.migrate），于是这里恒为 undefined、
  // kbManager 恒为 null，知识库整块功能静默失效。e2e 靠 AXON_KB_EMBED_* 注入桩服务，
  // 走不到这条真实路径，所以一直是绿的。
  const embTargets = resolveEmbeddingModels(rawConfig.providers).flatMap(
    ({ provider, model }): EmbeddingTarget[] =>
      provider.baseUrl && provider.apiKey && model.id
        ? [{ model: model.id, endpoint: provider.baseUrl, apiKey: provider.apiKey }]
        : [],
  );
  // AXON_KB_EMBED_* 供端到端测试把 embedding 指向本地桩服务（照 AXON_KNOWLEDGE_DIR 的惯例）。
  // 三件套齐全时**整组替换**，不让真实配置混进 e2e。
  const stubEndpoint = process.env.AXON_KB_EMBED_ENDPOINT;
  const stubKey = process.env.AXON_KB_EMBED_KEY;
  const stubModel = process.env.AXON_KB_EMBED_MODEL;
  const kbTargets: EmbeddingTarget[] =
    stubEndpoint && stubKey && stubModel
      ? [{ model: stubModel, endpoint: stubEndpoint, apiKey: stubKey }]
      : embTargets;
  const kbManager: import('@axon/knowledge').KnowledgeManager | null =
    kbTargets.length && !SMOKE ? makeKnowledgeManager({ targets: kbTargets }) : null;
  if (kbManager) {
    console.log(
      `[desktop] 知识库向量模型：${kbTargets[0]!.model}（共 ${kbTargets.length} 个可选）`,
    );
  } else if (!SMOKE) {
    console.warn(
      '[desktop] 没有可用的向量模型，知识库未启用 —— 到 设置 → 模型配置 给某个模型勾上「向量」。',
    );
  }

  host = await createHost(rawConfig, kbManager ?? undefined);
  roleBridge = new RoleBridge({ dir: ROLES_DIR, builtinRoles: EFFECTIVE_ROLES, host });
  await roleBridge.init();
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

  // M14：知识库 bridge（使用 createHost 之前预创建的 kbManager）。
  // kbManager 为 null 时（冒烟/未配置）注册空 stub，使 kb.* 命令返回空结果。
  if (kbManager) {
    knowledgeBridge = new KnowledgeBridge(
      ipcMain,
      () => win?.webContents ?? null,
      kbManager,
    );
    knowledgeBridge.bindEvents();
    console.log('[desktop] KnowledgeBridge 已就绪，kb 工具已注入 host');
  }
  // kbManager 为 null 时不建 bridge —— 信封处理器里 kb.* 会返回
  // 「知识库未启用」的结构化错误，由 S4 屏提示用户去配 Provider。

  // 项目层：独立于会话存储的项目元数据（一项目一文件）。
  // host 只需要「projectId → cwd」解析器来固化项目会话的工作空间。
  projectStore = new ProjectStore({ dir: PROJECTS_DIR });
  await projectStore.load();
  host.setProjectCwdResolver((id) => projectStore!.get(id)?.cwd);
  // 「可信路径集合」的两类初始来源（安全边界见 workspace.ts 文件头）：
  // 项目 cwd 与设置里的默认工作目录 —— 都是用户自己选的，不是渲染层编的。
  for (const p of projectStore.current().entries) trustPath(p.cwd);
  trustPath(configStore!.snapshot().config.defaultCwd);
  projectStore.watch((s) => {
    // 热重载进来的项目（用户手改项目文件）同样入集合。
    for (const p of s.entries) trustPath(p.cwd);
    sendEvent('projects.changed', s);
  });
  console.log(`[desktop] projects: ${projectStore.current().entries.length} 个，目录 ${PROJECTS_DIR}`);

  // 外部 Agent 工具：有缓存直接就绪；首次启动在后台探测，不挡窗口。
  // 冒烟模式不探测也不碰缓存文件：真探会起登录 shell、跑用户机器上的 CLI，
  // 而写缓存会把真用户的探测结果覆盖成空 —— 都与冒烟的隔离原则相悖。
  agentTools = new AgentToolsRegistry({
    cachePath: AGENT_TOOLS_CACHE,
    ...(SMOKE
      ? { detect: async () => [], cacheIO: { read: async () => null, write: async () => undefined } }
      : {}),
    onChange: (snapshot) => sendEvent('agentTools.changed', { snapshot }),
  });
  await agentTools.init();

  // 外部引擎（M9）：本机装没装、怎么拉起由这里回答，host 只管编排。
  host.setExternalEngineProvider({
    label: (engineId) => KNOWN_AGENT_TOOLS.find((t) => t.id === engineId)?.label ?? engineId,
    unavailableReason(engineId) {
      if (engineId !== CLAUDE_ENGINE_ID) return `暂不支持用 ${engineId} 执行会话`;
      const snap = agentTools!.snapshot();
      const claude = snap.tools.find((t) => t.id === CLAUDE_ENGINE_ID);
      if (claude?.installed) return undefined;
      return snap.status === 'detecting' && !claude
        ? '还在检测本机的 Agent 工具，请稍候再试'
        : '本机未检测到 Claude Code：安装后在「执行引擎」菜单里点「重新检测」';
    },
    create(spec) {
      return createClaudeEngine({
        cwd: spec.cwd,
        messages: spec.messages,
        ...(isClaudeResumeCursor(spec.cursor) ? { cursor: spec.cursor } : {}),
        // 路径到用时再取：用户「重新检测」之后，已建好的会话也能用上新路径。
        resolveRuntime: async () => {
          const claude = agentTools!.snapshot().tools.find((t) => t.id === CLAUDE_ENGINE_ID);
          if (!claude?.installed || !claude.path) {
            throw new Error('本机未检测到 Claude Code：安装后在「执行引擎」菜单里点「重新检测」');
          }
          // 普通会话的工作目录是临时目录，退出时会被清掉（workspace.ts）；重启后
          // Claude 要在**同一个路径**下才找得到它的会话记录，目录没了就先建回来。
          await mkdir(spec.cwd, { recursive: true });
          return { executable: claude.path, env: { ...process.env, PATH: await userSearchPath() } };
        },
        gate: spec.gate,
        onCursor: (cursor) => spec.onCursor({ ...cursor }),
      });
    },
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
      event,
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

        // 知识库层（M14）：kb.* 统一走 KnowledgeBridge.handle。
        //
        // 未配置 provider 时 knowledgeBridge 为 null，此时读写分流：
        // **读**（list/listDocs/query）降级为空结果 —— S4 屏首屏就会拉 kb.list，
        // 这里抛错会让用户一进屏就吃一条红条，而「还没有知识库」才是真实状态；
        // **写**（create/addSource/...）必须抛错 —— 用户正等着表单反馈，静默失败
        // 会让人以为建成了。错误消息直接指向该去改什么。
        if (request.command.startsWith('kb.')) {
          if (!knowledgeBridge) {
            if (request.command === 'kb.list' || request.command === 'kb.listDocs' || request.command === 'kb.query') {
              return { id: request.id, ok: true, result: [] as never };
            }
            return {
              id: request.id,
              ok: false,
              error: {
                code: 'kb-unavailable',
                message: '知识库未启用：请先在设置里配置 Provider 的 baseUrl 与 apiKey',
              },
            };
          }
          const result = await knowledgeBridge.handle(request.command, request.payload);
          return { id: request.id, ok: true, result: result as never };
        }

        // 项目层：ProjectStore（文件 IO）。create 成功后 watch 会补发 projects.changed，
        // 但这里立即以返回值让 UI 先更新，不等 watch 防抖。
        if (request.command === 'project.list') {
          return { id: request.id, ok: true, result: projectStore!.current() };
        }
        if (request.command === 'project.create') {
          const { name, cwd, kind } = request.payload as {
            name: string;
            cwd: string;
            kind?: ProjectKind;
          };
          const result = await projectStore!.create({ name, cwd, kind });
          if (result.accepted) {
            if (result.project) trustPath(result.project.cwd);
            sendEvent('projects.changed', projectStore!.current());
          }
          return { id: request.id, ok: true, result };
        }
        if (request.command === 'project.pickWorkspace') {
          // 渲染进程零 Node，目录选择器只能在主进程弹；限定为目录选择。
          // 标题不带「项目」二字：新建会话页换工作目录也走这条（两处入口共用）。
          const picked = await dialog.showOpenDialog({
            title: '选择工作空间',
            properties: ['openDirectory', 'createDirectory'],
          });
          const path = picked.filePaths[0];
          // 用户亲手在系统对话框里选的目录 = 可信来源，入集合后
          // `workspace.inspect` 才肯给它探测文件夹名与分支。
          if (path) trustPath(path);
          const result =
            picked.canceled || !path
              ? { cancelled: true }
              : { cancelled: false, path };
          return { id: request.id, ok: true, result };
        }

        // 工作区元信息（新建会话页的工作区 chip）。两条命令都不碰会话 ——
        // 会话还没建出来，正是拿不到 sessionId 才需要它们。
        if (request.command === 'workspace.newTemp') {
          return { id: request.id, ok: true, result: await newTempWorkspace() };
        }
        if (request.command === 'workspace.inspect') {
          const { path } = request.payload as { path: string };
          // 未授权路径会抛错（workspace.ts 里的安全边界），照常走 error 回包。
          return { id: request.id, ok: true, result: inspectWorkspace(path) };
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
        if (request.command === 'config.reset') {
          const result = await configStore!.reset();
          if (result.accepted) await applyConfigPatch();
          return { id: request.id, ok: true, result };
        }

        // 多提供商写侧（M15）：provider 是数组，点号路径表达不了「第几个的哪个
        // 字段」，所以整卡提交走这两条，而不是 config.patch。落盘成功后同样要
        // applyConfigPatch —— 否则改完模型源要重启才生效。
        if (request.command === 'provider.save') {
          const result = await configStore!.saveProvider(
            (request.payload as { provider: ProviderConfig }).provider,
          );
          if (result.accepted) await applyConfigPatch();
          return { id: request.id, ok: true, result };
        }
        if (request.command === 'provider.delete') {
          const result = await configStore!.deleteProvider(
            (request.payload as { id: string }).id,
          );
          if (result.deleted) await applyConfigPatch();
          return { id: request.id, ok: true, result };
        }

        // 外壳类（MU-3 E-3）：枚举 → 真路径的解析只在主进程做，
        // 渲染层拿不到、也不该拿到任意路径的 open 能力。
        if (request.command === 'shell.openPath') {
          const kind = (request.payload as { kind: OpenPathKind }).kind;
          const path = OPEN_PATHS[kind]();
          // 配置是单文件：openPath 会用默认编辑器打开它，而用户点的是
          // 「在访达中显示」—— 语义是定位，不是打开。
          if (kind === 'config') shell.showItemInFolder(path);
          else await shell.openPath(path);
          return { id: request.id, ok: true, result: { path } };
        }

        if (request.command === 'shell.pickFiles') {
          const picked = await dialog.showOpenDialog({
            title: '选择附件',
            properties: ['openFile', 'multiSelections'],
          });
          const paths = picked.canceled ? [] : picked.filePaths;
          return { id: request.id, ok: true, result: { paths } };
        }

        if (request.command === 'session.create') {
          const payload = request.payload as import('@axon/protocol').CreateSessionPayload;
          const { attachments, ...rest } = payload;
          // 先用不含 attachments 的 payload 建会话（协议层不认识这个字段）。
          const summary = await host!.execute('session.create', rest as never);
          // 有附件才复制；cwd 从刚建出来的会话记录里取，保证目录一定存在。
          if (attachments && attachments.length > 0) {
            const cwd = (summary as import('@axon/protocol').SessionSummary).record.cwd;
            await Promise.all(
              attachments.map(async (src) => {
                const name = src.replace(/\\/g, '/').split('/').pop() ?? src;
                try {
                  await copyFile(src, join(cwd, name));
                } catch (e) {
                  console.warn(`[desktop] 附件复制失败：${src} → ${name}`, e);
                }
              }),
            );
          }
          return { id: request.id, ok: true, result: summary };
        }

        // 应用菜单（Windows 自绘标题栏里的那排菜单名）。
        // 菜单清单读的是主进程真装着的那份，渲染层不复制一份名字。
        if (request.command === 'menu.list') {
          return { id: request.id, ok: true, result: { items: appMenuItems() } };
        }
        if (request.command === 'menu.popup') {
          // 窗口取**发起请求的那个**，不是模块级的 win：菜单要挂在发起者身上，
          // 否则位置与「点外面关闭」的归属都会怪。
          const sender = BrowserWindow.fromWebContents(event.sender);
          if (!sender) throw new Error('menu.popup：找不到发起请求的窗口');
          popupAppMenu((request.payload as { menuId: AxonMenuId }).menuId, sender);
          return { id: request.id, ok: true, result: { opened: true } };
        }

        // 工作区文件浏览（S2 顶部「打开文件」）：sessionId → record.cwd 作沙箱根，
        // relPath 经 resolveInCwd 校验后必须仍落在根内，否则抛错（防目录穿越）。

        // 会话工作区元信息：文件夹名 + git 分支（无仓库时 branch 为 null）。
        if (request.command === 'session.cwdInfo') {
          const { sessionId } = request.payload as { sessionId: string };
          const cwd = host!.getSession(sessionId)?.record.cwd;
          if (!cwd) throw new Error(`会话不存在或无工作区：${sessionId}`);
          // 用 describeWorkspace 而不是 inspectWorkspace：这条命令的凭据是
          // sessionId（会话存在就说明 cwd 可信），路径本身不需要再查可信集合 ——
          // 否则升级前建的老会话（cwd 可能是任意目录）会直接报错。
          const info = describeWorkspace(cwd);
          return { id: request.id, ok: true, result: { folderName: info.folderName, branch: info.branch } };
        }

        if (request.command === 'fs.listDir') {
          const { sessionId, relPath } = request.payload as {
            sessionId: string;
            relPath: string;
          };
          const cwd = host!.getSession(sessionId)?.record.cwd;
          if (!cwd) throw new Error(`会话不存在或无工作区：${sessionId}`);
          const target = resolveInCwd(cwd, relPath);
          const dirents = await readdir(target, { withFileTypes: true });
          const entries = await Promise.all(
            dirents
              .filter((d) => d.isDirectory() || d.isFile())
              .map(async (d) => {
                const kind = d.isDirectory() ? ('dir' as const) : ('file' as const);
                let size: number | undefined;
                if (kind === 'file') {
                  try {
                    size = (await stat(join(target, d.name))).size;
                  } catch {
                    size = undefined;
                  }
                }
                return { name: d.name, kind, size };
              }),
          );
          // 目录在前、各自按名排序：文件树的稳定观感靠这一步，不靠渲染层。
          entries.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return { id: request.id, ok: true, result: { root: cwd, relPath, entries } };
        }
        if (request.command === 'fs.readFile') {
          const { sessionId, relPath } = request.payload as {
            sessionId: string;
            relPath: string;
          };
          const cwd = host!.getSession(sessionId)?.record.cwd;
          if (!cwd) throw new Error(`会话不存在或无工作区：${sessionId}`);
          const target = resolveInCwd(cwd, relPath);
          const info = await stat(target);
          if (!info.isFile()) throw new Error(`不是文件：${relPath}`);
          const size = info.size;
          if (size > FS_PREVIEW_MAX_BYTES) {
            return {
              id: request.id,
              ok: true,
              result: { content: '', encoding: 'utf8', tooLarge: true, size },
            };
          }
          const mime = IMAGE_MIME[extname(target).toLowerCase()];
          if (mime) {
            const buf = await fsReadFile(target);
            return {
              id: request.id,
              ok: true,
              result: { content: buf.toString('base64'), encoding: 'base64', mime, size },
            };
          }
          const content = await fsReadFile(target, 'utf8');
          return { id: request.id, ok: true, result: { content, encoding: 'utf8', size } };
        }

        // 外部 Agent 工具探测（agent-tools.ts）：不属于 host 编排逻辑。
        if (request.command === 'agentTools.get') {
          return { id: request.id, ok: true, result: agentTools!.snapshot() };
        }
        if (request.command === 'agentTools.redetect') {
          return { id: request.id, ok: true, result: await agentTools!.redetect() };
        }

        // M10：子任务 session 列表
        if (request.command === 'subsession.list') {
          const { parentSessionId } = request.payload as { parentSessionId: string };
          const parent = host!.getSession(parentSessionId);
          const childIds = parent?.record.childSessionIds ?? [];
          const result = childIds.flatMap((id) => {
            const s = host!.getSession(id);
            return s ? [{ record: s.record, rootPath: s.rootPath, status: s.status, counts: s.counts, usage: s.usage }] : [];
          });
          return { id: request.id, ok: true, result };
        }

        // M6: provider.test —— W-B 的 provider-probe.ts 落地后替换 stub 实现。
        // 拦在 host.execute 之前，因为 host 不处理这条命令。
        if (request.command === 'provider.test') {
          try {
            const { probeProvider } = await import('./provider-probe.ts');
            const payload = request.payload as
              | { model?: string; providerId?: string; kind?: 'chat' | 'embedding' }
              | undefined;
            const result = await probeProvider(payload?.model, payload?.providerId, payload?.kind);
            return { id: request.id, ok: true, result };
          } catch {
            // provider-probe.ts 尚未交付（W-B 阶段）或探针失败时的兜底。
            const result: CommandMap['provider.test']['result'] = {
              ok: false,
              latencyMs: 0,
              models: [],
              error: 'provider-probe not yet available',
            };
            return { id: request.id, ok: true, result };
          }
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
  // 菜单在窗口之后装：「设置…」点下去要有窗口可切（且此时 configStore 已就位）。
  installAppMenu({
    openSettings: () => {
      // 「设置…」/⌘, 落到主窗的 S8 屏 —— 与侧栏那个「设置」同一屏。
      // 这里原本调 openSettingsWindow() 开独立窗，而渲染层早已不认那个窗口
      // （main.tsx 不再看 URL hash），于是同一个入口会点出两种设置界面，
      // 其中一种还是个和主窗长得一模一样的重复窗口。
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      sendEvent('ui.openSettings', {});
    },
  });

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
  projectStore?.dispose();
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
  // 清掉本次运行期分配的临时工作目录（普通会话的默认工作区，见 workspace.ts）。
  // 与 flush 并行，同样带上限：目录被外部占用删不掉时不能拖着应用关不掉。
  // 注意这是**真删** —— temp 目录里的产物会一并消失，这是既定语义。
  const cleaned = Promise.race([
    disposeTempWorkspaces(),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  void Promise.all([flushed, cleaned]).finally(() => app.quit());
});

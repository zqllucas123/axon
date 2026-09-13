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
  type CommandMap,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@axon/protocol';
import {
  createFauxSource,
  createOpenAICompatSource,
  fauxAssistantMessage,
  scriptedSource,
  withTurnCost,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost } from './host.ts';
import { ALL_ROLES } from './roles.ts';
import { RoleBridge } from './role-bridge.ts';
import {
  CONFIG_PATH,
  loadConfig,
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

let win: BrowserWindow | null = null;
let host: AxonHost | null = null;
let roleBridge: RoleBridge | null = null;

/**
 * 选一个 model source：真网关（`~/.axon/config.json` 配好了）或 faux。
 *
 * 降级而非报错，是因为「没配 key 就启动不了」会把整个开发/测试链路绑在
 * 一个外部依赖上；冒烟、CI、以及新克隆的仓库都应该能直接 `bun run dev`。
 */
async function createModelSource(): Promise<{ source: ModelSource; label: string; config: AxonConfig }> {
  const { config, error } = await loadConfig();
  if (error) console.warn(`[desktop] ${error}`);
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
      config,
      source: real,
      label: `真模型 ${choice.providerId}/${choice.defaultModel} @ ${choice.baseUrl}（key ${maskKey(choice.apiKey)}）`,
    };
  }

  // faux：零成本、无需 API key、可重复。它不是残留物，是测试通道的正式成员。
  const faux = await createFauxSource({ provider: 'axon-dev' });
  faux.setResponses([]);
  return { config, source: faux, label: `faux（${choice.reason}；配置文件 ${CONFIG_PATH}）` };
}

async function createHost(): Promise<AxonHost> {
  const { source, label, config } = await createModelSource();
  console.log(`[desktop] model source: ${label}`);

  // ── 冒烟钩子（只有 ui-smoke 通过 env 打开，生产路径不受影响）──
  // AXON_SMOKE_SCRIPT：任何 user 文本都得到脚本化答复。faux 的响应队列是
  // 「每条消费一个」（pi-ai providers/faux.js:337 shift），普通模式几轮就空；
  // scriptedSource 按文本路由永不耗尽，冒烟可以连发多轮。
  let modelSource: ModelSource = source;
  if (process.env.AXON_SMOKE_SCRIPT) {
    modelSource = scriptedSource(
      source,
      {},
      (text) => fauxAssistantMessage(`${text}（脚本答复）`),
    );
  }
  // AXON_SMOKE_BUDGET_COST / _HARD：每轮注入固定成本 + 硬线阈值，
  // 供 ui-smoke 驱动预算熔断的 warning→frozen 两段 UI。
  if (process.env.AXON_SMOKE_BUDGET_COST) {
    const cost = Number(process.env.AXON_SMOKE_BUDGET_COST);
    modelSource = withTurnCost(modelSource, () => cost);
  }
  // 预算硬线：冒烟 env 优先，否则读配置。接了真模型之后这行不再是演习——
  // faux 时代 cost 恒为 0（faux.js:147 硬编码），没人会真的花钱。
  const budget = process.env.AXON_SMOKE_BUDGET_HARD
    ? { hardUsd: Number(process.env.AXON_SMOKE_BUDGET_HARD) }
    : config.budgetUsd
      ? { hardUsd: config.budgetUsd }
      : undefined;

  return new AxonHost({
    modelSource,
    roles: ALL_ROLES,
    budget,
    emit: (event, payload, sourcePath) => {
      // 窗口可能已关闭（用户退出时仍有在途事件），静默丢弃。
      if (!win || win.isDestroyed()) return;
      win.webContents.send(ipcEventChannel(event), {
        event,
        payload,
        source: sourcePath,
        at: Date.now(),
      });
    },
  });
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
  host = await createHost();
  roleBridge = new RoleBridge({ dir: ROLES_DIR, builtinRoles: ALL_ROLES, host });
  await roleBridge.init();
  const state = host.listRoles();
  console.log(
    `[desktop] roles: ${state.entries.length} 个（用户 ${state.entries.filter((e) => e.source === 'user').length}），issues: ${state.issues.length}，目录 ${ROLES_DIR}`,
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

app.on('will-quit', () => {
  roleBridge?.dispose();
});

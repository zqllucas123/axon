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

import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  IPC_COMMAND_CHANNEL,
  ipcEventChannel,
  type CommandMap,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@axon/protocol';
import { createFauxSource } from '@axon/kernel';
import { AxonHost } from './host.ts';
import { ALL_ROLES } from './roles.ts';

/**
 * 构建产物是 ESM（pi 包 ESM-only，见 scripts/build.mjs），所以用 `import.meta.url`
 * 而非 `__dirname` —— 后者在 ESM 下不存在。
 */
const here = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let host: AxonHost | null = null;

async function createHost(): Promise<AxonHost> {
  // 目前用 faux provider 起步 —— 真 provider 接入是下一步的事。
  // 好处是现在就能端到端跑通 UI↔IPC↔编排，不被 API key 卡住。
  const source = await createFauxSource({ provider: 'axon-dev' });
  source.setResponses([]);

  return new AxonHost({
    modelSource: source,
    roles: ALL_ROLES,
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

  ipcMain.handle(
    IPC_COMMAND_CHANNEL,
    async (
      _event,
      request: RequestEnvelope,
    ): Promise<ResponseEnvelope> => {
      try {
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

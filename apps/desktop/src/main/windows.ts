/**
 * 窗口工厂 —— 主窗之外的第二个窗口（设置窗）从这里开（MU-3 切片 2）。
 *
 * 为什么设置要独立成窗，而不是主窗里的一屏（拍板 P-3 / UX `03-设置界面设计.md:111-113`）：
 *  - 设置**没有会话上下文**。塞进主窗就得决定「顶栏那枚会话 chip 此刻指谁」，
 *    而正确答案是「谁也不指」—— 一个语义上为空的 chip 比没有 chip 更糟。
 *  - 用户改设置时常要对照正在跑的会话（并发上限、审批档），两个窗口能并排看。
 *
 * 单例语义写在主进程而不是渲染层：渲染层没有「已经有一个设置窗了」这个事实，
 * 只有主进程知道。渲染层只发意图（`window.openSettings`）。
 */

import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 构建产物是 ESM（见 scripts/build.mjs）：没有 __dirname，只能靠 import.meta.url。 */
const here = dirname(fileURLToPath(import.meta.url));

let settingsWin: BrowserWindow | null = null;

/** 当前设置窗（没开则 null）。事件广播要用它 —— 设置窗也订阅 `config.changed`。 */
export function settingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
}

/**
 * 打开设置窗；**已开则聚焦**（03 §2「聚焦而非新开」）。
 *
 * 与主窗共用同一份 `index.html` + `renderer.js`，靠 URL hash 分叉
 * （`main.tsx` 读 `location.hash === '#settings'`）。共用的理由是构建保险丝：
 * 再开一条 renderer 入口就要再加一条 esbuild 产物 + 一份 CSP 相同的 html，
 * 而两者唯一的差别只是挂哪个根组件。
 */
export function openSettingsWindow(): BrowserWindow {
  const existing = settingsWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  const w = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: '设置',
    backgroundColor: '#fcfcfb', // = tokens.css --bg-canvas
    webPreferences: {
      // 与主窗同样的三条铁律：渲染进程绝不碰 Node（AGENTS.md §4.3）。
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void w.loadFile(join(here, 'renderer/index.html'), { hash: 'settings' });
  w.on('closed', () => {
    settingsWin = null;
  });
  settingsWin = w;
  return w;
}

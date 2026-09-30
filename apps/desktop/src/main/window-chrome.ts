/**
 * 窗口 chrome —— Windows 的**自绘标题栏**（本次改动）。
 *
 * 为什么 Windows 要自绘：它原来有两行顶栏 —— 系统原生标题栏（图标 + `Axon` +
 * 最小化/最大化/关闭），下面紧跟 Electron 自己画的**菜单栏**（文件/编辑/视图/窗口）。
 * 用户要求菜单并进标题栏那一行。做不到「把菜单塞进原生标题栏」，因为那是 OS 画的
 * 非客户区；只能反过来：`titleBarStyle: 'hidden'` 去掉原生标题栏，用
 * `titleBarOverlay` 把系统的三个窗控按钮以**叠加层**保留，标题栏那一行由渲染层画
 * （`renderer/components/Titlebar.tsx`）。
 *
 * macOS 不走这条路：它早就用 `hiddenInset` 把内容顶到窗口顶沿，而且菜单在**系统**
 * 顶栏，窗口里不需要再画一条。Linux 也不走：Linux 不支持窗控叠加层，自绘就得自己
 * 实现最小化/最大化/关闭三个按钮，另开一轮。
 */

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/** 只有 Windows 自绘标题栏（见文件头）。渲染层靠 `window.axon.platform` 做同一个判断。 */
const CUSTOM_TITLEBAR = process.platform === 'win32';

/**
 * 标题栏高度（DIP）。
 *
 * 与 `renderer/styles/components.css` 的 `.titlebar { height }` 是**同一个数**：
 * 叠加层（系统窗控按钮）的位置由这里的 `titleBarOverlay.height` 决定，
 * 我们的标题栏底色/边框由 CSS 决定，两者不等高就会露出错位的一条。
 * 改一处必须改另一处。
 */
export const TITLEBAR_HEIGHT = 40;

/**
 * 叠加层的底色与按钮颜色 —— 必须与 `tokens.css` 的 `--bg-sidebar`（#f2f1ee）
 * 和 `--text`（#1c1b19）**逐字相等**。叠加层是系统画的一块矩形，
 * 颜色对不上就会在标题栏右侧露出一块异色（改令牌时别忘了这里）。
 */
const TITLEBAR_BG = '#f2f1ee';
const TITLEBAR_FG = '#1c1b19';

/**
 * 窗口 chrome 相关构造项（展开进 `BrowserWindow` 的 options）。
 *
 * **不要加 `thickFrame: false`。** frameless 窗口在 Windows 上默认保留
 * `WS_THICKFRAME`（`thickFrame` 默认为 true），拖边缩放、Aero Snap、窗口阴影与
 * 动画全靠它；顺手关掉会一次性弄丢这三样，而症状（「窗口拖不动边」）看着像别的原因。
 */
export function windowChromeOptions(): BrowserWindowConstructorOptions {
  if (!CUSTOM_TITLEBAR) return {};
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR_BG,
      symbolColor: TITLEBAR_FG,
      height: TITLEBAR_HEIGHT,
    },
  };
}

/**
 * 窗口创建后的 chrome 收尾：藏掉原生菜单栏（菜单本身照旧装着，见 `menu.ts` 文件头）。
 *
 * 每个窗口都要调 —— 它在**创建时刻**生效，对之后新建的窗口不会自动补。主窗在
 * `createWindow` 末尾调，`menu.ts` 的 `installAppMenu` 在设置完菜单后再全量调一次
 * （顺序理由见那里）。
 */
export function applyWindowChrome(win: BrowserWindow): void {
  if (!CUSTOM_TITLEBAR) return;
  win.setMenuBarVisibility(false);
}
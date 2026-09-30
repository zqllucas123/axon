/**
 * 自绘标题栏（仅 Windows）—— 一条通栏，「Axon」与顶层菜单名同行。
 *
 * 形状：左「Axon」+ 文件/编辑/视图/窗口；最右的三个窗控按钮**不在 DOM 里**，
 * 是系统画的叠加层（`titleBarOverlay`，见 `main/window-chrome.ts`），
 * 所以这一条要按 `env(titlebar-area-*)` 让出右边（CSS 里做）。
 *
 * 为什么要自绘：Windows 原有两行顶栏 —— 系统标题栏 + Electron 的菜单栏。
 * 原生标题栏是 OS 画的非客户区，塞不进菜单项，只能反过来把标题栏交给页面画
 * （`titleBarStyle:'hidden'`），把菜单栏藏掉（`setMenuBarVisibility(false)`，
 * 快捷键不受影响，见 `main/menu.ts` 文件头）。
 *
 * 为什么菜单名要问主进程要（`menu.list`）而不是写死：菜单的真身在
 * `main/menu.ts` 的 template 里，这里再抄一份就是两份真相 —— 以后加一项菜单，
 * 标题栏会少一个按钮**且不报错**。
 *
 * 为什么点击走 `menu.popup` 而不是自己弹一个 HTML 菜单：撤销栈与剪贴板是
 * webContents 的能力（`document.execCommand` 已废），自己实现等于把
 * 复制/粘贴/撤销/开发者工具/缩放整套重写一遍且必然有出入。弹出的仍是原生菜单，
 * 连快捷键提示与勾选态都是 Electron 给的。
 *
 * 非 Windows 返回 null：macOS 的菜单在系统顶栏、窗口里不需要再画一条；
 * Linux 没有窗控叠加层（自绘就得自己实现三个窗控按钮），都维持原生边框。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { isCustomTitlebar } from '../chrome.ts';
import type { AxonMenuId } from '@axon/protocol';

type MenuItem = { id: AxonMenuId; label: string };

function describe(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}

export function Titlebar(): ReactElement | null {
  const custom = isCustomTitlebar();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!custom) return;
    let alive = true;
    window.axon
      .invoke('menu.list', {})
      .then(({ items: list }) => {
        if (alive) setItems(list);
      })
      .catch((e: unknown) => {
        if (alive) setFailure(describe(e));
      });
    return () => {
      alive = false;
    };
  }, [custom]);

  // 平台判断放在 hooks 之后（hooks 顺序不能随平台变），返回值放在这里。
  if (!custom) return null;

  const open = (menuId: AxonMenuId): void => {
    // 用 onClick 而不是 onMouseDown/onPointerDown：click 在 mouseup 之后派发，
    // 主进程弹菜单时鼠标键已经松开，否则那次 mouseup 会被原生菜单当成
    // 「点在菜单外面」而立刻把它关掉。
    window.axon
      .invoke('menu.popup', { menuId })
      .catch((e: unknown) => setFailure(describe(e)));
  };

  return (
    <div className="titlebar" data-smoke="titlebar">
      <span className="titlebar-brand">Axon</span>
      <nav className="titlebar-menus">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="titlebar-menu"
            data-menu-id={item.id}
            data-smoke={`menu-btn-${item.id}`}
            onClick={() => open(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {/* 失败不吞，但也不进主区那条错误条：这是**窗口 chrome** 的故障，
          显示在内容区中间会让人以为会话出错了。就地显示 + title 里带原因。 */}
      {failure ? (
        <span className="titlebar-error" title={failure}>
          菜单不可用
        </span>
      ) : null}
    </div>
  );
}
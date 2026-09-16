/**
 * 应用菜单 —— 在此之前全仓没有一处 `Menu`，用的是 Electron 的默认菜单（MU-3 切片 2）。
 *
 * 为什么非装不可：`⌘,`（设置）在 macOS 上是肌肉记忆级的快捷键，而它只能挂在
 * 应用菜单上；顺带把默认菜单里本来就该有的复制/粘贴/撤销（`editMenu` 角色）
 * 补齐 —— 默认菜单在自定义 template 出现后**会整个消失**，不补就等于弄丢了
 * 输入框里的 ⌘C/⌘V（Electron 的 role 机制，不是我们自己实现剪贴板）。
 *
 * 这里只声明「有哪些项」，动作全部回调出去（窗口归 windows.ts 管），
 * 菜单模块自己不持有任何状态。
 */

import { Menu, app, type MenuItemConstructorOptions } from 'electron';

export interface AppMenuHandlers {
  /** 「设置…」被点或 ⌘, 被按。 */
  openSettings(): void;
}

export function installAppMenu(handlers: AppMenuHandlers): void {
  const isMac = process.platform === 'darwin';
  const settingsItem: MenuItemConstructorOptions = {
    label: '设置…',
    accelerator: 'CmdOrCtrl+,',
    click: () => handlers.openSettings(),
  };

  const template: MenuItemConstructorOptions[] = [
    // macOS 的第一个菜单必须是应用菜单（名字取自 app.name）。
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [...(isMac ? [] : [settingsItem, { type: 'separator' } as MenuItemConstructorOptions]), { role: isMac ? 'close' : 'quit' }],
    },
    // 角色菜单原样用 Electron 的实现：自己写剪贴板项既多余又容易漏（如 ⌘Z 的
    // 撤销栈是 webContents 的能力，不是我们能代劳的）。
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

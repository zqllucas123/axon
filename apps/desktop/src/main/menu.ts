/**
 * 应用菜单 —— 在此之前全仓没有一处 `Menu`，用的是 Electron 的默认菜单（MU-3 切片 2）。
 *
 * 为什么非装不可：`⌘,`（设置）在 macOS 上是肌肉记忆级的快捷键，而它只能挂在
 * 应用菜单上；顺带把默认菜单里本来就该有的复制/粘贴/撤销（`editMenu` 角色）
 * 补齐 —— 默认菜单在自定义 template 出现后**会整个消失**，不补就等于弄丢了
 * 输入框里的 ⌘C/⌘V（Electron 的 role 机制，不是我们自己实现剪贴板）。
 *
 * ── Windows 自绘标题栏（本次改动）──
 * Windows 上这个菜单**不再显示成原生菜单栏**：`setMenuBarVisibility(false)` 把
 * 它藏起来，菜单名改由渲染层画进窗口标题栏（`renderer/components/Titlebar.tsx`，
 * 与「Axon」同行）。三个后果要记住：
 *  - **菜单本身没换**：还是这个 template、还是原生 role。点击走 `popupAppMenu`
 *    弹的仍是系统原生下拉。渲染层只是「菜单名的显示方」，不是第二套菜单实现。
 *  - **accelerator 照旧**：菜单栏隐藏不影响快捷键 —— Win/Linux 上「注册」与
 *    「显示」是两件事（`registerAccelerator` 的注解），`⌘,`/`⌘C` 全部还在。
 *    所以 `hideNativeMenuBar` 只是隐藏，**绝不能改成 `setApplicationMenu(null)`**。
 *  - **顶层 label 必须写死**：不写的话 Electron 按系统 locale 推导（`编辑`/`Edit`
 *    随系统语言变），标题栏里就是中英混排、且 `menu.list` 不确定。子项同理。
 *
 * 这里只声明「有哪些项」，动作全部回调出去（窗口归主进程 index.ts 管），
 * 菜单模块自己不持有任何状态。
 */

import { BrowserWindow, Menu, app, type MenuItemConstructorOptions } from 'electron';
import type { AxonMenuId } from '@axon/protocol';

export interface AppMenuHandlers {
  /** 「设置…」被点或 ⌘, 被按。 */
  openSettings(): void;
}

/** 顶层菜单的 id 清单 —— 渲染层那排菜单名的唯一真相（顺序也取自这里）。 */
const MENU_IDS: readonly AxonMenuId[] = ['file', 'edit', 'view', 'window'];

function isAxonMenuId(value: string | undefined): value is AxonMenuId {
  return value !== undefined && (MENU_IDS as readonly string[]).includes(value);
}

/**
 * 编辑菜单。
 *
 * 逐项照抄 Electron 默认 `editMenu` 的构造（撤销栈与剪贴板都是 webContents 的能力，
 * 不是我们能代劳的，见文件头），只覆盖 label —— 顶层与子项都写中文，
 * 否则标题栏里会是「文件 Edit View Window」。
 */
function editMenuTemplate(isMac: boolean): MenuItemConstructorOptions {
  return {
    id: 'edit',
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
            { role: 'delete', label: '删除' },
            { role: 'selectAll', label: '全选' },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete', label: '删除' },
            { type: 'separator' },
            { role: 'selectAll', label: '全选' },
          ] as MenuItemConstructorOptions[])),
    ],
  };
}

/** 视图菜单：默认 `viewMenu` 的那几项，只换中文 label（含缩放与全屏）。 */
function viewMenuTemplate(): MenuItemConstructorOptions {
  return {
    id: 'view',
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '切换全屏' },
    ],
  };
}

/** 窗口菜单：默认 `windowMenu` 的那几项，只换中文 label。 */
function windowMenuTemplate(isMac: boolean): MenuItemConstructorOptions {
  return {
    id: 'window',
    label: '窗口',
    submenu: [
      { role: 'minimize', label: '最小化' },
      // `zoom` 在 Windows/Linux 上等同于最大化/还原，标签照 macOS 的习惯叫「缩放」。
      { role: 'zoom', label: '缩放' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'front', label: '全部置于顶层' },
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close', label: '关闭' }] as MenuItemConstructorOptions[])),
    ],
  };
}

export function installAppMenu(handlers: AppMenuHandlers): void {
  const isMac = process.platform === 'darwin';
  const settingsItem: MenuItemConstructorOptions = {
    label: '设置…',
    accelerator: 'CmdOrCtrl+,',
    click: () => handlers.openSettings(),
  };

  const template: MenuItemConstructorOptions[] = [
    // macOS 的第一个菜单必须是应用菜单（名字取自 app.name）。这一组保持 Electron
    // 的 role 默认文案：它出现在**系统**菜单栏（不在我们窗口里），跟随系统语言。
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
      id: 'file',
      label: '文件',
      submenu: [
        ...(isMac
          ? ([{ role: 'close', label: '关闭窗口' }] as MenuItemConstructorOptions[])
          : ([
              settingsItem,
              { type: 'separator' },
              { role: 'quit', label: '退出 Axon' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    editMenuTemplate(isMac),
    viewMenuTemplate(),
    windowMenuTemplate(isMac),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // 顺序要紧：**必须在设置菜单之后**藏菜单栏。反过来的话，新菜单挂上去时
  // Electron 会连菜单栏的可见性一起重置，Windows 上就是「藏了又冒出来」。
  hideNativeMenuBar();
}

/**
 * 隐藏原生菜单栏（菜单本身照旧装着，见文件头：accelerator 靠它活着）。
 *
 * 幂等，且**必须由窗口工厂在每个窗口创建后也调一次** —— 这个函数只覆盖调用时刻
 * 已存在的窗口。非 Windows 平台直接返回：macOS 的菜单在系统顶栏，没有可藏的东西。
 */
export function hideNativeMenuBar(): void {
  if (process.platform !== 'win32') return;
  for (const w of BrowserWindow.getAllWindows()) w.setMenuBarVisibility(false);
}

/**
 * 顶层菜单清单 —— 渲染层的标题栏用 `menu.list` 命令拿它来画那排菜单名。
 *
 * 读的是**装上去的那份菜单**而不是 template 变量：只有这样才能保证
 * 「渲染出来的按钮数 === 主进程真装了几项」。构造形状不认识（id 不在
 * `AxonMenuId` 里）的项直接跳过 —— macOS 的 app 菜单就是这种。
 */
export function appMenuItems(): Array<{ id: AxonMenuId; label: string }> {
  const menu = Menu.getApplicationMenu();
  if (!menu) return [];
  const items: Array<{ id: AxonMenuId; label: string }> = [];
  for (const item of menu.items) {
    if (isAxonMenuId(item.id)) items.push({ id: item.id, label: item.label });
  }
  return items;
}

/**
 * 在光标处弹出某个顶层菜单的原生子菜单（渲染层点标题栏里的菜单名时调）。
 *
 * **不传 x/y**：Electron 的默认值就是「当前鼠标位置」，这正是原生菜单栏的手感；
 * 传坐标反而要自己处理「客户区 vs 屏幕坐标」「CSS px vs DIP」两重换算，
 * 而两者都会随 DPI 缩放与最大化状态漂移。
 *
 * 找不到（或它没有子菜单）时**抛错**：这是一条命令，错误要经 IPC 变成结构化
 * 失败回给渲染层显示出来，不能静默 —— 菜单名点下去什么都不发生是最难查的形态。
 */
export function popupAppMenu(menuId: AxonMenuId, win: BrowserWindow): void {
  const item = Menu.getApplicationMenu()?.items.find((i) => i.id === menuId);
  if (!item?.submenu) throw new Error(`应用菜单里没有「${menuId}」这一项，或它没有子菜单`);
  item.submenu.popup({ window: win });
}
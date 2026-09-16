/**
 * 渲染进程入口 —— createRoot + 挂外壳。
 * 状态与订阅全在 state/store.tsx（AppProvider），这里再复杂就是设计事故。
 *
 * MU-3 起有两个窗口共用这一份产物：主窗与设置窗（`main/windows.ts`）。
 * 分叉只看 URL hash —— 再开一条 esbuild 入口 + 一份 html 只为换个根组件，
 * 代价比一行判断大得多，而且两份 CSP 容易跑偏。
 */

import { createRoot } from 'react-dom/client';
import { AppProvider } from './state/store.tsx';
import { Shell } from './components/Shell.tsx';
import { SettingsApp } from './settings/SettingsApp.tsx';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('index.html 缺少 <div id="root">');

const isSettings = window.location.hash === '#settings';
document.body.dataset.window = isSettings ? 'settings' : 'main';
// 两窗共用一份 index.html ⇒ <title> 也共用。标题栏必须分得清谁是谁
// （BrowserWindow 的 title 选项会被页面的 <title> 覆盖，只能在这里改）。
if (isSettings) document.title = '设置';

createRoot(rootEl).render(
  isSettings ? (
    <SettingsApp />
  ) : (
    <AppProvider>
      <Shell />
    </AppProvider>
  ),
);

/**
 * 渲染进程入口 —— createRoot + 挂外壳。
 * 状态与订阅全在 state/store.tsx（AppProvider），这里再复杂就是设计事故。
 *
 * 只有一个窗：设置已从独立 BrowserWindow 改成主窗内的一屏（S8，Shell.tsx 路由），
 * 所以这里不再看 URL hash 分叉。
 */

import { createRoot } from 'react-dom/client';
import { AppProvider } from './state/store.tsx';
import { Shell } from './components/Shell.tsx';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('index.html 缺少 <div id="root">');

createRoot(rootEl).render(
  <AppProvider>
    <Shell />
  </AppProvider>,
);

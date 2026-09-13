/**
 * 渲染进程入口 —— 只做两件事：createRoot + 挂 App。
 * 状态、订阅、生命周期全在 App.tsx；这里再复杂就是设计事故。
 */

import { createRoot } from 'react-dom/client';
import { App } from './components/App.tsx';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('index.html 缺少 <div id="root">');

createRoot(rootEl).render(<App />);
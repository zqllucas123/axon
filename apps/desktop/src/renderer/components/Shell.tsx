/**
 * 应用外壳 —— 四块骨架（ux 01 §2：侧栏 / 顶栏 / 主区 / 右栏）+ 屏路由。
 * 屏幕是纯 UI 状态（state/types.ts）：导航只改 store.screen，不做 URL/history。
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Topbar, SessionTopbarSide } from './Topbar.tsx';
import { S0NewSession } from './S0NewSession.tsx';
import { S1Workbench } from './S1Workbench.tsx';
import { SessionMain, SessionRightPanel } from './S2Session.tsx';
import { S3Teams } from './S3Teams.tsx';
import { S5Inbox } from './S5Inbox.tsx';
import { S6Budget } from './S6Budget.tsx';
import { S7Sessions } from './S7Sessions.tsx';
import { SettingsScreen } from '../settings/SettingsApp.tsx';
import { Icon } from '../icons.tsx';

function Screen(): ReactElement {
  const { screen } = useApp();
  switch (screen) {
    case 's1':
      return <S1Workbench />;
    case 's3':
      return <S3Teams />;
    case 's5':
      return <S5Inbox />;
    case 's6':
      return <S6Budget />;
    case 's7':
      return <S7Sessions />;
    // 's8' 不在这里：它在 Shell 里整屏接管，不进主区路由。
    // 's0' 落在 default：它是启动屏，也是任何意外值的兼底。
    default:
      return <S0NewSession />;
  }
}

/** 命令失败一律显示出来（不吞错误；error 只读，来自 store）。 */
function ErrorBar(): ReactElement | null {
  const { error, dismissError } = useApp();
  if (!error) return null;
  return (
    <div className="card err" style={{ margin: '0 28px 12px' }} data-smoke="error-bar">
      <div className="card-head">
        <Icon name="alert" size={16} />
        <span className="name">命令失败</span>
        <span className="spacer" />
        <button className="act" onClick={dismissError} title="关闭">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="card-body mono">{error}</div>
    </div>
  );
}

export function Shell(): ReactElement {
  const { screen, rightPanel } = useApp();
  const [rightPanelWidth, setRightPanelWidth] = useState(420);

  // 侧栏收起态（纯 UI，不入协议 / store）：只影响外壳的两列骨架，故就近放在 Shell。
  // 记忆到 localStorage，重开窗保留；⌘B / Ctrl+B 全局切换（对齐 VS Code「切换侧边栏」）。
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('axon.sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('axon.sidebarCollapsed', next ? '1' : '0');
      } catch {
        /* 隐私模式下 localStorage 可能抛错：切换仍生效，只是不记忆。 */
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  // S8 设置屏**整屏接管**：它自带一套左导航（`.st-sidebar`），再叠主窗 Sidebar
  // 就是两条侧栏并列；而且设置没有会话上下文，Topbar 那排会话胶囊（预算/待批/
  // 活跃会话）在这里语义为空。返回靠设置屏自己的「← 返回」（SettingsApp.tsx）。
  if (screen === 's8') return <SettingsScreen />;

  const showRightPanel = screen === 's2' && rightPanel !== 'none';
  const layoutStyle = { '--right-panel-w': `${showRightPanel ? rightPanelWidth : 0}px` } as CSSProperties;

  return (
    <div className={`window${collapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar />
      <div className={`main app-layout${showRightPanel ? ' has-right-panel' : ''}`} style={layoutStyle}>
        <Topbar sidebarCollapsed={collapsed} onToggleSidebar={toggleSidebar} />
        <div className="topbar-side">{showRightPanel ? <SessionTopbarSide /> : null}</div>
        <div className="screen-main">
          <ErrorBar />
          {screen === 's2' ? <SessionMain /> : <Screen />}
        </div>
        <div className="screen-side">
          {showRightPanel ? <SessionRightPanel width={rightPanelWidth} onWidthChange={setRightPanelWidth} /> : null}
        </div>
      </div>
    </div>
  );
}

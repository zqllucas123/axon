/**
 * 应用外壳 —— 四块骨架（ux 01 §2：侧栏 / 顶栏 / 主区 / 右栏）+ 屏路由。
 * 屏幕是纯 UI 状态（state/types.ts）：导航只改 store.screen，不做 URL/history。
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Titlebar } from './Titlebar.tsx';
import { Topbar, SessionTopbarSide } from './Topbar.tsx';
import { S0NewSession } from './S0NewSession.tsx';
import { S1Workbench } from './S1Workbench.tsx';
import { SessionMain, SessionRightPanel } from './S2Session.tsx';
import { S3Teams } from './S3Teams.tsx';
import { S4Knowledge } from './S4Knowledge.tsx';
import { S5Inbox } from './S5Inbox.tsx';
import { S6Usage } from './S6Usage.tsx';
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
    case 's4':
      return <S4Knowledge />;
    case 's5':
      return <S5Inbox />;
    case 's6':
      return <S6Usage />;
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

  /**
   * 窗口 chrome 是**通栏**的，所以它在两条路由分支之外 —— 标题栏那一行必须
   * 在 `.window`（左栏 + 主区两列 Grid）之上，而不是某一列里。
   *
   * 为什么 S8 也包进来而不是各写一份：Windows 上菜单栏是被藏掉的，标题栏里的
   * 那排菜单名是**唯一的**菜单入口（见 components/Titlebar.tsx）。S8 单独走一条
   * 不带标题栏的分支，等于设置屏里没有菜单；两条分支各画一次又必然漂移。
   */
  const showRightPanel = screen === 's2' && rightPanel !== 'none';
  const layoutStyle = { '--right-panel-w': `${showRightPanel ? rightPanelWidth : 0}px` } as CSSProperties;

  return (
    <div className="app-frame">
      <Titlebar />
      <div className="app-body">
        {screen === 's8' ? (
          // S8 设置屏**整屏接管**：它自带一套左导航（`.st-sidebar`），再叠主窗
          // Sidebar 就是两条侧栏并列；而且设置没有会话上下文，Topbar 那排会话胶囊
          // （预算/待批/活跃会话）在这里语义为空。返回靠设置屏自己的「← 返回」
          // （SettingsApp.tsx）。
          <SettingsScreen />
        ) : (
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
        )}
      </div>
    </div>
  );
}

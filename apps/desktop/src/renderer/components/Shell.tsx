/**
 * 应用外壳 —— 四块骨架（ux 01 §2：侧栏 / 顶栏 / 主区 / 右栏）+ 屏路由。
 * 屏幕是纯 UI 状态（state/types.ts）：导航只改 store.screen，不做 URL/history。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Topbar } from './Topbar.tsx';
import { S0NewSession } from './S0NewSession.tsx';
import { S1Workbench } from './S1Workbench.tsx';
import { S2Session } from './S2Session.tsx';
import { S3Teams } from './S3Teams.tsx';
import { S5Inbox } from './S5Inbox.tsx';
import { S6Budget } from './S6Budget.tsx';
import { S7Sessions } from './S7Sessions.tsx';
import { Icon } from '../icons.tsx';

function Screen(): ReactElement {
  const { screen } = useApp();
  switch (screen) {
    case 's1':
      return <S1Workbench />;
    case 's2':
      return <S2Session />;
    case 's3':
      return <S3Teams />;
    case 's5':
      return <S5Inbox />;
    case 's6':
      return <S6Budget />;
    case 's7':
      return <S7Sessions />;
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
  return (
    <div className="window">
      <Sidebar />
      <div className="main">
        <Topbar />
        <ErrorBar />
        {/* 主区以下由各屏自己排（原型就是这么分的）：S0/S2 是 `.body > .col + .inspector`，
            S1/S3 是 `.body > .canvas + .inspector`，S2 还在 body 之上多一条 session-bar。
            外壳硬套一层 .col/.canvas 会逼各屏往外抠，反而失真。 */}
        <Screen />
      </div>
    </div>
  );
}

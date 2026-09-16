/**
 * 应用外壳 —— 四块骨架（ux 01 §2：侧栏 / 顶栏 / 主区 / 右栏）+ 屏路由。
 * 屏幕是纯 UI 状态（state/types.ts）：导航只改 store.screen，不做 URL/history。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Topbar } from './Topbar.tsx';
import { Inspector } from './Inspector.tsx';
import { S0NewSession } from './S0NewSession.tsx';
import { S1Workbench } from './S1Workbench.tsx';
import { S2Session } from './S2Session.tsx';
import { S3Teams } from './S3Teams.tsx';
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
        <div className="body">
          <div className="col">
            <div className="canvas">
              <Screen />
            </div>
          </div>
          <Inspector />
        </div>
      </div>
    </div>
  );
}

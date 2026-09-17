/**
 * S8 设置窗外壳 —— 左导航 + 右内容（MU-3 切片 4，W-D）。
 *
 * 结构照原型 s8-settings.html：`.st-win` > `.st-sidebar`（`.st-nav` 三组）
 * + `.st-main` > `.st-body` > pane。
 *
 * ── 两处按用户拍板不渲染 ──
 * 1. **「← 返回应用」与假交通灯**：原型是浏览器里的静态稿，需要自绘窗控；真窗口
 *    有原生交通灯，再画一套只会变成两排按钮。样式仍留在 settings.css 里备用。
 * 2. **「团队与角色 ↗」「预算与用量 ↗」两个跳回主窗的入口**：协议里只有
 *    `window.openSettings`（主窗 → 设置窗的单向），没有反向的聚焦/导航命令。
 *    用户拍板「这两项不用从设置窗跳回主窗」，所以它们降级为导航里的一段
 *    **说明文字**（`.st-navnote`）——告诉你去哪儿找，而不是给一个点了没反应的项。
 *
 * 错误条：`config.patch` 的**字段级**错误在各自行内标红（fields.tsx），这里只接
 * 传输/命令级错误（IPC 断了、命令抛异常），所以它是一条可关闭的横幅而不是行内红字。
 */

import { useState, type ReactElement } from 'react';
import { SettingsProvider, useSettings } from './SettingsStore.tsx';
import { GeneralPane } from './panes/General.tsx';
import { AppearancePane } from './panes/Appearance.tsx';
import { ModelsPane } from './panes/Models.tsx';
import { OrchestrationPane } from './panes/Orchestration.tsx';
import { AboutPane } from './panes/About.tsx';

type PaneId = 'general' | 'appearance' | 'model' | 'orchestration' | 'about';

const PANES: ReadonlyArray<{ id: PaneId; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'appearance', label: '外观' },
  { id: 'model', label: '模型与网关' },
  { id: 'orchestration', label: '编排与安全' },
  { id: 'about', label: '关于' },
];

function paneOf(id: PaneId): ReactElement {
  switch (id) {
    case 'general':
      return <GeneralPane />;
    case 'appearance':
      return <AppearancePane />;
    case 'model':
      return <ModelsPane />;
    case 'orchestration':
      return <OrchestrationPane />;
    case 'about':
      return <AboutPane />;
  }
}

function SettingsShell(): ReactElement {
  const { error, dismissError } = useSettings();
  const [pane, setPane] = useState<PaneId>('general');

  return (
    <div className="st-win" data-smoke="settings-win">
      <aside className="st-sidebar">
        <div className="st-nav">
          <div className="st-group">个人</div>
          {PANES.slice(0, 4).map((p) => (
            <button
              key={p.id}
              type="button"
              className={`st-item${pane === p.id ? ' is-on' : ''}`}
              data-smoke={`settings-${p.id}`}
              onClick={() => setPane(p.id)}
            >
              {p.label}
            </button>
          ))}

          <div className="st-group">在主窗里管</div>
          {/* 不做成可点项：没有「设置窗 → 主窗」的导航协议（见文件头）。 */}
          <p className="st-navnote">
            团队与角色、预算与用量都在主窗：左栏「团队」进角色与编队，顶栏预算胶囊进用量明细。
            这里只放影响全局默认值的设置。
          </p>

          <div className="st-group">其他</div>
          <button
            type="button"
            className={`st-item${pane === 'about' ? ' is-on' : ''}`}
            data-smoke="settings-about"
            onClick={() => setPane('about')}
          >
            关于
          </button>
        </div>
      </aside>

      <main className="st-main">
        <div className="st-body">
          {error ? (
            <div className="card err" data-smoke="settings-error">
              <div className="t">设置操作失败</div>
              <div className="d">{error}</div>
              <button type="button" className="btn sm ghost" onClick={dismissError}>
                知道了
              </button>
            </div>
          ) : null}
          {paneOf(pane)}
        </div>
      </main>
    </div>
  );
}

export function SettingsApp(): ReactElement {
  return (
    <SettingsProvider>
      <SettingsShell />
    </SettingsProvider>
  );
}

/**
 * S8 设置窗外壳 —— 左导航 + 右内容（原型 `docs/ux/mockups/s8-settings.html`）。
 *
 * 本文件在切片 2 只搭「窗能开、五个 pane 能切」的骨架；每个 pane 的内容由
 * MU-3 阶段 1 的 W-D 会话填（文件所有权见 MU-3 §7.0）。
 *
 * 一条纪律照抄自 UX `03-设置界面设计.md:18`：**协议给不出的项就不画**，
 * 不摆一个永远灰着的假开关充数。
 */

import { useState, type ReactElement } from 'react';
import { SettingsProvider, useSettings } from './SettingsStore.tsx';

/** 五个 pane（03 §3 的信息分组）。 */
const PANES = [
  { id: 'general', label: '通用' },
  { id: 'model', label: '模型与网关' },
  { id: 'budget', label: '预算与限额' },
  { id: 'appearance', label: '外观' },
  { id: 'about', label: '关于' },
] as const;

type PaneId = (typeof PANES)[number]['id'];

function SettingsBody(): ReactElement {
  const [pane, setPane] = useState<PaneId>('general');
  const { config, error, dismissError } = useSettings();

  return (
    <div className="st-win">
      <nav className="st-nav">
        {PANES.map((p) => (
          <button
            key={p.id}
            className={`st-navitem${pane === p.id ? ' is-on' : ''}`}
            onClick={() => setPane(p.id)}
            data-smoke={`settings-${p.id}`}
          >
            {p.label}
          </button>
        ))}
      </nav>
      <main className="st-main">
        {error ? (
          // 与主窗 ErrorBar 同一套类（components.css 的 .card.err），不另造样式。
          <div className="card err" data-smoke="settings-error">
            <div className="card-head">
              <span className="name">命令失败</span>
              <span className="spacer" />
              <button className="act" onClick={dismissError} title="关闭">
                ✕
              </button>
            </div>
            <div className="card-body mono">{error}</div>
          </div>
        ) : null}
        {config === null ? <div className="empty">读取配置中…</div> : <Pane id={pane} />}
      </main>
    </div>
  );
}

/** 占位：各 pane 由 W-D 填充（MU-3 切片 7）。 */
function Pane({ id }: { id: PaneId }): ReactElement {
  const label = PANES.find((p) => p.id === id)?.label ?? id;
  return (
    <section className="st-pane" data-pane={id}>
      <div className="st-sec">{label}</div>
      <div className="empty">此节尚未实现（MU-3 切片 7）。</div>
    </section>
  );
}

export function SettingsApp(): ReactElement {
  return (
    <SettingsProvider>
      <SettingsBody />
    </SettingsProvider>
  );
}

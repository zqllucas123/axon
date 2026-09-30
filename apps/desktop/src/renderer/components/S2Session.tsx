/**
 * S2 会话屏（团队 / 单兵两态）。
 *
 * 骨架：消息流容器 + 输入区（+ 右栏按需面板）。原「会话条」（引擎行 / 对话·账本·用量
 * 分段 / 叫人）已并入顶栏一行：标题 / 文件 / 属性 / 叫人 全在 Topbar，本屏不再自带头条。
 * 「叫人」弹层的开关态提到 store（escalateOpen），顶栏按钮开、本屏渲染 EscalateSheet。
 * 账本 / 用量视图仍在（sessionView 切换），入口从 S1 统计卡进；缺口一律「拿不到就不渲染」。
 */

import { useState, useEffect, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import { Inspector } from './Inspector.tsx';
import { WorkspacePanel } from './WorkspacePanel.tsx';
import { MessageStream } from './MessageStream.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { EscalateSheet, LedgerView, UsageView } from './S2Views.tsx';

/** 右列内容由 Shell 的共享 Grid 承载，确保其顶边与会话右顶栏共用分割线。 */
export function SessionRightPanel({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}): ReactElement | null {
  const { rightPanel, setEscalateOpen } = useApp();
  if (rightPanel === 'props') return <Inspector onEscalate={() => setEscalateOpen(true)} />;
  if (rightPanel === 'files') return <WorkspacePanel width={width} onWidthChange={onWidthChange} />;
  return null;
}

export function SessionMain(): ReactElement {
  const { current, sessionView, focusPath, prompt, interrupt, agents, escalateOpen, setEscalateOpen } = useApp();
  const [text, setText] = useState('');
  // 工作区元信息：文件夹名 + git 分支。换会话时重新拉，失败静默降级（null）。
  const [cwdInfo, setCwdInfo] = useState<{ folderName: string; branch: string | null } | null>(null);

  useEffect(() => {
    if (!current) { setCwdInfo(null); return; }
    setCwdInfo(null);
    void window.axon.invoke('session.cwdInfo', { sessionId: current.record.id }).then((info) => {
      setCwdInfo(info ?? null);
    }).catch(() => { /* 静默降级 */ });
  }, [current?.record.id]);

  if (!current) {
    return (
      <div className="stream">
        <div className="empty">
          <span className="k">没有选中的会话</span>
          从左栏「项目」或「最近」里点一个会话，或去「新建会话」起一个。
        </div>
      </div>
    );
  }

  const focus = focusPath ? agents[focusPath] : undefined;
  const running = focus?.status === 'running';

  const send = () => {
    const t = text.trim();
    if (!t || !focusPath) return;
    setText('');
    void prompt(focusPath, t);
  };

  return (
    <>
      <div className="session-main body">
        <div className="col">
      {sessionView === 'chat' ? (
        <>
          <section className="canvas">
            <MessageStream />
          </section>
          <div className={`composer-wrap${cwdInfo ? ' has-cwd' : ''}`}>
            {/* 工作区上下文条：文件夹名 + 本地 + git 分支，截图中的三个小 chip。
                异步拉取，未就绪时隐藏，不阻塞输入区渲染。 */}
            {cwdInfo ? (
              <div className="cwd-bar attached" data-smoke="session-cwd">
                <div className="cwd-pill">
                  <span className="cwd-item">
                    <Icon name="folder" size={14} />
                    <span className="context-label">{cwdInfo.folderName}</span>
                  </span>
                  <span className="cwd-item">
                    <Icon name="monitor" size={14} />
                    <span className="context-label">本地</span>
                  </span>
                  {cwdInfo.branch ? (
                    <span className="cwd-item">
                      <Icon name="branch" size={14} />
                      <span className="context-label">{cwdInfo.branch}</span>
                      <span className="context-detail">工作分支</span>
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="composer">
              <textarea
                className="ph"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={focus ? `发给 ${focus.displayName}…（Enter 发送，Shift+Enter 换行）` : '先选一个成员…'}
                data-smoke="composer"
                style={{ width: '100%', border: 0, background: 'none', resize: 'none', outline: 'none', font: 'inherit' }}
              />
              <div className="row">
                <span className="mode" title="焦点分身">
                  <Icon name="branch" size={14} />
                  {focus?.displayName ?? '—'}
                </span>
                <span className="spacer" />
                {focusPath ? <ModelPicker focusPath={focusPath} /> : null}
                <button
                  className="send"
                  onClick={running ? () => focusPath && void interrupt(focusPath) : send}
                  title={running ? '中断任务' : '发送（Enter）'}
                  disabled={!focusPath}
                >
                  <Icon name={running ? 'pause' : 'arrowUp'} size={16} />
                </button>
              </div>
            </div>
          </div>
        </>
      ) : sessionView === 'ledger' ? (
        <section className="canvas">
          <LedgerView />
        </section>
      ) : (
        <section className="canvas">
          <UsageView />
        </section>
      )}
        </div>
      </div>

      {escalateOpen ? <EscalateSheet onClose={() => setEscalateOpen(false)} /> : null}
    </>
  );
}

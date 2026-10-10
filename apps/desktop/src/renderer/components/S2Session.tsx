/**
 * S2 会话屏（团队 / 单兵两态）。
 *
 * 骨架：消息流容器 + 输入区（+ 右栏按需面板）。原「会话条」（引擎行 / 对话·账本·用量
 * 分段 / 叫人）已并入顶栏一行：标题 / 文件 / 属性 / 叫人 全在 Topbar，本屏不再自带头条。
 * 「叫人」弹层的开关态提到 store（escalateOpen），顶栏按钮开、本屏渲染 EscalateSheet。
 * 账本 / 用量视图仍在（sessionView 切换），入口从 S1 统计卡进；缺口一律「拿不到就不渲染」。
 *
 * M10：子任务面板（`childSessions`）显示主管 session 派生的全部子 session。
 * 点击子 session 行可以切换到那个会话查看详情。
 */

import { useState, useEffect, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import { ComposerBar } from './ComposerBar.tsx';
import { EnginePicker } from './EnginePicker.tsx';
import { Inspector } from './Inspector.tsx';
import { WorkspacePanel } from './WorkspacePanel.tsx';
import { MessageStream } from './MessageStream.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { EscalateSheet, LedgerView, UsageView } from './S2Views.tsx';
import type { SessionSummary } from '@axon/protocol';

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

/** 子任务面板（M10）：主管 session 派生的子 session 列表。 */
function SubSessionPanel({
  childSessions,
  onNavigate,
}: {
  childSessions: NonNullable<SessionSummary['childSessions']>;
  onNavigate: (sessionId: string) => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  const statusDot = (status: string) => {
    if (status === 'running') return 'dot dot-running';
    if (status === 'done') return 'dot dot-done';
    if (status === 'failed') return 'dot dot-failed';
    if (status === 'waiting') return 'dot dot-waiting';
    return 'dot dot-idle';
  };

  return (
    <div className="subsession-panel" data-smoke="subsession-panel">
      <button
        className="subsession-header"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <Icon name="users" size={14} />
        <span>子任务 · {childSessions.length} 个</span>
        <span className="subsession-header-arrow">{collapsed ? '›' : '∨'}</span>
      </button>
      {!collapsed ? (
        <div className="subsession-list">
          {childSessions.map((cs) => (
            <button
              key={cs.sessionId}
              className="subsession-row"
              onClick={() => onNavigate(cs.sessionId)}
              data-smoke="subsession-row"
              data-session={cs.sessionId}
              title={`切换到子任务：${cs.title}`}
            >
              <span className={statusDot(cs.status)} />
              <span className="subsession-title">{cs.title}</span>
              {cs.hasPending ? <span className="subsession-badge" title="有待批审批" /> : null}
              {cs.costUsd > 0 ? (
                <span className="subsession-cost">${cs.costUsd.toFixed(3)}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SessionMain(): ReactElement {
  const { current, sessionView, focusPath, prompt, interrupt, agents, escalateOpen, setEscalateOpen, sessions, openSession } = useApp();
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

  // M10：子任务列表（主管 session 才有）
  // M10：子任务列表（主管 session 才有）
  const childSessions = current.childSessions;

  // M10：如果是子 session，显示「返回主管」面包屑
  const parentSessionId = current.record.parentSessionId;
  const parentSession = parentSessionId ? sessions.find((s) => s.record.id === parentSessionId) : undefined;

  return (
    <>
      <div className="session-main body">
        <div className="col">
      {sessionView === 'chat' ? (
        <>
          {/* M10：子 session 面包屑 */}
          {parentSession ? (
            <div className="subsession-breadcrumb" data-smoke="subsession-breadcrumb">
              <button className="btn sm ghost" onClick={() => openSession(parentSession.record.id)}>
  <Icon name="history" size={14} />
                返回主管：{parentSession.record.title}
              </button>
            </div>
          ) : null}

          <section className="canvas">
            <MessageStream />
          </section>

          {/* M10：子任务面板（仅主管 session 显示） */}
          {childSessions && childSessions.length > 0 ? (
            <SubSessionPanel
              childSessions={childSessions}
              onNavigate={(id) => openSession(id)}
            />
          ) : null}

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
            {/* 外壳（容器 / textarea / 工具栏三段式布局）由 ComposerBar 收口，与 S0 共用一份；
                这里只给出本屏的控件行为：附件无协议面、引擎只读、模式走「叫人」弹层。 */}
            <ComposerBar
              value={text}
              onChange={setText}
              onSubmit={send}
              placeholder={focus ? `发给 ${focus.displayName}…（Enter 发送，Shift+Enter 换行）` : '先选一个成员…'}
              textareaSmoke="composer"
              left={
                <>
                  <button className="tool-btn" disabled title="尚未支持：协议里没有附件面">
                    <Icon name="paperclip" size={16} />
                  </button>
                  <EnginePicker value={current.record.engineId ?? null} />
                  <button
                    className={`tool-btn${current.record.executor === 'team' ? ' is-on' : ''}`}
                    onClick={() => setEscalateOpen(true)}
                    data-smoke="mode-trigger"
                    disabled={!!current.record.engineId}
                    title={
                      current.record.engineId
                        ? '外部引擎会话暂不支持叫人组队'
                        : current.record.executor === 'team'
                        ? `团队模式 · ${current.record.teamId ?? '未知团队'}（点击切换）`
                        : '执行模式：单兵（点击叫人升级为团队）'
                    }
                  >
                    <Icon name="users" size={16} />
                  </button>
                </>
              }
              /* 外部引擎用它自己的模型设置，Axon 网关的模型表对它没有意义 —— 不显示选择器。 */
              right={focusPath && !current.record.engineId ? <ModelPicker focusPath={focusPath} /> : null}
              send={{
                icon: running ? 'pause' : 'arrowUp',
                onClick: running ? () => focusPath && void interrupt(focusPath) : send,
                title: running ? '中断任务' : '发送（Enter）',
                disabled: !focusPath,
              }}
            />
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


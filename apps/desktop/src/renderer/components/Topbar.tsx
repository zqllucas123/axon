/**
 * 顶栏（原型：h56 / padding 0 18px 0 22px / 标题 fs17·500）。
 *
 * 标题右边是本屏焦点分身的 tag（`/0/1/2`）—— ux 01 §2.1-③「一屏一个焦点分身」的锚点。
 * 缺口处置（MU-2 §4.6）：原型顶栏的「正在：…」任务文本拿不到（快照无 task）⇒ 整块不渲染。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Chips } from './Chips.tsx';
import { Icon } from '../icons.tsx';

export function Topbar({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}): ReactElement {
  const { screen, current, focusPath, rightPanel, setRightPanel, setEscalateOpen } = useApp();
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!actionsOpen) return;
    const onMouseDown = (event: MouseEvent): void => {
      if (actionsRef.current && !actionsRef.current.contains(event.target as Node)) setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [actionsOpen]);

  useEffect(() => {
    if (screen !== 's2' || !current) setActionsOpen(false);
  }, [screen, current]);

  const title =
    screen === 's0'
      ? '新建会话'
      : screen === 's1'
        ? '会话总览'
        : screen === 's3'
          ? '团队管理'
          : (current?.record.title ?? '会话');

  return (
    <div className="topbar">
      {/* 侧栏切换：收起时按钮留在主区顶栏，仍是唯一重新展开的入口（对齐 VS Code ⌘B）。 */}
      <button
        className={`sidebar-toggle${sidebarCollapsed ? ' is-collapsed' : ''}`}
        data-smoke="toggle-sidebar"
        title={`${sidebarCollapsed ? '展开' : '收起'}侧边栏 (⌘B)`}
        aria-label="切换侧边栏"
        aria-pressed={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <Icon name="panel" size={18} />
      </button>
      <span className="title">{title}</span>
      {screen === 's2' && focusPath ? (
        <span className="tag mono" title="当前焦点分身（点右栏成员切换）">
          {focusPath}
        </span>
      ) : null}
      <span className="spacer" />
      {screen === 's2' && current ? (
        <span className="panel-toggles">
          <button
            className={`btn sm ghost${rightPanel === 'files' ? ' is-on' : ''}`}
            data-smoke="toggle-files"
            title="打开文件（工作区目录树）"
            onClick={() => setRightPanel(rightPanel === 'files' ? 'none' : 'files')}
          >
            <Icon name="folder" size={14} />
            文件
          </button>
          <div ref={actionsRef} className="session-actions">
            <button
              className={`btn sm ghost session-actions-trigger${actionsOpen || rightPanel === 'props' ? ' is-on' : ''}`}
              data-smoke="session-actions"
              title="会话操作"
              aria-label="会话操作"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((open) => !open)}
            >
              <Icon name="sliders" size={14} />
            </button>
            {actionsOpen ? (
              <div className="menu session-actions-menu" role="menu">
                <button
                  className={`menu-item${rightPanel === 'props' ? ' is-on' : ''}`}
                  data-smoke="toggle-props"
                  role="menuitem"
                  title="会话属性（成员 / 账本 / 协作动作）"
                  onClick={() => {
                    setRightPanel('props');
                    setActionsOpen(false);
                  }}
                >
                  <Icon name="list" size={16} />
                  <span>属性</span>
                  {rightPanel === 'props' ? <span className="mk">已打开</span> : null}
                </button>
              </div>
            ) : null}
          </div>
        </span>
      ) : null}
      {/* 会话屏（S2）的工作区面包屑和「叫人」在 Shell 的共享右列顶栏渲染，
          这里只留文件与会话属性控制。

          chips 曾因「整宽顶栏与右面板错位」在 S2 被摘掉（dbcb39c，2026-09-20），
          但七天后的 grid 改造（1aaa24b）把 `.topbar` 锁进了 `grid-column: 1`、
          右列顶栏独占第 2 列 —— 顶栏物理上再也越不出自己那一列，那条理由就失效了。
          摘掉的后果是 `Chips` 里整套 `inSession` 分支（本会话预算/待批/账本）
          成了跑不到的死代码，也违背它自己头注记的规矩「需要你决策的东西永远有 chip」。
          2026-10-09 恢复。 */}
      <Chips />
    </div>
  );
}

/** 会话右列的独立顶栏：与下方 Inspector / WorkspacePanel 共用同一 Grid 列。 */
export function SessionTopbarSide(): ReactElement | null {
  const { current, setEscalateOpen } = useApp();
  if (!current) return null;

  return (
    <div className="session-topbar-side" data-smoke="session-topbar-side">
      <div className="workspace-crumb" data-smoke="workspace-crumb" title={current.record.cwd}>
        <Icon name="folder" size={16} />
        <span className="mono">{current.record.cwd}</span>
      </div>
      {!current.team ? (
        <button
          className="btn sm"
          data-smoke="escalate"
          title="升级为团队会话（消息不丢）"
          onClick={() => setEscalateOpen(true)}
        >
          <Icon name="users" size={14} />
          叫人（升级为团队会话）
        </button>
      ) : (
        <button className="btn sm ghost" disabled title="临时加人（M4 后）">
          <Icon name="plus" size={14} />
          临时加人
        </button>
      )}
    </div>
  );
}

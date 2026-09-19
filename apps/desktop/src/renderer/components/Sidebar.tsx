/**
 * 左栏（原型 shell.js:sidebarHTML）。
 *
 * 硬规矩（ux 01 §2.1-①）：左栏只列「会话」这一种粒度 —— 进行中 / 最近两组，
 * 加一级导航。**会话内部的成员树绝不在这里出现**（那是右栏的事）。
 *
 * 数据纪律（M5 §4.5 懒加载）：本文件只读 `sessions: SessionSummary[]`，
 * 绝不调用 session.get —— 列表渲染不得把会话树拉进内存。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { globalChips, groupSessionsByProject, sessionMeta, splitSessions, statusDot } from '../state/selectors.ts';
import { Icon, type IconName } from '../icons.tsx';
import { ProjectCreateDialog } from './ProjectCreateDialog.tsx';
import type { Screen } from '../state/types.ts';
import type { SessionSummary } from '@axon/protocol';

/**
 * 一级导航（顺序照抄原型：团队管理沉在后面 —— 配置不是日常动线）。
 *
 * MU-3 切片 2.5：S5/S6/S7 从「置灰占位」升为可点 —— 屏已经存在了。
 * badge 只能取**真值**（原先写死的 '2' 是占位假数据，已删）。
 */
const NAV: Array<{ id: Screen; icon: IconName; label: string }> = [
  { id: 's0', icon: 'pen', label: '新建会话' },
  { id: 's1', icon: 'layers', label: '会话总览' },
  { id: 's5', icon: 'inbox', label: '收件箱' },
  { id: 's6', icon: 'wallet', label: '预算与用量' },
  { id: 's7', icon: 'history', label: '会话恢复' },
  { id: 's3', icon: 'users', label: '团队管理' },
];

export function Sidebar(): ReactElement {
  const { screen, go, sessions, sessionId, openSession, pending, projects, newSessionInProject, openSettings, openPath } = useApp();
  const { active, recent } = splitSessions(sessions);
  const chips = globalChips({ sessions, pending });
  const projectGroups = groupSessionsByProject(projects.entries, sessions);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleProject = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const row = (s: SessionSummary) => (
    <button
      key={s.record.id}
      className={`side-row ${screen === 's2' && s.record.id === sessionId ? 'is-active' : ''}`}
      data-smoke="session-row"
      data-session={s.record.id}
      onClick={() => openSession(s.record.id)}
      title={s.record.title}
    >
      <span className={`sdot ${statusDot(s.status)}`} />
      <span className="label">{s.record.title}</span>
      <span className="meta">{sessionMeta(s)}</span>
    </button>
  );

  return (
    <aside className="sidebar">
      {/*
        原型里的假交通灯（三个红黄绿 `<span className="dot">`）已删：主窗没有设
        `titleBarStyle`，用的是**原生标题栏**，macOS 自己在左上角画了一组真交通灯。
        原型是浏览器里的静态稿才需要自绘窗控；这里再画一组，屏幕上就是两组圆点，
        而假的那组还点不动。（`.traffic` 样式随本次一起删。）
      */}

      {/*
        brand 区只留品牌字。原本这里摆着两个 `opacity:0.5` 的占位图标（搜索 / 通知），
        MU-3 切片 8 删除 —— 它们是 `<span>`：无 onClick、无 role、无 tabIndex，点上去
        什么也不会发生，却有 hover 底色诱导人去点（`components.css` 的 `.brand .act`）。
        而且两个能力已经有真正的去处：「通知」就是下面 NAV 里的 s5 收件箱（带真 badge），
        「搜索」则连协议面都没有（台账 D-12）。两个入口指向同一件事时，留那个假的只会分歧。
      */}
      <div className="brand">
        <span className="name">Axon</span>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${screen === n.id ? 'is-active' : ''}`}
            data-smoke={`nav-${n.id}`}
            onClick={() => go(n.id)}
          >
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {/* 收件箱 badge 取实时待批数；为 0 就不显示（没事就不要制造红点）。 */}
            {n.id === 's5' && chips.pendingAll > 0 ? <span className="badge">{chips.pendingAll}</span> : null}
          </button>
        ))}
      </nav>

      <div className="side-scroll">
        {/* 项目模块：可折叠分组，项目下挂归属会话 + 项目内新建会话 */}
        <div className="side-section">
          <span>项目</span>
          <span className="spacer" />
          <button className="act" title="新建项目" data-smoke="new-project" onClick={() => setProjectDialog(true)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {projectGroups.length === 0 ? (
          <div className="empty" style={{ padding: '4px 18px 8px' }}>
            还没有项目 —— 点右上「+」建一个，指定工作空间后即可在其中新建会话。
          </div>
        ) : (
          projectGroups.map(({ project, sessions: rows }) => {
            const isOpen = !collapsed.has(project.id);
            return (
              <div key={project.id} className="proj-group" data-smoke="project-group" data-project={project.id}>
                <button
                  className="proj-head"
                  aria-expanded={isOpen}
                  data-smoke="project-head"
                  onClick={() => toggleProject(project.id)}
                  title={project.cwd}
                >
                  <Icon name={isOpen ? 'chevD' : 'chevR'} size={14} cls="caret" />
                  <span className="label">{project.name}</span>
                  <span className="meta">{rows.length}</span>
                </button>
                {isOpen ? (
                  <div className="proj-body">
                    {rows.length === 0 ? (
                      <div className="empty" style={{ padding: '2px 18px 4px 30px' }}>
                        （还没有会话）
                      </div>
                    ) : (
                      rows.map((s) => (
                        <button
                          key={s.record.id}
                          className={`side-row proj-row ${screen === 's2' && s.record.id === sessionId ? 'is-active' : ''}`}
                          data-smoke="session-row"
                          data-session={s.record.id}
                          onClick={() => openSession(s.record.id)}
                          title={s.record.title}
                        >
                          <span className={`sdot ${statusDot(s.status)}`} />
                          <span className="label">{s.record.title}</span>
                          <span className="meta">{sessionMeta(s)}</span>
                        </button>
                      ))
                    )}
                    <button
                      className="proj-newsession"
                      data-smoke="project-new-session"
                      onClick={() => newSessionInProject(project.id)}
                    >
                      <Icon name="plus" size={14} />
                      <span>新建会话</span>
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        <div className="side-section">
          <span>进行中</span>
          <span className="spacer" />
          <button className="act" title="新建会话" onClick={() => go('s0')}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {active.length === 0 ? (
          <div className="empty" style={{ padding: '4px 18px 8px' }}>
            还没有会话 —— 去「新建会话」起一个。
          </div>
        ) : (
          active.map(row)
        )}

        <div className="side-section">
          <span>最近</span>
        </div>
        {recent.length === 0 ? (
          <div className="empty" style={{ padding: '4px 18px 8px' }}>
            （会话结束后会出现在这里）
          </div>
        ) : (
          recent.map(row)
        )}
      </div>

      {menuOpen ? (
        <div className="menu menu-up" onClick={(e) => e.stopPropagation()}>
          {/* MU-3：两条死链接上真落点（设置窗单例 / shell.openPath）。 */}
          <button className="menu-item" data-smoke="menu-settings" onClick={() => openSettings()}>
            <Icon name="settings" size={16} />
            <span>设置…</span>
            <span className="mk">⌘,</span>
          </button>
          <button className="menu-item" data-smoke="menu-config-dir" onClick={() => void openPath('config')}>
            <Icon name="folder" size={16} />
            <span>在访达中显示配置</span>
            <span className="mk mono">~/.axon</span>
          </button>
          <div className="menu-sep" />
          <span className="menu-item">
            <Icon name="help" size={16} />
            <span>关于 Axon</span>
          </span>
        </div>
      ) : null}

      <div className="side-foot">
        <button
          className={`user-btn ${menuOpen ? 'is-on' : ''}`}
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <span className="ava user">L</span>
          <span className="who">lucaszhou</span>
          <Icon name="chevD" size={14} cls="caret" />
        </button>
        <span className="spacer" />
        <button className="tag" title="跨会话待批 —— 点进收件箱" data-smoke="foot-pending" onClick={() => go('s5')}>
          待批 {chips.pendingAll}
        </button>
      </div>

      {projectDialog ? <ProjectCreateDialog onClose={() => setProjectDialog(false)} /> : null}
    </aside>
  );
}

/**
 * S0 新建会话 —— 应用启动的落地屏（ux 02 §4）。
 *
 * 三张执行方式模式卡（文案照 ux 02 §3.1）+ 团队卡片（team.list 真实数据）。
 * 缺口处置（MU-2 §4.6）：原型右栏的「最近用过」频次拿不到 ⇒ 改「最近会话」（updatedAt 倒序）。
 */

import { useState, type ReactElement } from 'react';
import { useApp } from '../state/store.ts';
import { splitSessions } from '../state/selectors.ts';
import { Icon, type IconName } from '../icons.tsx';

type Mode = 'engine' | 'team' | 'adhoc';

/** adhoc 置灰：现挑成员的面板属 M4 后的手动作协作，本片不做（§4.6 缺口处置）。 */
const MODES: Array<{ id: Mode; icon: IconName; title: string; desc: string; meta: string; enabled: boolean }> = [
  {
    id: 'engine',
    icon: 'spark',
    title: '内置引擎',
    desc: '直接开干。适合查资料、改一处代码这种不必组队的事。',
    meta: '单兵 · 不开子 Agent',
    enabled: true,
  },
  {
    id: 'team',
    icon: 'users',
    title: '团队',
    desc: '按团队档实例化成员，主控负责拆解与验收。',
    meta: '多分身 · 有账本',
    enabled: true,
  },
  {
    id: 'adhoc',
    icon: 'branch',
    title: '自由编队',
    desc: '现在挑几个人，不落成团队档；用完即散。',
    meta: '多分身 · 不入团队库',
    enabled: false,
  },
];

export function S0NewSession(): ReactElement {
  const { teams, sessions, createSession, openSession } = useApp();
  const [mode, setMode] = useState<Mode>('engine');
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needTeam = mode === 'team';
  const ready = title.trim().length > 0 && (!needTeam || teamId !== null) && !busy;
  const { recent } = splitSessions(sessions);

  const start = async () => {
    if (!ready) return;
    setBusy(true);
    const s = await createSession({
      title: title.trim(),
      cwd: '',
      executor: needTeam ? 'team' : 'engine',
      ...(needTeam && teamId ? { teamId } : {}),
      ...(task.trim() ? { initialPrompt: task.trim() } : {}),
    });
    setBusy(false);
    if (s) {
      setTitle('');
      setTask('');
    }
  };

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>新建会话</h1>
        <p>一个会话 = 一棵 Agent 树 + 一份账本。选执行方式，写清要做什么。</p>
      </div>

      <div className="grid2">
        <div>
          <div className="side-section" style={{ padding: '0 0 8px' }}>
            <span>执行方式</span>
          </div>
          <div className="mode-grid" style={{ gridTemplateColumns: '1fr' }}>
            {MODES.map((m) => (
              <button
                key={m.id}
                className={`mode-card ${mode === m.id ? 'is-on' : ''}`}
                data-smoke={`mode-${m.id}`}
                disabled={!m.enabled}
                style={m.enabled ? undefined : { opacity: 0.5 }}
                onClick={() => setMode(m.id)}
                title={m.enabled ? undefined : '自由编队留到 M4 之后'}
              >
                <span className="mc-t">
                  <Icon name={m.icon} size={16} />
                  {m.title}
                </span>
                <span className="mc-d">{m.desc}</span>
                <span className="mc-m">{m.meta}</span>
              </button>
            ))}
          </div>

          <div className="side-section" style={{ padding: '18px 0 8px' }}>
            <span>标题</span>
          </div>
          <input
            className="inp"
            style={{ width: '100%', height: 34 }}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一句话说清这次要做什么"
            data-smoke="session-title"
          />

          <div className="side-section" style={{ padding: '18px 0 8px' }}>
            <span>首条任务（可留空，进会话后再发）</span>
          </div>
          <textarea
            className="field ta"
            style={{ width: '100%', font: 'inherit', resize: 'vertical' }}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="把任务写清楚：要什么、边界在哪、怎么算完成"
            data-smoke="session-task"
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 }}>
            <button className="btn primary" onClick={() => void start()} disabled={!ready} data-smoke="start-session">
              {busy ? '正在建…' : '开始'}
            </button>
            <span className="hint" style={{ margin: 0 }}>
              {needTeam && !teamId ? '团队模式要先在右栏选一个团队' : 'Enter 发送首条任务（⌘↵ 直接开始待补）'}
            </span>
          </div>
        </div>

        <div>
          {needTeam ? (
            <>
              <div className="side-section" style={{ padding: '0 0 8px' }}>
                <span>选团队</span>
                <span className="spacer" />
                <button className="act" onClick={() => setTeamId(null)} title="清空选择">
                  <Icon name="x" size={14} />
                </button>
              </div>
              {teams.entries.length === 0 ? (
                <div className="empty">
                  <span className="k">还没有团队档</span>
                  去「团队管理」建一个，或用内置团队。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {teams.entries.map((t) => (
                    <button
                      key={t.team.name}
                      className={`team-card ${teamId === t.team.name ? 'is-on' : ''}`}
                      data-smoke="team-card"
                      data-team={t.team.name}
                      onClick={() => setTeamId(t.team.name)}
                    >
                      <span className="tc-head">
                        <Icon name="users" size={16} />
                        <span className="tc-name">{t.team.name}</span>
                        <span className="spacer" />
                        <span className="tag">{t.source === 'builtin' ? '内置' : '用户'}</span>
                      </span>
                      <span className="tc-desc">{t.team.description ?? '（没有描述）'}</span>
                      <span className="tc-foot">
                        {t.team.members.length} 成员
                        {t.team.budget?.hardUsd ? ` · 预算 $${t.team.budget.hardUsd}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="side-section" style={{ padding: '0 0 8px' }}>
                <span>最近会话</span>
              </div>
              {recent.length === 0 ? (
                <div className="empty">（还没有已完成的会话）</div>
              ) : (
                <div className="list">
                  {recent.slice(0, 5).map((s) => (
                    <button
                      key={s.record.id}
                      className="list-row"
                      data-smoke="recent-session"
                      onClick={() => openSession(s.record.id)}
                    >
                      <span className="grow">
                        <span className="t1">{s.record.title}</span>
                        <span className="t2">{s.team ? s.team.name : '单兵'}</span>
                      </span>
                      <span className="when">{new Date(s.record.updatedAt).toLocaleDateString()}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

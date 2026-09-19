/**
 * S0 新建会话 —— 应用启动的落地屏（ux 02 §4；逐值对齐 s0-new-session.html）。
 *
 * 为什么没有「标题」输入框：原型就没有 —— 会话的题目就是**任务本身的第一行**。
 * 让人为起名再写一遍是多余的；题目仍可事后改（S2 会话条、S6 列表）。
 *
 * 缺口处置（MU-2 §4.6）：
 *   - 原型右栏「最近用过」是**频次统计**（今天 3 次 / 昨天），协议里没有计数 ⇒
 *     换成「最近会话」（updatedAt 倒序），标题同步改 —— 不编假频次；
 *   - 「临时编队」当面挑人属 M4 之后的协作动作 ⇒ 卡片置灰而不删（它标出三档的存在）；
 *   - 数据来源标注（.ann）是 §十二 台账 C-7，本片不渲染。
 */

import { useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { splitSessions, relDay } from '../state/selectors.ts';
import { Icon, type IconName } from '../icons.tsx';
import type { SessionExecutor } from '@axon/protocol';

const MODES: Array<{
  id: SessionExecutor;
  icon: IconName;
  title: string;
  desc: string;
  meta: string;
  enabled: boolean;
}> = [
  {
    id: 'engine',
    icon: 'spark',
    title: '内置引擎（默认）',
    desc: '不组队，Axon 自己干。适合改错别字、查协议、跑一次测试这类一眼能完的活。',
    meta: '1 个执行体 · 无协作账本 · 最省',
    enabled: true,
  },
  {
    id: 'team',
    icon: 'users',
    title: '指定团队',
    desc: '按既有编队开工，lead 拆解后分派给成员。适合跨层改动、需要评审或并行的活。',
    meta: '2~6 个 Agent · 落协作账本',
    enabled: true,
  },
  {
    id: 'adhoc',
    icon: 'layers',
    title: '临时编队',
    desc: '这一次从 Agent 库里挑几个人，用完即散，不存为团队。',
    meta: '自选成员 · 可事后「存为团队」',
    enabled: false,
  },
];

/** 会话标题 = 任务第一行，裁到 30 字（原型没有标题输入框，题目就是任务）。 */
function titleOfTask(task: string): string {
  const first = (task.trim().split('\n')[0] ?? '').trim();
  return first.length > 30 ? `${first.slice(0, 30)}…` : first;
}

/** 「今天 / 昨天 / 9-14」口径已归并到 `selectors.relDay`（MU-3 切片 8）。 */

export function S0NewSession(): ReactElement {
  const { config, teams, sessions, projects, projectContext, clearProjectContext, createSession, openSession, go } = useApp();
  const [picked, setPicked] = useState<SessionExecutor | null>(null);
  const [task, setTask] = useState('');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 默认选中项来自配置（defaultExecutor）—— S8 改配置要立刻反映到这张屏，不许写死 engine。
  const executor = picked ?? config?.config.defaultExecutor ?? 'engine';
  // 有项目上下文时：工作目录 = 项目工作空间（由主进程按 projectId 解析，这里只做展示）。
  const project = projectContext ? projects.entries.find((p) => p.id === projectContext.projectId) ?? null : null;
  const cwd = project ? project.cwd : config?.config.defaultCwd;
  const needTeam = executor === 'team';
  const ready = task.trim().length > 0 && (!needTeam || teamId !== null) && !busy;
  const { recent } = splitSessions(sessions);

  const start = async () => {
    if (!ready) return;
    setBusy(true);
    const s = await createSession({
      title: titleOfTask(task),
      // 项目会话只传 projectId，cwd 由主进程从项目解析（防伪造归属）；否则用默认目录。
      ...(project ? { projectId: project.id } : cwd ? { cwd } : {}),
      executor,
      ...(needTeam && teamId ? { teamId } : {}),
      initialPrompt: task.trim(),
    });
    setBusy(false);
    if (s) setTask('');
  };

  return (
    <div className="body">
      <div className="col">
        <section className="canvas">
          <div className="page">
            <div className="page-head" style={{ paddingTop: 28 }}>
              <h1>这次要做什么？</h1>
              <p>
                先说任务，再决定要不要组队。多数任务不需要一个功能全面的团队——Axon 默认用内置引擎单兵完成，
                中途发现做不动了再叫人。
              </p>
            </div>

            {project ? (
              <div className="proj-banner" data-smoke="project-context">
                <Icon name="folder" size={14} />
                <span className="pb-text">
                  正在 <b>{project.name}</b> 项目下新建会话 · <span className="mono">{project.cwd}</span>
                </span>
                <span className="spacer" />
                <button className="act" onClick={clearProjectContext} data-smoke="project-context-exit">
                  退出项目
                </button>
              </div>
            ) : null}

            <div className="composer" style={{ maxWidth: 'none', marginBottom: 22 }}>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void start();
                  }
                }}
                placeholder="例如：把 apps/api 的支付回调改成幂等，回调表加唯一键…"
                data-smoke="session-task"
                rows={2}
              />
              <div className="row">
                <span className="mode" title="工作目录（S8 设置窗里改默认值）">
                  <Icon name="folder" size={14} />
                  {cwd ?? '进程默认目录'}
                </span>
                <span className="spacer" />
                <button
                  className="btn sm primary"
                  onClick={() => void start()}
                  disabled={!ready}
                  data-smoke="start-session"
                  title={needTeam && !teamId ? '先选一个团队' : '↵'}
                >
                  {busy ? '正在建…' : '开始'}
                </button>
              </div>
            </div>

            <div className="side-section" style={{ paddingLeft: 0, paddingTop: 4 }}>
              <span>怎么执行</span>
            </div>
            <div className="mode-grid">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`mode-card ${executor === m.id ? 'is-on' : ''}`}
                  data-smoke={`mode-${m.id}`}
                  disabled={!m.enabled}
                  style={m.enabled ? undefined : { opacity: 0.55 }}
                  onClick={() => setPicked(m.id)}
                  title={m.enabled ? undefined : '当面挑成员属 M4 之后的协作动作，本片不做'}
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

            {needTeam ? (
              <>
                <div className="side-section" style={{ paddingLeft: 0 }}>
                  <span>选一个团队</span>
                  <span className="spacer" />
                  <button
                    className="act"
                    style={{ fontSize: 'var(--fs-12)', color: 'var(--sem-info)' }}
                    onClick={() => go('s3')}
                  >
                    去团队管理 →
                  </button>
                </div>
                {teams.entries.length === 0 ? (
                  <div className="empty">还没有团队档 —— 去「团队管理」建一个。</div>
                ) : (
                  <div className="grid3">
                    {teams.entries.map((t) => (
                      <button
                        key={t.team.name}
                        className={`team-card ${teamId === t.team.name ? 'is-on' : ''}`}
                        data-smoke="team-card"
                        data-team={t.team.name}
                        onClick={() => setTeamId(t.team.name)}
                      >
                        <span className="tc-head">
                          <span className="ava-stack">
                            {t.team.members.slice(0, 5).map((m) => (
                              <span key={m.name} className={`ava ${m.lead ? 'lead' : ''}`}>
                                {m.name.slice(0, 1)}
                              </span>
                            ))}
                          </span>
                          <span className="spacer" />
                          <span className="tag">{t.source === 'builtin' ? '内置' : '用户'}</span>
                        </span>
                        <span className="tc-name">{t.team.name}</span>
                        <span className="tc-desc">{t.team.description ?? '（这个团队还没有描述）'}</span>
                        <span className="tc-foot">
                          <span className="tag">{t.team.members.length} 成员</span>
                          {t.team.maxConcurrent ? <span className="tag">并发 {t.team.maxConcurrent}</span> : null}
                          {t.team.budget?.hardUsd ? (
                            <span className="tag">${t.team.budget.hardUsd.toFixed(2)} 上限</span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            <div className="card" style={{ marginTop: 22 }}>
              <div className="card-head">
                <Icon name="alert" size={16} />
                <span className="name">不确定要不要组队？</span>
              </div>
              <div className="card-body">
                直接用<b>内置引擎</b>开始。跑起来之后如果任务比想象的大，会话里随时能「叫人」——
                把当前上下文原地升级成团队会话，已产生的消息不丢（ForkMode 决定新成员能看到多少）。
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span className="tag">改错别字 → 内置引擎</span>
                  <span className="tag">查个协议怎么写 → 内置引擎</span>
                  <span className="tag">跨三层的重构 → 全栈小队</span>
                  <span className="tag">只想要评审意见 → 评审小队</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">
            <span>会话 = 一等公民</span>
          </div>
          <div className="prow sub">
            <span>任务</span>
            <span className="val">会话的题目</span>
          </div>
          <div className="prow sub">
            <span>执行方式</span>
            <span className="val">引擎 / 团队 / 临时</span>
          </div>
          <div className="prow sub">
            <span>工作目录</span>
            <span className="val">{cwd ?? '进程默认'}</span>
          </div>
          <div className="prow sub">
            <span>预算</span>
            <span className="val">
              {config?.config.budgetUsd ? `全局 $${config.config.budgetUsd.toFixed(2)}` : '继承团队或全局'}
            </span>
          </div>
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            团队是<b>模板</b>，会话是<b>实例</b>。改团队不影响已开的会话（合成发生在 session.create 时，与 spawn 同理）。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>最近会话</span>
          </div>
          {recent.length === 0 ? (
            <div className="empty" style={{ padding: '2px 12px 8px' }}>
              （还没有已结束的会话）
            </div>
          ) : (
            recent.slice(0, 4).map((s) => (
              <button
                key={s.record.id}
                className="prow sub"
                data-smoke="recent-session"
                onClick={() => openSession(s.record.id)}
              >
                <span className="ava" style={{ width: 20, height: 20 }}>
                  {s.record.title.slice(0, 1)}
                </span>
                <span>{s.record.title}</span>
                <span className="val">{relDay(s.record.updatedAt)}</span>
              </button>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

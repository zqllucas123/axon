/**
 * S1 会话总览（工作台）—— 全局屏（chip 口径随之切到「跨会话」）。
 *
 * 数据纪律（M5 §4.5）：本屏**只读 `SessionSummary`**（来自 session.list）。
 * 「看详情必须走 openSession」在这里表现为一条硬规矩：
 *
 *   「「某会话」的分身」一节只在**已经装载过**的会话上渲染（`details[sid]` 有才渲染），
 *   绝不为了渲染它去补一次 session.get —— 这正是实现计划里那条懒加载反向断言
 *   （渲染 S1 后 `storage.status.loadedCount` 不得增长）。
 *
 * 口径差异（登记进 MU-2 §十二）：原型该节的标题取「最近点开的会话」，本实现取
 * `current`（用户当前选中的会话）；没有选中会话时整节不渲染（不许编数据）。
 */

import { useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { splitSessions, statusDot, statusLabel, money } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';
import { formatForkMode, parseForkMode, type AgentSnapshot, type SessionSummary } from '@axon/protocol';

/** 列表过滤器：全部 / 团队 / 单兵（原型 seg 三态）。 */
type ListFilter = 'all' | 'team' | 'solo';
/** 分身过滤器：全部 / 运行中 / 等待 / 异常（原型 seg 四态）。 */
type MemberFilter = 'all' | 'running' | 'waiting' | 'error';

/** 团队会话 = 有团队引用（executor=team/adhoc 且落了 teamId）。 */
const isTeam = (s: SessionSummary): boolean => s.record.executor !== 'engine';

function matches(s: SessionSummary, f: ListFilter): boolean {
  if (f === 'all') return true;
  return f === 'team' ? isTeam(s) : !isTeam(s);
}

function matchesMember(m: AgentSnapshot, f: MemberFilter): boolean {
  if (f === 'all') return true;
  if (f === 'running') return m.status === 'running';
  if (f === 'waiting') return m.status === 'waiting';
  return m.status === 'failed';
}

/** 会话行：头像（团队取首字 / 单兵取 spark）+ 标题行 + meta 行 + 花费。 */
function SessionRow({ s, onOpen }: { s: SessionSummary; onOpen: () => void }): ReactElement {
  const team = s.team;
  const c = s.counts;
  return (
    <button className="list-row" data-smoke="session-row" data-session={s.record.id} onClick={onOpen}>
      {team ? (
        <span className="ava lead">{team.name.slice(0, 1)}</span>
      ) : (
        <span className="ava">
          <Icon name="spark" size={14} />
        </span>
      )}
      <span className="grow">
        <span className="t1">
          {s.record.title}
          {team ? <span className="tag">{team.name}</span> : <span className="tag">单兵 · 内置引擎</span>}
          {team && team.tempCount > 0 ? <span className="tag">+{team.tempCount} 临时</span> : null}
          {c.pending > 0 ? <span className="tag err">{c.pending} 待批</span> : null}
        </span>
        <span className="t2">
          {c.members} 分身 · {c.running} running / {c.parked} parked
          {c.suspended ? ` / ${c.suspended} suspended` : ''} · {c.ledger} 笔协作 · {s.record.cwd}
        </span>
      </span>
      <span className="when">{money(s.usage.costUsd)}</span>
      <Icon name="chevR" size={14} />
    </button>
  );
}

/** 分身行：状态点 + 名 + 路径 + 状态 + 上下文/工具数（可得字段，缺口不渲染）。 */
function MemberRow({
  m,
  toolCount,
  onOpen,
}: {
  m: AgentSnapshot;
  toolCount: number | null;
  onOpen: () => void;
}): ReactElement {
  const working = m.status === 'running';
  return (
    <button className="list-row" data-smoke="member-row" data-path={m.path} onClick={onOpen}>
      <span className={`sdot ${statusDot(m.status)}`} />
      <span className="grow">
        <span className="t1">
          {m.displayName}
          <span className="tag mono">{m.path.replace(/^\/[^/]+/, '') || '/0'}</span>
          <span className={`tag${m.status === 'failed' ? ' err' : m.status === 'running' ? ' run' : ''}`}>
            {statusLabel(m.status)}
          </span>
        </span>
        <span className="t2">
          {m.waitingOn?.length
            ? `在等：${m.waitingOn.join('、')}`
            : m.status === 'failed'
              ? '上一次运行以错误结束'
              : working
                ? '正在跑'
                : '空闲'}
        </span>
      </span>
      <span className="tag">fork: {formatForkMode(parseForkMode(m.forkMode))}</span>
      <span className="tag">{toolCount === null ? '—' : `${toolCount} 工具`}</span>
      <span className="when">{money(m.usage.costUsd)}</span>
      <Icon name="chevR" size={14} />
    </button>
  );
}

export function S1Workbench(): ReactElement {
  const {
    sessions, teams, roles, current, details, agents, budget, pending,
    openSession, go, setFocus, setSessionView,
  } = useApp();
  const [filter, setFilter] = useState<ListFilter>('all');
  const [memFilter, setMemFilter] = useState<MemberFilter>('all');

  const { active, recent } = splitSessions(sessions);
  const shown = active.filter((s) => matches(s, filter));
  const teamN = active.filter(isTeam).length;
  const soloN = active.length - teamN;

  /** 待你处理 = 活着的挂起请求（与顶栏 chip 同源，不用节流过的 counts.pending）。 */
  const pendingN = pending.filter((p) => p.state === 'pending').length;
  const totalCost = sessions.reduce((n, s) => n + (s.usage.costUsd ?? 0), 0);
  const totalLedger = sessions.reduce((n, s) => n + s.counts.ledger, 0);

  /**
   * 当前会话（用户选中的那个）。
   *
   * 注意 `details[sid]` 这一道闸：S1 只允许用**已经装载进来的**成员树，
   * 没装载就整块不渲染 —— 调用 session.get 会让 `loadedCount` 增长，断言就红了。
   */
  const detail = current ? details[current.record.id] : undefined;
  const roster = current
    ? Object.values(agents).filter((m) => m.sessionId === current.record.id)
    : [];
  const rosterShown = roster.filter((m) => matchesMember(m, memFilter));
  const runN = roster.filter((m) => m.status === 'running').length;
  const waitN = roster.filter((m) => m.status === 'waiting').length;
  const errN = roster.filter((m) => m.status === 'failed').length;

  const toolCountOf = (roleName: string): number | null => {
    const hit = roles.entries.find((e) => e.role.name === roleName);
    return hit?.role.tools ? hit.role.tools.length : null;
  };

  const openMember = (path: string): void => {
    setFocus(path);
    go('s2');
  };

  return (
    <div className="body">
      <section className="canvas">
        <div className="page page-wide">
          {/* ── 活跃会话 ─ */}
          <div className="toolbar" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 'var(--fs-13)', color: 'var(--text-muted)' }}>
              活跃会话 {active.length}
            </span>
            <span className="seg">
              <button className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>
                全部
              </button>
              <button className={filter === 'team' ? 'is-on' : ''} onClick={() => setFilter('team')}>
                团队 {teamN}
              </button>
              <button className={filter === 'solo' ? 'is-on' : ''} onClick={() => setFilter('solo')}>
                单兵 {soloN}
              </button>
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="btn sm primary" data-smoke="new-session" onClick={() => go('s0')}>
              <Icon name="plus" size={14} />
              新建会话
            </button>
          </div>

          {shown.length === 0 ? (
            <div className="empty">
              <span className="k">
                {active.length === 0 ? '还没有进行中的会话' : `没有「${filter === 'team' ? '团队' : '单兵'}」会话`}
              </span>
              {active.length === 0 ? '去「新建会话」起一个任务。' : '换个过滤器看看。'}
            </div>
          ) : (
            <div className="list" style={{ marginBottom: 26 }}>
              {shown.map((s) => (
                <SessionRow key={s.record.id} s={s} onOpen={() => openSession(s.record.id)} />
              ))}
            </div>
          )}

          {/* ── 当前会话的分身（只在已装载时渲染；绝不补拉） ── */}
          {current && detail ? (
            <>
              <div className="toolbar" style={{ marginTop: 6 }}>
                <span style={{ fontSize: 'var(--fs-13)', color: 'var(--text-muted)' }}>
                  「{current.record.title}」的分身 {roster.length} 个
                </span>
                <span className="seg">
                  <button className={memFilter === 'all' ? 'is-on' : ''} onClick={() => setMemFilter('all')}>
                    全部
                  </button>
                  <button
                    className={memFilter === 'running' ? 'is-on' : ''}
                    onClick={() => setMemFilter('running')}
                  >
                    运行中 {runN}
                  </button>
                  <button className={memFilter === 'waiting' ? 'is-on' : ''} onClick={() => setMemFilter('waiting')}>
                    等待 {waitN}
                  </button>
                  <button className={memFilter === 'error' ? 'is-on' : ''} onClick={() => setMemFilter('error')}>
                    异常 {errN}
                  </button>
                </span>
                <span className="spacer" style={{ flex: 1 }} />
                <button className="btn sm ghost" disabled title="临时加人（M4 后）">
                  <Icon name="plus" size={14} />
                  临时加人
                </button>
              </div>
              <div className="list">
                {rosterShown.map((m) => (
                  <MemberRow
                    key={m.path}
                    m={m}
                    toolCount={toolCountOf(m.role)}
                    onOpen={() => openMember(m.path)}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="empty">
              <span className="k">还没有选中会话</span>
              点上面任意一行进会话，这里会跟着显示它的分身树；
              没打开过的会话不会为这一屏单独读盘（懒加载纪律）。
            </div>
          )}

          {/* ── 三张 stat ── */}
          <div className="grid3" style={{ marginTop: 22 }}>
            {(() => {
              const toUsage = (): void => {
                if (!current) return;
                setSessionView('usage');
                go('s2');
              };
              const toLedger = (): void => {
                if (!current) return;
                setSessionView('ledger');
                go('s2');
              };
              return (
                <>
                  {current ? (
                    <button className="stat" onClick={toUsage} data-smoke="stat-usage">
                      <div className="k">本会话花费</div>
                      <div className="v">{money(current.usage.costUsd)}</div>
                      <div className="s">
                        软线 ${current.budget.effectiveSoftUsd.toFixed(2)} · 硬线 $
                        {current.budget.effectiveHardUsd.toFixed(2)} · 进会话用量 →
                      </div>
                    </button>
                  ) : (
                    <div className="stat">
                      <div className="k">累计花费</div>
                      <div className="v">{money(totalCost)}</div>
                      <div className="s">
                        跨 {sessions.length} 个会话 · 全局已用 {money(budget?.spentUsd)}
                      </div>
                    </div>
                  )}
                  <div className="stat">
                    <div className="k">待你处理</div>
                    <div className="v">{pendingN}</div>
                    <div className="s">挂起中的审批与提问（收件箱同源）</div>
                  </div>
                  {current ? (
                    <button className="stat" onClick={toLedger} data-smoke="stat-ledger">
                      <div className="k">协作落账</div>
                      <div className="v">{current.counts.ledger}</div>
                      <div className="s">进本会话账本 →</div>
                    </button>
                  ) : (
                    <div className="stat">
                      <div className="k">协作落账</div>
                      <div className="v">{totalLedger}</div>
                      <div className="s">跨 {sessions.length} 个会话合计</div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">
            <span>团队</span>
            <span className="spacer" />
            <button className="act" title="团队管理" onClick={() => go('s3')}>
              <Icon name="chevR" size={14} />
            </button>
          </div>
          {teams.entries.map((e) => (
            <div className="prow" key={e.team.name} data-smoke="team-row" data-team={e.team.name}>
              <span className="ava" style={{ width: 20, height: 20 }}>
                {e.team.name.slice(0, 1)}
              </span>
              <span>{e.team.name}</span>
              <span className="val">
                {e.team.members.length} 成员
                {current?.record.teamId === e.team.name ? ' · 使用中' : ''}
              </span>
            </div>
          ))}
          {teams.issues.length ? (
            <div className="hint" style={{ padding: '2px 10px 8px' }}>
              {teams.issues.length} 个团队有问题，引用它的会话可能起不来。
              <button className="link" onClick={() => go('s3')}>
                去团队管理 →
              </button>
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>并发闸门</span>
          </div>
          {current ? (
            <>
              <div className="prow sub">
                <span>running</span>
                <span className="val">
                  {current.counts.running} / {current.record.maxConcurrent ?? '—'}
                </span>
              </div>
              <div className="prow sub">
                <span>parked（排队）</span>
                <span className="val">{current.counts.parked}</span>
              </div>
              <div className="prow sub">
                <span>suspended（父等后代）</span>
                <span className="val">{current.counts.suspended}</span>
              </div>
              <div className="hint" style={{ padding: '2px 10px 8px' }}>
                gate 只数 running；waiting = parked 或 suspended（退位让额）⇒ 死锁结构性不可能。
              </div>
            </>
          ) : (
            <div className="empty">
              <span className="k">没有选中会话</span>
              闸门是会话级的：进会话后这里显示它的额度占用。
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
/**
 * 右栏检视栏（原型：width --inspector-w / padding 4px 18px 20px 4px）。
 *
 * 硬规矩（ux 01 §2.1-①，用户 2026-09-14 拍板）：左栏管「会话之间」、
 * 右栏管「会话之内」—— 分身树 / 成员详情 / 会话账本都只在这里出现，
 * 且**按会话粒度重建**（ux 02 §3.6）：换会话 ⇒ 面板跟着换。
 *
 * 缺口纪律（MU-2 §4.6）：模型行、审批档行**删掉**（快照里没有这两个真相字段）；
 * 工具行降级为「工具（角色白名单）N」；排队位次删掉（counts.parked 只有数量）。
 */

import type { ReactElement } from 'react';
import { COLLAB_ACTIONS, type AgentPath } from '@axon/protocol';
import { useApp } from '../state/store.tsx';
import { buildMemberTree, leafOf, statusDot, type MemberNode } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';
import { ACTION_ICON, ACTION_LABEL, LedgerRow } from './S2Views.tsx';

export function Inspector({ onEscalate }: { onEscalate?: () => void }): ReactElement | null {
  const { screen, current, details, focusPath, setFocus, ledger, roles, setSessionView, go } = useApp();
  if (screen !== 's2' || !current) return null;

  const detail = details[current.record.id];
  const members = detail?.members ?? [];
  const tree = buildMemberTree(members);
  const solo = !current.team;
  const focus = focusPath ? members.find((m) => m.path === focusPath) : undefined;

  // 工具行的真实口径：角色白名单条数（生效交集拿不到，见台账 A-3）。**不写「生效」二字。**
  const roleTools = focus ? (roles.entries.find((e) => e.role.name === focus.role)?.role.tools?.length ?? 0) : 0;
  const waiting = (focus?.waitingOn ?? []).map((p) => members.find((m) => m.path === p)?.displayName ?? p);
  // 精简账本 = 与当前成员**直接相关**的条目（participant 口径：from 或 to 命中）。
  const mine = ledger
    .filter((r) => r.sessionId === current.record.id && focus !== undefined && (r.from === focus.path || r.to === focus.path))
    .sort((a, b) => b.at - a.at);
  const sessionRecords = ledger.filter((r) => r.sessionId === current.record.id);
  const pendingLedger = sessionRecords.filter((r) => r.adoption === 'pending').length;

  return (
    <aside className="inspector">
      {/* ① 本会话成员树 */}
      <div className="panel">
        <div className="panel-title">
          <span>本会话成员</span>
          {solo ? (
            <span className="tag">单兵</span>
          ) : (
            <span className="tag">
              {current.team?.memberCount ?? 0}
              {current.team?.tempCount ? ` + ${current.team.tempCount} 临时` : ''}
            </span>
          )}
          <span className="spacer" />
          <span className="tag">{current.counts.running} 跑</span>
        </div>

        <div className="team-strip">
          <Icon name={solo ? 'spark' : 'users'} size={14} />
          <span>{solo ? '未组队 · 内置引擎' : `${current.team?.name ?? ''} · ${current.team?.memberCount ?? 0} 成员`}</span>
          <span className="spacer" />
          {solo ? (
            <button className="link" onClick={onEscalate} data-smoke="escalate-link">
              叫人 →
            </button>
          ) : (
            <button className="link" onClick={() => go('s3')}>
              编队 →
            </button>
          )}
        </div>

        {tree.length === 0 ? (
          <div className="empty">
            <span className="k">正在读会话树…</span>会话树来自 session.get —— 懒加载：点开会话才会读树。
          </div>
        ) : (
          <div className="tree">{tree.map((n) => renderNode(n, focusPath, setFocus))}</div>
        )}

        <div className="hint" style={{ padding: '6px 10px 4px' }}>
          {solo ? '单兵会话没有分身树。要并行 / 要评审时再叫人。' : '点成员切焦点；下方面板始终跟随选中的那一个。'}
        </div>
      </div>

      {/* ② 当前成员（缺口纪律：只列真拿得到的字段） */}
      {focus ? (
        <div className="panel">
          <div className="panel-title">
            <span>当前成员</span>
            <span className="tag mono">{focus.path}</span>
            <span className="spacer" />
            <button className="act" title="看该角色的定义（团队管理 → 类型）" onClick={() => go('s3')}>
              <Icon name="pen" size={14} />
            </button>
          </div>
          <div className="prow">
            <Icon name="users" size={16} />
            <span>类型</span>
            <span className="val">{focus.role}</span>
          </div>
          <div className="prow">
            <Icon name="layers" size={16} />
            <span>所属团队</span>
            <span className="val">{current.team?.name ?? '未组队'}</span>
          </div>
          <div className="prow">
            <Icon name="commit" size={16} />
            <span>上下文</span>
            <span className="val">fork: {focus.forkMode === undefined || focus.forkMode === null ? 'none' : String(focus.forkMode)}</span>
          </div>
          <div className="prow">
            <Icon name="list" size={16} />
            <span>工具（角色白名单）</span>
            <span className="val">{roleTools}</span>
          </div>
          <div className="prow">
            <Icon name="clock" size={16} />
            <span>在等谁</span>
            <span className="val">{waiting.length ? waiting.join('、') : '—'}</span>
          </div>
          <div className="prow">
            <Icon name="wallet" size={16} />
            <span>本树用量</span>
            <span className="val">${focus.usage.costUsd.toFixed(3)}</span>
          </div>
          {focus.lastError ? (
            <div className="hint" style={{ padding: '4px 10px 8px', color: 'var(--text-secondary)' }}>
              最近一次错误：{focus.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ③ 本会话账本（精简：只列与当前成员直接相关的） */}
      <div className="panel">
        <div className="panel-title">
          <span>本会话账本</span>
          {pendingLedger > 0 ? (
            <span className="tag err" style={{ marginLeft: 6 }}>
              {pendingLedger} 待表态
            </span>
          ) : null}
          <span className="spacer" />
          <button className="act" title="展开为全幅（会话条 → 账本）" onClick={() => setSessionView('ledger')}>
            <Icon name="panelR" size={14} />
          </button>
        </div>
        <div className="led-mini">
          {mine.slice(0, 4).map((r) => (
            <LedgerRow record={r} key={r.id} />
          ))}
          {mine.length === 0 ? (
            <div className="hint" style={{ padding: '8px 10px' }}>
              还没有与<b>当前成员</b>直接相关的协作记录。
            </div>
          ) : null}
        </div>
        <div className="hint" style={{ padding: '8px 10px' }}>
          面板只列与<b>当前成员</b>相关的条目；本会话共 {sessionRecords.length} 笔，点右上角展开。
        </div>
      </div>

      {/* ④ 协作动作（静态口径说明，不是状态） */}
      <div className="panel">
        <div className="panel-title">
          <span>协作动作</span>
          <span className="spacer" />
          <span className="tag mono">枚举 + 落账</span>
        </div>
        {COLLAB_ACTIONS.map((a) => (
          <div className="prow sub" key={a}>
            <Icon name={ACTION_ICON[a]} size={16} />
            <span>{a}</span>
            <span className="val">{ACTION_LABEL[a]}</span>
          </div>
        ))}
        <div className="hint" style={{ padding: '4px 10px 8px' }}>
          协作只由编排工具发起（不做自由消息总线）；人手发起待 M4 之后评审。
        </div>
      </div>
    </aside>
  );
}

function renderNode(
  node: MemberNode,
  focusPath: AgentPath | null,
  setFocus: (p: AgentPath) => void,
): ReactElement {
  const s = node.snapshot;
  const isFocus = focusPath === s.path;
  return (
    <div key={s.path}>
      <button
        className={`side-row lv${Math.min(node.depth, 2)} ${isFocus ? 'is-active' : ''}`}
        data-smoke="member-row"
        data-path={s.path}
        onClick={() => setFocus(s.path)}
        title={s.lastError ?? undefined}
      >
        <span className={`sdot ${statusDot(s.status)}`} />
        <span className="label">{s.displayName}</span>
        <span className="meta mono">{leafOf(s.path)}</span>
      </button>
      {node.children.map((c) => renderNode(c, focusPath, setFocus))}
    </div>
  );
}

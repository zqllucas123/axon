/**
 * 右栏检视栏（原型：width --inspector-w / padding 4px 18px 20px 4px）。
 *
 * 硬规矩（ux 01 §2.1-①，用户 2026-09-14 拍板）：左栏管「会话之间」、
 * 右栏管「会话之内」—— 分身树/成员详情/会话账本都只在这里出现。
 * 且右栏**按会话粒度重建**（ux 02 §3.6）：换会话 ⇒ 面板跟着换。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { buildMemberTree, leafOf, statusDot, type MemberNode } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';
import type { AgentPath } from '@axon/protocol';

export function Inspector(): ReactElement | null {
  const { screen, current, details, focusPath, setFocus } = useApp();
  if (screen !== 's2' || !current) return null;

  const detail = details[current.record.id];
  const tree = buildMemberTree(detail?.members ?? []);
  const solo = !current.team;

  return (
    <aside className="inspector">
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
          <span>
            {solo ? '未组队 · 内置引擎' : `${current.team?.name ?? ''} · ${current.team?.memberCount ?? 0} 成员`}
          </span>
        </div>

        {tree.length === 0 ? (
          <div className="empty">
            <span className="k">正在读会话树…</span>
            会话树来自 session.get —— 懒加载：点开会话才会读树。
          </div>
        ) : (
          <div className="tree">{tree.map((n) => renderNode(n, focusPath, setFocus))}</div>
        )}

        <div className="hint" style={{ padding: '6px 10px 4px' }}>
          {solo ? '单兵会话没有分身树。要并行 / 要评审时再叫人。' : '点成员切焦点；下方面板始终跟随选中的那一个。'}
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

/**
 * S1 会话总览 —— 全局屏（chip 口径随之切到「跨会话」）。
 *
 * 数据纪律（M5 §4.5）：本屏只读 SessionSummary（来自 session.list）；
 * 看详情必须走 openSession —— session.get 只允许出现在 store.openSession 里。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { sessionMeta, splitSessions, statusDot, statusLabel } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';

export function S1Workbench(): ReactElement {
  const { sessions, openSession, go, budget, pending } = useApp();
  const { active, recent } = splitSessions(sessions);

  const memberTotal = sessions.reduce((n, s) => n + s.counts.members, 0);
  const runningTotal = sessions.reduce((n, s) => n + s.counts.running, 0);
  const costTotal = sessions.reduce((n, s) => n + (s.usage.costUsd ?? 0), 0);

  return (
    <div className="body">
      <section className="canvas">
    <div className="page page-wide">
      <div className="page-head">
        <h1>会话总览</h1>
        <p>
          进行中 {active.length} · 最近 {recent.length} —— 点任意一行进会话。
        </p>
      </div>

      <div className="grid3" style={{ marginBottom: 18 }}>
        <span className="stat">
          <span className="k">进行中的会话</span>
          <span className="v">{active.length}</span>
          <span className="s">{runningTotal} 个分身正在跑</span>
        </span>
        <span className="stat">
          <span className="k">会话内分身</span>
          <span className="v">{memberTotal}</span>
          <span className="s">跨 {sessions.length} 个会话</span>
        </span>
        <span className="stat">
          <span className="k">累计花费</span>
          <span className="v">${costTotal.toFixed(2)}</span>
          <span className="s">
            全局已用 ${(budget?.spentUsd ?? 0).toFixed(2)} · 待批 {pending.filter((p) => p.state === 'pending').length}
          </span>
        </span>
      </div>

      <div className="side-section" style={{ padding: '0 0 8px' }}>
        <span>进行中</span>
      </div>
      {active.length === 0 ? (
        <div className="empty">
          <span className="k">没有进行中的会话</span>
          <button className="btn sm" onClick={() => go('s0')} style={{ marginTop: 8 }}>
            <Icon name="plus" size={14} />
            新建会话
          </button>
        </div>
      ) : (
        <div className="list">
          {active.map((s) => (
            <button
              key={s.record.id}
              className="list-row"
              data-smoke="session-row"
              data-session={s.record.id}
              onClick={() => openSession(s.record.id)}
            >
              <span className={`sdot ${statusDot(s.status)}`} />
              <span className="grow">
                <span className="t1">{s.record.title}</span>
                <span className="t2">
                  {sessionMeta(s)} · {statusLabel(s.status)} · {s.counts.members} 分身（{s.counts.running} 跑 /{' '}
                  {s.counts.parked} 排队）
                  {s.counts.ledger ? ` · 账本 ${s.counts.ledger}` : ''}
                  {s.counts.pending ? ` · 待批 ${s.counts.pending}` : ''}
                </span>
              </span>
              <span className="when">${(s.usage.costUsd ?? 0).toFixed(2)}</span>
            </button>
          ))}
        </div>
      )}

      {recent.length ? (
        <>
          <div className="side-section" style={{ padding: '18px 0 8px' }}>
            <span>最近</span>
          </div>
          <div className="list">
            {recent.slice(0, 8).map((s) => (
              <button
                key={s.record.id}
                className="list-row"
                data-smoke="session-row"
                data-session={s.record.id}
                onClick={() => openSession(s.record.id)}
              >
                <span className={`sdot ${statusDot(s.status)}`} />
                <span className="grow">
                  <span className="t1">{s.record.title}</span>
                  <span className="t2">
                    {sessionMeta(s)} · {statusLabel(s.status)}
                  </span>
                </span>
                <span className="when">{new Date(s.record.updatedAt).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
      </section>
    </div>
  );
}

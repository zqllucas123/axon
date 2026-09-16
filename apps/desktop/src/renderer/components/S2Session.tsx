/**
 * S2 会话屏（团队 / 单兵两态）。
 *
 * 本切片先立骨架：会话条（ident + seg + 动作）+ 消息流容器 + 输入区。
 * 六元件渲染与右栏细节在切片 3/4 补齐；缺口一律「拿不到就不渲染」（MU-2 §4.6）。
 */

import { useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { VIEW_LABEL } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';
import { Inspector } from './Inspector.tsx';
import { MessageStream } from './MessageStream.tsx';
import type { SessionView } from '../state/types.ts';

export function S2Session(): ReactElement {
  const { current, details, sessionView, setSessionView, focusPath, prompt, interrupt, agents } = useApp();
  const [text, setText] = useState('');

  if (!current) {
    return (
      <div className="stream">
        <div className="empty">
          <span className="k">没有选中的会话</span>
          从左栏「进行中」里点一个会话，或去「新建会话」起一个。
        </div>
      </div>
    );
  }

  const detail = details[current.record.id];
  const solo = !current.team;
  const focus = focusPath ? agents[focusPath] : undefined;
  const running = focus?.status === 'running';
  const views: SessionView[] = ['chat', 'ledger', 'usage'];

  const send = () => {
    const t = text.trim();
    if (!t || !focusPath) return;
    setText('');
    void prompt(focusPath, t);
  };

  return (
    <>
      <div className="session-bar">
        <Icon name={solo ? 'spark' : 'users'} size={14} />
        <span>
          {solo ? (
            <>
              未组队 · 由 <b style={{ color: 'var(--text)' }}>Axon 内置引擎</b> 直接执行
            </>
          ) : (
            <>
              团队 <b style={{ color: 'var(--text)' }}>{current.team?.name ?? ''}</b> · {current.team?.memberCount ?? 0} 成员已实例化
              {current.team?.tempCount ? ` +${current.team.tempCount} 临时` : ''}
            </>
          )}
        </span>

        <span className="seg" style={{ marginLeft: 6 }}>
          {views.map((v) => {
            const dead = v === 'ledger' && solo;
            const n =
              v === 'chat'
                ? String((detail?.counts.members ?? current.counts.members) + 1)
                : v === 'ledger'
                  ? dead
                    ? '—'
                    : current.counts.ledger
                      ? String(current.counts.ledger)
                      : '—'
                  : `$${(current.usage.costUsd ?? 0).toFixed(2)}`;
            return (
              <button
                key={v}
                className={sessionView === v ? 'is-on' : ''}
                disabled={dead}
                data-smoke={`view-${v}`}
                title={dead ? '单兵会话没有协作，自然没有账本' : undefined}
                onClick={() => setSessionView(v)}
              >
                {VIEW_LABEL[v]}
                <span className="n">{n}</span>
              </button>
            );
          })}
        </span>

        <span className="spacer" />
        {solo ? (
          <button className="btn sm" data-smoke="escalate" title="升级为团队会话（切片 5 接浮层）">
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

      <div className="body">
        <div className="col">
      {sessionView === 'chat' ? (
        <>
          <section className="canvas">
            <MessageStream />
          </section>
          <div className="composer-wrap">
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
                {running ? (
                  <button className="btn sm" onClick={() => focusPath && void interrupt(focusPath)}>
                    <Icon name="pause" size={14} />
                    中断
                  </button>
                ) : null}
                <button className="send" onClick={send} title="发送（Enter）" disabled={!focusPath}>
                  <Icon name="arrowUp" size={16} />
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="stream">
          <div className="empty">
            <span className="k">{VIEW_LABEL[sessionView]} 视图</span>
            本视图在切片 6 落地（数据已在会话摘要里：账本 {current.counts.ledger} 笔 / 用量 $
            {(current.usage.costUsd ?? 0).toFixed(2)}）。
          </div>
        </div>
      )}
        </div>
        <Inspector />
      </div>
    </>
  );
}

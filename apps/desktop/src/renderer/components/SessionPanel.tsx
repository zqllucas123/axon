/**
 * 会话面板 —— **MU-1 的临时壳**（MU-2 会被 S0/S1 两屏整体替换）。
 *
 * 它存在只为一件事：让「会话是一等公民」在界面上有个落点，从而能手工
 * 演示与冒烟。刻意保持极简（列表 + 两个按钮），不碰设计稿的卡片样式 ——
 * 把视觉做进临时壳，MU-2 就得先删一遍再写一遍。
 *
 * 纪律不变：这里只渲染 `SessionSummary` 并发出意图（选中/新建/删除），
 * 任何「该不该允许」的判断都在主进程。
 */

import type { SessionSummary } from '@axon/protocol';

export interface SessionPanelProps {
  sessions: SessionSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRemove: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  ok: '正常',
  warning: '接近上限',
  frozen: '已冻结',
};

export function SessionPanel({ sessions, currentId, onSelect, onCreate, onRemove }: SessionPanelProps) {
  return (
    <>
      <div className="panel-head">
        <span>会话</span>
        <button type="button" className="mini" data-smoke="session-create" onClick={onCreate}>
          + 新建
        </button>
      </div>
      <div className="sessions">
        {sessions.length === 0 && <div className="hint">（还没有会话）</div>}
        {sessions.map((s) => {
          const r = s.record;
          const badge =
            r.executor === 'team' ? '团队' : r.executor === 'adhoc' ? '临时编队' : '内置引擎';
          return (
            <div
              key={r.id}
              className={`session${r.id === currentId ? ' sel' : ''}`}
              data-smoke="session-row"
              data-session={r.id}
              onClick={() => onSelect(r.id)}
              title={`${r.id} · ${s.rootPath} · 工作目录 ${r.cwd}`}
            >
              <span className="dot" data-s={s.status} />
              <span className="lbl">{r.title}</span>
              <span className="meta">
                {badge} · {s.team ? `${s.team.name} · ` : ''}
                {s.counts.members} 成员 · {s.counts.ledger} 笔 · {STATUS_LABEL[s.budget.tier]}
              </span>
              {s.counts.pending > 0 && <span className="pending">{s.counts.pending} 待批</span>}
              <button
                type="button"
                className="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`删除会话「${r.title}」？会连同它的全部成员一起删除。`)) {
                    onRemove(r.id);
                  }
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
/**
 * S2 会话内视图与浮层（MU-2 切片 5/6）。
 *
 *  - `LedgerView`：本会话账本全幅视图（四动词过滤 + 表态）—— 账本 seg 的第二视图
 *  - `UsageView`：本会话用量（会话预算卡 + 按成员表）—— 第三个视图
 *  - `EscalateSheet`：「叫人」选团队浮层（原型只画了入口按钮，浮层是实现新增）
 *
 * 数据全部来自已有命令（`ledger.query` / `session.get` / `budget` 摘要），零新增协议；
 * 缺口一律整块不渲染（MU-2 §4.6）：不显示消息级成本、不显示生效 model/审批档。
 */

import { useState, type ReactElement } from 'react';
import { COLLAB_ACTIONS, type CollabAction, type LedgerRecord } from '@axon/protocol';
import { useApp } from '../state/store.tsx';
import { statusLabel, money } from '../state/selectors.ts';
import { Icon, type IconName } from '../icons.tsx';

/** 四动词 → 图标（与原型 `.lm` 的图标口径一致）。 */
export const ACTION_ICON: Record<CollabAction, IconName> = {
  consult: 'reply',
  fork: 'layers',
  delegate: 'branch',
  handoff: 'commit',
};

/** 四动词 → 一句话语义（原型右栏「协作动作」面板的文案）。 */
export const ACTION_LABEL: Record<CollabAction, string> = {
  consult: '问一句，不转移',
  fork: '带上下文分叉',
  delegate: '派活，等回执',
  handoff: '整段交接',
};

/** 账本一行（右栏精简面板与全幅视图共用同一形状，钩子也共用）。 */
export function LedgerRow({ record }: { record: LedgerRecord }): ReactElement {
  const { agents, adopt } = useApp();
  const who = (path: string): string => agents[path]?.displayName ?? path;
  const pending = record.adoption === 'pending';
  return (
    <div
      className={pending ? 'lm todo' : 'lm'}
      data-smoke="ledger-row"
      data-adoption={record.adoption}
      data-id={record.id}
      data-action={record.action}
    >
      <Icon name={ACTION_ICON[record.action]} size={14} />
      <div className="g">
        <div>
          <span className="v">{record.action}</span>{' '}
          <span className="p">
            {who(record.from)} → {record.to === record.from ? '（自己）' : who(record.to)}
          </span>{' '}
          {record.adoption === 'adopted' ? <span className="tag ok">已采纳</span> : null}
          {record.adoption === 'rejected' ? <span className="tag err">已驳回</span> : null}
          {record.adoption === 'pending' ? <span className="tag wait">待表态</span> : null}
          {record.status === 'open' ? <span className="tag run">进行中</span> : null}
        </div>
        {record.summary ? <div className="d">{record.summary}</div> : null}
        {record.contextScope !== undefined && record.contextScope !== null ? (
          <div className="d">
            <span className="tag mono">context: {String(record.contextScope)}</span>
          </div>
        ) : null}
        {pending ? (
          <div className="acts">
            <button className="btn sm" data-smoke="ledger-adopt" onClick={() => void adopt(record.id, 'adopted')}>
              采纳
            </button>
            <button className="btn sm ghost" onClick={() => void adopt(record.id, 'rejected')}>
              驳回
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ViewHead({ title, note }: { title: string; note: string }): ReactElement {
  return (
    <div className="view-head">
      <span className="k">{title}</span>
      <span className="n">{note}</span>
    </div>
  );
}

/** 账本视图：本会话全部条目 + 四动词过滤（口径与右栏精简面板一致）。 */
export function LedgerView(): ReactElement {
  const { ledger, current } = useApp();
  const [filter, setFilter] = useState<CollabAction | 'all'>('all');
  const sid = current?.record.id ?? '';
  const mine = ledger.filter((r) => r.sessionId === sid);
  const shown = mine.filter((r) => filter === 'all' || r.action === filter).sort((a, b) => b.at - a.at);
  const pending = mine.filter((r) => r.adoption === 'pending').length;

  return (
    <div className="stream">
      <ViewHead
        title="本会话账本"
        note={`共 ${mine.length} 笔${pending > 0 ? ` · ${pending} 笔待你表态` : ''}（ledger.query(sessionId)）`}
      />
      <div className="seg">
        <button className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>
          全部<span className="n">{mine.length}</span>
        </button>
        {COLLAB_ACTIONS.map((a) => {
          const n = mine.filter((r) => r.action === a).length;
          return (
            <button key={a} className={filter === a ? 'is-on' : ''} onClick={() => setFilter(a)} title={ACTION_LABEL[a]}>
              {a}
              <span className="n">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="led-mini">
        {shown.map((r) => (
          <LedgerRow record={r} key={r.id} />
        ))}
        {shown.length === 0 ? (
          <div className="empty">
            <span className="k">{mine.length === 0 ? '这个会话还没有协作记录' : '该动词下没有记录'}</span>
            {mine.length === 0
              ? '协作动作（consult / fork / delegate / handoff）由编排工具发起，落成一笔账后才会出现在这里。'
              : '换一个过滤档看看。'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 用量视图：会话预算卡 + 按成员表（口径与顶栏 chip 同源：会话摘要的 usage 字段）。 */
export function UsageView(): ReactElement {
  const { current, details } = useApp();
  if (!current) return <div className="stream" />;
  const members = details[current.record.id]?.members ?? [];
  const b = current.budget;
  const rows = [...members].sort((a, x) => x.usage.costUsd - a.usage.costUsd);
  const sum = rows.reduce((n, m) => n + m.usage.costUsd, 0);

  return (
    <div className="stream">
      <ViewHead title="本会话用量" note="按成员累计（含各自子树）；金额口径与顶栏 chip 同源" />
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-title">
          <span>预算</span>
          <span className={b.tier === 'frozen' ? 'tag err' : b.tier === 'warning' ? 'tag wait' : 'tag ok'}>
            {b.tier === 'frozen' ? '已熔断' : b.tier === 'warning' ? '接近软线' : '正常'}
          </span>
          <span className="spacer" />
          <span className="mono" style={{ color: 'var(--text-dim)' }}>
            {b.limitedBy ? `受${b.limitedBy === 'global' ? '全局' : b.limitedBy === 'team' ? '团队' : '会话'}预算限制` : ''}
          </span>
        </div>
        <div className="prow">
          <Icon name="wallet" size={16} />
          <span>已花</span>
          <span className="val">{money(b.spentUsd, 3)}</span>
        </div>
        <div className="prow">
          <Icon name="alert" size={16} />
          <span>硬线</span>
          <span className="val">{b.effectiveHardUsd > 0 ? money(b.effectiveHardUsd) : '不设限'}</span>
        </div>
        <div className="prow">
          <Icon name="clock" size={16} />
          <span>成员数</span>
          <span className="val">{rows.length}</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>按成员</span>
          <span className="tag mono">usage.costUsd</span>
        </div>
        <div className="tree">
          {rows.map((m) => (
            <div className="side-row" key={m.path} data-smoke="usage-row" data-path={m.path}>
              <span className="label">{m.displayName}</span>
              <span className="meta">{statusLabel(m.status)}</span>
              <span className="meta mono">
                {m.usage.inputTokens.toLocaleString('en-US')} in · {m.usage.outputTokens.toLocaleString('en-US')} out
              </span>
              <span className="meta mono">{money(m.usage.costUsd, 3)}</span>
            </div>
          ))}
          {rows.length === 0 ? (
            <div className="empty">
              <span className="k">树还没读进来</span>
              会话树走 session.get 懒加载：点开会话时读一次。
            </div>
          ) : null}
        </div>
        <div className="hint" style={{ padding: '6px 10px 4px' }}>
          成员合计 {money(sum, 3)}（会话累计 {money(current.usage.costUsd, 3)}；差额来自升级前的历史与父子重复归因）。
        </div>
      </div>
    </div>
  );
}

/**
 * 「叫人」浮层 —— 单兵 → 团队（原型 s2-solo 的入口按钮 + 本实现新增的选择浮层）。
 *
 * 原型没画浮层的形状（只画了入口），这里按「一屏一件事」的最小形态做：
 * 列真实团队（team.list），选了就 `session.escalate`。
 */
export function EscalateSheet({ onClose }: { onClose: () => void }): ReactElement {
  const { teams, current, escalate } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (teamId: string): Promise<void> => {
    if (!current || busy) return;
    setBusy(true);
    const ok = await escalate(current.record.id, teamId);
    setBusy(false);
    if (ok) onClose();
    else setErr('升级失败，原因见顶栏错误条');
  };

  return (
    <div className="sheet-mask" onClick={onClose} data-smoke="escalate-sheet">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          <span>叫人 · 升级为团队会话</span>
          <span className="spacer" />
          <button className="act" onClick={onClose} title="关闭">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="hint" style={{ padding: '2px 10px 10px' }}>
          已产生的消息不丢（carryMessages）；升级后各成员按自己的分身模式决定能看到多少上下文。
        </div>
        <div className="team-list">
          {teams.entries.map((e) => (
            <button className="side-row" key={e.team.name} onClick={() => void pick(e.team.name)} disabled={busy}>
              <Icon name="users" size={16} />
              <span className="label">{e.team.name}</span>
              <span className="meta">{e.team.members.length} 成员</span>
              <span className="spacer" />
              <Icon name="chevR" size={14} />
            </button>
          ))}
          {teams.entries.length === 0 ? (
            <div className="empty">
              <span className="k">还没有团队</span>
              去「团队管理」建一个，或用原型内置的三张团队卡。
            </div>
          ) : null}
        </div>
        {err ? <div className="hint" style={{ color: 'var(--danger, #b4232a)' }}>{err}</div> : null}
      </div>
    </div>
  );
}

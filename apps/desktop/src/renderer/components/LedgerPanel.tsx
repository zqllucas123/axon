/**
 * 协作账本面板（UX S4）。
 *
 * 一行 = 一笔协作：`发起方 —动作→ 目标`，右侧是裁决态与增量成本。
 * 只有 `adoption === 'pending'` 的行才给「采纳 / 驳回」按钮 ——
 * fork / handoff 是 not_applicable，给按钮等于暗示它们需要被裁决。
 *
 * 裁决策略（人工 / 委派）在头部切换：这是**全局**开关（决策 D2），
 * 不是每条记录的选项，所以放面板头而不是行内。
 */

import type { AdoptionPolicy, LedgerRecord } from '@axon/protocol';

export interface LedgerPanelProps {
  records: LedgerRecord[];
  policy: AdoptionPolicy;
  /** 可作为裁决者的角色名（用于委派下拉）。 */
  arbiterRoles: string[];
  onAdopt: (id: string, adoption: 'adopted' | 'rejected') => void;
  onPolicyChange: (policy: AdoptionPolicy) => void;
}

const ACTION_LABEL: Record<LedgerRecord['action'], string> = {
  consult: '咨询',
  fork: '分叉',
  delegate: '委派',
  handoff: '交接',
};

const ADOPTION_LABEL: Record<LedgerRecord['adoption'], string> = {
  pending: '待裁决',
  adopted: '已采纳',
  rejected: '已驳回',
  not_applicable: '—',
};

const leafOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const usd = (n?: number) => (n === undefined ? '' : `$${n.toFixed(4)}`);

export function LedgerPanel({
  records,
  policy,
  arbiterRoles,
  onAdopt,
  onPolicyChange,
}: LedgerPanelProps) {
  const policyValue = policy.mode === 'human' ? '' : 'arbiterRole' in policy ? policy.arbiterRole : '';
  const pendingCount = records.filter((r) => r.adoption === 'pending').length;

  return (
    <>
      <div className="panel-head">
        <span>协作账本{records.length > 0 && ` · ${records.length}`}</span>
        <select
          className="mini-select"
          data-smoke="adoption-policy"
          value={policyValue}
          title="谁来裁决协作产出。默认人工；委派给 Agent 时，被裁决方及其后代自动没资格。"
          onChange={(e) =>
            onPolicyChange(
              e.target.value === '' ? { mode: 'human' } : { mode: 'delegate', arbiterRole: e.target.value },
            )
          }
        >
          <option value="">人工裁决</option>
          {arbiterRoles.map((r) => (
            <option key={r} value={r}>
              委派 {r}
            </option>
          ))}
        </select>
      </div>
      <div className="ledger" data-smoke="ledger-list" data-pending={pendingCount}>
        {records.length === 0 && <div className="dim">暂无协作记录。Agent 之间一发生协作就会在这里落账。</div>}
        {records.map((r) => (
          <div className="lrec" key={r.id} data-smoke="ledger-row" data-adoption={r.adoption}>
            <div className="lrec-line">
              <span className="act" data-a={r.action}>
                {ACTION_LABEL[r.action]}
              </span>
              <span className="who">
                {leafOf(r.from)} → {leafOf(r.to)}
              </span>
              <span className={`st ${r.status}`}>{r.status === 'open' ? '进行中' : ADOPTION_LABEL[r.adoption]}</span>
            </div>
            {r.summary && <div className="lrec-sum">{r.summary}</div>}
            <div className="lrec-foot">
              <span className="cost">{usd(r.usage?.costUsd)}</span>
              {r.adoptedBy && (
                <span className="by">
                  {r.adoptedBy.kind === 'human' ? '人工裁决' : `由 ${leafOf(r.adoptedBy.path)} 裁决`}
                </span>
              )}
              {r.adoptedNote && <span className="note">{r.adoptedNote}</span>}
              {r.status === 'settled' && r.adoption === 'pending' && (
                <span className="lrec-act">
                  <button className="mini" data-smoke="ledger-adopt" onClick={() => onAdopt(r.id, 'adopted')}>
                    采纳
                  </button>
                  <button className="mini danger" onClick={() => onAdopt(r.id, 'rejected')}>
                    驳回
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

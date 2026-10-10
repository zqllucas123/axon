/**
 * S6 用量 —— 跨会话的花费视图。
 *
 * 本屏只回答「总共花了多少、哪个会话花得最多」。刻意不做的两件事：
 *  - 「花在谁身上」属会话内 S2-usage（本屏每行点进去就是那儿）；
 *  - 不做日/周趋势：协议没有带时间戳的用量序列，画出来就是假数据。
 *
 * 数据源：只读 `session.list` 的会话摘要（`usage` 字段；已结束会话取落盘 `rollup`）
 * 与内存里的 `sessions`，不额外读盘、不新增命令。
 *
 * 文案纪律：累计额是**进程内累计、没有日切**，重启即清零 —— 所以绝不写
 * 「本月已用」这种会被误解成账期的措辞。
 *
 * 预算熔断（软/硬线、三档限额、frozen 终态）已于 2026-10-10 整体下线，
 * 本屏从「预算与用量」缩成纯用量。限额相关的指标卡、档位语义面板与
 * 事件流面板随之删除。
 */

import type { ReactElement } from 'react';
import type { SessionSummary } from '@axon/protocol';
import { useApp } from '../state/store.tsx';
import { money, spendRanking, totalUsage } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';

/** 按会话一行：点进去 = 该会话的「用量」视图（S2-usage），不是又一个仪表盘。 */
function UsageRow({ s, onOpen }: { s: SessionSummary; onOpen: () => void }): ReactElement {
  return (
    <button
      className="list-row"
      data-smoke="usage-session-row"
      data-session={s.record.id}
      onClick={onOpen}
      title="进该会话的「用量」页"
    >
      <span className="grow">
        <span className="t1">{s.record.title}</span>
        <span className="t2">
          {s.team ? s.team.name : '单兵'} · {s.counts.members} 个成员 ·{' '}
          {s.usage.inputTokens.toLocaleString('en-US')} in /{' '}
          {s.usage.outputTokens.toLocaleString('en-US')} out
        </span>
      </span>
      <span className="when">{money(s.usage.costUsd)}</span>
      <Icon name="chevR" size={14} />
    </button>
  );
}

export function S6Usage(): ReactElement {
  const { sessions, openSession, setSessionView, go } = useApp();

  const total = totalUsage(sessions);
  // 只有这一个源：会话摘要（含已结束会话的落盘 rollup）。原先还有一条主进程的
  // `usage.get` 快照，但它只在启动读一次、之后没有任何事件推它 —— 开机后花的钱
  // 永远进不去（屏上「累计已用」挂在 $0.00），随 2026-10-10 预算下线一并撤掉。
  const spentUsd = total.costUsd;

  const live = sessions.filter((s) => s.record.status !== 'closed');
  const closed = sessions.filter((s) => s.record.status === 'closed');
  const closedCost = closed.reduce((n, s) => n + (s.rollup?.usage.costUsd ?? s.usage.costUsd ?? 0), 0);
  const ranking = spendRanking(live).filter((s) => (s.usage.costUsd ?? 0) > 0);

  const teamCost = live.filter((s) => s.team);
  const soloCost = live.filter((s) => !s.team);
  const sum = (list: SessionSummary[]): number => list.reduce((n, s) => n + (s.usage.costUsd ?? 0), 0);

  const toUsage = (id: string): void => {
    openSession(id);
    // openSession 会把视图置回「对话」，所以这一句必须在它之后：本屏的语义是「看花费」。
    setSessionView('usage');
  };

  return (
    <div className="body" data-screen="s6">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>用量</h1>
            <p>
              <b>全局口径</b>：跨会话的累计花费。单个任务花了多少、花在谁身上，看那个会话自己的「用量」页。
            </p>
          </div>

          {/* ── 三指标 ── */}
          <div className="grid3">
            <div className="stat" data-smoke="usage-total">
              <div className="k">累计已用</div>
              <div className="v">{money(spentUsd)}</div>
              <div className="s">{live.length} 个进行中会话 · 进程内累计（无日切，重启清零）</div>
            </div>
            <div className="stat" data-smoke="usage-tokens">
              <div className="k">累计 token</div>
              <div className="v">
                {total.inputTokens.toLocaleString('en-US')} /{' '}
                {total.outputTokens.toLocaleString('en-US')}
              </div>
              <div className="s">输入 / 输出</div>
            </div>
            <div className="stat" data-smoke="usage-closed">
              <div className="k">已结束会话</div>
              <div className="v">{money(closedCost)}</div>
              <div className="s">{closed.length} 个 · 来自落盘 rollup 汇总</div>
            </div>
          </div>

          {/* ── 按会话 ── */}
          <div className="side-section" style={{ paddingLeft: 0, marginTop: 10 }}>
            按会话
          </div>
          {ranking.length === 0 && closed.length === 0 ? (
            <div className="empty">
              <span className="k">还没有会话产生花费</span>
              起一个任务之后，这里按累计花费从高到低排；点任意一行进那个会话的「用量」页。
            </div>
          ) : (
            <div className="list">
              {ranking.map((s) => (
                <UsageRow key={s.record.id} s={s} onOpen={() => toUsage(s.record.id)} />
              ))}
              {closed.length > 0 ? (
                <button className="list-row" data-smoke="usage-closed-row" onClick={() => go('s7')}>
                  <span className="grow">
                    <span className="t1">已结束的 {closed.length} 个会话</span>
                    <span className="t2">历史合计 · 来自落盘 rollup 汇总（不为算钱读会话树）</span>
                  </span>
                  <span className="when">{money(closedCost)}</span>
                  <Icon name="chevR" size={14} />
                </button>
              ) : null}
            </div>
          )}

          {/* ── 成本构成（降级版：只按「组队与否」分，不做协作动作切片，见台账 D-5） ── */}
          <div className="side-section" style={{ paddingLeft: 0, marginTop: 22 }}>
            成本构成（跨会话）
          </div>
          <div className="list">
            <div className="list-row">
              <span className="grow">
                <span className="t1">团队会话</span>
                <span className="t2">{teamCost.length} 个进行中</span>
              </span>
              <span className="when">{money(sum(teamCost))}</span>
            </div>
            <div className="list-row">
              <span className="grow">
                <span className="t1">单兵会话</span>
                <span className="t2">{soloCost.length} 个进行中</span>
              </span>
              <span className="when">{money(sum(soloCost))}</span>
            </div>
            <div className="list-row">
              <span className="grow">
                <span className="t1">单次均价</span>
                <span className="t2">
                  团队 {teamCost.length ? money(sum(teamCost) / teamCost.length) : '—'} · 单兵{' '}
                  {soloCost.length ? money(sum(soloCost) / soloCost.length) : '—'}
                </span>
              </span>
              <span className="when">
                {teamCost.length && soloCost.length && sum(soloCost) > 0
                  ? `${(sum(teamCost) / teamCost.length / (sum(soloCost) / soloCost.length)).toFixed(1)}×`
                  : '—'}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

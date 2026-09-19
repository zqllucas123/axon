/**
 * S6 预算与用量 —— 跨会话的花费视图（原型 `docs/ux/mockups/s6-budget.html`）。
 *
 * 所有权（MU-3 §7.0）：本文件由并行会话 **W-B** 实现。
 *
 * 屏的定位（00 §S6 / MU-3 §三.2）：**全局口径的只读屏**。
 *  - 「花在谁身上」属会话内 S2-usage（本屏每行点进去就是那儿）；
 *  - 「改限额」属设置窗 S8（本屏只给一个入口按钮，不在这里编辑）。
 *
 * 数据只用三样，全部已在 store 内存里：
 *  - `budget`（`budget.get` 快照 + `budget.warning/frozen` 事件修正）：全局档位与软硬线；
 *  - `budgetAlert`（store 的遗留口，MU-2 起无人消费，本屏接手）：最近一次跃迁现场；
 *  - `sessions`（`session.list`，含 `usage` / `budget` / `rollup`）。
 *
 * **懒加载纪律（M5 前提，MU-3 R-7）**：本屏一次 `session.get` 都不许发 ——
 * 列表数字全部取自 `SessionSummary`（未装载的会话由主进程用落盘 rollup 填），
 * 验收时 `storage.status.loadedCount` 进本屏前后必须不变。
 *
 * 文案纪律（拍板 P-8 / §1.2-5）：`BudgetGuard` 是进程内累计、**没有日切**，
 * 全屏一律写「累计」，不出现「今日」「/日」；协议给不出的三样东西整块删掉而不是填假值：
 *  - 「其中协作开销 $X（N%）」：用量未按协作动作切片（台账 D-5）；
 *  - 「19 轮 / 12 轮」：`SessionCounts` 无轮数字段（台账 D-6）；
 *  - `.ava-stack` 头像叠层：`SessionTeamRef` 没有成员名单（沿用 MU-2 的「团队名首字 + 成员数」）。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { BudgetTier, SessionSummary } from '@axon/protocol';
import { useApp, type BudgetAlert } from '../state/store.tsx';
import { money, spendRanking, strictestTier, totalUsage, fmtTime } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';

/** 档位 → tag 类名（与 S1/S2 的状态色同源：warning 用 run 的琥珀，frozen 用 err 的红）。 */
const TIER_TAG: Record<BudgetTier, string> = { ok: 'tag ok', warning: 'tag run', frozen: 'tag err' };
/** 档位 → 语义色（stat 的大字用）。 */
const TIER_COLOR: Record<BudgetTier, string> = {
  ok: 'var(--sem-ok)',
  warning: 'var(--sem-run)',
  frozen: 'var(--sem-err)',
};
/** `limitedBy` 的三层中文名（SessionBudgetView.limitedBy）。 */
const LAYER: Record<'global' | 'team' | 'session', string> = {
  global: '全局',
  team: '团队',
  session: '会话',
};

/** 百分比：上限为 0（= 不设限）时没有百分比可言，返回 null 而不是 0。 */
function pct(spent: number, limit: number): number | null {
  if (!(limit > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((spent / limit) * 100)));
}

/** 「$已用 / $有效上限」；上限为 0 时只给已用（`hard <= 0` 与「不设限」同义，见 session.ts）。 */
function spendOf(s: SessionSummary): string {
  const hard = s.budget.effectiveHardUsd;
  return hard > 0 ? `${money(s.usage.costUsd)} / ${money(hard)}` : money(s.usage.costUsd);
}

/**
 * 告警卡：有会话（或全局）进了 warning/frozen 才出现。
 *
 * 叙述句必须回答 G9.2 的三问 ——「为什么冻结 / 已用多少 / 上限多少」，
 * 而不是只闪一条 banner（那正是 MU-2 下线掉的 `.budget` 横幅）。
 */
function AlertCard({
  tier,
  worst,
  spentUsd,
  softUsd,
  hardUsd,
}: {
  tier: BudgetTier;
  worst: SessionSummary | undefined;
  spentUsd: number;
  softUsd: number;
  hardUsd: number;
}): ReactElement {
  const p = pct(spentUsd, hardUsd);
  const frozen = tier === 'frozen';
  return (
    <div className="card attn" style={{ marginBottom: 18 }} data-smoke="budget-alert" data-tier={tier}>
      <div className="card-head">
        <Icon name="alert" size={16} />
        <span className="name">{worst ? `会话「${worst.record.title}」已进入 ${tier} 档` : `全局预算已进入 ${tier} 档`}</span>
        <span className="spacer" />
        <span className={TIER_TAG[tier]}>{tier}</span>
      </div>
      <div className="card-body">
        累计已用 <b>{money(spentUsd)}</b>
        {hardUsd > 0 ? ` / ${money(hardUsd)}（全局硬线）` : '（全局硬线未设，熔断关闭）'}
        {worst
          ? `；其中「${worst.record.title}」已用 ${money(worst.usage.costUsd)}${
              worst.budget.effectiveSoftUsd > 0 ? `，超过它自己的软线 ${money(worst.budget.effectiveSoftUsd)}` : ''
            }${worst.budget.limitedBy ? `（上限来自${LAYER[worst.budget.limitedBy]}档）` : ''}。`
          : '。'}
        {frozen
          ? ' frozen 是终态：该会话所有成员停止新轮次，且当前没有恢复通道（G9.2）。'
          : ' 到硬线后进入 frozen：该会话所有成员停止新轮次，且当前没有恢复通道（G9.2）。'}
        <div className={frozen ? 'bar danger' : 'bar warn'} style={{ marginTop: 12 }}>
          <span style={{ width: `${p ?? 0}%` }} />
        </div>
        <div className="hint">
          {hardUsd > 0 ? `全局硬线 ${money(hardUsd)} · 已用 ${p}%` : '全局未设硬线'}
          {softUsd > 0 ? ` · 软线 ${money(softUsd)}` : ''}
          {worst ? '；冒烟的是单个会话，不是总额 —— 这就是预算要分三层的理由。' : ''}
        </div>
      </div>
    </div>
  );
}

/** 按会话一行：点进去 = 该会话的「用量」视图（S2-usage），不是又一个仪表盘。 */
function BudgetRow({ s, onOpen }: { s: SessionSummary; onOpen: () => void }): ReactElement {
  const team = s.team;
  const b = s.budget;
  return (
    <button
      className="list-row"
      data-smoke="budget-session-row"
      data-session={s.record.id}
      data-tier={b.tier}
      onClick={onOpen}
    >
      {/* 原型这里是 .ava-stack 头像叠层；SessionTeamRef 没有成员名单 ⇒ 沿用 MU-2 的团队首字 + 成员数 */}
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
          {b.tier === 'ok' ? null : <span className={TIER_TAG[b.tier]}>{b.tier}</span>}
        </span>
        <span className="t2">
          {s.counts.members} 成员
          {b.effectiveSoftUsd > 0 ? ` · 软线 ${money(b.effectiveSoftUsd)}` : ''}
          {b.effectiveHardUsd > 0 ? ` · 硬线 ${money(b.effectiveHardUsd)}` : ' · 不设限'}
          {b.limitedBy ? ` · 受${LAYER[b.limitedBy]}档限制` : ''}
        </span>
      </span>
      <span className="when">{spendOf(s)}</span>
      <Icon name="chevR" size={14} />
    </button>
  );
}

/**
 * 「最近预算事件」的本地流水。
 *
 * 协议只有两条**事件**（budget.warning/frozen）与一份**快照**（budget.get），
 * 没有事件历史命令 ⇒ 这份列表天生易失：它只记本屏打开之后收到的跃迁，
 * 切屏或刷新即清空。这一点必须写在屏上，否则用户会把它当史料。
 */
interface AlertEntry {
  alert: BudgetAlert;
  /** 观测时刻；进本屏之前就发生的那条没有时刻（事件负载不带时间戳）。 */
  at?: number;
  seq: number;
}

function useAlertFeed(alert: BudgetAlert | null): AlertEntry[] {
  const [feed, setFeed] = useState<AlertEntry[]>([]);
  const mounted = useRef(false);
  useEffect(() => {
    const fresh = mounted.current;
    mounted.current = true;
    if (!alert) return;
    setFeed((prev) => [{ alert, ...(fresh ? { at: Date.now() } : {}), seq: prev.length }, ...prev].slice(0, 6));
  }, [alert]);
  return feed;
}

export function S6Budget(): ReactElement {
  const { budget, sessions, budgetAlert, openSession, setSessionView, go, openSettings } = useApp();

  const total = totalUsage(sessions);
  // 累计已用：优先用熔断器的累计（它才是 frozen 的判据）；快照还没到就先用会话合计兜底。
  const spentUsd = budget?.spentUsd ?? total.costUsd;
  const softUsd = budget?.softUsd ?? 0;
  const hardUsd = budget?.hardUsd ?? 0;

  // 进行中 / 已结束两组：排行只列进行中的，已结束的折成末尾一行历史合计。
  const live = sessions.filter((s) => s.record.status !== 'closed');
  const closed = sessions.filter((s) => s.record.status === 'closed');
  const ranking = spendRanking(live);
  // 历史合计只认落盘 rollup（懒加载会话的唯一数字来源）；已装载的会话 rollup 缺省时用实时摘要兜底。
  const closedCost = closed.reduce((n, s) => n + (s.rollup?.usage.costUsd ?? s.usage.costUsd ?? 0), 0);

  const worst = strictestTier(live);
  // 全局档位与「最严会话档位」取更严者：全局 frozen 时没有哪个会话还能跑。
  const globalTier: BudgetTier = budget?.state ?? 'ok';
  const rank: Record<BudgetTier, number> = { ok: 0, warning: 1, frozen: 2 };
  const alertTier: BudgetTier = rank[globalTier] > rank[worst.tier] ? globalTier : worst.tier;

  // 三层限额面板：哪一层在真正管事，靠每个会话的 limitedBy 数出来（不编）。
  const byLayer = (k: 'global' | 'team' | 'session'): number =>
    live.filter((s) => s.budget.limitedBy === k).length;

  const teamCost = live.filter((s) => s.record.executor !== 'engine');
  const soloCost = live.filter((s) => s.record.executor === 'engine');
  const sum = (list: SessionSummary[]): number => list.reduce((n, s) => n + (s.usage.costUsd ?? 0), 0);

  const feed = useAlertFeed(budgetAlert);
  const titleOf = (id?: string): string | undefined =>
    id ? (sessions.find((s) => s.record.id === id)?.record.title ?? id) : undefined;

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
            <h1>预算与用量</h1>
            <p>
              <b>全局口径</b>：跨会话的累计额与档位。单个任务花了多少、花在谁身上，看那个会话自己的「用量」页；
              改限额在设置窗。
            </p>
          </div>

          {alertTier === 'ok' ? null : (
            <AlertCard
              tier={alertTier}
              worst={worst.session}
              spentUsd={spentUsd}
              softUsd={softUsd}
              hardUsd={hardUsd}
            />
          )}

          {/* ── 三指标 ── */}
          <div className="grid3">
            <div className="stat" data-smoke="budget-total">
              <div className="k">累计已用</div>
              <div className="v">{money(spentUsd)}</div>
              <div className="s">
                {live.length} 个进行中会话 · 进程内累计（无日切，重启清零）
              </div>
            </div>
            <div className="stat" data-smoke="budget-limits">
              <div className="k">全局软线 / 硬线</div>
              <div className="v">
                {softUsd > 0 ? money(softUsd) : '—'} / {hardUsd > 0 ? money(hardUsd) : '—'}
              </div>
              <div className="s">
                {budget?.disabled ? '硬线 ≤ 0 ⇒ 熔断关闭' : '来自 BudgetGuard 配置（config.json）'}
              </div>
            </div>
            <div className="stat" data-smoke="budget-tier" data-tier={worst.tier}>
              <div className="k">最严重的会话档位</div>
              <div className="v" style={{ color: TIER_COLOR[worst.tier] }}>
                {worst.tier}
              </div>
              <div className="s">
                {worst.session ? `「${worst.session.record.title}」· ` : ''}ok → warning → frozen（单向）
              </div>
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
                <BudgetRow key={s.record.id} s={s} onOpen={() => toUsage(s.record.id)} />
              ))}
              {closed.length > 0 ? (
                <button className="list-row" data-smoke="budget-closed" onClick={() => go('s7')}>
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
          <div className="grid2">
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
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <Icon name="wallet" size={16} />
                <span className="name">到了线会怎样</span>
              </div>
              <div className="card-body">
                <p style={{ margin: '0 0 8px' }}>
                  过<b>软线</b>进 <code>warning</code>：只是提醒，成员照常跑。
                </p>
                <p style={{ margin: '0 0 8px' }}>
                  过<b>硬线</b>进 <code>frozen</code>：该会话所有成员停止新轮次，且是<b>终态</b>——
                  当前没有「解冻」命令（G9.2），只能调高上限后新起会话。
                </p>
                <p style={{ margin: 0 }}>
                  本屏只读。上限（全局软/硬线）在设置窗改，团队与会话档在团队管理与建会话时定。
                </p>
              </div>
              <div className="card-foot">
                <span className="spacer" />
                <button className="btn sm ghost" data-smoke="budget-to-settings" onClick={() => openSettings()}>
                  <Icon name="settings" size={14} />
                  去设置改全局上限
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">
            <span>档位语义</span>
          </div>
          <div className="prow sub">
            <span className="sdot done" />
            <span>ok</span>
            <span className="val">未过软线</span>
          </div>
          <div className="prow sub">
            <span className="sdot run" />
            <span>warning</span>
            <span className="val">过软线，仍可跑</span>
          </div>
          <div className="prow sub">
            <span className="sdot err" />
            <span>frozen</span>
            <span className="val">停新轮次，终态</span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>三层限额</span>
          </div>
          <div className="prow">
            <Icon name="wallet" size={14} />
            <span>全局</span>
            <span className="val">
              {softUsd > 0 ? money(softUsd) : '—'} / {hardUsd > 0 ? money(hardUsd) : '不设限'}
            </span>
          </div>
          <div className="prow">
            <Icon name="users" size={14} />
            <span>团队默认</span>
            <span className="val">{byLayer('team') ? `${byLayer('team')} 个会话受限` : '各队自定'}</span>
          </div>
          <div className="prow">
            <Icon name="folder" size={14} />
            <span>单会话</span>
            <span className="val">
              {byLayer('session') ? `${byLayer('session')} 个会话自设` : '继承团队，可下调'}
            </span>
          </div>
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            三层取更严者生效（MU-1 已交付：全局 <code>config.json</code> / 团队档 / 会话档）；
            每个会话生效的是哪一层，见上面那行的「受…档限制」。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>最近预算事件</span>
          </div>
          {feed.length === 0 ? (
            <div className="empty" style={{ padding: '2px 10px 8px' }}>
              <span className="k">本次运行期还没有跃迁</span>
              档位变化（warning / frozen）到达时出现在这里。
            </div>
          ) : (
            feed.map((e) => (
              <div className="prow sub" key={e.seq} data-smoke="budget-event" data-state={e.alert.state}>
                <span className={e.alert.state === 'frozen' ? 'sdot err' : 'sdot run'} />
                <span>
                  budget.{e.alert.state}
                  {e.alert.scope === 'session' ? ` · ${titleOf(e.alert.sessionId) ?? '某会话'}` : ' · 全局'}
                </span>
                <span className="val">{e.at ? fmtTime(e.at) : money(e.alert.spentUsd)}</span>
              </div>
            ))
          )}
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            易失列表：协议只有两条事件与一份快照，没有事件历史 ⇒ 这里只记<b>本屏打开之后</b>收到的跃迁，
            切屏或刷新即清空。没有时刻的那条是进本屏前就已发生的（事件负载不带时间戳）。
          </div>
        </div>
      </aside>
    </div>
  );
}

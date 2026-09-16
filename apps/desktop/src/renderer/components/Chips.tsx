/**
 * 顶栏三枚 chip（原型 shell.js:statusChipsHTML）。
 *
 * 硬规矩（ux 01 §2.1-④）：需要你决策的东西永远有 chip，且 chip **随屏切作用域** ——
 * 会话屏读本会话口径（counts/budget），全局屏读跨会话口径，两套数字永不混用。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { globalChips, sessionChips } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';

function money(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`;
}

export function Chips(): ReactElement {
  const { screen, current, sessions, pending, budget } = useApp();
  const inSession = screen === 's2';

  const spend = inSession
    ? {
        label: '本会话',
        used: current?.budget.spentUsd ?? 0,
        hard: current?.budget.effectiveHardUsd ?? 0,
        tier: current?.budget.tier ?? 'ok',
        limitedBy: current?.budget.limitedBy,
      }
    : {
        label: '今日',
        used: budget?.spentUsd ?? 0,
        hard: budget?.hardUsd ?? 0,
        tier: budget?.state ?? 'ok',
        limitedBy: undefined as 'global' | 'team' | 'session' | undefined,
      };
  const hardText = spend.hard > 0 ? money(spend.hard) : '不设限';
  const budgetCls = spend.tier === 'frozen' ? 'chip danger' : spend.tier === 'warning' ? 'chip warn' : 'chip';
  const limitedByText =
    spend.limitedBy === 'team' ? '受团队预算限制' : spend.limitedBy === 'session' ? '受本会话预算限制' : undefined;

  const g = globalChips({ sessions, pending });
  // 会话屏的待批数取**实时值**（审批卡与 chip 必须同一口径，counts 会节流滞后一拍）。
  const livePending =
    inSession && current
      ? pending.filter((p) => p.state === 'pending' && p.sessionId === current.record.id).length
      : undefined;
  const pendingN = inSession ? sessionChips(current, livePending).pending : g.pendingAll;
  const solo = inSession && current !== null && !current.team;
  const ledgerN = inSession ? (current?.counts.ledger ?? 0) : g.activeSessions;

  return (
    <div className="status-chips">
      <span className={budgetCls} title={limitedByText}>
        <Icon name="wallet" size={14} />
        <span>
          {spend.label} {money(spend.used)} / {hardText}
        </span>
      </span>

      <span className={pendingN > 0 ? 'chip danger' : 'chip'}>
        <Icon name="shield" size={14} />
        <span>
          待批 {pendingN}
          {inSession ? '' : '（全部会话）'}
        </span>
      </span>

      {inSession ? (
        <span
          className="chip plain"
          style={solo || ledgerN === 0 ? { opacity: 0.45 } : undefined}
          title={solo ? '单兵会话没有协作，自然没有账本' : '本会话账本'}
        >
          <Icon name="book" size={14} />
          <span>本会话账本 {ledgerN === 0 ? '—' : ledgerN}</span>
        </span>
      ) : (
        <span className="chip plain" title="进行中的会话数">
          <Icon name="layers" size={14} />
          <span>活跃会话 {ledgerN}</span>
        </span>
      )}
    </div>
  );
}

/**
 * S6 预算与用量 —— 跨会话的花费视图（原型 `docs/ux/mockups/s6-budget.html`）。
 *
 * 所有权（MU-3 §7.0）：本文件由并行会话 **W-B** 实现；主线只在切片 2.5 放下骨架。
 *
 * 已经备好的原料：
 *  - `budget`（`budget.get` + `budget.warning/frozen` 事件）：全局档位与软硬线；
 *  - `budgetAlert`（store）：最近一次跃迁现场（MU-2 起就在，一直没人消费，S6 接手）；
 *  - `sessions`：每会话 `usage` 与 `budget`（**已在内存**，不要为了用量去 `session.get`
 *    —— 那会打穿 M5 懒加载，验收时用 `storage.loadedCount` 反向断言，见 R-7）；
 *  - `spendRanking` / `strictestTier` / `totalUsage` / `money`（selectors）。
 *
 * 文案纪律（拍板 P-8）：`BudgetGuard` **没有日切**，全屏一律写「累计」，不许出现「今日」。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { money, totalUsage } from '../state/selectors.ts';

export function S6Budget(): ReactElement {
  const { budget, sessions } = useApp();
  const total = totalUsage(sessions);

  return (
    <div className="body" data-screen="s6">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>预算与用量</h1>
          </div>
          <div className="empty" data-smoke="budget-placeholder">
            <span className="k">累计花费 {money(budget?.spentUsd ?? total.costUsd)}</span>
            本屏的完整实现见 MU-3 切片 6。
          </div>
        </div>
      </section>
    </div>
  );
}

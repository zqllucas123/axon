/**
 * S5 收件箱 —— 跨会话的待办聚合（原型 `docs/ux/mockups/s5-inbox.html`）。
 *
 * 所有权（MU-3 §7.0）：本文件由并行会话 **W-A** 实现；主线只在切片 2.5 放下骨架。
 *
 * 已经备好的原料（不需要新增协议）：
 *  - `pending`（store）：`pending.list` + `approval.request` 事件，含穿透链 chain；
 *  - `resolvedFeed`（store 派生）：**本次运行期内**已处理的流水（拍板 P-5：
 *    `ApprovalBroker` 结算即删，协议没有 `pending.history`，所以刷新后这段会空）；
 *  - `splitPending` / `blockedCount`（selectors）：分段与影响面口径；
 *  - `<ApprovalCard variant="inbox">`（components/parts）：与 S2 流内**同一张卡**。
 *
 * 纪律：缺口整块不渲染（不做选项式提问 —— 拍板 P-6，`question.request` 全仓无发射方）。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { splitPending } from '../state/selectors.ts';
import { ApprovalCard } from './parts/ApprovalCard.tsx';

export function S5Inbox(): ReactElement {
  const { pending, sessions, openSession } = useApp();
  const { waiting } = splitPending(pending);
  const titleOf = (sid: string): string =>
    sessions.find((s) => s.record.id === sid)?.record.title ?? sid;

  return (
    <div className="body" data-screen="s5">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>收件箱</h1>
          </div>
          {waiting.length === 0 ? (
            <div className="empty" data-smoke="inbox-empty">
              <span className="k">没有待处理的事</span>
              需要你批准或回答时，会出现在这里，并同时出现在对应会话里。
            </div>
          ) : (
            waiting.map((p) => (
              <ApprovalCard
                key={p.requestId}
                request={p}
                variant="inbox"
                sessionTitle={titleOf(p.sessionId)}
                onOpenSession={() => openSession(p.sessionId)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

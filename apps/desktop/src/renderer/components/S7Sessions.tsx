/**
 * S7 会话恢复 —— 落盘会话的清单与存储实况（原型 `docs/ux/mockups/s7-sessions.html`）。
 *
 * 所有权（MU-3 §7.0）：本文件由并行会话 **W-C** 实现；主线只在切片 2.5 放下骨架。
 *
 * 已经备好的原料：
 *  - `sessions`：`session.list` 的摘要，MU-3 E-1 起**带 `rollup`** ——
 *    「上次中断」那行字的唯一真实来源是 `rollup.interruptedAt`（别用 updatedAt 假装）；
 *  - `storage`：`storage.status` 的 root / sessionCount / loadedCount / issues；
 *  - `splitRecoverable` / `interruptedAt` / `fmtTime` / `relDay`（selectors）。
 *
 * 纪律：本屏**只读摘要**。点「继续」= `openSession`（它才允许触发 `session.get`），
 * 渲染列表本身绝不能让 `loadedCount` 增长（R-7 反向断言）。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { splitRecoverable } from '../state/selectors.ts';

export function S7Sessions(): ReactElement {
  const { sessions, storage } = useApp();
  const { recoverable } = splitRecoverable(sessions);

  return (
    <div className="body" data-screen="s7">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>会话恢复</h1>
          </div>
          <div className="empty" data-smoke="sessions-placeholder">
            <span className="k">
              落盘 {storage?.sessionCount ?? 0} 个会话 · 可恢复 {recoverable.length} 个
            </span>
            本屏的完整实现见 MU-3 切片 7。
          </div>
        </div>
      </section>
    </div>
  );
}

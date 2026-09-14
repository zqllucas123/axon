/**
 * 审批收件箱（UX S5）—— 挂起的 HITL 请求。
 *
 * 薄壳：这里不判断「该不该批」，只把主进程穿透父链之后**仍然落到人头上**的
 * 请求摆出来。能被父代批的请求根本不会走到这个组件（ApprovalBroker 已消化）。
 *
 * 显示 `chain` 是刻意的：深层子 Agent 的请求冒到人面前时，人需要知道
 * 「这是替谁问的、经过了谁」，否则一个 /root/planner-1/developer-2 的
 * 危险操作看上去像是凭空冒出来的。
 */

import type { PendingRequest } from '@axon/protocol';

export interface ApprovalInboxProps {
  pending: PendingRequest[];
  onRespond: (requestId: string, approved: boolean) => void;
}

const leafOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

export function ApprovalInbox({ pending, onRespond }: ApprovalInboxProps) {
  if (pending.length === 0) return null;
  const req = pending[0]!;
  return (
    <div className="approval" data-smoke="approval-banner">
      <div className="approval-main">
        <b>需要你批准</b>
        <span className="chain">
          {/* 穿透路径：origin 在最左，root 在最右 */}
          {req.chain.map(leafOf).join(' → ')}
        </span>
        <span className="msg">{req.message}</span>
        {pending.length > 1 && <span className="more">还有 {pending.length - 1} 条待办</span>}
      </div>
      <div className="approval-act">
        <button
          className="mini primary"
          data-smoke="approval-approve"
          onClick={() => onRespond(req.requestId, true)}
        >
          批准
        </button>
        <button
          className="mini danger"
          data-smoke="approval-deny"
          onClick={() => onRespond(req.requestId, false)}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

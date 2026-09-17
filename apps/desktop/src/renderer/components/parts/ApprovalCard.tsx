/**
 * 审批/提问卡 —— S2 会话流与 S5 收件箱**共用同一张卡**（MU-3 切片 2.5 从
 * `MessageStream.tsx` 原样抽出）。
 *
 * 为什么必须共用而不是各画一张：同一条待办在两个屏上长得不一样，用户就会
 * 怀疑那是两件事。UX `00-信息架构与屏幕清单.md` 的 I-* 意图表也是按「一条待办
 * 一个处理动作」编号的。
 *
 * 两个 variant 只差外围信息，处理动作完全一致：
 *  - `stream`（S2 流内，默认）：不显示会话名 —— 你已经在这个会话里了；
 *  - `inbox`（S5 收件箱）：显示会话名与发起者，因为收件箱是跨会话的。
 *
 * 两个**扩展点**（MU-3 阶段 1 回收 W-A 的需求，由主线补）—— 为什么是口子而不是
 * 再开一个 variant：卡头的等待标、卡体的附加块，属于「调用方才知道该填什么」的
 * 信息（等待时长需要一个秒级 tick，cwd 需要查会话）。把它们塞进卡片内部就要让卡片
 * 去读它不该读的 store，也会把「每秒重渲染」的代价强加给 S2。两个口子都有默认值，
 * 不传时与抽件前的形态逐像素一致（S2 零变化，四个 data-smoke 钩子不动）。
 *
 * 抽取时**不改任何外观与 data-smoke 钩子**（既有冒烟依赖 `approval-banner` /
 * `approval-approve` / `approval-reject` / `question-answer` 四个钩子）。
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import type { PendingRequest } from '@axon/protocol';
import { useApp } from '../../state/store.tsx';
import { Icon } from '../../icons.tsx';

export type ApprovalVariant = 'stream' | 'inbox';

/** 穿透链：origin → … → root → 你（`PendingRequest.chain` 是真实路径数组）。 */
export function Chain({ chain }: { chain: string[] }): ReactElement {
  const { agents } = useApp();
  return (
    <div className="chain" style={{ marginTop: 10 }}>
      {chain.map((p) => (
        <span key={p} style={{ display: 'contents' }}>
          <span className="node">{agents[p]?.displayName ?? p}</span>
          <span className="arr">→</span>
        </span>
      ))}
      <span className="node you">你</span>
    </div>
  );
}

/** 提问卡尾（`question.respond`）：输入框 + 提交（Enter 提交）。 */
function QuestionFoot({ request }: { request: PendingRequest }): ReactElement {
  const { answerQuestion } = useApp();
  const [answer, setAnswer] = useState('');
  const submit = () => {
    const t = answer.trim();
    if (!t) return;
    void answerQuestion(request.requestId, t);
  };
  return (
    <div className="card-foot">
      <input
        className="inp"
        value={answer}
        placeholder="回答后回车提交…"
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        style={{ flex: 1 }}
      />
      <button className="btn sm primary" data-smoke="question-answer" onClick={submit} disabled={!answer.trim()}>
        <Icon name="check" size={14} />
        提交
      </button>
    </div>
  );
}

export function ApprovalCard({
  request,
  variant = 'stream',
  /** 收件箱用：这条待办属于哪个会话（标题由调用方解，卡片不查 store 找会话）。 */
  sessionTitle,
  /** 收件箱用：点标题跳进该会话。 */
  onOpenSession,
  /**
   * 卡头右侧的状态标，默认「等待中」。
   * S5 传入带秒表的「等待 3′12 / 超时 10′」：那个数字需要调用方自己的 tick，
   * 卡片不该为了它内置一个定时器（S2 流内几十张卡片各起一个定时器是灾难）。
   */
  headTag,
  /**
   * 插在卡体末尾（消息与穿透链之后）的附加内容。
   * S5 用它放「发起者 + 完整命令与工作目录」折叠块 —— 那些信息要查会话拿 cwd，
   * 是收件箱的上下文，不属于卡片本身。
   */
  children,
}: {
  request: PendingRequest;
  variant?: ApprovalVariant;
  sessionTitle?: string;
  onOpenSession?: () => void;
  headTag?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const { respondApproval } = useApp();
  const args = request.args ? JSON.stringify(request.args) : '';
  const isQuestion = request.kind === 'question';
  return (
    <div className="card attn" data-smoke="approval-banner" data-request={request.requestId}>
      <div className="card-head">
        <Icon name={isQuestion ? 'help' : 'shield'} size={16} />
        <span className="name">{isQuestion ? '需要你回答' : '需要你批准'}</span>
        {request.tool ? (
          <span className="path">{args ? `${request.tool} · ${args.slice(0, 80)}` : request.tool}</span>
        ) : null}
        <span className="spacer" />
        {variant === 'inbox' && sessionTitle ? (
          <button className="tag" onClick={onOpenSession} data-smoke="inbox-open-session">
            {sessionTitle}
          </button>
        ) : null}
        {headTag ?? <span className="tag run">等待中</span>}
      </div>
      <div className="card-body">
        {request.message}
        {request.chain.length > 1 ? <Chain chain={request.chain} /> : null}
        {children}
      </div>
      {isQuestion ? (
        <QuestionFoot request={request} />
      ) : (
        <div className="card-foot">
          <span className="spacer" />
          <button className="btn sm danger" data-smoke="approval-reject" onClick={() => void respondApproval(request.requestId, false)}>
            <Icon name="x" size={14} />
            拒绝
          </button>
          <button className="btn sm primary" data-smoke="approval-approve" onClick={() => void respondApproval(request.requestId, true)}>
            <Icon name="check" size={14} />
            批准一次
          </button>
        </div>
      )}
    </div>
  );
}

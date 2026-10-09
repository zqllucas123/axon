/**
 * S2 消息流（MU-2 切片 3）。
 *
 * 数据全部真实，三个来源：
 *  - `agent.messages` 回放（打开会话时一次）→ `store.streams[path]`
 *  - `agent.message.* / agent.tool.* / agent.turn.end` 事件增量 → 同上
 *  - `pending.list` + `approval.request`（本会话待批）→ 流尾的审批/提问卡
 *
 * 缺口纪律（MU-2 §4.6）：拿不到的一律**整块不渲染**，不许填假数据 ——
 *  ① 气泡不渲染 `.bubble-meta`（`MessageLike` 无 `at`，没有真实时间戳）；
 *  ② 助手正文尾不渲染逐条 cost（无消息级 usage，成本只在活动行按回合显示）；
 *  ③ 不渲染 thinking 折叠块（思考流形状未定，见台账 B-2）；
 *  ④ 不渲染流式光标/增量（没接 delta，助手消息整块出现，见台账 B-1）。
 *
 * L3 纪律：本组件只做「渲染 + 发意图」，任何状态判断都在 `state/selectors.ts`。
 */

import { useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import { inlineSegments, parseProse, type StreamItem } from '../state/selectors.ts';
// 审批/提问卡与 S5 收件箱共用一张（MU-3 切片 2.5 抽到 parts/）。
import { ApprovalCard } from './parts/ApprovalCard.tsx';

/** 长输出截断（原型只有固定高度，滚动查看；截断避免 DOM 里塞整篇文件）。 */
const CLIP = 1600;

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}\n…（已截断 ${text.length - CLIP} 字符）` : text;
}

/**
 * 工具四态 → 前置状态点。复用 components.css 既有 `.dot-*` 家族（与 S2 子任务面板同
 * 一套语义色）：绿=成功 / 红=失败 / 蓝脉冲=进行中 / 灰=未记录结果。只上色不写字，
 * 文字进 title/aria（去掉右侧 `ok · N 行` 标签，见截图反馈）。
 */
const TOOL_STATE: Record<'running' | 'ok' | 'err' | 'lost', { dot: string; label: string }> = {
  ok: { dot: 'dot dot-done', label: '执行成功' },
  err: { dot: 'dot dot-failed', label: '执行失败' },
  running: { dot: 'dot dot-running', label: '执行中' },
  lost: { dot: 'dot dot-idle', label: '未记录结果' },
};

/** 行内 `code` 片段（原型正文里的 <code>）。 */
function Inline({ text }: { text: string; key?: string }): ReactElement {
  return (
    <>
      {inlineSegments(text).map((seg, i) =>
        seg.code ? <code key={i}>{seg.text}</code> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

/** 助手正文（段落 + 列表，对齐原型 `.assistant > p / ul > li`）。 */
function Prose({ text }: { text: string }): ReactElement {
  return (
    <>
      {parseProse(text).map((block, i) =>
        block.kind === 'p' ? (
          <p key={i}>
            <Inline text={block.text} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((li, j) => (
              <li key={j}>
                <Inline text={li} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

function ToolCard({ item }: { item: Extract<StreamItem, { kind: 'tool' }> }): ReactElement {
  const { focusPath, agents, interrupt } = useApp();
  /**
   * 回放时找不到 toolResult 的调用，要用**活快照**校正一次：如果这个成员此刻还在跑
   * 或者还在等人批，那它就是「进行中」，不是「未记录结果」（实测：等审批的工具卡
   * 被回放标成了「未记录结果」，看起来像丢了）。反之，成员已停就保持「未记录结果」——
   * 不许编成功也不许编失败。
   */
  const agentStatus = focusPath ? agents[focusPath]?.status : undefined;
  const state =
    item.state === 'lost' && (agentStatus === 'running' || agentStatus === 'waiting') ? 'running' : item.state;
  const done = state !== 'running';
  /**
   * 工具详情默认收起：只有存在结果体、且用户点击卡头时才展开（见截图反馈）。
   * 卡头保持**整行可点 + 手型光标**（`.card-head.toggle`），折叠箭头只做可展开提示，
   * 不缩小点击热区。
   */
  const [open, setOpen] = useState(false);
  const hasBody = done && !!item.result;
  return (
    <div
      className={state === 'err' ? 'card err' : 'card'}
      data-smoke="tool-card"
      data-tool={item.name}
      data-state={state}
    >
      <div
        className={hasBody ? 'card-head toggle' : 'card-head'}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? open : undefined}
        onClick={hasBody ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          hasBody
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
      >
        <span
          className={TOOL_STATE[state].dot}
          title={TOOL_STATE[state].label}
          aria-label={TOOL_STATE[state].label}
          role="img"
        />
        {hasBody ? <Icon name={open ? 'chevD' : 'chevR'} size={14} /> : null}
        <span className="name">{item.name}</span>
        {item.args ? <span className="path">{item.args}</span> : null}
      </div>
      {hasBody && open ? <div className="card-body mono">{clip(item.result)}</div> : null}
      {state === 'running' ? (
        <div className="card-foot">
          <span className="spacer" />
          <button
            className="btn sm ghost"
            title="中断该分身当前回合"
            onClick={() => focusPath && void interrupt(focusPath)}
          >
            <Icon name="pause" size={14} />
            中断
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 三点跳动动画，在引擎运行但尚无文本输出时显示。 */
function ThinkingIndicator(): ReactElement {
  return (
    <div className="thinking-indicator" aria-label="正在思考" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}

export function MessageStream(): ReactElement {
  const { streams, focusPath, pending, current, agents } = useApp();
  const items = focusPath ? (streams[focusPath] ?? []) : [];
  const approvals = current ? pending.filter((p) => p.state === 'pending' && p.sessionId === current.record.id) : [];

  // 引擎在跑但流尾还没有 pending 助手占位（发送→message.start 的空窗）时，
  // 主动在流底部插入思考指示器。
  const focusStatus = focusPath ? agents[focusPath]?.status : undefined;
  const isRunning = focusStatus === 'running';
  const lastItem = items[items.length - 1];
  const hasPendingAssistant = lastItem?.kind === 'assistant' && lastItem.pending;
  const showThinkingIndicator = isRunning && !hasPendingAssistant && approvals.length === 0;
  const focusName = focusPath ? (agents[focusPath]?.displayName ?? '') : '';

  return (
    <div className="stream">
      {items.length === 0 ? (
        <div className="empty">
          <span className="k">这个会话还没有消息</span>
          下面的输入区会把任务发给当前焦点分身{focusName ? `（${focusName}）` : ''}。
        </div>
      ) : null}

      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div className="bubble-row" key={item.id} data-smoke="user-bubble">
                <div className="bubble">
                  <Inline text={item.text} />
                </div>
              </div>
            );
          case 'assistant':
            return (
              <div className={item.pending ? 'assistant pending' : 'assistant'} key={item.id} data-smoke="assistant-msg">
                {item.pending && !item.text
                  ? <ThinkingIndicator />
                  : <Prose text={item.text} />}
              </div>
            );
          case 'tool':
            return <ToolCard item={item} key={item.id} />;
          case 'turn':
            return (
              <div className="activity" key={item.id}>
                <Icon name="history" size={16} />
                <span>{item.text}</span>
                {item.detail ? <span className="dur">{item.detail}</span> : null}
              </div>
            );
          case 'error':
            return (
              <div className="card err" key={item.id}>
                <div className="card-head">
                  <Icon name="alert" size={16} />
                  <span className="name">模型调用失败</span>
                  <span className="spacer" />
                  <span className="tag err">error</span>
                </div>
                <div className="card-body">{item.text}</div>
              </div>
            );
          default:
            return null;
        }
      })}

      {/* running 且流尾没有 pending 助手消息时（发送→message.start 的空窗），显示思考指示器。 */}
      {showThinkingIndicator ? <ThinkingIndicator /> : null}

      {approvals.map((p) => (
        <ApprovalCard request={p} key={p.requestId} />
      ))}
    </div>
  );
}
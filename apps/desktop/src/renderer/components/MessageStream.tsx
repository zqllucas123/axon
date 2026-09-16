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
import type { PendingRequest } from '@axon/protocol';
import { useApp } from '../state/store.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { inlineSegments, parseProse, type StreamItem } from '../state/selectors.ts';

/** 工具名 → 图标（对齐原型：read_file=file / bash=terminal / edit=pen…）。 */
const TOOL_ICONS: Record<string, IconName> = {
  read_file: 'file',
  write_file: 'pen',
  edit_file: 'pen',
  replace_in_file: 'pen',
  list_files: 'folder',
  glob: 'search',
  grep: 'search',
  bash: 'terminal',
  shell: 'terminal',
  agent: 'branch',
  spawn_agent: 'branch',
};

/** 长输出截断（原型只有固定高度，滚动查看；截断避免 DOM 里塞整篇文件）。 */
const CLIP = 1600;

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}\n…（已截断 ${text.length - CLIP} 字符）` : text;
}

function lines(text: string): number {
  return text.trim() ? text.trim().split('\n').length : 0;
}

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
  const { focusPath, interrupt } = useApp();
  const done = item.state !== 'running';
  return (
    <div className={item.state === 'err' ? 'card err' : 'card'} data-smoke="tool-card" data-tool={item.name}>
      <div className="card-head">
        <Icon name={TOOL_ICONS[item.name] ?? 'terminal'} size={16} />
        <span className="name">{item.name}</span>
        {item.args ? <span className="path">{item.args}</span> : null}
        <span className="spacer" />
        <span className={item.state === 'ok' ? 'tag ok' : item.state === 'err' ? 'tag err' : item.state === 'running' ? 'tag run' : 'tag'}>
          {item.state === 'ok'
            ? `ok · ${lines(item.result)} 行`
            : item.state === 'err'
              ? '失败'
              : item.state === 'running'
                ? 'running'
                : '未记录结果'}
        </span>
      </div>
      {done && item.result ? <div className="card-body mono">{clip(item.result)}</div> : null}
      {item.state === 'running' ? (
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

/** 穿透链：origin → … → root → 你（`PendingRequest.chain` 是真实路径数组）。 */
function Chain({ chain }: { chain: string[] }): ReactElement {
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

function ApprovalCard({ request }: { request: PendingRequest }): ReactElement {
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
        <span className="tag run">等待中</span>
      </div>
      <div className="card-body">
        {request.message}
        {request.chain.length > 1 ? <Chain chain={request.chain} /> : null}
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

/** 提问卡（`question.respond`）：输入框 + 提交（Enter 提交）。 */
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

export function MessageStream(): ReactElement {
  const { streams, focusPath, pending, current, agents } = useApp();
  const items = focusPath ? (streams[focusPath] ?? []) : [];
  const approvals = current ? pending.filter((p) => p.state === 'pending' && p.sessionId === current.record.id) : [];
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
                {item.pending ? <p>正在生成…</p> : <Prose text={item.text} />}
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

      {approvals.map((p) => (
        <ApprovalCard request={p} key={p.requestId} />
      ))}
    </div>
  );
}
/**
 * S5 收件箱 —— 跨会话的待办聚合（原型 `docs/ux/mockups/s5-inbox.html`）。
 *
 * 所有权（MU-3 §7.0）：本文件由并行会话 **W-A** 实现。
 *
 * 本屏存在的唯一理由（`docs/ux/02-团队与会话模型.md:120-122`）：**跨会话**。
 * 会话内的审批就地出现在会话流里（`MessageStream` 按 `p.sessionId === current` 切片），
 * 这里补的是另一半 —— 你在 A 会话干活时 B 会话有人卡住了。
 *
 * 原料（零协议新增，全部来自 store）：
 *  - `pending`：启动 `pending.list` 补拉 + `approval.request` / `question.request` 增量；
 *  - `resolvedFeed`：本次运行期已处理流水（含 `approval.delegated` 的代批留痕）；
 *  - `agents` / `sessions`：把路径与会话 id 翻译成人看得懂的名字（**只读内存**，
 *    绝不为了渲染一行去 `session.get` —— 那会打穿 M5 懒加载）。
 *
 * 纪律（逐条对应 MU-3 拍板）：
 *  - P-5：已处理流水只覆盖**本次运行期**，屏上明说刷新即清空（协议无 `pending.history`）；
 *  - P-6：提问卡只做**纯文本**，不画选项式（`question.request` 全仓无发射方，画了就是假数据）；
 *  - 不做「本会话内同类命令自动放行」（无规则放行协议）；
 *  - 不做「批准一次 / 批准并继续」两个按钮（`approval.respond` 只有一个布尔 `approved`）；
 *  - 原型的「今天已处理 7」是示意数字，不是真值 —— 一律换成真实计数。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AgentPath, PendingRequest } from '@axon/protocol';
import { useApp } from '../state/store.tsx';
import { fmtTime, splitPending } from '../state/selectors.ts';
import { ApprovalCard } from './parts/ApprovalCard.tsx';
import { Icon, type IconName } from '../icons.tsx';

/** 分段①：按紧迫度。「全部」= 两段依次铺开，不是第三份口径。 */
type Tab = 'waiting' | 'resolved' | 'all';

/**
 * `PendingRequest.detail` 在协议里是 `unknown`（结算方各写各的），
 * 这里把**实际会出现的三种写法**收拢成一个只读视图：
 *  - `pending.resolved` 事件 → `{ outcome }`（store.tsx 订阅处）；
 *  - 本地乐观结算 → `{ outcome }`（store.respondApproval）；
 *  - `approval.delegated` 留痕 → `{ outcome:'approved', delegated:true, approver }`。
 * 认不出来就当空对象，宁可少显示一行字，也不编。
 */
type ResolvedDetail = {
  outcome?: 'approved' | 'denied' | 'answered' | 'expired' | 'cancelled';
  delegated?: boolean;
  approver?: string;
};

function detailOf(p: PendingRequest): ResolvedDetail {
  return p.detail && typeof p.detail === 'object' ? (p.detail as ResolvedDetail) : {};
}

/** 时长 mm:ss（超过一小时补时位）。收件箱的「等了多久」要精确到秒，`since()` 的粗粒度不够用。 */
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 结算口径 → 动词 + 图标。未知 outcome 只说「已处理」，不猜。 */
function outcomeFace(d: ResolvedDetail): { verb: string; icon: IconName } {
  if (d.delegated) return { verb: '代批放行', icon: 'shield' };
  switch (d.outcome) {
    case 'approved':
      return { verb: '批准', icon: 'check' };
    case 'denied':
      return { verb: '拒绝', icon: 'x' };
    case 'answered':
      return { verb: '已回答', icon: 'check' };
    case 'expired':
      return { verb: '超时拒绝', icon: 'clock' };
    case 'cancelled':
      return { verb: '作废', icon: 'x' };
    default:
      return { verb: '已处理', icon: 'check' };
  }
}

export function S5Inbox(): ReactElement {
  const { pending, resolvedFeed, sessions, agents, error, openSession, respondApproval } = useApp();

  const [tab, setTab] = useState<Tab>('waiting');
  /** 会话过滤（null = 全部会话）。空串是「事件没给会话归属」那一档，与 null 不同。 */
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  /** 「全部拒绝」的两步确认 + 进度 + 事后说明（批量动作不该一击必中）。 */
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const { waiting, resolved } = splitPending(pending);
  /**
   * 待处理**升序**（等最久的排最前）：收件箱是「谁卡得最久」的队列，
   * 与已处理流水的「最近发生的在最上」刚好相反，两段各按各的语义排。
   */
  const waitingAll = useMemo(() => [...waiting].sort((a, b) => a.at - b.at), [waiting]);
  /** 已处理 = store 的派生流水（= `pending` 里 state==='resolved' 那些，同一份真相）。 */
  const resolvedAll = useMemo(() => [...resolvedFeed].sort((a, b) => b.at - a.at), [resolvedFeed]);

  // 等待时长要走字，按秒重算；没有待处理时不开表（空屏不该有心跳）。
  const [now, setNow] = useState(() => Date.now());
  const hasWaiting = waitingAll.length > 0;
  useEffect(() => {
    if (!hasWaiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasWaiting]);

  const titleOf = (sid: string): string | undefined =>
    sessions.find((s) => s.record.id === sid)?.record.title;
  const cwdOf = (sid: string): string | undefined =>
    sessions.find((s) => s.record.id === sid)?.record.cwd;
  const nameOf = (path: AgentPath | string): string =>
    path ? (agents[path]?.displayName ?? path) : '未知发起者';

  // ── 分段② 会话枚举：从**当前分段的数据**里数出来，不是写死的三枚 ──
  const scope = tab === 'waiting' ? waitingAll : tab === 'resolved' ? resolvedAll : [...waitingAll, ...resolvedAll];
  const bySession = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of scope) m.set(p.sessionId, (m.get(p.sessionId) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [scope]);
  // 过滤器指向的会话已经没有待办了（刚被批完）就自动松开，避免停在空视图上。
  useEffect(() => {
    if (sessionFilter !== null && !bySession.some(([sid]) => sid === sessionFilter)) setSessionFilter(null);
  }, [bySession, sessionFilter]);

  const keep = (p: PendingRequest): boolean => sessionFilter === null || p.sessionId === sessionFilter;
  const shownWaiting = waitingAll.filter(keep);
  const shownResolved = resolvedAll.filter(keep);

  // ── 全部拒绝：循环 N 次 approval.respond（协议没有批量命令，就老实循环）──
  const bulkTargets = shownWaiting.filter((p) => p.kind === 'approval');
  const errorRef = useRef<string | null>(error);
  errorRef.current = error;
  const rejectAll = async (): Promise<void> => {
    const targets = [...bulkTargets];
    if (targets.length === 0) return;
    const before = errorRef.current;
    setConfirmBulk(false);
    setBatchNote(null);
    setBatch({ done: 0, total: targets.length });
    let sent = 0;
    for (const t of targets) {
      // 串行而不是 Promise.all：失败要能定位到第几条，且主进程结算是单点，
      // 并发拒绝除了让错误条互相覆盖之外没有任何好处。
      await respondApproval(t.requestId, false);
      sent += 1;
      setBatch({ done: sent, total: targets.length });
    }
    setBatch(null);
    // 部分失败的唯一可观测信号是 store.error 变了（`respondApproval` 不回结果，
    // 且它对每一条都做了乐观结算）。说清楚：界面已经把它们移走，但主进程那边未必。
    if (errorRef.current && errorRef.current !== before) {
      setBatchNote(
        `这批 ${targets.length} 条里至少有一条没能送达主进程（错误见页面顶部）。界面已乐观把它们移出待处理；` +
          `真正没结算的请求会在下次刷新（pending.list 补拉）时重新出现。`,
      );
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'waiting', label: `待处理 ${waitingAll.length}` },
    { id: 'resolved', label: `本次已处理 ${resolvedAll.length}` },
    { id: 'all', label: '全部' },
  ];

  return (
    <div className="body" data-screen="s5">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>收件箱</h1>
            <p>
              <b>跨会话聚合</b> —— 你在 A 会话里干活时 B 会话有人卡住了，这是本屏存在的唯一理由；会话内的审批
              <b>就地</b>出现在会话流里，不只藏在这里。子分身的请求沿父链向上穿透，父级无权代批时才冒泡到你；
              重开应用后由 <code>pending.list</code> 补拉仍挂着的请求。
            </p>
          </div>

          {/* ── 工具条：紧迫度分段 × 会话分段 + 批量拒绝 ── */}
          <div className="toolbar">
            <span className="seg">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? 'is-on' : ''}
                  data-smoke={`inbox-tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </span>
            {bySession.length > 0 ? (
              <span className="seg">
                <button className={sessionFilter === null ? 'is-on' : ''} onClick={() => setSessionFilter(null)}>
                  全部会话
                </button>
                {bySession.map(([sid, n]) => (
                  <button
                    key={sid || '__none__'}
                    className={sessionFilter === sid ? 'is-on' : ''}
                    title={sid || '事件未携带会话归属'}
                    onClick={() => setSessionFilter(sid)}
                  >
                    {titleOf(sid) ?? (sid ? sid : '未归属会话')} {n}
                  </button>
                ))}
              </span>
            ) : null}
            <span className="spacer" style={{ flex: 1 }} />
            {tab !== 'resolved' && bulkTargets.length > 0 ? (
              batch ? (
                <button className="btn sm ghost" disabled>
                  拒绝中 {batch.done}/{batch.total}
                </button>
              ) : confirmBulk ? (
                <>
                  <span className="inbox-confirm">确认拒绝这 {bulkTargets.length} 条？</span>
                  <button className="btn sm ghost" onClick={() => setConfirmBulk(false)}>
                    取消
                  </button>
                  <button className="btn sm danger" data-smoke="inbox-reject-all-confirm" onClick={() => void rejectAll()}>
                    <Icon name="x" size={14} />
                    确认全部拒绝
                  </button>
                </>
              ) : (
                <button className="btn sm ghost" data-smoke="inbox-reject-all" onClick={() => setConfirmBulk(true)}>
                  全部拒绝 {bulkTargets.length}
                </button>
              )
            ) : null}
          </div>

          {batchNote ? (
            <div className="card err inbox-batch-note">
              <div className="card-head">
                <Icon name="alert" size={16} />
                <span className="name">批量拒绝没有全部成功</span>
              </div>
              <div className="card-body">{batchNote}</div>
            </div>
          ) : null}

          {/* ── 待处理：审批卡与提问卡（同一张卡，只差卡尾动作）── */}
          {tab !== 'resolved' ? (
            shownWaiting.length === 0 ? (
              <div className="empty" data-smoke="inbox-empty">
                <span className="k">没有等你拍板的事</span>
                当某个分身要动一个需要审批的工具，而它自己和整条父链都是 <code>always_ask</code> 时，请求会冒泡到这里；
                链上只要有一级是 <code>auto</code> / <code>full_access</code>，它就被<b>替你批了</b>，不会出现在这一段 ——
                那种情况会在下面「本次已处理」留一条代批流水。提问同理：分身问你问题时也落在这里。
                {sessionFilter !== null ? '（当前只看某一个会话，点「全部会话」看全部。）' : ''}
              </div>
            ) : (
              shownWaiting.map((p) => (
                <ApprovalCard
                  key={p.requestId}
                  request={p}
                  variant="inbox"
                  {...(titleOf(p.sessionId) ? { sessionTitle: titleOf(p.sessionId) } : {})}
                  onOpenSession={() => openSession(p.sessionId)}
                  headTag={
                    <span className="tag run">
                      等待 {dur(now - p.at)}
                      {p.expiresAt ? ` / 超时 ${dur(p.expiresAt - p.at)}` : ''}
                    </span>
                  }
                >
                  {/* 发起者一行：`question.request` 事件不带 origin（ipc.ts:329），那就整行不渲染。 */}
                  {p.origin ? (
                    <div className="inbox-origin">
                      发起：<b>{nameOf(p.origin)}</b>
                      {p.approvalMode ? (
                        <>
                          （审批档 <code>{p.approvalMode}</code>）
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {p.kind === 'approval' && (p.tool || p.args !== undefined || cwdOf(p.sessionId)) ? (
                    <details className="fold inbox-fold">
                      <summary>
                        <Icon name="terminal" size={16} />
                        <span>完整命令与工作目录</span>
                        <span className="spacer" />
                        <Icon name="chevD" size={14} />
                      </summary>
                      <div className="fold-body mono">
                        {[
                          p.tool ? `tool: ${p.tool}` : null,
                          p.args !== undefined ? `args: ${JSON.stringify(p.args, null, 2)}` : null,
                          cwdOf(p.sessionId) ? `cwd（会话工作目录）: ${cwdOf(p.sessionId)}` : null,
                        ]
                          .filter((l): l is string => l !== null)
                          .join('\n')}
                      </div>
                    </details>
                  ) : null}
                </ApprovalCard>
              ))
            )
          ) : null}

          {/* ── 本次已处理：流水，不是历史（P-5）── */}
          {tab !== 'waiting' ? (
            <>
              <div className="side-section inbox-sec">
                <span>本次已处理 {shownResolved.length}</span>
              </div>
              <div className="hint inbox-sec-note">
                只是<b>本次运行期</b>的流水，<b>刷新后清空</b>：审批一旦结算，主进程就把它从挂起表里删了，
                协议没有 <code>pending.history</code>，真历史要等新协议（MU-3 台账 D-1）。
              </div>
              {shownResolved.length === 0 ? (
                <div className="empty" data-smoke="inbox-feed-empty">
                  <span className="k">本次运行期还没处理过请求</span>
                  你批准/拒绝的每一条，以及链上祖先<b>替你批</b>的每一条（<code>approval.delegated</code>），都会记在这里。
                </div>
              ) : (
                <div className="list" data-smoke="inbox-feed">
                  {shownResolved.map((p) => {
                    const d = detailOf(p);
                    const face = outcomeFace(d);
                    const title = titleOf(p.sessionId);
                    return (
                      <div className="list-row" key={p.requestId} data-request={p.requestId}>
                        <Icon name={face.icon} size={16} />
                        <div className="grow">
                          <div className="t1">
                            {face.verb} · {p.tool ?? (p.kind === 'question' ? '提问' : '—')}
                            <span className="tag mono">{nameOf(p.origin)}</span>
                            {title ? (
                              <button className="tag" onClick={() => openSession(p.sessionId)}>
                                {title}
                              </button>
                            ) : null}
                          </div>
                          <div className="t2">
                            {d.delegated && d.approver
                              ? `由 ${nameOf(d.approver)}（档位 ${p.approvalMode ?? '—'}）代批 —— 没有惊动你`
                              : p.message}
                          </div>
                        </div>
                        <span className="when">{fmtTime(p.at)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">
            <span>穿透规则</span>
          </div>
          {/* 三个档位名以 packages/protocol/src/agent.ts:201 的 ApprovalMode 枚举为准。 */}
          <div className="prow sub def">
            <span className="k">always_ask</span>
            <span className="d">自己的叶子工具调用必问</span>
          </div>
          <div className="prow sub def">
            <span className="k">auto</span>
            <span className="d">自己的调用直接放行，并可代批后代</span>
          </div>
          <div className="prow sub def">
            <span className="k">full_access</span>
            <span className="d">同 auto；语义更强，内置角色未用</span>
          </div>
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            沿父链向上找第一个 auto / full_access 代批；都没有则到人（<code>approval.ts:134-148</code>）。
            ⚠️ 档位是<b>按 Agent</b> 而非按工具的：除编排工具（D5 豁免）外没有风险分级。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>阻塞影响</span>
          </div>
          <BlockedList waiting={waitingAll} now={now} />
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            等审批期间分身<b>仍记为 running</b>，并<b>占着并发额度</b>（<code>host.ts:267</code>）；
            退位让额的是「父等后代」那种 waiting（waitingOn 非空，即 suspended）。
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * 阻塞影响：直接卡住的是请求的 `origin`；链上祖先只有在**快照里确实在等后代**
 * （`status==='waiting'` 且 `waitingOn` 非空 —— 这就是 host 口径的 suspended）
 * 时才算间接等待。
 *
 * 为什么不按「status==='suspended'」筛：`AgentStatus` 里根本没有这个值
 * （`packages/protocol/src/agent.ts:205-211`），suspended 是 waiting 的一种。
 * 会话没被装载过时 `agents` 里没有这些成员 —— 那就少列一行，不去补拉、也不编。
 */
function BlockedList({ waiting, now }: { waiting: PendingRequest[]; now: number }): ReactElement {
  const { agents } = useApp();
  const rows: Array<{ path: string; label: string; kind: 'direct' | 'indirect'; val: string }> = [];
  const seen = new Set<string>();
  for (const p of waiting) {
    if (p.origin && !seen.has(p.origin)) {
      seen.add(p.origin);
      rows.push({
        path: p.origin,
        label: agents[p.origin]?.displayName ?? p.origin,
        kind: 'direct',
        val: `阻塞 ${dur(now - p.at)}`,
      });
    }
    for (const a of p.chain.slice(1)) {
      const snap = agents[a];
      if (!snap || seen.has(a)) continue;
      if (snap.status !== 'waiting' || !snap.waitingOn?.length) continue;
      seen.add(a);
      rows.push({ path: a, label: snap.displayName, kind: 'indirect', val: '间接等待' });
    }
  }
  if (rows.length === 0) {
    return (
      <div className="empty" style={{ padding: '2px 10px 8px' }}>
        <span className="k">没有分身被卡住</span>
        有人等你拍板时，这里会列出直接卡住的分身与在等它的祖先。
      </div>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <div className="prow sub" key={r.path} title={r.path}>
          <span className={`sdot ${r.kind === 'direct' ? 'err' : 'wait'}`} />
          <span>{r.label}</span>
          <span className="val">{r.val}</span>
        </div>
      ))}
    </>
  );
}

/**
 * S7 会话恢复 —— 落盘会话的清单与存储实况（原型 `docs/ux/mockups/s7-sessions.html`）。
 *
 * 所有权（MU-3 §7.0）：本文件由并行会话 **W-C** 实现。
 *
 * 数据源（全部已在内存，**本屏一次 invoke 都不发**）：
 *  - `sessions`：`session.list` 的摘要。未装载的会话由主进程用落盘 rollup 拼出
 *    （`host.ts:1128-1146` 的 `rollupSummaryOf`），所以 `counts`/`usage` 也是真数；
 *  - `rollup.interruptedAt`（MU-3 E-1 透传）：「上次中断」那行字的**唯一**来源；
 *  - `storage`：`storage.status` 的 root / sessionCount / loadedCount / issues。
 *
 * 纪律：
 *  1. **只读摘要**。点「继续」= `openSession`（store 里唯一允许触发 `session.get`
 *     的地方，M5 的 `ensureSessionLoaded` 会在那时懒加载整棵树）；渲染这一屏
 *     绝不能让 `storage.status.loadedCount` 增长（MU-3 R-7 反向断言）。
 *  2. **不发明动作**：原型上的「清理孤儿」「只读打开」两个按钮整块删掉 ——
 *     前者无扫描/删除命令且删用户目录不可逆（§1.2-6 / 台账 D-8），
 *     后者无只读模式协议（台账 D-10）。坏文件只报告，不代用户处置。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { fmtTime, interruptedAt, since, statusDot, statusLabel } from '../state/selectors.ts';
import { Icon } from '../icons.tsx';
import type { SessionSummary, StorageIssue, StorageIssueKind } from '@axon/protocol';

/** 分段（MU-3 §4.3）：全部 / 可恢复（有中断痕迹）/ 已归档（record.status='closed'）。 */
type Seg = 'all' | 'recoverable' | 'archived';

/** 可恢复 = 落盘 rollup 里带 `interruptedAt`（§4.3 原话，不看实时状态）。 */
function isRecoverable(s: SessionSummary): boolean {
  return interruptedAt(s) !== undefined;
}

/** 已归档 = 会话记录的用户意志态（与运行时 AgentStatus 正交，见 protocol/session.ts:61）。 */
function isArchived(s: SessionSummary): boolean {
  return s.record.status === 'closed';
}

function inSeg(s: SessionSummary, seg: Seg): boolean {
  if (seg === 'all') return true;
  return seg === 'recoverable' ? isRecoverable(s) : isArchived(s);
}

/** 状态 tag 的配色跟 `.sdot` 五档同源（selectors.statusDot），只是换成 tag。 */
function statusTagClass(s: SessionSummary): string {
  const dot = statusDot(s.status);
  if (dot === 'run') return 'tag run';
  if (dot === 'err') return 'tag err';
  if (dot === 'wait') return 'tag wait';
  return 'tag';
}

/**
 * 一行会话。
 *
 * 数字的出处（逐个可追）：`counts.members`（分身数）/ `counts.ledger`（协作笔数）
 * 来自 `SessionSummary.counts` —— 未装载的会话取自 `rollup.counts`；
 * `record.cwd` 是会话的工作目录；右侧时间是 `record.updatedAt`。
 * 原型那行里的「N 条消息」**没有协议字段**（`SessionCounts` 无消息计数），整块删掉。
 */
function SessionRow({ s, onContinue }: { s: SessionSummary; onContinue: () => void }): ReactElement {
  const cut = interruptedAt(s);
  return (
    <div className="list-row" data-smoke="s7-row" data-session={s.record.id}>
      <span className={`sdot ${statusDot(s.status)}`} />
      <span className="grow">
        <span className="t1">
          {s.record.title}
          <span className="tag mono">{s.record.id}</span>
          <span className={statusTagClass(s)}>{statusLabel(s.status)}</span>
          {cut !== undefined ? <span className="tag info">可恢复</span> : null}
          {isArchived(s) ? <span className="tag">已归档</span> : null}
        </span>
        <span className="t2">
          {s.counts.members} 个分身 · {s.counts.ledger} 笔协作 · {s.record.cwd}
        </span>
        {cut !== undefined ? (
          <span
            className="t2 s7-cut"
            title="rollup.interruptedAt —— 恢复扫描发现「上次退出时仍有成员在跑」的时刻"
          >
            上次中断于 {fmtTime(cut)}，运行中的分身已降为空闲（时间线里有留痕）
          </span>
        ) : null}
      </span>
      <span className="when" title={fmtTime(s.record.updatedAt)}>
        {since(s.record.updatedAt)}
      </span>
      <button className="btn sm" data-smoke="s7-continue" onClick={onContinue}>
        继续
      </button>
    </div>
  );
}

/** 存储问题的人话（八种 kind 见 protocol/session.ts:75-84、M5 §4.8）。 */
const ISSUE_META: Record<StorageIssueKind, { label: string; hint: string }> = {
  'corrupt-line': { label: '坏行', hint: '单行解析失败，已跳过；同文件其余内容照读。' },
  'partial-line': { label: '半行', hint: '末尾写了一半的行（进程被杀），已丢弃。' },
  'missing-header': { label: '缺 header', hint: '分身文件缺首行身份，该分身没有被恢复。' },
  'version-too-new': { label: '版本过新', hint: '文件由更新版本的 Axon 写下，本版本拒载它。' },
  'path-mismatch': { label: '路径对不上', hint: '文件名与文件内记的路径不一致，以文件内为准。' },
  'unreadable-dir': { label: '读不了', hint: '目录或文件读失败（权限/磁盘），内容没进来。' },
  'orphan-dir': { label: '孤儿目录', hint: '有会话目录但缺 session.json，已跳过；不会自动删除。' },
  'write-failed': { label: '写失败', hint: '内存里的改动没落盘；界面上的状态仍然有效。' },
};

/** `StorageStatus.issues` 在 store 里是 `unknown[]`（协议真实类型是 StorageIssue）。 */
function asIssues(raw: unknown[] | undefined): StorageIssue[] {
  if (!raw) return [];
  return raw.filter((x): x is StorageIssue => {
    if (typeof x !== 'object' || x === null) return false;
    const o = x as { kind?: unknown; path?: unknown };
    return typeof o.kind === 'string' && o.kind in ISSUE_META && typeof o.path === 'string';
  });
}

/** 按 kind 分组（条数多的排前面）。 */
function groupIssues(issues: StorageIssue[]): Array<{ kind: StorageIssueKind; items: StorageIssue[] }> {
  const by = new Map<StorageIssueKind, StorageIssue[]>();
  for (const i of issues) by.set(i.kind, [...(by.get(i.kind) ?? []), i]);
  return [...by.entries()]
    .map(([kind, items]) => ({ kind, items }))
    .sort((a, b) => b.items.length - a.items.length);
}

export function S7Sessions(): ReactElement {
  const { sessions, storage, openSession, openPath } = useApp();
  const [seg, setSeg] = useState<Seg>('all');

  // 列表口径与左栏一致：按 updatedAt 倒序（最近动过的在最上面）。
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.record.updatedAt - a.record.updatedAt),
    [sessions],
  );
  const recoverableN = ordered.filter(isRecoverable).length;
  const archivedN = ordered.filter(isArchived).length;
  const shown = ordered.filter((s) => inSeg(s, seg));

  const issues = asIssues(storage?.issues);
  const groups = groupIssues(issues);
  // 列表最多 50 条（store 调 `session.list` 用缺省 limit，session-store.ts:112），
  // 磁盘上可能更多 —— 两个数不一致时说清楚，别让用户以为会话丢了。
  const truncated = storage ? storage.sessionCount > ordered.length : false;

  const segBtn = (id: Seg, label: string, n: number): ReactElement => (
    <button
      className={seg === id ? 'is-on' : ''}
      data-smoke={`s7-seg-${id}`}
      onClick={() => setSeg(id)}
    >
      {label} {n}
    </button>
  );

  return (
    <div className="body" data-screen="s7">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>会话恢复</h1>
            <p>
              会话都在磁盘上，重启不会丢。这一屏回答两件事：上次退出时哪些会话还在跑（「可恢复」），
              以及磁盘上有没有读不动的文件。列表只读每个会话的汇总，点「继续」才会真的把那棵树读进来。
            </p>
          </div>

          <div className="toolbar">
            <div className="seg">
              {segBtn('all', '全部', ordered.length)}
              {segBtn('recoverable', '可恢复', recoverableN)}
              {segBtn('archived', '已归档', archivedN)}
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="empty" data-smoke="s7-empty">
              {seg === 'all' ? (
                <>
                  <span className="k">磁盘上还没有会话</span>
                  新建一个会话后，它会立刻落盘；下次打开 Axon 时就能在这里找到它。
                </>
              ) : seg === 'recoverable' ? (
                <>
                  <span className="k">没有被中断的会话</span>
                  只有「上次退出时还有分身在跑 / 在等」的会话才会出现在这里；
                  正常结束的会话不算中断，它们在「全部」里。
                </>
              ) : (
                <>
                  <span className="k">没有已归档的会话</span>
                  归档是会话记录上的 <code>status: 'closed'</code>；当前版本还没有「归档会话」这个动作，
                  所以这一段暂时总是空的（会话只有开着或被删除两种下场）。
                </>
              )}
            </div>
          ) : (
            <div className="list">
              {shown.map((s) => (
                <SessionRow key={s.record.id} s={s} onContinue={() => openSession(s.record.id)} />
              ))}
            </div>
          )}

          {/* ── 存储实况（storage.status；原型此处是一张「M5 待落盘清单」设计表，已过时 → 换成实况） ── */}
          <div className="card" style={{ marginTop: 24 }} data-smoke="s7-storage">
            <div className="card-head">
              <Icon name="db" size={16} />
              <span className="name">存储实况</span>
              <span className="spacer" />
              <button className="btn sm ghost" onClick={() => void openPath('sessions')}>
                <Icon name="folder" size={14} />
                打开会话目录
              </button>
            </div>
            <div className="card-body">
              {storage === null ? (
                <div className="empty">
                  <span className="k">还没拿到存储实况</span>
                  <code>storage.status</code> 没有返回（启动时拉一次）。
                </div>
              ) : (
                <>
                  <table className="tbl">
                    <tbody>
                      <tr>
                        <td style={{ width: 150, color: 'var(--text-muted)' }}>会话根目录</td>
                        <td className="num">{storage.root || '（未落盘）'}</td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-muted)' }}>落盘会话</td>
                        <td>
                          <span className="num">{storage.sessionCount}</span> 个
                          {truncated ? `（列表只显示最近 ${ordered.length} 个）` : ''}
                        </td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-muted)' }}>已装载</td>
                        <td>
                          <span className="num">{storage.loadedCount}</span> 个 —— 懒加载：点开谁才读谁的树
                        </td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-muted)' }}>读写问题</td>
                        <td>
                          <span className="num">{issues.length}</span> 条
                          {issues.length ? `（${groups.length} 类）` : '　一切正常'}
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {groups.length ? (
                    <div className="s7-issues" data-smoke="s7-issues">
                      {groups.map((g) => (
                        <details className="fold" key={g.kind}>
                          <summary>
                            <Icon name="alert" size={14} />
                            <span>{ISSUE_META[g.kind].label}</span>
                            <span className="tag mono">{g.kind}</span>
                            <span className="spacer" />
                            <span className="tag">{g.items.length} 条</span>
                          </summary>
                          <div className="fold-body">
                            <div className="hint" style={{ marginTop: 0 }}>
                              {ISSUE_META[g.kind].hint}
                            </div>
                            {g.items.map((i, n) => (
                              <div className="prow def" key={`${i.path}-${i.at}-${n}`}>
                                <span className="k">{i.path}</span>
                                <span className="d">
                                  {i.detail}
                                  {i.sessionId ? ` · 会话 ${i.sessionId}` : ''} · {fmtTime(i.at)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  ) : null}

                  <div className="hint">
                    坏文件不阻断启动：能读的照读，读不动的记在这里。Axon
                    不会自动删除磁盘上的任何会话数据 —— 需要清理时请自己去目录里处理。
                    以上四个数取自本次启动时的那一次 <code>storage.status</code>。
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">
            <span>「继续」之后会怎样</span>
          </div>
          <div className="prow def">
            <span className="k">运行中 / 等待中的分身</span>
            <span className="d">降为空闲，不自动续跑；时间线留一条「应用重启：运行中被中断，已降为空闲」。</span>
          </div>
          <div className="prow def">
            <span className="k">排队与没喂出去的话</span>
            <span className="d">丢弃（不落盘）—— 重启后重投一遍等于重复扣费。</span>
          </div>
          <div className="prow def">
            <span className="k">上次挂起的审批 / 提问</span>
            <span className="d">已在重启时结算为「拒绝」，理由「应用重启，审批未决」。</span>
          </div>
          <div className="prow def">
            <span className="k">没结算完的协作账目</span>
            <span className="d">结算为「应用重启，未及结算」，账本不留半开的账。</span>
          </div>
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            消息、分身树、账本本身都在盘上，恢复的是它们；上面这四项是<b>运行时</b>的东西，
            重启后无法凭空复原（M5 §4.6 恢复语义）。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>这一屏不做的事</span>
          </div>
          <div className="prow def">
            <span className="k">不自动清理孤儿目录</span>
            <span className="d">缺 session.json 的目录只报告不删除：删用户数据不可逆，需要单独设计确认流程。</span>
          </div>
          <div className="prow def">
            <span className="k">没有「只读打开」</span>
            <span className="d">协议里没有只读模式，会话只能整份继续 —— 与其画个假按钮，不如先不画。</span>
          </div>
        </div>
      </aside>
    </div>
  );
}

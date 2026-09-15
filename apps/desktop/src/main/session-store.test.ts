/**
 * SessionStore / 标题 / 三层预算 / 会话摘要 —— 纯函数单测（MU-1 方案 §八）。
 *
 * 这一层刻意不碰宿主：会话汇总是 S0/S1/S2 三个屏共同的数据源，
 * 一旦它只能通过「起一个宿主再观察」来验证，就没法穷举边界
 * （恰恰是「parked 与 suspended 分开算」「软线逐层算完再取严」这些地方容易错）。
 */

import { describe, expect, it } from 'vitest';
import type { AgentSnapshot, PendingRequest, SessionRecord } from '@axon/protocol';
import { SESSION_SCHEMA_VERSION, SESSION_TITLE_MAX } from '@axon/protocol';
import {
  SessionStore,
  buildSessionSummary,
  computeEffectiveBudget,
  titleFromPrompt,
} from './session-store.ts';

function record(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  const at = over.createdAt ?? 1_000;
  return {
    id,
    title: `会话 ${id}`,
    cwd: '/tmp',
    executor: 'engine',
    status: 'open',
    createdAt: at,
    updatedAt: at,
    schemaVersion: SESSION_SCHEMA_VERSION,
    ...over,
  };
}

function snap(path: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    path,
    role: 'engine',
    displayName: path,
    status: 'idle',
    children: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    sessionId: path.split('/')[1] ?? 's1',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// SessionStore
// ─────────────────────────────────────────────────────────────

describe('SessionStore · CRUD 与副本纪律', () => {
  it('写入与读出都是副本：改返回的对象不影响库里的记录', () => {
    const store = new SessionStore();
    const created = store.create(record('s1'));
    created.title = '被外部改过';
    expect(store.get('s1')?.title).toBe('会话 s1');

    const read = store.get('s1')!;
    read.title = '又被改了';
    expect(store.get('s1')?.title).toBe('会话 s1');
  });

  it('list 按创建时间倒序（最近的在前），limit 截断', () => {
    const store = new SessionStore();
    store.create(record('s1', { createdAt: 100 }));
    store.create(record('s3', { createdAt: 300 }));
    store.create(record('s2', { createdAt: 200 }));
    expect(store.list().map((r) => r.id)).toEqual(['s3', 's2', 's1']);
    expect(store.list({ limit: 2 }).map((r) => r.id)).toEqual(['s3', 's2']);
  });

  it('同毫秒创建时按 id 兜底排序（保证稳定，不靠 Map 插入序）', () => {
    const store = new SessionStore();
    store.create(record('sa', { createdAt: 100 }));
    store.create(record('sb', { createdAt: 100 }));
    // 同 createdAt 时 id 大的在前：与「id 前缀是 base36 时间戳」的直觉一致。
    expect(store.list({ limit: 1 }).map((r) => r.id)).toEqual(['sb']);
  });

  it('按状态过滤；all 是缺省', () => {
    const store = new SessionStore();
    store.create(record('s1'));
    store.create(record('s2', { status: 'closed' }));
    expect(store.list({ status: 'open' }).map((r) => r.id)).toEqual(['s1']);
    expect(store.list({ status: 'closed' }).map((r) => r.id)).toEqual(['s2']);
    expect(store.list().length).toBe(2);
  });

  it('update 忽略 undefined（区别于「置空」），并推进 updatedAt', () => {
    let now = 5_000;
    const store = new SessionStore({ now: () => now });
    store.create(record('s1', { createdAt: 100, updatedAt: 100 }));
    const after = store.update('s1', { title: '新标题', budget: undefined });
    expect(after?.title).toBe('新标题');
    expect(after?.budget).toBeUndefined();
    expect(after?.updatedAt).toBe(5_000);
    expect(store.update('ghost', { title: 'x' })).toBeUndefined();
  });

  it('remove 返回被删记录；再删同 id 返回 undefined', () => {
    const store = new SessionStore();
    store.create(record('s1'));
    expect(store.remove('s1')?.id).toBe('s1');
    expect(store.remove('s1')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('M5 起不再淘汰：会话不会「自己消失」（返回条数由 list.limit 决定）', () => {
    const store = new SessionStore();
    for (let i = 1; i <= 250; i += 1) store.create(record(`s${i}`, { createdAt: i }));

    expect(store.size).toBe(250);
    expect(store.has('s1')).toBe(true);
    expect(store.list().length).toBe(50); // 缺省 50（R9）
    expect(store.list({ limit: 3 }).map((r) => r.id)).toEqual(['s250', 's249', 's248']);
  });
});

// ─────────────────────────────────────────────────────────────
// M5 切片 3：装载与落盘回调
// ─────────────────────────────────────────────────────────────

describe('SessionStore · 装载与 onChange（M5）', () => {
  it('构造时注入 records（启动装载）；同 id 不覆盖', () => {
    const store = new SessionStore({
      records: [record('s1', { title: '磁盘上的' }), record('s2')],
    });
    expect(store.size).toBe(2);
    store.load([record('s1', { title: '后来的' })]);
    expect(store.get('s1')?.title).toBe('磁盘上的');
  });

  it('load() 不触发 onChange（否则每次启动都会重写全部 session.json）', () => {
    const events: string[] = [];
    const store = new SessionStore({ onChange: (e) => events.push(e.kind) });
    store.load([record('s1')]);
    expect(events).toEqual([]);
  });

  it('create / update / remove 各触发一次，带记录副本', () => {
    const events: { kind: string; id: string; title: string }[] = [];
    const store = new SessionStore({
      now: () => 9_000,
      onChange: (e) => events.push({ kind: e.kind, id: e.record.id, title: e.record.title }),
    });
    store.create(record('s1', { title: 'A' }));
    store.update('s1', { title: 'B' });
    store.remove('s1');

    expect(events).toEqual([
      { kind: 'create', id: 's1', title: 'A' },
      { kind: 'update', id: 's1', title: 'B' },
      { kind: 'remove', id: 's1', title: 'B' },
    ]);
    expect(store.size).toBe(0);
  });

  it('update 未命中不触发（没有记录就没有落盘）', () => {
    let calls = 0;
    const store = new SessionStore({ onChange: () => { calls += 1; } });
    store.update('ghost', { title: 'x' });
    store.remove('ghost');
    expect(calls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 标题
// ─────────────────────────────────────────────────────────────

describe('titleFromPrompt —— 单行化 + 截断', () => {
  it('折叠空白（换行会让左栏列表高矮不一）', () => {
    expect(titleFromPrompt('把 apps/api 的\n支付回调  改成幂等')).toBe(
      '把 apps/api 的 支付回调 改成幂等',
    );
  });

  it('超长截断到 max 并加省略号', () => {
    const long = 'x'.repeat(100);
    const t = titleFromPrompt(long);
    expect(t.length).toBe(SESSION_TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
  });

  it('正好等于上限时不截断（边界不多加一个省略号）', () => {
    const exact = 'y'.repeat(SESSION_TITLE_MAX);
    expect(titleFromPrompt(exact)).toBe(exact);
  });

  it('只有空白 → 空串（调用方据此拒绝空标题）', () => {
    expect(titleFromPrompt('   \n\t ')).toBe('');
  });
});
// ─────────────────────────────────────────────────────────────
// 三层预算（G10.4）
// ─────────────────────────────────────────────────────────────

describe('computeEffectiveBudget · 三层取更严者', () => {
  it('三档都没写 ⇒ 不设限（0），档位 ok，没有「受谁限制」', () => {
    const v = computeEffectiveBudget({ global: {} }, 5);
    expect(v.effectiveHardUsd).toBe(0);
    expect(v.effectiveSoftUsd).toBe(0);
    expect(v.tier).toBe('ok');
    expect(v.limitedBy).toBeUndefined();
  });

  it('只写全局硬线：软线缺省 = 硬线 × 0.8，两步跃迁', () => {
    expect(computeEffectiveBudget({ global: { hardUsd: 10 } }, 7.9).tier).toBe('ok');
    expect(computeEffectiveBudget({ global: { hardUsd: 10 } }, 8).tier).toBe('warning');
    expect(computeEffectiveBudget({ global: { hardUsd: 10 } }, 10).tier).toBe('frozen');
  });

  it('0 与缺省同义（不设）；负数是坏数据也当不设', () => {
    const v = computeEffectiveBudget({ global: { hardUsd: 0, softUsd: -3 } }, 100);
    expect(v.effectiveHardUsd).toBe(0);
    expect(v.tier).toBe('ok');
  });

  it('团队线比全局线更严 ⇒ 生效值取团队，limitedBy=team', () => {
    const v = computeEffectiveBudget({ global: { hardUsd: 10 }, team: { hardUsd: 4 } }, 3);
    expect(v.effectiveHardUsd).toBe(4);
    expect(v.limitedBy).toBe('team');
    expect(v.effectiveSoftUsd).toBe(3.2); // 团队软线缺省 = 4 × 0.8
  });

  it('会话线更严 ⇒ limitedBy=session；更松则被忽略（可下调不可上调）', () => {
    const stricter = computeEffectiveBudget(
      { global: { hardUsd: 10 }, self: { hardUsd: 2 } },
      0,
    );
    expect(stricter.effectiveHardUsd).toBe(2);
    expect(stricter.limitedBy).toBe('session');

    const looser = computeEffectiveBudget(
      { global: { hardUsd: 10 }, self: { hardUsd: 99 } },
      0,
    );
    expect(looser.effectiveHardUsd).toBe(10);
    expect(looser.limitedBy).toBe('global');
  });

  it('软线**逐层算完再取严**：团队只写软线、全局只写硬线也不出错', () => {
    // 全局：软 8（10×0.8）；团队：软 1（显式）。取严 ⇒ 1。
    const v = computeEffectiveBudget(
      { global: { hardUsd: 10 }, team: { softUsd: 1 } },
      1,
    );
    expect(v.effectiveHardUsd).toBe(10);
    expect(v.effectiveSoftUsd).toBe(1);
    expect(v.tier).toBe('warning');
    // 拿最终硬线反推软线会得到 8 —— 那是错的，这条用例就是防它的。
  });

  it('显式软线优先于推导值（同层）', () => {
    const v = computeEffectiveBudget({ global: { hardUsd: 10, softUsd: 9 } }, 8);
    expect(v.effectiveSoftUsd).toBe(9);
    expect(v.tier).toBe('ok');
  });

  it('把三档原样带出来（UI 要能解释「为什么是 $1.50」）', () => {
    const v = computeEffectiveBudget(
      { global: { hardUsd: 10 }, team: { hardUsd: 1.5 }, self: { hardUsd: 3 } },
      0,
    );
    expect(v.global).toEqual({ hardUsd: 10 });
    expect(v.team).toEqual({ hardUsd: 1.5 });
    expect(v.self).toEqual({ hardUsd: 3 });
  });

  it('spentUsd 原样回传（会话已花来自会话根快照）', () => {
    expect(computeEffectiveBudget({ global: {} }, 1.234).spentUsd).toBe(1.234);
  });
});

// ─────────────────────────────────────────────────────────────
// 会话摘要
// ─────────────────────────────────────────────────────────────

const ROOT = '/s1';
const pending = (path: string): PendingRequest => ({
  requestId: `r-${path}`,
  sessionId: 's1',
  origin: path,
  chain: [path, ROOT],
  tool: 'bash',
  args: {},
  approvalMode: 'always_ask',
  message: `${path} 请求执行工具 bash`,
  at: 1_000,
  state: 'pending',
  kind: 'approval',
});

describe('buildSessionSummary · 计数口径', () => {
  const members: AgentSnapshot[] = [
    snap(ROOT, { role: 'lead', displayName: '团队主控', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } }),
    snap(`${ROOT}/dev-1`, { status: 'running' }),
    snap(`${ROOT}/tester-1`, { status: 'waiting' }),
    snap(`${ROOT}/architect-1`, { status: 'waiting', waitingOn: [`${ROOT}/architect-1/dev-2`] }),
    snap(`${ROOT}/done-1`, { status: 'done' }),
  ];

  it('members 不含会话根（用户眼里「成员」指它带的人）', () => {
    const s = buildSessionSummary({
      record: record('s1'),
      rootPath: ROOT,
      status: 'idle',
      members,
      ledgerCount: 3,
      pending: [],
      globalBudget: {},
    });
    expect(s.counts.members).toBe(4);
    expect(s.counts.running).toBe(1);
    expect(s.counts.ledger).toBe(3);
  });

  it('parked（排队等额度）与 suspended（父在等后代）分开算', () => {
    const s = buildSessionSummary({
      record: record('s1'),
      rootPath: ROOT,
      status: 'idle',
      members,
      ledgerCount: 0,
      pending: [],
      globalBudget: {},
    });
    expect(s.counts.parked).toBe(1); // tester-1：waiting 且没在等谁
    expect(s.counts.suspended).toBe(1); // architect-1：waiting 且在等 dev-2
  });

  it('usage 取会话根快照（父链已汇总），预算档由它算', () => {
    const s = buildSessionSummary({
      record: record('s1'),
      rootPath: ROOT,
      status: 'idle',
      members,
      ledgerCount: 0,
      pending: [],
      globalBudget: { hardUsd: 0.6 },
    });
    expect(s.usage.costUsd).toBe(0.5);
    // 硬线 0.6 的软线是 0.48：0.5 过软线=warning，还没到硬线
    expect(s.budget.tier).toBe('warning');
    expect(s.budget.spentUsd).toBe(0.5);
  });

  it('pending 只算本会话的（调用方已过滤，这里只计长度）', () => {
    const s = buildSessionSummary({
      record: record('s1'),
      rootPath: ROOT,
      status: 'idle',
      members,
      ledgerCount: 0,
      pending: [pending(`${ROOT}/dev-1`), pending(`${ROOT}/tester-1`)],
      globalBudget: {},
    });
    expect(s.counts.pending).toBe(2);
  });

  it('根不在成员里 ⇒ usage 归零（不冒充一份假数字）', () => {
    const s = buildSessionSummary({
      record: record('s1'),
      rootPath: ROOT,
      status: 'idle',
      members: [snap(`${ROOT}/dev-1`)],
      ledgerCount: 0,
      pending: [],
      globalBudget: {},
    });
    expect(s.usage.costUsd).toBe(0);
    expect(s.counts.members).toBe(1);
  });

  it('团队引用带 tempCount（临时成员不算团队成员）', () => {
    const s = buildSessionSummary({
      record: record('s1', { executor: 'team', teamId: '全栈小队' }),
      rootPath: ROOT,
      status: 'idle',
      members,
      ledgerCount: 0,
      pending: [],
      globalBudget: {},
      team: {
        name: '全栈小队',
        description: '',
        members: [
          { name: '主控', role: 'lead', lead: true },
          { name: '开发者', role: 'developer' },
        ],
      },
      tempCount: 2,
    });
    expect(s.team).toEqual({ id: '全栈小队', name: '全栈小队', memberCount: 2, tempCount: 2 });
  });

  it('status 是运行时事实，与 record.status（用户意志）分开', () => {
    const s = buildSessionSummary({
      record: record('s1', { status: 'closed' }),
      rootPath: ROOT,
      status: 'running',
      members,
      ledgerCount: 0,
      pending: [],
      globalBudget: {},
    });
    expect(s.record.status).toBe('closed');
    expect(s.status).toBe('running');
  });
});

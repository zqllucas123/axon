import { describe, expect, test } from 'vitest';
import { Ledger, truncateSummary } from './ledger.ts';
import { LEDGER_SCHEMA_VERSION, type UsageTotals } from '@axon/protocol';

function makeLedger(opts: { maxRecords?: number } = {}) {
  let t = 1_000;
  let n = 0;
  return new Ledger({
    now: () => (t += 10),
    suffix: () => `s${(n += 1)}`,
    maxRecords: opts.maxRecords,
  });
}

const usage = (input: number, output: number, cost: number): UsageTotals => ({
  inputTokens: input,
  outputTokens: output,
  costUsd: cost,
});

describe('Ledger.record', () => {
  test('落一笔 delegate：open + pending + mention URI + schema 版本', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/planner-1',
      to: '/root/planner-1/developer-1',
      origin: { tool: 'agent', toolCallId: 'call_1' },
      contextScope: 'none',
    });

    expect(r.version).toBe(LEDGER_SCHEMA_VERSION);
    expect(r.status).toBe('open');
    expect(r.adoption).toBe('pending');
    expect(r.mention).toBe('mention://agent-session/root/planner-1/developer-1');
    expect(r.contextScope).toBe('none');
  });

  test('fork 与 handoff 无需裁决，直接 not_applicable', () => {
    const ledger = makeLedger();
    const fork = ledger.record({
      action: 'fork',
      from: '/root/a-1',
      to: '/root/a-1/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    const handoff = ledger.record({
      action: 'handoff',
      from: '/root/a-1',
      to: '/root/a-1/b-1',
      origin: { tool: 'agent_resume', toolCallId: 'c2' },
    });
    expect(fork.adoption).toBe('not_applicable');
    expect(handoff.adoption).toBe('not_applicable');
  });

  test('同一 toolCallId 重复落账幂等 —— 账上不出现两行同源记录', () => {
    const ledger = makeLedger();
    const first = ledger.record({
      action: 'consult',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent_message', toolCallId: 'dup' },
    });
    const second = ledger.record({
      action: 'consult',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent_message', toolCallId: 'dup' },
    });
    expect(second.id).toBe(first.id);
    expect(ledger.size).toBe(1);
  });

  test('id 的字典序与时间序一致（补零），否则 before 游标翻页会乱', () => {
    const ledger = makeLedger();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        ledger.record({
          action: 'consult',
          from: '/root/a-1',
          to: '/root/b-1',
          origin: { tool: 'agent_message', toolCallId: `c${i}` },
        }).id,
      );
    }
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('Ledger.settle', () => {
  test('结算写入 usage 增量（不是累计值）与截断后的摘要', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
      usageBaseline: usage(100, 50, 0.01),
    });

    const settled = ledger.settle(r.id, {
      usageNow: usage(340, 210, 0.043),
      summary: '  方案已完成  ',
    });

    expect(settled?.status).toBe('settled');
    expect(settled?.usage?.inputTokens).toBe(240);
    expect(settled?.usage?.outputTokens).toBe(160);
    expect(settled?.usage?.costUsd).toBeCloseTo(0.033, 10);
    expect(settled?.summary).toBe('方案已完成');
    expect(settled?.settledAt).toBeGreaterThan(settled!.at);
  });

  test('子树 usage 回退（被裁剪）时增量钳到 0，不报负数', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
      usageBaseline: usage(500, 500, 1),
    });
    const settled = ledger.settle(r.id, { usageNow: usage(100, 100, 0.2) });
    expect(settled?.usage).toEqual(usage(0, 0, 0));
  });

  test('重复 settle 是 no-op —— 中断与终态可能连着来', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    const first = ledger.settle(r.id, { summary: '第一次' });
    const second = ledger.settle(r.id, { summary: '第二次' });
    expect(second?.summary).toBe('第一次');
    expect(second?.settledAt).toBe(first!.settledAt);
  });

  test('settle 不存在的记录返回 null', () => {
    expect(makeLedger().settle('nope')).toBeNull();
  });

  test('openRecordsFor 只返回该 agent 作为 to 且未结算的记录', () => {
    const ledger = makeLedger();
    const a = ledger.record({
      action: 'delegate',
      from: '/root/p-1',
      to: '/root/p-1/d-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    ledger.record({
      action: 'delegate',
      from: '/root/p-1',
      to: '/root/p-1/d-2',
      origin: { tool: 'agent', toolCallId: 'c2' },
    });
    const settled = ledger.record({
      action: 'consult',
      from: '/root/p-1',
      to: '/root/p-1/d-1',
      origin: { tool: 'agent_message', toolCallId: 'c3' },
    });
    ledger.settle(settled.id);

    const open = ledger.openRecordsFor('/root/p-1/d-1');
    expect(open.map((r) => r.id)).toEqual([a.id]);
  });
});

describe('Ledger.adopt', () => {
  test('人工裁决留 human 署名', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    const adopted = ledger.adopt(r.id, 'adopted', { kind: 'human' }, '看过了');
    expect(adopted?.adoption).toBe('adopted');
    expect(adopted?.adoptedBy).toEqual({ kind: 'human' });
    expect(adopted?.adoptedNote).toBe('看过了');
  });

  test('自动裁决留 agent 署名 —— 账上必须能与人工裁决区分', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    const adopted = ledger.adopt(r.id, 'rejected', {
      kind: 'agent',
      path: '/root/aligner-1',
      policyAt: 999,
    });
    expect(adopted?.adoptedBy).toEqual({
      kind: 'agent',
      path: '/root/aligner-1',
      policyAt: 999,
    });
  });

  test('markArbitrationSent 幂等：同一记录只派发一次裁决请求', () => {
    const ledger = makeLedger();
    const r = ledger.record({
      action: 'delegate',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    expect(ledger.markArbitrationSent(r.id)).toBe(true);
    expect(ledger.markArbitrationSent(r.id)).toBe(false);
  });
});

describe('Ledger.query', () => {
  function seeded() {
    const ledger = makeLedger();
    ledger.record({
      action: 'delegate',
      from: '/root/p-1',
      to: '/root/p-1/d-1',
      origin: { tool: 'agent', toolCallId: 'c1' },
    });
    ledger.record({
      action: 'fork',
      from: '/root/p-1',
      to: '/root/p-1/d-2',
      origin: { tool: 'agent', toolCallId: 'c2' },
    });
    ledger.record({
      action: 'consult',
      from: '/root/q-1',
      to: '/root/q-1/e-1',
      origin: { tool: 'agent_message', toolCallId: 'c3' },
    });
    return ledger;
  }

  test('默认按时间倒序，最新在前', () => {
    const out = seeded().query();
    expect(out.total).toBe(3);
    expect(out.records[0]?.origin.toolCallId).toBe('c3');
  });

  test('agent 精确匹配只看 from/to 两端', () => {
    const out = seeded().query({ agent: '/root/p-1/d-1' });
    expect(out.records.map((r) => r.origin.toolCallId)).toEqual(['c1']);
  });

  test('subtree 把子树内的 agent 也算命中', () => {
    const out = seeded().query({ agent: '/root/p-1', subtree: true });
    expect(out.total).toBe(2);
    expect(out.records.map((r) => r.action).sort()).toEqual(['delegate', 'fork']);
  });

  test('action 与 adoption 过滤', () => {
    const ledger = seeded();
    expect(ledger.query({ action: ['fork'] }).total).toBe(1);
    expect(ledger.query({ adoption: ['not_applicable'] }).total).toBe(1);
    expect(ledger.query({ adoption: ['pending'] }).total).toBe(2);
  });

  test('status 过滤跟随 settle', () => {
    const ledger = seeded();
    const first = ledger.query({ action: ['delegate'] }).records[0]!;
    ledger.settle(first.id);
    expect(ledger.query({ status: ['settled'] }).total).toBe(1);
    expect(ledger.query({ status: ['open'] }).total).toBe(2);
  });

  test('limit 与 before 游标分页；total 不受分页影响', () => {
    const ledger = makeLedger();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        ledger.record({
          action: 'consult',
          from: '/root/a-1',
          to: '/root/b-1',
          origin: { tool: 'agent_message', toolCallId: `c${i}` },
        }).id,
      );
    }
    const page1 = ledger.query({ limit: 2 });
    expect(page1.total).toBe(5);
    expect(page1.records.map((r) => r.id)).toEqual([ids[4], ids[3]]);

    const page2 = ledger.query({ limit: 2, before: page1.records[1]!.id });
    expect(page2.records.map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });

  test('查询返回的是拷贝，外部改动污染不了账本', () => {
    const ledger = seeded();
    const got = ledger.query().records[0]!;
    got.adoption = 'adopted';
    expect(ledger.get(got.id)?.adoption).toBe('pending');
  });
});

describe('Ledger 上限', () => {
  test('超出上限丢最旧并计数，幂等键一并清理', () => {
    const ledger = makeLedger({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) {
      ledger.record({
        action: 'consult',
        from: '/root/a-1',
        to: '/root/b-1',
        origin: { tool: 'agent_message', toolCallId: `c${i}` },
      });
    }
    expect(ledger.size).toBe(3);
    expect(ledger.dropped).toBe(2);
    // 最旧的两条已被逐出，其 toolCallId 不再命中幂等键，可重新落账
    const again = ledger.record({
      action: 'consult',
      from: '/root/a-1',
      to: '/root/b-1',
      origin: { tool: 'agent_message', toolCallId: 'c0' },
    });
    expect(again.origin.toolCallId).toBe('c0');
    expect(ledger.size).toBe(3);
  });
});

describe('truncateSummary', () => {
  test('超长截断并加省略号，短的原样', () => {
    expect(truncateSummary('abc', 10)).toBe('abc');
    expect(truncateSummary('abcdefghijk', 5)).toBe('abcde…');
  });
});

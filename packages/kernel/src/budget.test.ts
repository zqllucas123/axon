/**
 * BudgetGuard 单测 —— 阈值跃迁只报一次 + 熔断关闭语义。
 */

import { describe, expect, it } from 'vitest';
import { BudgetGuard } from './budget.ts';

describe('BudgetGuard —— 阈值跃迁', () => {
  it('先越软线报 warning，再越硬线报 frozen，各自只报一次', () => {
    const g = new BudgetGuard({ hardUsd: 10 });
    expect(g.current).toBe('ok');

    expect(g.record(5)).toBe('none');
    expect(g.current).toBe('ok');

    // 软线 = 8（默认 hard × 0.8）
    expect(g.record(8)).toBe('warning');
    expect(g.record(8.5)).toBe('none'); // 同档不动
    expect(g.current).toBe('warning');

    expect(g.record(10)).toBe('frozen');
    expect(g.record(99)).toBe('none'); // 冻结后不再升级
    expect(g.current).toBe('frozen');
  });

  it('一步跨过软线直接到硬线只报 frozen', () => {
    const g = new BudgetGuard({ hardUsd: 1 });
    expect(g.record(5)).toBe('frozen');
    expect(g.record(6)).toBe('none');
  });

  it('显式软线覆盖默认', () => {
    const g = new BudgetGuard({ softUsd: 3, hardUsd: 10 });
    expect(g.record(3)).toBe('warning');
  });

  it('hardUsd <= 0 表示熔断关闭', () => {
    const g = new BudgetGuard({ hardUsd: 0 });
    expect(g.disabled).toBe(true);
    expect(g.record(1e9)).toBe('none');
    expect(g.current).toBe('ok');
    expect(() => g.assertCanStart('spawn')).not.toThrow();
  });
});

describe('BudgetGuard —— 新起点闸', () => {
  it('冻结后 refuse 新起点，警告档不拦', () => {
    const g = new BudgetGuard({ hardUsd: 10 });
    g.record(8);
    expect(() => g.assertCanStart('spawn')).not.toThrow();

    g.record(10);
    expect(() => g.assertCanStart('spawn')).toThrow(/预算已冻结/);
    expect(() => g.assertCanStart('prompt')).toThrow(/拒绝新的prompt/);
  });
});
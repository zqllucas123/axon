/**
 * BudgetGuard —— token 成本预算熔断（01 §8「多 Agent 并发下的 token 成本失控」的落地）。
 *
 * 纯逻辑、无 pi import、无副作用：记录累计花费，越过阈值只报告**跃迁**。
 *
 * 语义：
 *  - soft 线（默认 hard × 0.8）：第一次越过发 `warning`，之后保持
 *  - hard 线：第一次越过发 `frozen`，之后保持——frozen 即「拒绝新起点」
 *  - hardUsd <= 0 表示熔断关闭（永不冻结），便于测试与开发环境
 *
 * 接线点本来在 M1 就预留好了：`wire()` 的 turn_end 里 `registry.addUsage` 之后
 * 记一笔 root 累计（root 是全局总账），跃迁时发协议事件 `budget.warning` /
 * `budget.frozen`（事件字段 `usage + limitUsd` 在 protocol/ipc.ts 早已声明）。
 */

export type BudgetState = 'ok' | 'warning' | 'frozen';
export type BudgetTransition = 'none' | 'warning' | 'frozen';

export interface BudgetLimits {
  /** 软线（美元）。省略 = hard × 0.8。 */
  softUsd?: number;
  /** 硬线（美元）；<= 0 表示熔断关闭。 */
  hardUsd: number;
}

export class BudgetGuard {
  private readonly softUsd: number;
  private readonly hardUsd: number;
  private spentUsd = 0;
  private state: BudgetState = 'ok';

  constructor(limits: BudgetLimits) {
    this.hardUsd = limits.hardUsd;
    this.softUsd =
      limits.softUsd ?? (limits.hardUsd > 0 ? limits.hardUsd * 0.8 : 0);
  }

  get disabled(): boolean {
    return this.hardUsd <= 0;
  }

  /** 当前档位。 */
  get current(): BudgetState {
    return this.state;
  }

  /** 累计花费（美元）。 */
  get spent(): number {
    return this.spentUsd;
  }

  /**
   * 记录**累计**花费（不是增量——直接吃 root 快照里的 usage.costUsd）。
   * 返回本次造成的跃迁；同一阈值只报一次。
   */
  record(cumulativeUsd: number): BudgetTransition {
    this.spentUsd = cumulativeUsd;
    if (!this.disabled) {
      if (this.state !== 'frozen' && cumulativeUsd >= this.hardUsd) {
        // 从 ok 或 warning 直接越过硬线都只报 frozen（一步跨软线不补报 warning）
        this.state = 'frozen';
        return 'frozen';
      }
      if (this.state === 'ok' && cumulativeUsd >= this.softUsd) {
        this.state = 'warning';
        return 'warning';
      }
    }
    return 'none';
  }

  /**
   * 新起点闸：赔偿结算后确定还能不能开工。frozen 时返回错误原因给调用方。
   *
   * > 设计决策（M3 #4）：硬线冻结只挡「新起点」（spawn / prompt），在跑 Agent 不杀。
   * > 半截活比超支更糟——模型在跑任务的钱已经花了，砍掉反而两头亏。
   */
  assertCanStart(context: string): void {
    if (!this.disabled && this.state === 'frozen') {
      throw new Error(
        `预算已冻结（累计 $${this.spentUsd.toFixed(4)} ≥ $${this.hardUsd.toFixed(4)}），拒绝新的${context}`,
      );
    }
  }
}
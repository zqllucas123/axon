/**
 * AutoAdoption —— 裁决权委派的资格校验与 arbiter 解析（M4 决策 D2）。
 *
 * 用户拍板：默认人工表态，但允许开全局开关把决策权交给指定 Agent。
 * 「交给 Agent」若不设边界，就退化成 01 §6.4 反对的那个天窗
 * （Agent 自己批准自己的协作成果）。所以这里钉死两条：
 *
 *   1. 裁决者不得是被裁决方 `to`，也不得是 `to` 的后代
 *      —— adoption 裁的就是「to 的产出该不该被采纳」，自己或自己的下属
 *         来盖章等于自己给自己发合格证。
 *      —— `arbiter === from` 是**允许**的：发起方判断成果好不好，
 *         本来就是正当的编排语义。
 *   2. 不合格时**回落人工**并写明原因，不静默失败也不硬批。
 *
 * 第三条（裁决权靠工具行使、host 在运行期校验身份）落在 host 的
 * driver.adoptCollab 与 orchestrator 的 ledger_adopt 上。
 */

import {
  isAncestorOf,
  type AdoptionPolicy,
  type AgentPath,
  type AgentSnapshot,
  type LedgerRecord,
} from '@axon/protocol';

export type ArbiterResolution =
  | { kind: 'human'; reason?: string }
  | { kind: 'agent'; path: AgentPath };

export interface ArbiterContext {
  /** 当前存活的全部 agent 快照。 */
  agents: () => AgentSnapshot[];
  exists: (path: AgentPath) => boolean;
}

/**
 * 按角色名找 arbiter：取该角色**最早创建**的存活实例。
 *
 * 为什么是最早而不是最新：策略配置的语义是「让 aligner 来裁决」，
 * 用户心里想的是那一个长期在场的对齐者。挑最新会让每次 spawn 新实例
 * 都悄悄改变裁决者，账上署名跳来跳去无法追责。
 */
export function findArbiterByRole(
  ctx: ArbiterContext,
  role: string,
): AgentPath | undefined {
  const candidates = ctx
    .agents()
    .filter((a) => a.role === role)
    .sort((a, b) => a.createdAt - b.createdAt || (a.path < b.path ? -1 : 1));
  return candidates[0]?.path;
}

/**
 * 判定某条记录该由谁裁决。
 *
 * 任何一步走不通都回落 human 并带上原因 —— 记录会保持 pending
 * 等人来点，而不是被悄悄放过。
 */
export function resolveArbiter(
  policy: AdoptionPolicy,
  record: Pick<LedgerRecord, 'from' | 'to'>,
  ctx: ArbiterContext,
): ArbiterResolution {
  if (policy.mode === 'human') return { kind: 'human' };

  let arbiter: AgentPath | undefined;
  if ('arbiter' in policy) {
    arbiter = policy.arbiter;
    if (!ctx.exists(arbiter)) {
      return { kind: 'human', reason: `裁决者 ${arbiter} 已不存在，回落人工裁决` };
    }
  } else {
    arbiter = findArbiterByRole(ctx, policy.arbiterRole);
    if (!arbiter) {
      return {
        kind: 'human',
        reason: `找不到角色 ${policy.arbiterRole} 的存活实例，回落人工裁决`,
      };
    }
  }

  const ineligible = arbiterIneligibleReason(arbiter, record);
  if (ineligible) return { kind: 'human', reason: ineligible };

  return { kind: 'agent', path: arbiter };
}

/**
 * 资格校验的唯一真相。返回 undefined 表示合格。
 *
 * host 在两个地方复用它：派发裁决请求前（决定发不发），
 * 以及 `ledger_adopt` 工具 execute 时（决定认不认）。两处必须同源，
 * 否则会出现「发得出去但认不下来」的僵局。
 */
export function arbiterIneligibleReason(
  arbiter: AgentPath,
  record: Pick<LedgerRecord, 'from' | 'to'>,
): string | undefined {
  if (arbiter === record.to) {
    return `裁决者 ${arbiter} 就是被裁决方，不能自己给自己的产出盖章`;
  }
  if (isAncestorOf(record.to, arbiter)) {
    return `裁决者 ${arbiter} 是被裁决方 ${record.to} 的后代，不能给上级的产出盖章`;
  }
  return undefined;
}

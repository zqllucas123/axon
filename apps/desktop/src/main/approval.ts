/**
 * ApprovalBroker —— 工具执行前的 HITL 门与审批父链穿透（M4）。
 *
 * 为什么放在 app 层而不是 kernel：它要读角色的 approval 档、要沿 registry 的
 * 父链向上走、要发 IPC 事件——都是宿主编排职责。塞进 kernel 会把 registry
 * 依赖拖进内核（Ledger 是纯数据结构才留在 kernel）。
 *
 * ── 穿透语义（抄 TabTin `permissions/subagent-hitl.ts:9-17`）──
 *
 * 子 Agent 的审批请求不是独立的，它走父亲的通道。父亲若已获授权
 * （full_access / auto），就替它做主，不必惊动人：
 *
 *   always_ask 的 agent 想动手
 *     → 沿父链向上找第一个「能替它做主」的节点
 *         父档 full_access / auto ⇒ 父代批，放行
 *         父档也是 always_ask     ⇒ 继续向上
 *     → 到 root 仍没人代批 ⇒ 发 approval.request 给人
 *
 * ── D5：只拦叶子工具，不拦编排工具 ──
 *
 * 七个编排工具（agent / agent_wait / … / ledger_adopt）**豁免**。
 * 理由很硬：tools universe 里叶子工具目前是空的，若拦编排工具，
 * 四个 always_ask 内置角色一 spawn 就卡住等人批，M3 的 E2E 与真模型
 * 尖峰全部失效。等 M6/M7 有了真叶子工具再谈放开。
 */

import {
  parentPath,
  sessionIdOfPath,
  type AgentPath,
  type ApprovalMode,
  type EventMap,
  type PendingRequest,
} from '@axon/protocol';
import type { ToolGateResult } from '@axon/kernel';
import { ORCHESTRATION_TOOL_NAMES } from './orchestrator.ts';

const ORCHESTRATION_TOOLS = new Set<string>(ORCHESTRATION_TOOL_NAMES);

/** 审批请求默认超时 300s；超时按拒绝处理并把原因回灌给模型。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export interface ApprovalBrokerOptions {
  /** 查某 agent 生效的审批档；agent 不存在或无角色返回 undefined。 */
  approvalModeOf: (path: AgentPath) => ApprovalMode | undefined;
  /** 该 agent 是否还存在（remove 之后要取消其挂起请求）。 */
  exists: (path: AgentPath) => boolean;
  emit: <E extends keyof EventMap>(event: E, payload: EventMap[E], source?: AgentPath) => void;
  /** 等人批期间把该 agent 挂出/收回 idle 看门狗的视野。 */
  onWaitStart?: (path: AgentPath) => void;
  onWaitEnd?: (path: AgentPath) => void;
  timeoutMs?: number;
  now?: () => number;
}

interface Entry {
  request: PendingRequest;
  resolve: (r: ToolGateResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ApprovalDecision {
  /** 放行/拒绝。 */
  allow: boolean;
  /** 谁做的决定（human 或代批的祖先），用于日志与调试。 */
  decidedBy: 'self' | 'ancestor' | 'human' | 'timeout' | 'cancelled' | 'exempt';
  ancestor?: AgentPath;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Entry>();
  private readonly opts: ApprovalBrokerOptions;
  /** 可热改（S8 的「审批超时」）：保存配置后新请求立刻用新值。 */
  private timeoutMs: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(options: ApprovalBrokerOptions) {
    this.opts = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 改审批超时（毫秒）；0 = 不超时。只影响**之后**的请求。 */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms > 0 ? ms : 0;
  }

  get currentTimeoutMs(): number {
    return this.timeoutMs;
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ allow: false, reason: '宿主已关闭，审批请求作废' });
    }
    this.pending.clear();
  }

  /**
   * 计算穿透结果，不产生副作用 —— 便于单测把「谁代批」钉死。
   *
   * 返回 undefined 表示「没人能代批，得问人」。
   * MU-1 起它是 `delegatedApproval` 的薄封装，保留这个名字是因为测试与
   * 既有调用点都在用它（两者共用一份逻辑，不会漂移）。
   */
  resolveDelegation(origin: AgentPath): { allow: true; ancestor?: AgentPath } | undefined {
    const d = this.delegatedApproval(origin);
    if (!d) return undefined;
    return d.ancestor ? { allow: true, ancestor: d.ancestor } : { allow: true };
  }

  /** 穿透路径 origin → … → root，供 UI 说清「这个请求替谁问、经过了谁」。 */
  chainOf(origin: AgentPath): AgentPath[] {
    const chain: AgentPath[] = [origin];
    let cursor = parentPath(origin);
    while (cursor) {
      chain.push(cursor);
      cursor = parentPath(cursor);
    }
    return chain;
  }

  /**
   * 代批判定（MU-1 修②）：返回「谁会替它批」及其档位；`ancestor` 缺省表示
   * 这个 agent 自己就有放行档（自批，不是代批）。
   *
   * 从 `resolveDelegation` 里拆出来是为了让**留痕**与**判定**共用同一份逻辑：
   * gate() 拿到结果后发 `approval.delegated`，不至于出现「判定说代批了，
   * 事件说没人」这种两处漂移。
   */
  delegatedApproval(
    origin: AgentPath,
  ): { allow: true; ancestor?: AgentPath; mode: ApprovalMode } | undefined {
    const own = this.opts.approvalModeOf(origin);
    if (own === 'full_access' || own === 'auto') return { allow: true, mode: own };

    let cursor = parentPath(origin);
    while (cursor) {
      const mode = this.opts.approvalModeOf(cursor);
      // 会话根若没有角色（mode undefined）：它代表「人」，不能代批，必须落到人手上。
      if (mode === 'full_access' || mode === 'auto') {
        return { allow: true, ancestor: cursor, mode };
      }
      cursor = parentPath(cursor);
    }
    return undefined;
  }

  /**
   * HITL 门。返回可直接交给 `onBeforeTool` 的结果。
   *
   * 注意它只处理 HITL；白名单拦截在调用方（host.spawn 的 onBeforeTool）先行，
   * 两道闸互不覆盖：白名单管「能碰什么」，这里管「多大程度放手」。
   */
  async gate(origin: AgentPath, tool: string, args: unknown): Promise<ToolGateResult> {
    // D5：编排工具豁免
    if (ORCHESTRATION_TOOLS.has(tool)) return { allow: true };

    const delegated = this.delegatedApproval(origin);
    if (delegated) {
      // 修②：代批必须留痕。旧实现在这里直接 return，于是「默认配置下 HITL
      // 形同虚设」这件事在界面上完全不可见（既没有请求，也没有记录）。
      if (delegated.ancestor) {
        this.opts.emit(
          'approval.delegated',
          {
            origin,
            tool,
            approver: delegated.ancestor,
            mode: delegated.mode,
            chain: this.chainOf(origin),
            at: this.now(),
          },
          origin,
        );
      }
      return { allow: true };
    }

    const mode = this.opts.approvalModeOf(origin) ?? 'always_ask';
    const requestId = `apr-${(this.seq += 1)}`;
    const at = this.now();
    const expiresAt = this.timeoutMs > 0 ? at + this.timeoutMs : undefined;
    const chain = this.chainOf(origin);

    const request: PendingRequest = {
      requestId,
      kind: 'approval',
      // 会话归属从路径解 —— 多根模型下它就写在路径首段，不必额外传参。
      sessionId: sessionIdOfPath(origin) ?? '',
      origin,
      chain,
      tool,
      args,
      approvalMode: mode,
      message: `${origin} 请求执行工具 ${tool}`,
      at,
      expiresAt,
      state: 'pending',
    };

    return new Promise<ToolGateResult>((resolve) => {
      const entry: Entry = { request, resolve };
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // 超时按拒绝：原因回灌给模型，它自行纠偏（pi 把 deny reason 变成
          // error toolResult）。静默挂死才是最坏的选择。
          this.finish(requestId, 'expired', {
            allow: false,
            reason: `审批请求超时（${Math.round(this.timeoutMs / 1000)}s 无人响应），本次执行被拒绝`,
          });
        }, this.timeoutMs);
      }
      this.pending.set(requestId, entry);
      this.opts.onWaitStart?.(origin);
      this.opts.emit(
        'approval.request',
        {
          requestId,
          sessionId: request.sessionId,
          origin,
          chain,
          tool,
          args,
          approvalMode: mode,
          message: request.message,
        },
        origin,
      );
    });
  }

  /**
   * 人的回应。幂等：重复 respond 同一 requestId 直接返回，不重复 resolve。
   * 未知 requestId 也返回 accepted —— UI 可能在超时后才点，不该给它报错。
   */
  respond(requestId: string, approved: boolean, note?: string): { accepted: true } {
    this.finish(
      requestId,
      approved ? 'approved' : 'denied',
      approved
        ? { allow: true }
        : { allow: false, reason: note ?? '用户拒绝了本次工具执行' },
    );
    return { accepted: true };
  }

  /** agent 被删/被中断时取消其挂起请求，避免 UI 里留幽灵待办。 */
  cancelFor(path: AgentPath): void {
    for (const [id, entry] of [...this.pending]) {
      const origin = entry.request.origin;
      if (origin === path || origin.startsWith(`${path}/`)) {
        this.finish(id, 'cancelled', { allow: false, reason: 'Agent 已被移除，审批作废' });
      }
    }
  }

  list(): PendingRequest[] {
    // 顺带清掉已消失 agent 的请求：UI 刷新后补拉时不该看到幽灵。
    for (const [id, entry] of [...this.pending]) {
      if (!this.opts.exists(entry.request.origin)) {
        this.finish(id, 'cancelled', { allow: false, reason: 'Agent 已不存在，审批作废' });
      }
    }
    return [...this.pending.values()].map((e) => ({ ...e.request }));
  }

  get size(): number {
    return this.pending.size;
  }

  private finish(
    requestId: string,
    outcome: EventMap['pending.resolved']['outcome'],
    result: ToolGateResult,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // 幂等：已结过的请求再来一次是 no-op
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    this.opts.onWaitEnd?.(entry.request.origin);
    entry.resolve(result);
    this.opts.emit('pending.resolved', { requestId, outcome }, entry.request.origin);
  }
}

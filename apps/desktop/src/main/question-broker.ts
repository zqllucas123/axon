/**
 * QuestionBroker —— 主管 Agent 向用户提问的通道（M11 §2）。
 *
 * 与 ApprovalBroker 并列：审批管「可不可以做」，提问管「怎么做」。
 * 区别：
 *   - 超时行为：提问不超时（任务是长期的，用户可能隔天回来）
 *   - 回答形式：自由文本（不是允许/拒绝）
 *   - 渲染层入口：同一个收件箱，kind='question' 渲染不同组件
 *
 * 实现使用同一套 PendingRequest 接口（kind='question'），
 * 所以 `pending.list` 和 `pending.resolved` 事件同样适用，
 * 渲染层不需要新的轮询机制。
 */

import {
  sessionIdOfPath,
  type AgentPath,
  type EventMap,
  type PendingRequest,
} from '@axon/protocol';

export interface QuestionBrokerOptions {
  emit: <E extends keyof EventMap>(event: E, payload: EventMap[E], source?: AgentPath) => void;
  /** 提问的 agent 是否还存在（dispose 时取消其挂起的提问）。 */
  exists: (path: AgentPath) => boolean;
  /** 等人回答期间把该 agent 挂出 idle 看门狗的视野。 */
  onWaitStart?: (path: AgentPath) => void;
  onWaitEnd?: (path: AgentPath) => void;
  now?: () => number;
}

interface QuestionEntry {
  request: PendingRequest;
  resolve: (answer: string) => void;
}

export class QuestionBroker {
  private readonly pending = new Map<string, QuestionEntry>();
  private readonly opts: QuestionBrokerOptions;
  private readonly now: () => number;
  private seq = 0;

  constructor(options: QuestionBrokerOptions) {
    this.opts = options;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 主管 Agent 发起提问。返回 Promise，用户回答后 resolve。
   *
   * 主管调用方负责在等待期间 beginWait / endWait（让出并发额度）；
   * QuestionBroker 只管发事件和 resolve，不做并发控制。
   */
  ask(
    origin: AgentPath,
    question: string,
    options?: {
      context?: string;
      choices?: string[];
    },
  ): Promise<string> {
    const requestId = `qst-${(this.seq += 1)}`;
    const at = this.now();
    const sessionId = sessionIdOfPath(origin) ?? '';

    const message = options?.context
      ? `${question}\n\n背景：${options.context}`
      : question;

    const request: PendingRequest = {
      requestId,
      kind: 'question',
      sessionId,
      origin,
      chain: [origin],
      message,
      // choices 存在 detail 字段里，渲染层从这里读
      ...(options?.choices?.length ? { detail: { choices: options.choices } } : {}),
      at,
      state: 'pending',
    };

    return new Promise<string>((resolve) => {
      this.pending.set(requestId, { request, resolve });
      this.opts.onWaitStart?.(origin);

      this.opts.emit(
        'question.request',
        {
          requestId,
          message,
        },
        origin,
      );
    });
  }

  /**
   * 用户的回答（`question.respond` IPC 命令的落点）。
   * 幂等：重复调用同一 requestId 直接返回。
   */
  respond(requestId: string, answer: string): { accepted: true } {
    const entry = this.pending.get(requestId);
    if (!entry) return { accepted: true }; // 已超时/已回答，幂等

    this.pending.delete(requestId);
    this.opts.onWaitEnd?.(entry.request.origin);

    this.opts.emit(
      'pending.resolved',
      { requestId, outcome: 'answered' },
      entry.request.origin,
    );

    entry.resolve(answer);
    return { accepted: true };
  }

  /**
   * agent 被删/被中断时取消其挂起的提问，避免 UI 里留幽灵待办。
   */
  cancelFor(path: AgentPath): void {
    for (const [id, entry] of [...this.pending]) {
      const origin = entry.request.origin;
      if (origin === path || origin.startsWith(`${path}/`)) {
        this.pending.delete(id);
        this.opts.onWaitEnd?.(origin);
        this.opts.emit(
          'pending.resolved',
          { requestId: id, outcome: 'cancelled' },
          origin,
        );
        entry.resolve('（提问已取消：Agent 被中断）');
      }
    }
  }

  /** 所有挂起的提问（供 `pending.list` 命令返回）。 */
  list(): PendingRequest[] {
    for (const [id, entry] of [...this.pending]) {
      if (!this.opts.exists(entry.request.origin)) {
        this.cancelFor(entry.request.origin);
      }
    }
    return [...this.pending.values()].map((e) => ({ ...e.request }));
  }

  get size(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.resolve('（应用已关闭，提问未回答）');
    }
    this.pending.clear();
  }
}

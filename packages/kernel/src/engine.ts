/**
 * L1 边界层 —— Axon 与 pi 的唯一接触面。
 *
 * 为什么要这一层：pi 还在 0.85.x，未到 1.0，类型与钩子随时可能变。
 * 把所有 `import ... from "@earendil-works/pi-*"` 收敛在这一个文件里，
 * 上游一旦破坏性变更，改动面就只有这里，registry/orchestrator 不受影响。
 *
 * 反过来说：其他文件里出现 pi 的 import 就是设计事故。
 *
 * ── 具体在防什么（已核实的上游动向）──
 *
 * pi 正在把执行内核从 `Agent`（当前能用）迁向 `AgentHarness` + lane-based
 * Session。但 `AgentHarness` 的 22 个行为方法目前全是 `HarnessNotImplemented`，
 * 而其中 `lane` / `createLane` / `lanes`（`agent-harness.ts:445,448,451`）
 * 正是 Axon 要自建的那层能力。参见 `docs/02-调研补充与结论复核.md` §4 风险 A。
 *
 * 所以这一层的职责不止于「收敛 import」，还要**不让 `Agent` 类型本身泄露出去**：
 * 对外只给 `AxonEngine` 接口。将来底座换成 harness/lane 时，改的是这里的实现，
 * 不是编排层的设计。
 */

import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { MessageLike } from '@axon/protocol';

export type { AgentEvent, AgentTool, AgentToolResult, AgentMessage, StreamFn, Model };

/**
 * Axon 编排层看到的引擎面 —— **刻意小于 `Agent` 的全部能力**。
 *
 * 只声明编排真正需要的五件事。每多暴露一个 pi 的方法，未来迁移到
 * lane-based harness 时就多一处要填的坑。现在克制，将来省事。
 */
export interface AxonEngine {
  /** 投喂一条用户消息并启动一轮。 */
  prompt(text: string): Promise<void>;
  /** 等到完全静止（含所有 await 的事件监听器 settle）。 */
  waitForIdle(): Promise<void>;
  /** 中断当前轮。 */
  abort(): void;
  /** 订阅事件流；返回退订函数。监听器被**串行 await**，这是编排层挂起的手段之一。 */
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  /** 当前 transcript 快照（拷贝）。 */
  messages(): MessageLike[];
  /**
   * 投递指导消息：本轮结束后注入，下一轮首条生效（M3 决策最重上的
   * message 工具的通道）。
   *
   * pi 侧的承载：`Agent.steer()`（`dist/agent.d.ts:84`「injected after the
   * current assistant turn finishes」）；agent-loop 在轮间（`agent-loop.js:103`）
   * 拉取 steering 队列。对不在跑的 Agent 是「下一轮开始时生效」。
   */
  steer(text: string): void;
}

/** 创建一个受 Axon 管理的 pi Agent 所需的最小参数。 */
export interface EngineSpec {
  systemPrompt: string;
  model: Model<any>;
  /** 已由 ContextForker 切好、由 intersectTools 裁过权的初始状态。 */
  messages: AgentMessage[];
  tools: AgentState['tools'];
  streamFn: StreamFn;
  sessionId?: string;
  /** 工具执行前的闸门：返回 deny 即拦截。编排层用它做权限与审批。 */
  onBeforeTool?: (toolName: string, args: unknown) => Promise<ToolGateResult>;
}

export type ToolGateResult =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * 把 Axon 的 spec 翻译成 pi 的 AgentOptions 并实例化。
 *
 * 注意 `initialState` 一次性注入 systemPrompt/model/tools/messages —— 这正是
 * 角色化（systemPrompt+model）、分身（messages）、减能（tools）三个维度的落点，
 * 全部在构造期完成，不需要事后 patch 内部状态。
 */
export function createEngine(spec: EngineSpec): Agent {
  return new Agent({
    streamFn: spec.streamFn,
    sessionId: spec.sessionId,
    initialState: {
      systemPrompt: spec.systemPrompt,
      model: spec.model,
      messages: spec.messages,
      tools: spec.tools,
    },
    beforeToolCall: spec.onBeforeTool
      ? async (context) => {
          const verdict = await spec.onBeforeTool!(
            context.toolCall.name,
            context.args,
          );
          if (verdict.allow) return undefined;
          // pi 约定：{ block:true } 阻止执行，reason 作为 error toolResult 回灌，
          // 模型据此知道被拒及原因，而非静默失败。
          return { block: true, reason: verdict.reason };
        }
      : undefined,
  });
}

/** pi 的消息结构与协议层的 MessageLike 在运行时同形，此处只做类型跨越。 */
export function toMessageLike(messages: readonly AgentMessage[]): MessageLike[] {
  return messages as unknown as MessageLike[];
}

export function fromMessageLike(messages: readonly MessageLike[]): AgentMessage[] {
  return messages as unknown as AgentMessage[];
}

/** 读取当前 transcript 的快照（拷贝，调用方改动不会影响 agent）。 */
export function snapshotMessages(agent: Agent): MessageLike[] {
  return toMessageLike(structuredClone(agent.state.messages));
}

/**
 * 把原生 `Agent` 包成 `AxonEngine`。
 *
 * 这是编排层应该用的入口；`createEngine` 保留为逃生门（契约测试、
 * 以及确实需要 pi 原生能力的场景）。
 */
export function wrapEngine(agent: Agent): AxonEngine {
  return {
    prompt: (text) => agent.prompt(text),
    waitForIdle: () => agent.waitForIdle(),
    abort: () => agent.abort(),
    subscribe: (listener) => agent.subscribe(listener),
    messages: () => snapshotMessages(agent),
    steer: (text) =>
      agent.steer({
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      } as AgentMessage),
  };
}

/** 一步到位：建引擎并直接得到收敛后的接口。 */
export function createAxonEngine(spec: EngineSpec): AxonEngine {
  return wrapEngine(createEngine(spec));
}

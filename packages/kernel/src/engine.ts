/**
 * L1 边界层 —— Axon 与 pi 的唯一接触面。
 *
 * 为什么要这一层：pi 还在 0.85.x，未到 1.0，类型与钩子随时可能变。
 * 把所有 `import ... from "@earendil-works/pi-*"` 收敛在这一个文件里，
 * 上游一旦破坏性变更，改动面就只有这里，registry/orchestrator 不受影响。
 *
 * 反过来说：其他文件里出现 pi 的 import 就是设计事故。
 */

import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { MessageLike } from '@axon/protocol';

export type { AgentEvent, AgentMessage, StreamFn, Model };

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

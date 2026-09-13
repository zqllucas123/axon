/**
 * @axon/kernel 的公开面。
 *
 * 注意这里**不再导出** `createEngine` 与 `Agent` ——
 * 编排层与宿主应当只见到 `AxonEngine`（见 engine.ts 顶部的理由）。
 * 契约测试用相对路径直接 import engine.ts，不走这里。
 */

export {
  createAxonEngine,
  wrapEngine,
  toMessageLike,
  fromMessageLike,
  type AxonEngine,
  type EngineSpec,
  type ToolGateResult,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
  type Model,
} from './engine.ts';

export {
  createRegistry,
  createFauxSource,
  createOpenAICompatSource,
  withTurnCost,
  scriptedSource,
  lastUserText,
  streamFnOf,
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type ModelSource,
  type ModelRegistry,
  type OpenAICompatSpec,
  type OpenAICompatModel,
} from './provider.ts';

export {
  forkMessages,
  groupIntoRounds,
  repairMessages,
  intersectTools,
  assertWaitable,
  isDescendantOf,
} from './fork.ts';

export { BudgetGuard, type BudgetLimits, type BudgetState } from './budget.ts';

export {
  AgentRegistry,
  type AgentNode,
  type RegisterSpec,
  type RegistryOptions,
} from './registry.ts';

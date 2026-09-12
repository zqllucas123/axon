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
  type StreamFn,
  type Model,
} from './engine.ts';

export {
  createRegistry,
  createFauxSource,
  streamFnOf,
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type ModelSource,
  type ModelRegistry,
} from './provider.ts';

export {
  forkMessages,
  groupIntoRounds,
  repairMessages,
  intersectTools,
  assertWaitable,
} from './fork.ts';

export {
  AgentRegistry,
  type AgentNode,
  type RegisterSpec,
  type RegistryOptions,
} from './registry.ts';

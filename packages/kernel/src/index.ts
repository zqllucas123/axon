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
  type ThinkingLevel,
} from './engine.ts';

export {
  createRegistry,
  createFauxSource,
  createOpenAICompatSource,
  createMultiProviderSource,
  withTurnCost,
  withDsmlParsing,
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

/* BudgetGuard 已删（2026-10-10，用户决策）：token 成本熔断整体下线。
   用量统计（UsageTotals）保留 —— 它回答「花了多少」，与「拦不拦」是两件事。 */

export {
  Ledger,
  truncateSummary,
  type LedgerOptions,
  type RecordCollabSpec,
  type SettleSpec,
} from './ledger.ts';

export {
  AgentRegistry,
  type AgentNode,
  type RegisterSpec,
  type RegistryOptions,
} from './registry.ts';

export {
  createLeafTools,
  createLocalOps,
  LEAF_TOOL_NAMES,
  READ_ONLY_LEAF_TOOLS,
  WRITE_LEAF_TOOLS,
  PathEscapeError,
  resolveWithinCwd,
  truncateHead,
  formatSize,
  type LeafToolName,
  type LeafOperations,
  type BashResult,
  type BashExecOptions,
} from './tools/index.ts';

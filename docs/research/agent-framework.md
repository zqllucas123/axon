# Microsoft Agent Framework 深度调研报告（面向 Axon 内核选型）

- **调研对象**：`/Users/lucaszhou/works/prjs/agents/agent-framework`
- **调研版本**：`agent-framework-core` **1.14.0**（CHANGELOG 日期 2026-08-13），dotnet 1.18.0
- **许可证**：MIT（`LICENSE:1`）
- **调研立场**：只读；以 python 实现为主，dotnet 对照
- **目标场景**：Axon —— 多子 Agent 协作客户端，5+ 角色化子 Agent（进度管理/架构设计/开发执行/测试/人机对齐），支持用户手动创建「纯净上下文轻量分身」与「继承内核全部上下文分身」

> ⚠️ **重要前提纠正**：这个仓库的 API 比公开博客/教程里的版本新得多。网上大量资料提到的 `AgentThread`、`run_stream()`、`ChatAgent`、`@ai_function`、`ChatMessage` **在本仓库中已全部改名或合并**。当前真实 API 是 `AgentSession`、`run(stream=True)`、`Agent`、`@tool`、`Message`。下文所有结论基于本地源码实测，不是基于文档。

---

## 0. 执行摘要（TL;DR）

| 维度 | 结论 |
|---|---|
| 它是什么 | **SDK / 框架**，不是产品。但意外地**自带一套 coding-agent 执行面**（`_harness/`） |
| 多 Agent 编排 | **极强**。5 种成熟 orchestration + 通用图执行引擎 + checkpoint + HITL |
| 纯净/继承分身 | **原生支持，有三处独立机制可用**（见 §4.3），这是最大惊喜 |
| coding agent 执行面 | **部分自带**：文件读写/grep/ls/replace、shell（Local+Docker）、todo、plan/execute mode、skills、后台子 agent、工具审批。**缺**：LSP/AST 级代码库理解、diff/patch 引擎、git 集成 |
| 客户端/CLI | **只有 DevUI（明确声明"非生产"）** + 一个 Textual TUI 示例。产品级客户端要自己写 |
| 适配度评分 | **8.5 / 10** |
| 推荐路径 | **b) 全栈基于它开发**（而非仅作编排层） |

---

## 1. 整体架构

### 1.1 仓库布局

```
agent-framework/
├── python/packages/        # 36 个独立发布的 Python 包
│   ├── core/               # agent_framework —— 所有核心抽象
│   ├── orchestrations/     # 5 种多 agent 编排模式
│   ├── declarative/        # YAML/JSON 声明式加载
│   ├── tools/              # shell 工具（Local / Docker）
│   ├── devui/              # 调试 UI（sample app）
│   ├── openai/ anthropic/ gemini/ bedrock/ ollama/ mistral/ claude/ ...  # provider
│   ├── redis/ mem0/ azure-cosmos-memory/ azure-ai-search/   # 记忆/检索后端
│   ├── a2a/ ag-ui/ chatkit/ hosting*/                        # 协议与托管
│   └── lab/                # 研究性实验（gaia / tau2 / lightning）
├── dotnet/src/             # 36 个 C# 项目，与 python 基本对等
├── declarative-agents/     # 跨语言共享的 YAML 规格 + 样例
└── docs/decisions/         # 40+ 篇 ADR 设计决策记录
```

包状态一览（`python/PACKAGE_STATUS.md:17-52`）：
```
| `agent-framework`            | `python/`                   | `released` |
| `agent-framework-core`       | `python/packages/core`      | `released` |
| `agent-framework-orchestrations` | `python/packages/orchestrations` | `released` |
| `agent-framework-declarative`| `python/packages/declarative`| `released` |
| `agent-framework-openai`     | `python/packages/openai`    | `released` |
| `agent-framework-tools`      | `python/packages/tools`     | `beta`     |
| `agent-framework-devui`      | `python/packages/devui`     | `beta`     |
```

### 1.2 核心抽象的类型定义位置

| 抽象 | 文件 | 行号 | 说明 |
|---|---|---|---|
| `SupportsAgentRun` | `core/agent_framework/_agents.py` | **224** | Agent 协议（`@runtime_checkable` Protocol） |
| `BaseAgent` | `core/agent_framework/_agents.py` | **364** | 最小基类，无 middleware/telemetry |
| `RawAgent` | `core/agent_framework/_agents.py` | **707** | 完整实现，无装饰层 |
| `Agent` | `core/agent_framework/_agents.py` | **1766** | **推荐使用**：Raw + Middleware + Telemetry |
| `AgentSession` | `core/agent_framework/_sessions.py` | **1653** | 会话状态容器（旧名 `AgentThread`） |
| `SessionContext` | `core/agent_framework/_sessions.py` | **500** | 单次调用的上下文装配区 |
| `ContextProvider` | `core/agent_framework/_sessions.py` | **736** | 上下文工程插件基类 |
| `HistoryProvider` | `core/agent_framework/_sessions.py` | **879** | 历史存储抽象 |
| `SessionStore` / `FileSessionStore` | `core/agent_framework/_sessions.py` | **1731 / 1808** | 会话快照持久化 |
| `Workflow` | `core/agent_framework/_workflows/_workflow.py` | **208** | 图执行引擎 |
| `WorkflowBuilder` | `core/agent_framework/_workflows/_workflow_builder.py` | **53** | Fluent 构图 API |
| `Executor` / `@handler` | `core/agent_framework/_workflows/_executor.py` | **31 / 558** | 图节点 |
| `WorkflowContext` | `core/agent_framework/_workflows/_workflow_context.py` | **217** | 节点运行时上下文 |
| `AgentExecutor` | `core/agent_framework/_workflows/_agent_executor.py` | **119** | Agent→节点适配器 |
| `WorkflowCheckpoint` / `CheckpointStorage` | `core/agent_framework/_workflows/_checkpoint.py` | **31 / 129** | 检查点 |
| `@tool` / `FunctionTool` | `core/agent_framework/_tools.py` | **1162 / 316** | 函数工具 |
| `MCPTool` 及子类 | `core/agent_framework/_mcp.py` | **396 / 2705 / 2896 / 3201** | MCP stdio/HTTP/WS |
| `AgentMiddleware` / `ChatMiddleware` / `FunctionMiddleware` | `core/agent_framework/_middleware.py` | **477 / 600 / 536** | 三层中间件 |
| `create_harness_agent` | `core/agent_framework/_harness/_agent.py` | **302** | **coding-agent 工厂** |

### 1.3 与 Semantic Kernel / AutoGen 的关系

**Agent Framework 是 SK 与 AutoGen 的合并继任者**，不是包装层 —— 它是全新代码库，两个前身都提供**迁移指南**而非兼容层。

`README.md:100-101`：
```markdown
- **[Migration from Semantic Kernel](...migration-guide/from-semantic-kernel)** - Guide to migrate from Semantic Kernel
- **[Migration from AutoGen](...migration-guide/from-autogen)** - Guide to migrate from AutoGen
```

仓库内有成建制的迁移样例目录，可直接看到概念映射：
```
python/samples/autogen-migration/orchestrations/
    01_round_robin_group_chat.py   → GroupChatBuilder
    02_selector_group_chat.py      → GroupChatBuilder(selection_func=...)
    03_swarm.py                    → HandoffBuilder
    04_magentic_one.py             → MagenticBuilder
python/samples/semantic-kernel-migration/orchestrations/
    {sequential, concurrent_basic, group_chat, handoff, magentic}.py
python/samples/semantic-kernel-migration/processes/   ← SK Process → Workflow
```

血统很明确：**AutoGen 贡献了多 agent 编排思想**（Magentic-One 直接继承，见 `declarative-agents/workflow-samples/DeepResearch.yaml:2-3` 注释 *"according to the 'Magentic' orchestration pattern introduced by AutoGen"*），**SK 贡献了企业级工程能力**（provider 抽象、中间件、telemetry、声明式）。

**对 Axon 的意义**：选它等于一次性拿到 AutoGen 的编排研究成果 + SK 的生产工程化，不用在两者间二选一。

---

## 2. Agent 抽象

### 2.1 定义一个 Agent

`Agent.__init__`（`_agents.py:1862-1878`）：
```python
def __init__(
    self,
    client: SupportsChatGetResponse[OptionsCoT],
    instructions: str | None = None,
    *,
    id: str | None = None,
    name: str | None = None,
    description: str | None = None,
    tools: ToolTypes | Callable[..., Any] | Sequence[...] | None = None,
    default_options: OptionsCoT | None = None,
    context_providers: Sequence[ContextProvider] | None = None,      # ← 上下文工程注入点
    middleware: MiddlewareTypes | Sequence[MiddlewareTypes] | None = None,
    require_per_service_call_history_persistence: bool = False,
    compaction_strategy: CompactionStrategy | None = None,
    tokenizer: TokenizerProtocol | None = None,
    additional_properties: MutableMapping[str, Any] | None = None,
) -> None:
```

**关键设计**：`Agent` 是 `client` + `instructions` + `tools` + `context_providers` + `middleware` 的**组合容器**，不需要继承。角色化子 Agent 就是不同的 `instructions` + `tools` 组合 —— 这对 Axon 的 5 个角色是天然契合的。

三层类继承（`_agents.py:1766-1771`）：
```python
class Agent(
    AgentMiddlewareLayer,
    AgentTelemetryLayer,
    RawAgent[OptionsCoT],
    Generic[OptionsCoT],
):
```
想要极致轻量的分身可以用 `RawAgent`（跳过 middleware/telemetry 开销），想完全自定义可以直接实现 `SupportsAgentRun` Protocol。

### 2.2 run 接口签名（注意：没有 run_stream）

`SupportsAgentRun.run`（`_agents.py:316-324`）：
```python
def run(
    self,
    messages: AgentRunInputs | None = None,
    *,
    stream: bool = False,
    session: AgentSession | None = None,
    function_invocation_kwargs: Mapping[str, Any] | None = None,
    client_kwargs: Mapping[str, Any] | None = None,
) -> Awaitable[AgentResponse[Any]] | ResponseStream[AgentResponseUpdate, AgentResponse[Any]]:
```

`Agent.run` 完整签名（`_agents.py:1829-1842`）额外支持 per-run 覆盖：
```python
def run(
    self,
    messages: AgentRunInputs | None = None,
    *,
    stream: bool = False,
    session: AgentSession | None = None,
    middleware: MiddlewareTypes | Sequence[MiddlewareTypes] | None = None,   # 单次运行注入中间件
    tools: ToolTypes | Callable[..., Any] | Sequence[...] | None = None,      # 单次运行追加工具
    options: OptionsCoT | ChatOptions[Any] | None = None,
    compaction_strategy: CompactionStrategy | None = None,
    tokenizer: TokenizerProtocol | None = None,
    function_invocation_kwargs: Mapping[str, Any] | None = None,
    client_kwargs: Mapping[str, Any] | None = None,
) -> Awaitable[AgentResponse[Any]] | ResponseStream[AgentResponseUpdate, AgentResponse[Any]]:
```

**`stream` 参数用 `Literal[True]/[False]` overload 做类型分发**（`_agents.py:1781-1827`），返回类型在静态期就能确定。`ResponseStream` 既可 `async for` 迭代，也可 `await .get_final_response()` 拿终态 —— 对 Axon 的 TUI/GUI 流式渲染很友好。

**per-run `tools` 和 `middleware` 覆盖对 Axon 很有价值**：同一个"开发执行 Agent"实例，可以在不同任务里动态挂载不同工具集，不必重建 Agent。

### 2.3 AgentSession 是什么、上下文如何维护

`AgentSession`（`_sessions.py:1653-1686`）刻意做得**极薄**：
```python
class AgentSession:
    """A conversation session with an agent.

    Lightweight state container. Provider instances are owned by the agent,
    not the session. The session only holds session IDs and a mutable state dict.
    """
    def __init__(self, *, session_id=None, service_session_id=None):
        self._session_id = session_id or str(uuid.uuid4())
        self.service_session_id = service_session_id
        self.state: dict[str, Any] = {}
```

**这是理解整个框架的关键**：Session 不存消息！它只有 `session_id` + `state` dict。消息实际存在哪由 `HistoryProvider` 决定。

上下文装配流程（每次 `run()`）：

```
run() 被调用
  │
  ├─ 1. 创建 SessionContext（_sessions.py:500）
  │      { input_messages, context_messages{}, instructions[], tools[], middleware{} }
  │
  ├─ 2. 顺序调用每个 ContextProvider.before_run()   (_sessions.py:766)
  │      ├─ HistoryProvider  → context.extend_messages(self, 历史)
  │      ├─ CompactionProvider→ 压缩
  │      ├─ TodoProvider     → extend_instructions + extend_tools
  │      ├─ AgentModeProvider→ 注入 plan/execute 模式
  │      ├─ FileMemoryProvider→ 注入记忆
  │      ├─ SkillsProvider   → 渐进式加载技能
  │      └─ (自定义 provider)
  │
  ├─ 3. 拼装最终 messages/instructions/tools → 调 ChatClient
  │
  └─ 4. 顺序调用 ContextProvider.after_run()       (_sessions.py:787)
         └─ HistoryProvider.save_messages(...)
```

`ContextProvider` 钩子签名（`_sessions.py:766-773`）：
```python
async def before_run(
    self, *,
    agent: SupportsAgentRun,
    session: AgentSession,
    context: SessionContext,      # ← 在这里 extend_messages / extend_instructions / extend_tools / extend_middleware
    state: dict[str, Any],        # ← provider 私有状态，存在 session.state 里，可序列化
) -> None:
```

**消息来源可追溯**：`extend_messages` 给每条消息打 `_attribution` 标记（`_sessions.py:604-641`）：
```python
attribution = {"source_id": source_id, "source_type": type(source).__name__}
...
msg_copy.additional_properties.setdefault("_attribution", message_attribution)
```
还支持 `origin_session_ids`（`_sessions.py:590-602`）标注跨会话注入的内容 —— **这对 Axon 做"分身上下文来源审计/可视化"是现成的基础设施**。

序列化：`AgentSession.to_dict()/from_dict()`（`_sessions.py:1693/1709`），`state` 里的自定义类型需通过 `register_state_type()` 注册。

---

## 3. 多 Agent 编排（重点）

### 3.1 两个层次

```
┌─────────────────────────────────────────────────────────┐
│  agent-framework-orchestrations（高层，5 种成品模式）       │
│  SequentialBuilder / ConcurrentBuilder / HandoffBuilder   │
│  GroupChatBuilder / MagenticBuilder                      │
├─────────────────────────────────────────────────────────┤
│  agent_framework._workflows（底层，通用图执行引擎）         │
│  WorkflowBuilder + Executor + Edge + Checkpoint          │
│  ≈ Pregel 式 superstep 模型                              │
└─────────────────────────────────────────────────────────┘
```

高层 builder 全部编译成底层 Workflow。**Axon 可以两层混用**：常规流程用 builder，需要特殊拓扑时下沉到 `WorkflowBuilder`。

### 3.2 五种编排模式

来自 `packages/orchestrations/agent_framework_orchestrations/__init__.py:4-11`：
```python
"""Orchestration patterns for Microsoft Agent Framework.

This package provides high-level builders for common multi-agent workflow patterns:
- SequentialBuilder: Chain agents in sequence
- ConcurrentBuilder: Fan-out to multiple agents in parallel
- HandoffBuilder: Decentralized agent routing
- GroupChatBuilder: Orchestrator-directed multi-agent conversations
- MagenticBuilder: Magentic One pattern for sophisticated multi-agent orchestration
"""
```

| 模式 | 文件 | 行数 | 适用于 Axon 的哪个场景 |
|---|---|---|---|
| **Sequential** | `_sequential.py` | 272 | 架构设计 → 开发执行 → 测试 的流水线 |
| **Concurrent** | `_concurrent.py` | 434 | 多方案并行评估 / 并行测试 |
| **Handoff** | `_handoff.py` | 1129 | **最贴合 Axon**：mesh 拓扑，agent 间自主转交 |
| **GroupChat** | `_group_chat.py` | 1043 | 多角色评审、人机对齐讨论 |
| **Magentic** | `_magentic.py` | **1810** | **进度管理 Agent 的现成实现**：task ledger + progress ledger + stall/reset 检测 |

`GroupChatBuilder.__init__`（`_group_chat.py:617-628`）支持两种控制方式：
```python
participants: Sequence[SupportsAgentRun | Executor] | None = None,
...
selection_func: GroupChatSelectionFunction | None = None,      # 自定义选人逻辑（代码）
...
termination_condition: TerminationCondition | None = None,      # 自定义终止条件
```
—— 既可用 LLM orchestrator 选人，也可用纯代码函数选人（省 token、可确定性测试）。

**Magentic 对 Axon 的「进度管理子 Agent」几乎是量身定做**。它的公开类型（`__init__.py:40-60`）：
```python
MagenticProgressLedger, MagenticProgressLedgerItem,   # 进度台账
MagenticPlanReviewRequest, MagenticPlanReviewResponse, # 人工审阅计划（HITL）
MagenticResetSignal,                                   # 卡死重置
ORCH_MSG_KIND_TASK_LEDGER, ORCH_MSG_KIND_INSTRUCTION, ...
StandardMagenticManager, MagenticManagerBase,          # 可替换的 manager
```
`MagenticBuilder` 参数（见 `samples/03-workflows/orchestrations/magentic.py:95-102`）：
```python
workflow = MagenticBuilder(
    participants=[researcher_agent, coder_agent],
    intermediate_output_from=[researcher_agent, coder_agent],
    manager_agent=manager_agent,
    max_round_count=10,
    max_stall_count=3,      # 停滞检测
    max_reset_count=2,      # 自动重规划
).build()
```

### 3.3 图模型：Executor / Edge / 状态传递

**Executor = 图节点**，通过 `@handler` 声明处理方法（`_executor.py:558`，用法见 `_workflow_builder.py:63-86`）：
```python
from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler

class UpperCaseExecutor(Executor):
    @handler
    async def process(self, text: str, ctx: WorkflowContext[str]) -> None:
        await ctx.send_message(text.upper())

class ReverseExecutor(Executor):
    @handler
    async def process(self, text: str, ctx: WorkflowContext[Never, str]) -> None:
        await ctx.yield_output(text[::-1])

workflow = WorkflowBuilder(start_executor=upper).add_edge(upper, reverse).build()
events = await workflow.run("hello")
```

**类型驱动路由**：`WorkflowContext[OutT, W_OutT]` 的泛型参数编码了"能发什么消息 / 能产出什么输出"（`_workflow_context.py:226-262`），框架据此在 `build()` 时做**静态图校验**（`_workflows/_validation.py`，462 行）。`@handler` 也支持显式类型：`@handler(input=str|int, output=bool, workflow_output=...)`（`_executor.py:622-632`）。

**边的类型**（`WorkflowBuilder` 方法，`_workflow_builder.py`）：
| 方法 | 行号 | 语义 |
|---|---|---|
| `add_edge(src, tgt, condition=...)` | **230** | 普通有向边（可带条件） |
| `add_fan_out_edges(src, [t1,t2,...])` | **282** | 一对多广播 |
| `add_switch_case_edge_group(...)` | **338** | switch/case 路由 |
| `add_multi_selection_edge_group(...)` | **425** | 多选路由 |
| `add_fan_in_edges([s1,s2,...], tgt)` | **511** | 多对一聚合 |
| `add_chain([e1,e2,e3])` | **566** | 链式糖 |
| `build()` | **727** | 校验并冻结成 `Workflow` |

**状态在节点间如何传递** —— 三种通道，语义清晰：

1. **消息（点对点/广播）** —— `_workflow_context.py:318`：
```python
async def send_message(self, message: OutT, target_id: str | None = None) -> None:
    """target_id: The ID of the target executor... If None, the message will be sent to all target executors."""
```

2. **共享 workflow state（全局 KV）** —— `_workflow_context.py:436-442`：
```python
def get_state(self, key: str, default: Any = None) -> Any:
    return self._state.get(key, default)

def set_state(self, key: str, value: Any) -> None:
    self._state.set(key, value)
```

3. **workflow 输出（对外）** —— `_workflow_context.py:350` `yield_output()`，并可通过 builder 的 `output_from` / `intermediate_output_from` 精细控制哪些节点的产出算"最终输出"vs"中间输出"（`_workflow_builder.py:118-143`，设计得相当细）。

**执行模型是 superstep（Pregel 风格）**，见 `_workflow_builder.py:106-108`：
> *"max_iterations: Maximum number of iterations for workflow convergence. The first iteration is the initial run of the start executor, and each subsequent iteration is a superstep. Default is 100."*

### 3.4 Checkpoint（✅ 完整支持）

`WorkflowCheckpoint`（`_checkpoint.py:31-98`）：
```python
class WorkflowCheckpoint:
    workflow_name: str
    graph_signature_hash: str                    # 图拓扑哈希，恢复时校验兼容性
    checkpoint_id: CheckpointID
    previous_checkpoint_id: CheckpointID | None   # 检查点血缘链
    timestamp: str
    messages: dict[str, list[WorkflowMessage]]    # 在途消息
    state: dict[str, Any]                         # 已提交状态（含 _executor_state）
    pending_request_info_events: dict[str, WorkflowEvent[Any]]  # 未回答的 HITL 请求
    iteration_count: int
    metadata: dict[str, Any]
    version: str = "1.0"
```

重要设计（`_checkpoint.py:37-41`）：
> *"a checkpoint is not tied to a specific workflow instance, but rather to a workflow definition... This allows checkpoints to be shared and restored across different workflow instances of the same workflow definition."*

**存储后端**：`CheckpointStorage` Protocol（`_checkpoint.py:129`，方法 `save/load/list_checkpoints/delete/get_latest/list_checkpoint_ids`）+ 两个内置实现 `InMemoryCheckpointStorage`（**202**）、`FileCheckpointStorage`（**249**，含 `_validate_file_path` 路径穿越防护）。Axon 换成 SQLite/Postgres 只需实现 6 个 async 方法。

### 3.5 Human-in-the-Loop（✅ 一等公民）

**请求侧** —— `_workflow_context.py:403-434`：
```python
async def request_info(self, request_data: object, response_type: type, *, request_id: str | None = None) -> None:
    """Request information from outside of the workflow.

    Calling this method will cause the workflow to emit a request_info event (type='request_info')...
    Executors must have the corresponding response handlers defined using the
    @response_handler decorator to handle the incoming responses.
    """
```

**响应侧** —— `Workflow.run()` 的统一入口（`_workflow.py:709-745`）把"新运行 / 从检查点恢复 / 回答挂起请求"三件事合并：
```python
def run(
    self,
    message: Any | None = None,
    *,
    stream: bool = False,
    responses: Mapping[str, Any] | None = None,      # ← 回答挂起的 request_info
    checkpoint_id: str | None = None,                # ← 从检查点恢复
    checkpoint_storage: CheckpointStorage | None = None,
    include_status_events: bool = False,
    ...
)
```
文档明确（`_workflow.py:732-738`）：
> *"responses: ... Can be combined with checkpoint_id to restore a checkpoint and send responses in a single call."*

**这正是 Axon「人机对齐子 Agent」需要的语义**：workflow 跑到需要人确认处 → 落检查点 + 发 `request_info` 事件 → 进程可以退出 → 用户第二天回来 → `run(checkpoint_id=..., responses={req_id: 用户答复})` 续跑。

`_request_info_mixin.py`（369 行）承载这套机制；HITL 还有状态 `WorkflowRunState.IDLE_WITH_PENDING_REQUESTS`。

### 3.6 完整多 Agent 示例代码路径

**首推**（含 HITL + checkpoint + 工具审批三合一，最接近 Axon 需求）：
```
python/samples/03-workflows/orchestrations/handoff_with_tool_approval_checkpoint_resume.py
```

其余（`python/samples/03-workflows/orchestrations/`，全部实测存在）：
```
magentic.py                              # Magentic 基础（162 行，已通读）
magentic_human_plan_review.py            # 人工审阅计划 ★
magentic_checkpoint.py                   # Magentic + 检查点 ★
handoff_simple.py                        # handoff 基础（314 行，已通读）
handoff_autonomous.py                    # 全自主 handoff
handoff_with_code_interpreter_file.py    # handoff + code interpreter
sequential_agents.py / sequential_custom_executors.py
sequential_chain_only_agent_responses.py
concurrent_agents.py / concurrent_custom_aggregator.py
concurrent_custom_agent_executors.py
group_chat_agent_manager.py              # LLM 当 manager
group_chat_simple_selector.py            # 代码函数选人
group_chat_philosophical_debate.py
```

`handoff_simple.py:73-111` 的多角色定义写法（Axon 的 5 角色可照抄）：
```python
triage_agent = Agent(
    client=client,
    instructions=("You are frontline support triage. Route customer issues to the appropriate "
                  "specialist agents based on the problem described."),
    name="triage_agent",
    require_per_service_call_history_persistence=True,
)
refund_agent = Agent(client=client, instructions="You process refund requests.",
                     name="refund_agent", tools=[process_refund],
                     require_per_service_call_history_persistence=True)
# ... order_agent, return_agent
```
关键：`HandoffBuilder` **自动为每个 participant 生成 handoff 工具**（`handoff_simple.py:34-36` 注释：*"Auto-registered handoff tools: HandoffBuilder automatically creates handoff tools for each participant"*），不用手写路由。

### 3.7 Workflow 可以反过来当 Agent 用（嵌套关键）

`Workflow.as_agent()`（`_workflow.py:1193-1234`）：
```python
def as_agent(self, name=None, *, description=None, context_providers=None, **kwargs) -> WorkflowAgent:
    """Create a WorkflowAgent that wraps this workflow."""
```
另有 `_workflow_executor.py`（610 行）支持 **workflow 作为另一个 workflow 的节点**。

**对 Axon 的意义**：可以做分形架构 —— "开发执行"本身是个子 workflow（编码→自测→修复），但对上层编排器看来只是一个 Agent。

---

## 4. 上下文管理（Axon 分身需求的核心）

### 4.1 机制总览

```
Agent（拥有 provider 实例，无状态）
  │
  ├── context_providers = [HistoryProvider, CompactionProvider, TodoProvider, ...]
  │
  └── run(session=AgentSession)     ← 状态全在 session 里
                 │
                 └── session.state: dict   ← 每个 provider 有私有命名空间
```

**Agent 与 Session 正交**是最重要的设计：同一个 Agent 可以喂不同 session（多会话隔离），同一个 session 可以喂不同 Agent（多 agent 共享上下文）。Axon 的分身需求正好落在这个正交性上。

### 4.2 内置 provider 清单

| Provider | 文件:行 | 作用 |
|---|---|---|
| `ContextProvider` | `_sessions.py:736` | 基类 |
| `HistoryProvider` | `_sessions.py:879` | 历史抽象 |
| `InMemoryHistoryProvider` | `_sessions.py:2023` | 内存历史 |
| `FileHistoryProvider` | `_sessions.py:2105` | 文件历史（JSON/msgpack） |
| `CompactionProvider` | `_compaction.py` | 上下文窗口压缩 |
| `TodoProvider` | `_harness/_todo.py:446` | 待办清单 |
| `AgentModeProvider` | `_harness/_mode.py:197` | plan/execute 模式 |
| `FileMemoryProvider` | `_harness/_file_memory.py:220` | 文件记忆 |
| `FileAccessProvider` | `_harness/_file_access.py:1204` | 文件读写工具 |
| `SkillsProvider` | `_skills.py:1831` | 技能渐进加载 |
| `BackgroundAgentsProvider` | `_harness/_background_agents.py:268` | 后台子 agent |
| `ShellEnvironmentProvider` | `agent_framework_tools/shell/_environment.py` | shell 环境探测 |
| 外部后端 | `packages/{redis,mem0,azure-cosmos-memory,azure-ai-search}` | Redis/Mem0/Cosmos/AI Search |

### 4.3 「纯净分身」vs「继承全部上下文分身」——三套原生机制 ✅✅✅

这是我对这个框架评价最高的地方：**你的需求不需要 hack，框架在三个不同层次都给了开关。**

#### 机制 A：`Agent.as_tool(propagate_session=...)` —— 最直接

`_agents.py:585-608`：
```python
def as_tool(
    self, *,
    name: str | None = None,
    description: str | None = None,
    arg_name: str = "task",
    arg_description: str | None = None,
    approval_mode: Literal["always_require", "never_require"] = "never_require",
    stream_callback: Callable[[AgentResponseUpdate], Awaitable[None] | None] | None = None,
    propagate_session: bool = False,          # ★★★ 就是这个开关
) -> FunctionTool:
    """...
        propagate_session: If True, the parent agent's session is forwarded
            to this sub-agent's ``run()`` call so both agents share the
            same session. Defaults to False.
    """
```
官方示例（`_agents.py:621-628`）：
```python
# Convert the agent to a tool (independent session)   ← 纯净分身
research_tool = agent.as_tool()

# Convert the agent to a tool (shared session with parent)  ← 继承分身
research_tool = agent.as_tool(propagate_session=True)

coordinator = Agent(client=client, name="coordinator", tools=research_tool)
```
实现处（`_agents.py:659`）一行到底：
```python
session = ctx.session if propagate_session else None
```

> **Axon 直接映射**：用户点"创建轻量分身" → `as_tool()`；点"创建继承分身" → `as_tool(propagate_session=True)`。**零自研成本。**

#### 机制 B：`AgentExecutor(context_mode=...)` —— workflow 内三档粒度

`_agent_executor.py:136-161`：
```python
def __init__(
    self,
    agent: SupportsAgentRun,
    *,
    session: AgentSession | None = None,                                # ★ 显式传 session = 继承
    id: str | None = None,
    context_mode: Literal["full", "last_agent", "custom"] | None = None, # ★ 三档上下文
    context_filter: Callable[[list[Message]], list[Message]] | None = None,
):
    """...
        session: The session to use for running the agent. If None, a new session will be created.
        context_mode: ...
            - "full": append the full conversation (all prior messages + latest agent response)...
            - "last_agent": provide only the messages from the latest agent response as context...
            - "custom": use the provided context_filter function to determine which messages to include...
    """
```
隔离默认值在 `_agent_executor.py:169`：
```python
self._session = session or self._agent.create_session()   # 默认每个节点独立 session
```

比"纯净 / 全继承"二选一更进一步 —— `context_mode="custom"` + `context_filter` 让 Axon 能做**按角色裁剪的部分继承**（例如"测试 Agent 只继承架构决策和代码变更，不继承闲聊"）。

#### 机制 C：组装 `context_providers` —— 最彻底

因为消息存储权完全在 `HistoryProvider` 手里，Axon 可以这样定义分身工厂：

```python
# 纯净分身：全新 session + 自己的内存历史
def spawn_clean(role: str, instr: str) -> Agent:
    return Agent(client=client, name=role, instructions=instr,
                 context_providers=[InMemoryHistoryProvider(source_id=f"{role}-hist")])

# 继承分身：共享内核的 HistoryProvider 实例 + 共享 session_id
def spawn_inherited(role: str, instr: str, kernel_history: HistoryProvider) -> Agent:
    return Agent(client=client, name=role, instructions=instr,
                 context_providers=[kernel_history])   # 同一个 provider ⇒ 同一份历史
# 调用时传内核的 session：agent.run(task, session=kernel_session)
```

而且 `HistoryProvider` 的构造参数（`_sessions.py:911-920`）本身就是一组"读写权限位"：
```python
def __init__(self, source_id, *,
    load_messages: bool = True,             # 是否读历史（False ⇒ 只写不读，天然纯净）
    store_inputs: bool = True,
    store_context_messages: bool = False,
    store_context_from: set[str] | None = None,   # 只吸收指定来源
    store_outputs: bool = True,
):
```
`load_messages=False` + `store_outputs=True` ⇒ **"纯净输入、结果回灌内核"**的分身，一个参数搞定。

`store_context_from` 配合 §2.3 的 `_attribution` 标记，可以做到"这个分身只继承来自架构设计 Agent 的上下文"。

#### 参考样例
```
python/samples/02-agents/context_providers/simple_context_provider.py
python/samples/02-agents/context_providers/cross_session_observer.py      ★ 跨会话上下文观测
python/samples/02-agents/conversations/custom_history_provider.py
python/samples/02-agents/conversations/suspend_resume_session.py           ★ 会话挂起/恢复
python/samples/02-agents/conversations/{file,redis,cosmos}_history_provider.py
```

**结论：需求 4（两种分身模式）是本框架的强项，不是短板。** 甚至它给的粒度比你要求的更细。

---

## 5. 工具系统

### 5.1 `@tool` 装饰器

`_tools.py:1162-1174`：
```python
def tool(
    func: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    schema: type[BaseModel] | Mapping[str, Any] | None = None,
    approval_mode: ApprovalMode | None = None,
    kind: str | None = None,
    max_invocations: int | None = None,              # 工具实例生命周期内调用上限
    max_invocation_exceptions: int | None = None,    # 异常次数上限
    additional_properties: dict[str, Any] | None = None,
    result_parser: Callable[[Any], str | list[Content]] | _SkipParsingSentinel | None = None,
) -> FunctionTool | Callable[[Callable[..., Any]], FunctionTool]:
```
Schema 从签名 + `Annotated` 自动推导（`_tools.py:1177-1183`），也可显式传 Pydantic model 或 JSON schema。用法（`_tools.py:1234-1244`）：
```python
from agent_framework import tool
from typing import Annotated

@tool(approval_mode="never_require")
def tool_example(
    arg1: Annotated[str, "The first argument"],
    arg2: Annotated[int, "The second argument"],
) -> str:
    return f"arg1: {arg1}, arg2: {arg2}"
```
`max_invocations` / `max_invocation_exceptions` 对 Axon 防止 agent 死循环刷工具很实用。

### 5.2 Approval 机制（Axon 必需，且很完整）

**三层**：

1. **静态声明** —— `approval_mode: "always_require" | "never_require"`，默认 never（`_tools.py:408`）。注意坑（`_tools.py:1227-1228`）：*"if the model returns multiple function calls, some that require approval and others that do not, it will ask approval for all of them."*

2. **运行时审批状态机** —— `_harness/_tool_approval.py`（665 行）：
```python
class ToolApprovalRule(SerializationMixin):      # :86   可序列化的审批规则
class ToolApprovalState(SerializationMixin):     # :158  存在 session.state
def create_always_approve_tool_response(...)     # :218  "以后都批准这个工具"
def create_always_approve_tool_with_arguments_response(...)  # :234 "以后都批准这个工具+这组参数"
class ToolApprovalMiddleware                     # 协调标准规则 + 队列化审批提示
```
即 **Claude Code 式的 "don't ask again" 语义**，且规则随 session 持久化。

3. **启发式自动批准** —— `create_harness_agent(auto_approval_rules=[...])`（`_harness/_agent.py:336, 499-501`）：回调收到 `function_call` content，返回 `True` 即放行。

样例：
```
python/samples/02-agents/tools/function_tool_with_approval.py
python/samples/02-agents/tools/function_tool_with_approval_and_sessions.py
python/samples/03-workflows/orchestrations/handoff_with_tool_approval_checkpoint_resume.py
```

### 5.3 MCP 支持（很厚）

`_mcp.py` 共 **3398 行**：
```python
class MCPTool:                  # :396
class MCPStdioTool(MCPTool):    # :2705   本地进程
class MCPStreamableHTTPTool:    # :2896   HTTP
class MCPWebsocketTool:         # :3201   WebSocket
class MCPTaskOptions            # 长时任务（experimental: MCP_LONG_RUNNING_TASKS）
```
另有 **MCP Skills**（`_skills.py:4863 MCPSkillsSource`，experimental `MCP_SKILLS`）—— 把 MCP server 当技能来源；以及**反向能力** `packages/hosting-mcp/`：把 Axon 自己的 agent 暴露成 MCP server。

安全侧 `security.py`（experimental `FIDES`）提供 `SecureMCPToolProxy`、`IntegrityLabel`/`ConfidentialityLabel`、`ContentVariableStore`，配合 ADR `docs/decisions/0024-prompt-injection-defense.md` —— 对 Axon 接第三方 MCP 有现成的防注入层。

### 5.4 Hosted tools（服务端托管）

通过 client 能力 Protocol 暴露（`core/agent_framework/__init__.pyi:13-19`）：
```python
SupportsCodeInterpreterTool,
SupportsFileSearchTool,
SupportsImageGenerationTool,
SupportsWebSearchTool,
SupportsShellTool,
```
用法（`samples/03-workflows/orchestrations/magentic.py:72`）：
```python
code_interpreter_tool = client.get_code_interpreter_tool()
coder_agent = Agent(..., client=client, tools=code_interpreter_tool)
```
**这是能力探测式设计**（`isinstance(client, SupportsShellTool)`，见 `_harness/_agent.py:248`），换 provider 时框架会检测并降级 + 告警，不会静默失败。

本地 code interpreter 也有：`samples/02-agents/tools/local_code_interpreter/`、`monty_code_interpreter/`、`packages/monty/`、`packages/hyperlight/`（沙箱）、dotnet 的 `Microsoft.Agents.AI.LocalCodeAct`。

### 5.5 Shell 工具 ★（coding agent 关键）

`packages/tools/agent_framework_tools/shell/`，2480 行：
```
_tool.py        335   # LocalShellTool / DockerShellTool
_docker.py      719   # Docker 沙箱执行
_session.py     443   # 持久 shell 会话
_environment.py 281   # ShellEnvironmentProvider：探测 OS/shell/工具链并注入上下文
_policy.py      125   # 命令准入策略
_killtree.py    132   # 进程树杀灭（超时清理）
_truncate.py     41   # 输出截断
_resolve.py     111
```
接入方式（`_harness/_agent.py:258-261`）：
```python
from agent_framework_tools.shell import ShellEnvironmentProvider
shell_tool = client.get_shell_tool(func=as_function())
shell_provider = ShellEnvironmentProvider(shell_executor, shell_environment_provider_options)
```

---

## 6. 模型/Provider 抽象

### 6.1 支持矩阵（实测类名）

| Provider | 包 | 类（`_chat_client.py` 等） | 状态 |
|---|---|---|---|
| OpenAI | `openai` | `OpenAIChatClient:3430`, `OpenAIChatCompletionClient:1259`, `OpenAIEmbeddingClient:320` | released |
| Azure / Foundry | `foundry` | `FoundryChatClient:929`, `FoundryAgentChatClient`, `FoundryEmbeddingClient:323` | released |
| Anthropic | `anthropic` | `AnthropicClient:1599`, `AnthropicBedrockClient:108`, `AnthropicFoundryClient:112` | beta |
| Google Gemini | `gemini` | `GeminiChatClient:1319` | beta |
| AWS Bedrock | `bedrock` | `BedrockChatClient:227` | beta |
| Mistral | `mistral` | `MistralChatClient:867` | beta |
| Ollama（本地） | `ollama` | `OllamaChatClient:292` | beta |
| Claude Code SDK | `claude` | — | beta |
| GitHub Copilot | `github_copilot` | — | **released** |
| Copilot Studio | `copilotstudio` | — | beta |
| Foundry Local | `foundry_local` | — | beta |

### 6.2 切换成本：低

三个原因：
1. **`Agent` 只依赖 `SupportsChatGetResponse` Protocol**（`_agents.py:1864`），换 provider 就是换构造参数第一个对象。
2. **Raw/公开双层模式**（ADR `docs/decisions/0021-provider-leading-clients.md`）：每个 provider 都是 `RawXxxClient` + `XxxClient` 两层，扩展点一致。
3. **能力用 Protocol 探测**（§5.4），不是硬编码 if/else。

自定义 provider 有样例目录：`python/samples/02-agents/providers/custom/`。

### 6.3 不同 agent 配不同模型：✅ 原生支持

`client` 是 **per-Agent 构造参数**，不是全局单例。Axon 完全可以：
```python
architect = Agent(client=AnthropicClient(model="claude-opus-..."), name="architect", ...)  # 强模型做设计
coder     = Agent(client=OpenAIChatClient(model="gpt-...-codex"), name="coder", ...)
progress  = Agent(client=OllamaChatClient(model="qwen..."), name="progress", ...)          # 本地小模型管进度，省钱
```
然后一起丢进 `MagenticBuilder(participants=[...])`。

`Workflow.run()` 还支持 **per-agent 的运行时参数下发**（`_workflow.py:741-746`）：
> *"function_invocation_kwargs: ... Either a mapping for agent name or agent executor id to kwargs, or a flat mapping of kwargs for all tool invocations."*

---

## 7. 声明式定义（对「用户手动创建分身」很关键）

### 7.1 `declarative-agents/` 是什么

**跨语言共享的 YAML 规格 + 样例库**（python 和 dotnet 共用同一批 YAML 做一致性测试）：
```
declarative-agents/
├── agent-samples/
│   ├── chatclient/{Assistant,GetWeather}.yaml
│   ├── openai/{OpenAI,OpenAIChat,OpenAIAssistants,OpenAIResponses}.yaml
│   ├── azure/{AzureOpenAI,AzureOpenAIChat,AzureOpenAIAssistants,AzureOpenAIResponses}.yaml
│   └── foundry/{FoundryAgent,PersistentAgent,MicrosoftLearnAgent}.yaml
└── workflow-samples/
    ├── DeepResearch.yaml      # Magentic 多 agent 编排
    ├── CustomerSupport.yaml
    ├── Marketing.yaml
    └── MathChat.yaml
```

### 7.2 Agent 级 YAML（✅ 完全可行）

`declarative-agents/agent-samples/chatclient/GetWeather.yaml` 全文：
```yaml
kind: Prompt
name: Assistant
description: Helpful assistant
instructions: You are a helpful assistant. You answer questions using the tools provided.
model:
    options:
        temperature: 0.9
        topP: 0.95
        allowMultipleToolCalls: true
        chatToolMode: auto
tools:
  - kind: function
    name: GetWeather
    description: Get the weather for a given location.
    bindings:
      get_weather: get_weather          # ← YAML 名 → 宿主注册的 Python 函数
    parameters:
      properties:
        location:
          kind: string
          description: The city and state, e.g. San Francisco, CA
          required: true
        unit:
          kind: string
          required: false
          enum: [celsius, fahrenheit]
```
`Assistant.yaml` 还演示了 `outputSchema:`（结构化输出）。

加载 API —— `AgentFactory`（`packages/declarative/agent_framework_declarative/_loader.py:143`）：
```python
def create_agent_from_yaml_path(self, yaml_path: str | Path) -> Agent:      # :291
def create_agent_from_yaml(self, yaml_str: str) -> Agent:                   # :345
def create_agent_from_dict(self, agent_def: dict[str, Any]) -> Agent:       # :418
async def create_agent_from_yaml_path_async(self, yaml_path) -> Agent:      # :486
async def create_agent_from_yaml_async(self, yaml_str: str) -> Agent:       # :516
async def create_agent_from_dict_async(self, agent_def: dict) -> Agent:     # :547
```

> **Axon 直接映射**：用户在 UI 里填表 → 生成 dict → `create_agent_from_dict()` → 拿到 `Agent` → 配 §4.3 的 session 策略。`tools.bindings` 机制天然是安全边界：**用户只能绑定宿主预先注册的工具，不能在 YAML 里注入任意代码**。这对"让用户创建分身"是必要的沙箱。

`_models.py`（1154 行）是完整的 Pydantic schema，Axon 可以直接复用它做**表单校验和 UI 生成**。

### 7.3 Workflow 级 YAML（能力强但有代价）

`packages/declarative/agent_framework_declarative/_workflows/`，约 10500 行：
```
_declarative_builder.py   1057
_declarative_base.py      1226
_factory.py                811
_executors_agents.py      1158
_executors_tools.py        665
_executors_mcp.py          549
_state.py                  650
_powerfx_functions.py      498   ← Power Fx 表达式引擎
_executors_control_flow.py  461
_executors_http.py         417
_http_handler.py           237 / _mcp_handler.py 581 / _executors_external_input.py 243
```

代价在于**表达式语言是 Power Fx**（微软 Copilot Studio 血统），`=` 前缀。摘 `declarative-agents/workflow-samples/DeepResearch.yaml:20-52`：
```yaml
kind: Workflow
maxTurns: 500
trigger:
  kind: OnConversationStart
  id: workflow_demo
  actions:
    - kind: SetVariable
      variable: Local.AvailableAgents
      value: |-
        =[
            { name: "WeatherAgent",  description: "Able to retrieve weather information" },
            { name: "CoderAgent",    description: "Able to write and execute Python code" },
            { name: "KnowledgeAgent",description: "Able to perform generic websearches" }
        ]
    - kind: SetVariable
      variable: Local.TeamDescription
      value: "=Concat(ForAll(Local.AvailableAgents, $\"- \" & name & $\": \" & description), Value, \"\n\")"
    - kind: SetVariable
      variable: Local.InputTask
      value: =System.LastMessage.Text
    - kind: SendActivity
      activity: Analyzing facts...
```

**建议**：Axon **用 Agent 级 YAML（清爽、贴合分身需求），Workflow 级编排用 Python 代码写**。Power Fx 对你的团队和用户都是额外认知负担，而且调试体验远不如 Python。

---

## 8. 可观测性与持久化

### 8.1 OpenTelemetry（深度原生，非事后包装）

`opentelemetry-api` 是 **core 的 5 个硬依赖之一**（`packages/core/pyproject.toml:30`）：
```toml
dependencies = [
    "msgspec>=0.20.0,<0.22",
    "typing-extensions>=4.15.0,<5",
    "pydantic>=2,<3",
    "python-dotenv>=1,<2",
    "opentelemetry-api>=1.39.0,<2",
]
```

`observability.py`：
```python
class OtelAttr(str, Enum):                # :214   遵循 GenAI 语义约定
OTEL_METRICS: Final[str]                  # :153
def _create_otlp_exporters(...)           # :405
def _get_exporters_from_env(...)          # :531   标准 OTEL_EXPORTER_OTLP_* 全支持
def create_resource(...)                  # :624   OTEL_SERVICE_NAME / _VERSION / RESOURCE_ATTRIBUTES
def create_metric_views(...)              # :701
class ObservabilitySettings               # :727
USAGE_DETAIL_TO_OTEL_ATTR                 # :371   token 用量 → OTel 属性
```
`AgentTelemetryLayer` 是 `Agent` 的 MRO 组成部分（`_agents.py:1768`）—— 你用 `Agent` 就自动有 trace，不用额外接线。Workflow 层也做了 **trace context 跨节点传播**（`_workflow_context.py:270-301` 的 `trace_contexts` / `source_span_ids`，且 fan-in 聚合时保留所有上游 context —— 见 git log `00d7102c5 preserve all trace contexts in FanInEdgeRunner aggregation`）。

ADR：`docs/decisions/0003-agent-opentelemetry-instrumentation.md`。样例：`python/samples/02-agents/observability/`。

### 8.2 持久化三条线

| 线 | 类型 | 序列化 | 内置后端 |
|---|---|---|---|
| **Session 快照** | `AgentSession.to_dict/from_dict`（`_sessions.py:1693/1709`） | msgspec JSON + msgpack（`_sessions.py:490-493`） | `SessionStore:1731`, `FileSessionStore:1808`；外部：Foundry/Cosmos |
| **消息历史** | `HistoryProvider.get_messages/save_messages`（`_sessions.py:939/956`） | JSON / msgpack | `InMemoryHistoryProvider:2023`, `FileHistoryProvider:2105`；外部：Redis/Cosmos |
| **Workflow 检查点** | `WorkflowCheckpoint`（`_checkpoint.py:31`） | `_checkpoint_encoding.py`（421 行） | `InMemoryCheckpointStorage:202`, `FileCheckpointStorage:249` |

工程细节到位：`FileSessionStore._quarantine_corrupt_snapshot`（`_sessions.py:1991`，坏快照隔离而非崩溃）、`_session_file_lock`（`:2004`，线程锁）、`FileCheckpointStorage._validate_file_path`（`_checkpoint.py:293`，路径穿越防护）、`FileHistoryProvider` 的 async + thread 双锁（`:2354/2364`）。另有 git log `af4347a61 Restrict workflow type deserialization` —— 反序列化白名单，说明安全审计在持续跟进。

三份相关 ADR：`0018-agentthread-serialization.md`、`0034-python-session-store-serialization.md`、`0022-chat-history-persistence-consistency.md`。

---

## 9. 它是 SDK 还是产品？—— 有没有 coding agent 能力

### 9.1 定性：是 SDK。但比预期多给了一层"半成品 coding agent"

**没有产品级 CLI/客户端。** 唯一的 UI 是 DevUI，作者自己写明（`packages/devui/README.md:5-6`）：
> *"DevUI is a **sample app** to help you get started with the Agent Framework. It is **not** intended for production use. For production... it is recommended that you **build your own custom interface and API server** using the Agent Framework SDK."*

DevUI 有 CLI 入口（`packages/devui/pyproject.toml:44-45`）：
```toml
[project.scripts]
devui = "agent_framework_devui:main"
```
定位是"目录发现 + 跑 agent + 看 trace"的调试器，不是 Axon 要的客户端。

### 9.2 但是：`_harness/` 是一套真实的 coding-agent 执行面 ★★★

`packages/core/agent_framework/_harness/`，**共 7059 行**：
```
_file_access.py       1602   # 文件工具：read/ls/grep/write/delete/replace/replace_lines
_memory.py            1657   # 记忆
_loop.py               972   # agent 自主循环 + LLM judge 终止判定
_background_agents.py  684   # 后台子 agent 委派
_agent.py              683   # create_harness_agent 工厂
_tool_approval.py      665   # "don't ask again" 审批状态机
_todo.py               615   # 待办清单
_file_memory.py        531
_mode.py               325   # plan / execute 模式
```

`create_harness_agent` 的 docstring（`_harness/_agent.py:345-363`）自陈：
```
"""Create a pre-configured agent with batteries included.

Assembles an :class:`~agent_framework.Agent` from a chat client, automatically wiring:

- **Function invocation** — automatic tool calling loop
- **Per-service-call history persistence** — persists history after every model call
- **Compaction** — context-window compaction before/after each run
- **TodoProvider** — todo list management
- **AgentModeProvider** — plan/execute mode tracking
- **FileMemoryProvider** — file-based session memory (on by default)
- **FileAccessProvider** — shared file read/write tools (opt-in via ``file_access_store``)
- **SkillsProvider** — skill discovery and progressive loading
- **BackgroundAgentsProvider** — delegate work to background sub-agents
- **Tool approval** — "don't ask again" standing approval rules plus heuristic auto-approval callbacks
- **Looping** — re-run the agent until a ``should_continue`` predicate is satisfied
- **OpenTelemetry** — observability via ``AgentTelemetryLayer``
"""
```

**文件工具实测存在**（`_harness/_file_access.py:1264-1276`）：
```python
WRITE_TOOL_NAME = "file_access_write"
READ_TOOL_NAME = "file_access_read"
DELETE_TOOL_NAME = "file_access_delete"
LS_TOOL_NAME = "file_access_ls"
GREP_TOOL_NAME = "file_access_grep"
REPLACE_TOOL_NAME = "file_access_replace"
REPLACE_LINES_TOOL_NAME = "file_access_replace_lines"
```
存储抽象 `AgentFileStore`（`:513`）+ 两实现 `InMemoryAgentFileStore`（`:623`）、`FileSystemAgentFileStore`（`:770`，含 `_resolve_safe_path:816` 和 `_throw_if_contains_symlink:857` —— 路径穿越与符号链接逃逸防护）。

**后台子 Agent 的 6 个工具**（`_harness/_background_agents.py:275-283`）：
```
background_agents_start_task                    # 派活给命名子 agent
background_agents_wait_for_first_completion     # 等第一个完成
background_agents_get_task_results
background_agents_get_all_tasks
background_agents_continue_task                 # 向已完成任务的 session 追加输入续跑
background_agents_clear_completed_task
```
且 *"Each background task runs in its own session and executes concurrently"* —— **这是「纯净分身」的第四条现成路径**，而且是 agent 自己能调用的（LLM 驱动的动态分身创建）。

**技能系统**（`_skills.py`）：`SkillsProvider:1831` + `SkillsProvider.from_paths():2171`，扫描 `SKILL.md`，渐进式加载 —— 跟 Claude Code / 本会话的 skill 机制同构。样例技能见 `samples/02-agents/harness/build_your_own_claw/skills/{valuation,risk-scoring}/{SKILL.md,scripts/,references/}`。

**自主循环**（`_harness/_loop.py`）：
```python
class AgentLoopMiddleware(AgentMiddleware)   # :215
class JudgeVerdict(BaseModel)                # :102  LLM 裁判
def _build_judge_condition(...)              # :151
def todos_remaining(...)                     # :876  "还有待办就继续跑"
def background_tasks_running()               # :817  "还有后台任务就继续等"
```

**还有一个 Textual TUI 参考实现**（`samples/02-agents/harness/console/`），结构完整：
```
harness_console.py    # run_agent_async() 入口
app.py                # HarnessApp (Textual)
agent_runner.py       # 流式编排
state_driver.py / textual_state_driver.py
observers/{text_output,tool_call_display,tool_approval,error_display,usage_display,reasoning_display}.py
components/{scroll_panel,text_input,list_selection,agent_status,agent_mode_help}.py
commands/{exit,mode,todo,session}_handler.py     # /exit  /mode [plan|execute]  /todos  /session-export|import
```
以及 `samples/02-agents/harness/build_your_own_claw/` —— 官方"手搓你自己的 Claude Code"三步教程。

dotnet 侧对等：`dotnet/src/Microsoft.Agents.AI.Harness`、`Microsoft.Agents.AI.Tools.Shell`、`Microsoft.Agents.AI.LocalCodeAct`。

### 9.3 缺口清单：Axon 必须自己补什么

| 缺口 | 现状 | 自研量 |
|---|---|---|
| **代码库语义理解** | ❌ 只有 grep（正则）。无 LSP、无 tree-sitter/AST、无符号索引、无向量检索代码 | **大**（最大缺口） |
| **diff / patch 引擎** | ⚠️ 只有 `replace`（字符串替换）和 `replace_lines`（行号替换）。无 unified-diff 生成/应用、无冲突解决 | 中 |
| **git 集成** | ❌ 完全没有。只能靠 shell 调 git（无结构化 commit/branch/blame/stash 抽象） | 中 |
| **产品级客户端 UI** | ⚠️ 只有 DevUI（非生产）+ Textual 示例 | **大** |
| **权限/沙箱策略引擎** | ⚠️ 有 `shell/_policy.py`（125 行）+ Docker 沙箱 + 工具 approval，但没有"项目级细粒度权限配置"层 | 中小 |
| **多分身生命周期管理** | ⚠️ 底层齐备（session/checkpoint/background agents），但无"分身注册表 / 配额 / 并发调度 / 崩溃恢复"上层 | 中 |
| **测试执行结果解析** | ❌ 无 pytest/jest 等输出的结构化解析（Axon 测试 Agent 需要） | 小 |
| **Token 成本核算与预算** | ⚠️ OTel 有 token 用量指标，但无预算/限额/成本归因 | 小 |

---

## 10. 代码规模与质量

### 10.1 规模（实测 `wc -l`）

| 指标 | 数值 |
|---|---|
| Python 包数 | **36** |
| Python 源码文件（不含 tests） | **342** |
| Python 源码行数 | **146,347** |
| Python 测试行数 | **220,660** |
| **测试/源码比** | **1.51 : 1** ★ |
| dotnet 项目数 | 36 |
| dotnet `.cs` 文件 | 952 |
| dotnet 行数 | **117,262** |
| 声明式 workflow 子系统 | ~10,500 |
| `_harness/`（coding agent 面） | **7,059** |
| `_workflows/`（图引擎） | **~13,300** |
| `orchestrations/`（5 模式） | **6,002** |
| ADR 设计文档 | 40+ 篇（`docs/decisions/`） |

### 10.2 成熟度

- **版本**：`agent-framework-core` **1.14.0**；`Development Status :: 5 - Production/Stable`（`packages/core/pyproject.toml:16`）
- **不是 preview**：核心链路 `core` / `orchestrations` / `declarative` / `openai` / `foundry` / `ag-ui` / `github-copilot` 全部 `released`
- **preview 部分是明确隔离的**：`PACKAGE_STATUS.md:60-153` 逐条列出 experimental feature ID（`HARNESS`、`FUNCTIONAL_WORKFLOWS`、`SESSION_STORE`、`MCP_SKILLS`、`FIDES`、`EVALS`、`AGENT_HOOKS`、`PROGRESSIVE_TOOLS`、`FILE_HISTORY`、`DECLARATIVE_AGENTS`…），并有 `_feature_stage.py` 装饰器在运行时发 `ExperimentalWarning`
- **Python 支持**：3.10 – 3.14
- **迭代速度**：CHANGELOG 显示 1.13→1.14 约两周一个 minor，条目量很大

### 10.3 质量信号（都是正向的）

✅ **测试量 1.5× 源码量**，且有 deterministic replay 的 sample 验证（CHANGELOG "improve sample validation with deterministic replay"）
✅ **多重类型检查**：pyright + mypy `strict=true` + pyrefly + ty（`pyproject.toml:110-127`，`pyrefly.toml`，`ty.samples.toml`）
✅ **`py.typed` + `.pyi` stub**，每个子命名空间都有
✅ **bandit 安全扫描**（`pyproject.toml:129-131`）
✅ **40+ ADR**，重大设计都有书面决策记录
✅ **安全工作持续在做**：路径穿越防护、symlink/junction 拒绝（CHANGELOG "Reject Windows junctions while discovering and accessing skills"）、反序列化白名单、prompt injection ADR、FIDES 安全标签
✅ **API 演进有纪律**：BREAKING 变更在 CHANGELOG 里标 `[BREAKING — experimental]` / `[BREAKING — beta]`，稳定包不破
⚠️ **API 仍在快速演进**：`AgentThread`→`AgentSession`、`run_stream`→`run(stream=)`、`ChatMessage`→`Message`、`@ai_function`→`@tool` 都是近期改名。**Axon 必须锁版本（`==1.14.0`）并在自己的代码里加一层薄适配层。**
⚠️ **网络资料严重滞后于代码**，开发时以源码为准。

---

## 11. 作为 Axon 内核的适配度评分

# **8.5 / 10**

### 逐需求打分

| Axon 需求 | 得分 | 依据 |
|---|---|---|
| 5+ 角色化子 Agent | **10/10** | `Agent` 是组合式的（`_agents.py:1862`），角色=instructions+tools+model；5 种编排模式全覆盖你的协作形态 |
| 多 Agent 协作编排 | **10/10** | `orchestrations` 6002 行 + 图引擎 13300 行；Magentic 直接就是"进度管理 Agent" |
| **纯净上下文分身** | **10/10** | `as_tool()` 默认独立 session；`AgentExecutor` 默认 `create_session()`；`HistoryProvider(load_messages=False)`；background agents 各自独立 session —— **四条路** |
| **继承全部上下文分身** | **10/10** | `as_tool(propagate_session=True)`（`_agents.py:594`）；`AgentExecutor(session=..., context_mode="full")`；共享 `HistoryProvider` 实例 |
| 部分继承/裁剪上下文 | **10/10** | `context_mode="custom"` + `context_filter`（`_agent_executor.py:142-143`）；`store_context_from` + `_attribution` |
| 用户手动创建分身 | **9/10** | Agent 级 YAML + `create_agent_from_dict()`；`bindings` 天然沙箱；`_models.py` 可复用做表单。扣分：workflow 级 YAML 的 Power Fx 不适合直接暴露 |
| 人机对齐（HITL） | **10/10** | `request_info()` + `@response_handler` + `run(responses=...)` + `IDLE_WITH_PENDING_REQUESTS` + `MagenticPlanReviewRequest` + 工具审批状态机 |
| 持久化/崩溃恢复 | **9/10** | Session/History/Checkpoint 三线俱全，工程细节扎实。扣分：内置后端只有 memory/file，生产要自己写 SQLite/PG |
| 多模型混配 | **10/10** | `client` per-Agent；11 家 provider；能力 Protocol 探测 |
| 可观测性 | **10/10** | OTel 是硬依赖，GenAI 语义约定，trace 跨 workflow 节点传播 |
| 工具/MCP | **9/10** | `@tool` + 3398 行 MCP + approval 三层 + shell（Local/Docker）+ hosted tools |
| **coding agent 执行面** | **6/10** | ✅ 文件 read/ls/grep/write/replace、shell、todo、plan/execute、skills、后台 agent、审批。❌ 无 LSP/AST 代码理解、无 diff/patch 引擎、无 git 抽象 |
| 现成客户端 | **3/10** | DevUI 明确非生产；只有 Textual 示例可参考。产品 UI 要自己做 |
| 代码质量/可维护 | **9/10** | 1.5× 测试、strict 类型、40+ ADR、MIT。扣分：API 演进快 |

### 加权理由

**为什么给到 8.5 而不是更低**：你最难自研、最容易做错的三块 —— **多 Agent 编排的正确性**（superstep、fan-in 聚合、图校验）、**上下文隔离/继承的语义**（正好是你的核心需求，它给了四条现成路径）、**HITL + checkpoint 的暂停恢复语义**（跨进程重启续跑，极难自己写对）—— 它全部给齐，而且是 production-stable 质量，MIT 无约束。再加上 `_harness/` 意外地把 coding agent 的"骨架"也给了（todo/plan-execute/skills/文件/shell/审批），你省掉的不只是编排层。

**为什么不给 9+**：
1. **无产品级客户端** —— Axon 作为"客户端"产品，UI/交互/状态管理这块 100% 自研（DevUI 不可用，Textual 示例只能参考）。
2. **代码库理解能力缺失** —— 这是 coding agent 的真正护城河（LSP、符号索引、AST 编辑、diff 引擎、git），框架完全没有。`grep` 不等于代码理解。
3. **API 仍在改名期** —— 1.x 但近期发生 `AgentThread→AgentSession` 这类 rename，Axon 必须锁版本 + 自建适配层，这是持续的维护税。
4. **Azure/Foundry 引力** —— 样例默认 `FoundryChatClient`，非 Azure 路径虽支持但样例覆盖和打磨程度略逊（多数 provider 是 `beta`）。

---

## 12. 集成路径可行性

### a) 作为编排层依赖库 —— 可行，但**低估了它**

只用 `_workflows` + `orchestrations`，自己写 agent 运行时。

- ✅ 耦合最小，Axon 保持对 Agent 抽象的完全控制
- ❌ **白白丢掉** `_harness/` 7059 行（todo/plan-execute/file/shell/skills/审批/后台 agent）、`_sessions.py` 2376 行的 context provider 体系、`_mcp.py` 3398 行、11 家 provider 适配、OTel 接线
- ❌ 真正的问题：编排层和 Agent 层在这个框架里是**咬合的**。`AgentExecutor`（`_agent_executor.py:119`）依赖 `SupportsAgentRun` + `AgentSession` + `AgentResponse`；`context_mode`/`session` 这些正是你要的分身语义，它们长在 orchestration 与 session 的接缝上。剥离编排层 = 要么自己实现 `SupportsAgentRun` 全套协议（那不如直接用），要么失去 §4.3 的分身机制
- **判定：技术可行，但性价比最差。不推荐。**

### b) 全栈基于它开发 —— ✅ **推荐**

用 `agent-framework-core` + `orchestrations` + `declarative` + `tools` 做全部内核，Axon 自己写**客户端层 + 代码理解层**。

分层建议：
```
┌──────────────────────────────────────────────────┐
│ Axon 客户端层（100% 自研）                          │
│  TUI/GUI · 分身管理面板 · diff 审阅 · 权限配置       │
│  可参考 samples/02-agents/harness/console/         │
├──────────────────────────────────────────────────┤
│ Axon 领域层（自研，~30%）                           │
│  ① 代码理解：LSP client / tree-sitter / 符号索引 ★  │
│  ② diff/patch 引擎 + git 抽象 ★                    │
│  ③ 分身注册表（纯净/继承/裁剪三模式 + 配额调度）      │
│  ④ 5 角色的 instructions/tools/model 配置          │
│  ⑤ 测试输出解析器 · 成本预算                        │
│  以上①②⑤统一包装成 @tool 注入                      │
├──────────────────────────────────────────────────┤
│ MAF 适配层（自研，薄，~500 行）★必须有               │
│  锁定 ==1.14.0，隔离 Agent/Session/Workflow 命名    │
├──────────────────────────────────────────────────┤
│ Microsoft Agent Framework（依赖）                  │
│  Agent · AgentSession · ContextProvider           │
│  Workflow · orchestrations · _harness · MCP · OTel │
└──────────────────────────────────────────────────┘
```

落地映射（全部有源码依据）：
| Axon 组件 | 直接用什么 |
|---|---|
| 进度管理 Agent | `MagenticBuilder` + `MagenticProgressLedger` + `TodoProvider` |
| 架构设计 Agent | `Agent(client=强模型, instructions=..., tools=[只读代码理解工具])` |
| 开发执行 Agent | `create_harness_agent(file_access_store=..., shell_executor=LocalShellTool(), skills_paths=...)` |
| 测试 Agent | `Agent(tools=[shell_tool, 测试解析工具])` + `AgentLoopMiddleware`（跑到绿为止） |
| 人机对齐 Agent | `ctx.request_info()` + `@response_handler` + `ToolApprovalMiddleware` |
| 内核编排 | `HandoffBuilder`（mesh 自主转交）或 `MagenticBuilder`（中心化调度） |
| 纯净分身 | `as_tool()` / `AgentExecutor(context_mode="last_agent")` / `HistoryProvider(load_messages=False)` |
| 继承分身 | `as_tool(propagate_session=True)` / `AgentExecutor(session=kernel_session, context_mode="full")` |
| 用户建分身 | `AgentFactory.create_agent_from_dict()` + `tools.bindings` 白名单 |
| 会话/崩溃恢复 | `FileSessionStore` + `FileCheckpointStorage`（生产换 SQLite） |
| 追踪 | 白送（`AgentTelemetryLayer` 在 MRO 里） |

**风险与对策**：
- API 演进 → 锁 `==1.14.0` + 适配层 + CI 跑上游 CHANGELOG diff
- experimental 依赖（`HARNESS`/`SESSION_STORE`/`shell`）→ 这些正是你最需要的。对策：把 `_harness` 的 Provider 当**参考实现**，Axon 自己实现同接口的 `ContextProvider`（接口本身是 released 的，只有具体 provider 是 experimental）
- Azure 倾向 → 用 `OpenAIChatClient`/`AnthropicClient`/`OllamaChatClient`，自建集成测试

### c) 只借鉴设计 —— 不推荐（除非有硬约束）

值得抄的设计（就算选 b 也该理解）：
- **Session 极薄 + Provider 拥有存储权**（`_sessions.py:1656-1657`）—— 这是整个上下文隔离能力的源头
- **`ContextProvider.before_run/after_run` + `SessionContext` 装配区**（`_sessions.py:500, 766`）—— 比"塞 system prompt"优雅一个量级
- **消息 `_attribution` 溯源**（`_sessions.py:604-641`）
- **checkpoint 绑定 workflow 定义而非实例 + `graph_signature_hash` 校验**（`_checkpoint.py:37-48`）
- **`WorkflowContext[OutT, W_OutT]` 泛型即契约 → 构图期静态校验**
- **provider 能力用 Protocol 探测而非 if/else**（`SupportsShellTool` 等）
- **`Raw*` / 公开类双层 + Layer mixin 组合**（`_agents.py:1766`）

但只借鉴意味着放弃 **146k 行 production-stable 代码 + 220k 行测试 + MIT 许可**，然后自己重写编排引擎、checkpoint、HITL、11 家 provider 适配。**仅在有"不能引入微软系依赖"或"必须非 Python/C#"硬约束时才选。**

---

## 13. 拿来即用 vs 必须自己补

### ✅ 拿来即用（零/极少改动）

| 能力 | 位置 |
|---|---|
| Agent 抽象 + 组合式角色定义 | `_agents.py:1766` |
| 统一 `run(stream=)` + `ResponseStream` 流式 | `_agents.py:1829` |
| Session/上下文隔离与继承（★核心需求） | `_sessions.py:1653`, `_agents.py:594`, `_agent_executor.py:142` |
| ContextProvider 上下文工程管线 | `_sessions.py:736` |
| 上下文压缩（token 预算感知） | `_compaction.py` |
| 5 种多 Agent 编排 | `orchestrations/`（6002 行） |
| 通用图执行引擎（superstep、条件边、fan-in/out、switch） | `_workflows/`（~13300 行） |
| Workflow ↔ Agent 双向嵌套 | `_workflow.py:1193`, `_workflow_executor.py` |
| Checkpoint 保存/恢复 | `_checkpoint.py` |
| HITL request/response + 跨进程续跑 | `_workflow_context.py:403`, `_workflow.py:732` |
| `@tool` 装饰器 + schema 自动推导 | `_tools.py:1162` |
| 工具审批三层（含 "don't ask again" 持久化） | `_tools.py:1168`, `_harness/_tool_approval.py` |
| MCP client（stdio/HTTP/WS）+ MCP server 托管 | `_mcp.py`, `packages/hosting-mcp/` |
| Shell 执行（Local + Docker 沙箱 + 策略 + 进程树清理） | `packages/tools/shell/`（2480 行） |
| 文件工具 read/ls/grep/write/delete/replace/replace_lines | `_harness/_file_access.py:1264-1276` |
| Todo / plan-execute mode | `_harness/_todo.py:446`, `_mode.py:197` |
| Skills（SKILL.md 渐进加载） | `_skills.py:1831, 2171` |
| 后台子 Agent 委派（6 工具，独立 session） | `_harness/_background_agents.py:268` |
| Agent 自主循环 + LLM judge | `_harness/_loop.py:215` |
| 11 家 LLM provider + 能力探测 | `packages/{openai,anthropic,gemini,...}` |
| hosted code interpreter / web search / file search | `SupportsCodeInterpreterTool` 等 |
| 声明式 Agent YAML + 加载器 + Pydantic schema | `declarative/_loader.py:143`, `_models.py` |
| OTel 全链路（GenAI 语义约定 + 跨节点 trace） | `observability.py`, `_telemetry.py` |
| Session/History 持久化（file、Redis、Cosmos、Mem0） | `_sessions.py`, `packages/{redis,mem0,...}` |
| A2A / AG-UI / ChatKit 协议 | `packages/{a2a,ag-ui,chatkit}` |
| 评估框架 | `_evaluation.py`（experimental EVALS） |
| 安全：路径防护、prompt injection 防御、FIDES 标签 | `security.py`, `_file_access.py:816,857` |

### ❌ 必须自己补

| 缺口 | 为什么框架没有 | 工作量 | 优先级 |
|---|---|---|---|
| **代码库语义理解**：LSP client、tree-sitter/AST、符号索引、引用图、代码向量检索 | 框架只提供正则 `grep`，是通用 agent 框架而非 coding agent | **大（Axon 最大自研项，也是护城河）** | P0 |
| **diff / patch 引擎**：unified diff 生成、应用、冲突解决、变更审阅 | 只有字符串/行号 replace | 中 | P0 |
| **git 集成**：结构化 commit/branch/diff/blame/stash | 完全没有（只能 shell 调 git） | 中 | P0 |
| **产品级客户端**：TUI/GUI、分身管理面板、diff 审阅 UI、流式渲染、状态机 | DevUI 明确非生产 | **大**（可参考 `harness/console/`） | P0 |
| **分身生命周期管理**：注册表、配额、并发调度、崩溃恢复、上下文来源可视化 | 底层齐备但无上层管理面 | 中 | P1 |
| **项目级权限/沙箱策略**：路径白名单、命令白名单、危险操作分级 | 有 `shell/_policy.py` + Docker + approval，但无项目级配置层 | 中小 | P1 |
| **测试输出结构化解析**：pytest/jest/go test → 失败用例结构 | 框架不管领域 | 小 | P1 |
| **成本核算与预算**：per-agent token 成本归因、限额、熔断 | OTel 有用量指标，无预算逻辑 | 小 | P2 |
| **生产级存储后端**：SQLite/Postgres 的 SessionStore + CheckpointStorage | 内置只有 memory/file | 小（各 6 个 async 方法） | P1 |
| **MAF 适配层**：锁版本 + 命名隔离 | 上游 API 仍在演进 | 小（~500 行，但必须做） | P0 |

### 一句话总结「有没有 coding agent 的执行面」

**有骨架，没大脑。**

`_harness/` 给了执行面的**手脚**（文件读写、shell、todo、plan/execute、skills、审批、后台分身），质量不错、可直接用。但 coding agent 真正值钱的**代码理解大脑**（LSP/AST/符号索引/diff/git）完全没有 —— 它的文件工具停留在 `read/grep/replace` 这种"文本层"，而不是"代码层"。

Axon 的差异化恰好应该建在这个缺口上：**用 MAF 当躯干和神经系统（编排 + 上下文 + 分身 + HITL + 持久化 + 可观测），自研代码理解层当大脑，自研客户端当界面。**

---

## 附：关键文件速查

```
python/packages/core/agent_framework/
├── _agents.py                1925  SupportsAgentRun:224 BaseAgent:364 RawAgent:707 Agent:1766 as_tool:585
├── _sessions.py              2376  SessionContext:500 ContextProvider:736 HistoryProvider:879
│                                   AgentSession:1653 SessionStore:1731 FileSessionStore:1808
│                                   InMemoryHistoryProvider:2023 FileHistoryProvider:2105
├── _types.py                 4134  Message / Content / AgentResponse / ChatOptions
├── _tools.py                 3514  FunctionTool:316 tool():1162
├── _mcp.py                   3398  MCPTool:396 Stdio:2705 HTTP:2896 WS:3201
├── _middleware.py            1733  FunctionInvocationContext:212 ChatContext:381
│                                   AgentMiddleware:477 FunctionMiddleware:536 ChatMiddleware:600
├── _clients.py               1012  SupportsChatGetResponse / Supports*Tool
├── _skills.py                      SkillsProvider:1831 from_paths:2171 MCPSkillsSource:4863
├── _compaction.py                  CompactionProvider / ContextWindowCompactionStrategy
├── observability.py                OtelAttr:214 ObservabilitySettings:727
├── security.py                     FIDES: SecureMCPToolProxy / ContentLabel
├── _evaluation.py                  LocalEvaluator / evaluate_agent / evaluate_workflow
├── _workflows/  (~13300)
│   ├── _workflow.py          1243  Workflow:208 run:709 as_agent:1193
│   ├── _workflow_builder.py   890  WorkflowBuilder:53 add_edge:230 fan_out:282 switch:338
│   │                               multi_selection:425 fan_in:511 chain:566 build:727
│   ├── _executor.py           814  Executor:31 handler:558
│   ├── _workflow_context.py   489  WorkflowContext:217 send_message:318 yield_output:350
│   │                               request_info:403 get_state:436 set_state:440
│   ├── _agent_executor.py     602  AgentExecutor:119 (session / context_mode:142)
│   ├── _checkpoint.py         461  WorkflowCheckpoint:31 CheckpointStorage:129
│   │                               InMemory:202 File:249
│   ├── _edge.py               943 / _edge_runner.py 446 / _runner.py 481
│   ├── _validation.py         462 / _viz.py 442 / _functional.py 1624
│   ├── _request_info_mixin.py 369  (HITL)
│   └── _workflow_executor.py  610  (workflow 嵌套)
└── _harness/  (7059)  ★ coding agent 执行面
    ├── _agent.py              683  create_harness_agent:302
    ├── _file_access.py       1602  AgentFileStore:513 InMemory:623 FileSystem:770
    │                               FileAccessProvider:1204 tool names:1264-1276
    ├── _memory.py            1657 / _file_memory.py 531 (FileMemoryProvider:220)
    ├── _loop.py               972  AgentLoopMiddleware:215 JudgeVerdict:102 todos_remaining:876
    ├── _background_agents.py  684  BackgroundAgentsProvider:268
    ├── _tool_approval.py      665  ToolApprovalRule:86 ToolApprovalState:158
    ├── _todo.py               615  TodoProvider:446 TodoFileStore:288
    └── _mode.py               325  AgentModeProvider:197

python/packages/orchestrations/agent_framework_orchestrations/  (6002)
├── _magentic.py              1810  MagenticBuilder / StandardMagenticManager / ProgressLedger
├── _handoff.py               1129  HandoffBuilder / HandoffAgentExecutor
├── _group_chat.py            1043  GroupChatBuilder:617 (selection_func / termination_condition)
├── _base_group_chat_orchestrator.py 600
├── _concurrent.py             434  ConcurrentBuilder
└── _sequential.py             272  SequentialBuilder

python/packages/tools/agent_framework_tools/shell/  (2480)
└── _tool.py 335 · _docker.py 719 · _session.py 443 · _environment.py 281 · _policy.py 125

python/packages/declarative/agent_framework_declarative/  (11443)
├── _loader.py                 874  AgentFactory:143 create_agent_from_{yaml_path:291,yaml:345,dict:418}
├── _models.py                1154  Pydantic schema（可复用做 UI 表单）
└── _workflows/             ~10500  Power Fx 表达式引擎等

declarative-agents/
├── agent-samples/{chatclient,openai,azure,foundry}/*.yaml
└── workflow-samples/{DeepResearch,CustomerSupport,Marketing,MathChat}.yaml

python/samples/
├── 02-agents/harness/         ★ create_harness_agent + Textual TUI + build_your_own_claw
├── 02-agents/context_providers/  ★ 上下文隔离/共享
├── 02-agents/conversations/   ★ 历史持久化 + suspend_resume_session
├── 03-workflows/orchestrations/  ★ 全部多 agent 模式
├── autogen-migration/ · semantic-kernel-migration/
docs/decisions/                40+ ADR
```

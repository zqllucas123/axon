# OpenAI Codex 深度调研报告 —— 作为 Axon 多子 Agent 客户端内核的可行性评估

> 调研对象：`/Users/lucaszhou/works/prjs/agents/codex`（codex-rs + codex-cli + sdk）
> 调研方式：只读源码分析，重点 `codex-rs/core`、`codex-rs/protocol`、`codex-rs/app-server-protocol`
> 调研目标：评估将 codex 作为 Axon（5+ 角色化子 Agent 协作客户端）内核的适配度
> 结论速览：**适配度 9/10**。这个版本的 codex 已经不是"单 Agent CLI"，而是一个内建 **多 Agent 树 + 角色系统 + 上下文 fork 策略 + GUI 后端协议** 的 Agent 运行时。Axon 的核心需求几乎全部有对应的一等实现。

---

## 0. 关键结论摘要（先看这个）

| Axon 需求 | codex 现状 | 证据 |
|---|---|---|
| 5+ 角色化子 Agent | ✅ **一等支持**。`agent_roles` 配置系统，每角色独立 model / developer_instructions / features / skills | `core/src/agent/role.rs:36-48`, `core/src/config/agent_roles.rs:20` |
| 纯净上下文轻量分身 | ✅ `fork_turns="none"` → `SpawnAgentForkMode` 不传父历史 | `core/src/tools/handlers/multi_agents_v2/spawn.rs:298` |
| 继承全部内置上下文分身 | ✅ `fork_turns="all"` → `SpawnAgentForkMode::FullHistory` | `core/src/agent/control.rs:70-73`, `spawn.rs:301` |
| 部分继承（折中） | ✅ `fork_turns="3"` → `LastNTurns(3)` （额外赠送的能力） | `core/src/agent/control.rs:72`, `spawn.rs:305` |
| 子 Agent 间通信 | ✅ `InterAgentCommunication` + AgentPath 路径寻址（`/root/task1/task_3`） | `protocol/src/protocol.rs:738-754` |
| GUI 作为前端驱动 | ✅ app-server，**~230 个 JSON-RPC 方法**，stdio/unix/ws 三种传输 | `app-server-protocol/src/protocol/common.rs:487`, `app-server/src/main.rs:29-35` |
| 人机对齐（审批/追问） | ✅ `request_user_input` / `request_permissions` / `ExecApprovalRequest` 工具与事件 | `core/src/tools/handlers/request_user_input.rs` 等 |
| 流式输出 | ✅ delta 级事件（`AgentMessageContentDelta` / `ReasoningContentDelta`） | `protocol/src/protocol.rs:1470-1473` |
| 中断 | ✅ `Op::Interrupt` + `CancellationToken` 树 | `protocol/src/protocol.rs:546`, `tasks/regular.rs:82` |

**最大风险**：codex 的 `WireApi` 已**删除 Chat Completions**，只保留 Responses API（`model-provider-info/src/lib.rs:63-67, 86`）。接非 OpenAI 模型需要自建适配层。

---

## 1. Crate 拓扑：谁是真正的内核

`codex-rs` 是一个 **137 成员的 Cargo workspace**（`codex-rs/Cargo.toml:2-137`）。按职责分层：

### 1.1 内核层（Axon 真正要用的）

| Crate | 行数 | 职责 |
|---|---|---|
| **`core`** | **326,478** | **真正的内核**。Session/Turn 循环、上下文管理、工具注册与执行、多 Agent 控制、compact、AGENTS.md 装配 |
| `protocol` | 25,856 | `Op` / `Event` / `EventMsg` / `RolloutItem` 等核心协议类型（纯数据，无逻辑） |
| `config` | 24,188 | 分层配置栈（`ConfigLayerStack`），TOML 解析 |
| `state` | 21,920 | SQLite 状态库（`sqlx`） |
| `thread-store` | 29,563 | 线程持久化抽象 |
| `rollout` | 14,835 | JSONL rollout 文件读写、压缩、检索 |
| `tools` | 6,926 | `ToolSpec` / `JsonSchema` / `ToolExecutor` trait 定义（轻量，被 core 实现） |
| `sandboxing` | 8,322 | seatbelt(macOS) / landlock+bwrap(Linux) / windows 沙箱 |
| `ext/*` | 44,868 | 扩展模块：agent / goal / memories / mcp / queue / skills / web-search 等 |

**结论**：`codex-core` 是唯一的内核。它是一个 32.6 万行的巨型 crate，`lib.rs` 有 207 行纯粹的模块声明与 re-export（`core/src/lib.rs`）。

### 1.2 宿主/前端层（Axon 会替换掉的）

| Crate | 行数 | 职责 |
|---|---|---|
| `tui` | 270,222 | Ratatui 终端 UI —— **Axon 直接丢弃** |
| `app-server` | 144,829 | **JSON-RPC 后端服务** —— Axon 的核心集成点 |
| `app-server-protocol` | 32,339 | 协议定义（`ts-rs` 可导出 TypeScript） |
| `exec` | 10,991 | `codex exec` 非交互模式（SDK 底层驱动） |
| `cli` | — | 命令分发入口 |
| `mcp-server` | 4,164 | 把 codex 自己**暴露为 MCP server** |
| `rmcp-client` | 24,780 | 作为 **MCP client** 连接外部 server |

### 1.3 依赖方向

```
cli ──┬─> tui ─────────┐
      ├─> app-server ──┼─> core ──┬─> protocol (纯类型)
      └─> exec ────────┘          ├─> config / state / thread-store / rollout
                                  ├─> tools / sandboxing / execpolicy
                                  ├─> rmcp-client (MCP client)
                                  ├─> model-provider-info / models-manager
                                  └─> ext/* (可插拔扩展)
sdk/typescript ──(spawn 子进程)──> codex exec
sdk/python ─────(spawn 子进程)──> app-server
```

`protocol` 是叶子（零业务依赖），这是好设计——Axon 可以只依赖 `protocol` 来定义自己的前端类型。

---

## 2. Agent 主循环与事件模型

### 2.1 任务抽象：`SessionTask` trait

核心是一个小而清晰的 trait（`core/src/tasks/mod.rs:187-200`）：

```rust
pub(crate) trait SessionTask: Send + Sync + 'static {
    fn kind(&self) -> TaskKind;
    fn span_name(&self) -> &'static str;
    async fn run(
        self: Arc<Self>,
        sess: Arc<Session>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> SessionTaskResult;
    async fn abort(&self, session: Arc<Session>, ctx: Arc<TurnContext>);
}
```

五种实现（`core/src/tasks/mod.rs:1-5`）：`RegularTask`（常规对话）、`CompactTask`（压缩）、`ReviewTask`（审查）、`UserShellCommandTask`（`!cmd`）、以及 lifecycle。

**对 Axon 的意义**：新增一种子 Agent 工作模式 = 实现一个 `SessionTask`。这是内核最干净的扩展点之一。

### 2.2 两层循环

**外层**（`core/src/tasks/regular.rs:76-90`）：处理用户在模型运行中插入的新输入（steering）

```rust
let mut next_input = input;
loop {
    let last_agent_message = run_turn(
        Arc::clone(&sess), Arc::clone(&ctx), next_input,
        prewarmed_client_session.take(),
        cancellation_token.child_token(),   // ← 子 token，支持层级取消
    ).await?;
    if !sess.input_queue.has_pending_input(&sess.active_turn).await {
        return Ok(last_agent_message);
    }
    next_input = Vec::new();
}
```

**内层**（`core/src/session/turn.rs:301`，`run_turn` 从 153 行开始）：单个 turn 内的"采样 → 工具调用 → 再采样"循环。关键步骤：

1. `run_pre_sampling_compact` — 采样前自动压缩（`turn.rs:169`）
2. `capture_step_context_with_required_mcp_servers` — 冻结本步的上下文视图（`turn.rs:208`）
3. `record_context_updates_and_set_reference_context_item` — 记录上下文 diff 基线（`turn.rs:225`）
4. 循环体内 `sess.clone_history().await.for_prompt(...)` 构造模型输入（`turn.rs:371-373`）
5. `run_sampling_request(...)` 发起采样（`turn.rs:381`）
6. 依据 `needs_follow_up`（模型还要调工具）或 `has_pending_input`（用户插话）决定是否继续（`turn.rs:423`）

### 2.3 事件协议：`Op` 入 / `Event` 出

**`Op`（客户端 → 内核）**，`protocol/src/protocol.rs:543-698`，约 25 个变体。重点：

```rust
pub enum Op {
    Interrupt,                                    // :546  中断当前任务
    TurnInput { request, mode, reply },           // :571  提交 turn 输入（带 oneshot 回执）
    RecoverTurn { .. },                           // :578  恢复被中断的 turn
    InterAgentCommunication { communication },    // :594  ★ Agent 间通信
    ExecApproval { id, turn_id, decision },       // :599  命令审批
    PatchApproval { id, decision },               // :609  补丁审批
    ResolveElicitation { .. },                    // :617  MCP elicitation 应答
    UserInputAnswer { id, response },             // :631  ★ 人机对齐：回答模型追问
    RequestPermissionsResponse { id, response },  // :639  权限授予
    Compact,                                      // :666  手动压缩
    ThreadRollback { num_turns },                 // :678  回滚 N 轮
    Review { review_request },                    // :681  进入审查模式
    Shutdown,                                     // :687
    RunUserShellCommand { command },              // :694
    // ... 以及 Realtime 语音系列
}
```

`TurnInput` 变体带 `reply: oneshot::Sender<...>`（`:574`）——提交即得回执，这对 GUI 的乐观更新很友好。

**`EventMsg`（内核 → 客户端）**，`protocol/src/protocol.rs:1288-1500+`，**100+ 变体**。分类：

- **生命周期**：`TurnStarted`(:1332) / `TurnComplete`(:1341) / `TurnAborted`(:1451) / `SessionConfigured`(:1363)
- **流式增量**：`AgentMessageContentDelta`(:1470) / `PlanDelta`(:1471) / `ReasoningContentDelta`(:1472) / `ReasoningRawContentDelta`(:1473)
- **结构化条目**：`ItemStarted`(:1465) / `ItemCompleted`(:1466) —— 新一代 API，替代零散事件
- **工具执行**：`ExecCommandBegin`(:1396) / `ExecCommandOutputDelta`(:1399) / `ExecCommandEnd`(:1404) / `McpToolCallBegin`(:1383)
- **审批请求**：`ExecApprovalRequest`(:1409) / `RequestPermissions`(:1411) / `RequestUserInput`(:1413) / `ApplyPatchApprovalRequest`(:1421)
- **多 Agent（Collab）**：`CollabAgentSpawnBegin`(:1476) / `CollabAgentSpawnEnd`(:1478) / `CollabAgentInteractionBegin`(:1480) / `CollabWaitingBegin`(:1484) / `CollabCloseBegin`(:1488) —— **Axon 的子 Agent 面板可直接消费这些**
- **上下文**：`ContextCompacted`(:1324) / `TokenCount`(:1345) / `ThreadRolledBack`(:1327)
- **审查模式**：`EnteredReviewMode`(:1457) / `ExitedReviewMode`(:1460)

### 2.4 中断机制

三层：
1. `Op::Interrupt` → 触发 session 的 abort
2. `CancellationToken` 树 —— `cancellation_token.child_token()` 在每层派生（`tasks/regular.rs:82`, `turn.rs:389`），父取消自动传播到所有子任务
3. 优雅超时 `GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100`（`tasks/mod.rs:66`），超时后强杀

中断后会在历史里留下模型可见的标记（`tasks/mod.rs:102-125` `interrupted_turn_history_marker`），让模型知道"上一轮被打断了"——细节做得很到位。

---

## 3. 上下文与状态管理

### 3.1 `ContextManager`

`core/src/context_manager/history.rs:44-65`：

```rust
pub(crate) struct ContextManager {
    items: Arc<Vec<ResponseItemEnvelope>>,       // ← Arc 共享，读多写少零拷贝
    history_version: u64,                        // 压缩/回滚时递增
    token_info: Option<TokenUsageInfo>,
    reference_context_item: Option<TurnContextItem>,  // ← 上下文 diff 基线
    world_state_baseline: Option<WorldStateSnapshot>,
}
```

**设计亮点 —— 上下文 diff 机制**：`reference_context_item` 保存上一轮注入的上下文快照。下一轮只注入**变化的部分**（而非全量重注入），大幅节省 token。注释解释得很清楚（`history.rs:53-61`）：当它为 `None` 时，"settings diffing treats the next turn as having no baseline and emits a full reinjection"。

### 3.2 系统提示词装配

`Prompt` 结构（`core/src/client_common.rs:19-37`）：

```rust
pub struct Prompt {
    pub input: Vec<ResponseItem>,          // 会话历史
    pub(crate) tools: Arc<[ToolSpec]>,     // 工具（含 MCP 来源）
    pub(crate) parallel_tool_calls: bool,
    pub base_instructions: BaseInstructions,  // 系统提示词
    pub output_schema: Option<Value>,         // 结构化输出
    pub output_schema_strict: bool,
}
```

上下文片段是**类型化**的，`core/src/context/` 下有 40+ 个独立文件，每个是一种可注入的上下文片段：`environment_context.rs`、`user_instructions.rs`、`multi_agent_mode_instructions.rs`、`multi_agent_role_instructions.rs`、`subagent_notification.rs`、`inter_agent_message.rs`、`current_time_reminder.rs`、`token_budget_context.rs` 等。

每个片段实现 `matches_text()` 用于识别与剥离（见 `agent/control/spawn.rs:106-111` fork 时的清洗逻辑）。**这是个非常值得 Axon 借鉴的设计** —— 上下文片段可寻址、可剥离、可替换。

### 3.3 AGENTS.md 层级合并规则

`core/src/agents_md.rs:1-16` 的文档注释写明了规则：

1. **确定项目根**：从 cwd 向上走，直到找到 `project_root_markers`（默认 `.git`）。空列表则禁用向上遍历。
2. **收集**：从项目根**向下**到 cwd（含），收集每一层的 AGENTS.md，按该顺序拼接。
3. **不越过项目根**。

文件名优先级（`agents_md.rs:283-297`）：
```rust
names.push(LOCAL_AGENTS_MD_FILENAME);    // "AGENTS.override.md"  ← 最高优先
names.push(DEFAULT_AGENTS_MD_FILENAME);  // "AGENTS.md"
// + config.project_doc_fallback_filenames
```

拼接分隔符（`agents_md.rs:48`）：
```rust
const AGENTS_MD_SEPARATOR: &str = "\n\n--- project-doc ---\n\n";
```

实现细节：
- `find_nearest_ancestor_with_markers` 定位项目根（`agents_md.rs:226`）
- 并发探测，上限 256（`agents_md.rs:53` `MAX_CONCURRENT_ANCESTOR_PROBES`）
- 有字节预算 `config.project_doc_max_bytes`，超预算截断并 warn（`agents_md.rs:168-178`）
- 走 `ExecutorFileSystem` 抽象 + 沙箱上下文 —— 即使读 AGENTS.md 也受沙箱约束（`agents_md.rs:74-92`）
- 多环境（multi-environment）时输出带环境标签（`agents_md.rs:361-365`）

### 3.4 上下文压缩（compact）

`core/src/compact.rs`，783 行。两种注入策略（`compact.rs:68-74`）：

```rust
pub(crate) enum InitialContextInjection {
    BeforeLastUserMessage { world_state, step_context },  // 轮内压缩
    DoNotInject,                                          // 轮前/手动压缩
}
```

注释解释了为什么要分两种（`compact.rs:59-67`）：轮内压缩时模型被训练成"把压缩摘要看作历史最后一项"，所以必须把初始上下文注入到最后一条真实用户消息**之上**；而轮前压缩会清空 `reference_context_item`，下一轮自然全量重注入。

触发路径：
- `run_pre_sampling_compact`（`turn.rs:169`）—— 采样前检查
- `run_inline_auto_compact_task`（`compact.rs:111`）—— 轮内自动
- `Op::Compact`（`protocol.rs:666`）—— 手动
- 还有远程压缩：`compact_remote.rs` / `compact_remote_v2.rs` / `compact_remote_history.rs`（服务端压缩，省本地 token）

压缩提示词来自 `codex_prompts::SUMMARIZATION_PROMPT`，可被 `config.compact_prompt` 覆盖（`compact.rs:118-123`）。用户消息在压缩中最多保留 20,000 token（`compact.rs:57`）。

---

## 4. 多 Agent / 子 Agent —— **Axon 最关心的部分**

这个版本的 codex 有**完整的多 Agent 树实现**，不是玩具。

### 4.1 三套并存的子 Agent 机制

| 机制 | 上下文隔离 | 用途 | 代码 |
|---|---|---|---|
| **MultiAgent V2** | 可选 none/N/all | **生产级多 Agent 树**，Axon 主用 | `core/src/tools/handlers/multi_agents_v2/` |
| MultiAgent V1 | fork_context 布尔 | 旧版，命名空间 `multi_agent_v1` | `core/src/tools/handlers/multi_agents.rs` |
| Review 模式 | **完全纯净** | 独立上下文的代码审查子任务 | `core/src/tasks/review.rs` |

### 4.2 MultiAgent V2：六个工具

`core/src/tools/handlers/multi_agents_v2/` 目录下正好六个工具实现：

| 文件 | 工具名 | 语义 |
|---|---|---|
| `spawn.rs` | `spawn_agent` | 派生子 Agent，指定 `task_name` / `agent_type` / `fork_turns` / `model` / `reasoning_effort` / `service_tier` |
| `send_message.rs` | `send_message` | 向已存在 Agent 投递消息，**不触发新 turn** |
| `followup_task.rs` | `followup_task` | 投递后续任务，目标空闲则**触发 turn**；忙则在消息边界送达 |
| `wait.rs` | `wait_agent` | 等待任意 Agent 的 mailbox 更新（含最终状态通知）。有用户 steering 时提前返回 |
| `list_agents.rs` | `list_agents` | 列出当前根线程树下的活跃 Agent，可按路径前缀过滤 |
| `interrupt_agent.rs` | `interrupt_agent` | 中断目标 Agent 当前 turn，Agent 仍可接收消息 |

（另有 `message_tool.rs` 作为共用基础设施）

工具 Schema 定义在 `core/src/tools/handlers/multi_agents_spec.rs`：
- `create_spawn_agent_tool_v2`（:102）
- `create_send_message_tool`（:186）
- `create_followup_task_tool`（:218）
- `create_wait_agent_tool_v2`（:285）
- `create_list_agents_tool`（:297）
- `create_interrupt_agent_tool_v2`（:340）

**Agent 路径寻址**（`multi_agents_spec.rs:760-762`），这是很优雅的设计：

> "If your current task is `/root/task1` and you spawn_agent with task_name `task_3` the agent will have canonical task name `/root/task1/task_3`. You are then able to refer to this agent as `task_3` or `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only be able to communicate with this agent via its canonical name."

相对路径 + 绝对路径，类似文件系统。解析逻辑在 `agent/control.rs:384-403` `resolve_agent_reference`。

### 4.3 ★ 上下文隔离/继承：`SpawnAgentForkMode`

**这正是 Axon 的"纯净分身 vs 继承分身"需求的现成答案。**

类型定义（`core/src/agent/control.rs:69-73`）：

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SpawnAgentForkMode {
    FullHistory,
    LastNTurns(usize),
}
```

模型侧参数解析（`core/src/tools/handlers/multi_agents_v2/spawn.rs:279-313`）：

```rust
fork_turns: Option<String>,
// ...
let fork_turns = self.fork_turns...unwrap_or("all");

if fork_turns.eq_ignore_ascii_case("none") {
    // → 不 fork，纯净上下文
}
if fork_turns.eq_ignore_ascii_case("all") {
    // → SpawnAgentForkMode::FullHistory
}
let last_n_turns = fork_turns.parse::<usize>().map_err(|_| {
    "fork_turns must be `none`, `all`, or a positive integer string"
})?;
// → SpawnAgentForkMode::LastNTurns(n)
```

工具描述里对模型的指引（`multi_agents_spec.rs:768`）：
> "passing `fork_turns="none"` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs, whereas `fork_turns="all"` will provide the subagent with all surrounding context."

**映射到 Axon**：
- 「纯净上下文的轻量分身」= `fork_turns="none"`
- 「继承内核全部内置上下文的分身」= `fork_turns="all"`
- 赠送的第三态：`fork_turns="5"` = 只继承最近 5 轮

### 4.4 Fork 时的上下文清洗（精细工程）

`spawn_forked_thread`（`agent/control/spawn.rs:609-885`）不是简单复制历史，而是做了细致清洗：

**保留规则** `keep_forked_rollout_item`（`spawn.rs:54-91`）：
```rust
ResponseItem::Message { role, phase, .. } => match role.as_str() {
    "system" | "developer" | "user" => true,
    "assistant" => *phase == Some(MessagePhase::FinalAnswer),  // 只留最终答案
    _ => false,
},
// 工具调用、reasoning、中间产物 → 全部丢弃
RolloutItem::InterAgentCommunication(_) => false,   // 父的 Agent 间通信不继承
RolloutItem::TurnContext(_) | RolloutItem::WorldState(_) => preserve_reference_context_item,
```

**剥离父角色指令**（`spawn.rs:93-114` `retain_forked_developer_message`）：子 Agent 不应继承父的角色指令，所以要按片段类型剥离：
```rust
!(MultiAgentRoleInstructions::matches_text(text)
    || MultiAgentModeInstructions::matches_text(text)
    || CurrentTimeReminder::matches_text(text)
    || usage_hint_texts.iter().any(|t| t == text))
```

**替换为子 Agent 自己的指令**（`spawn.rs:729-784`）：找到父的 `developer_instructions` 文本，原地替换成子角色的指令。

**差异化处理 full vs truncated fork**（`spawn.rs:85-88` 注释）：
> "Full-history forks preserve the cached prompt prefix and can keep diffing from the parent's durable baseline. Truncated forks drop part of that prompt, so they must rebuild context on their first child turn."

这种级别的细节，自己从零实现至少要踩半年坑。

### 4.5 ★ 角色系统（Axon 的 5 个角色直接对应）

**类型定义** `AgentRoleOverrides`（`core/src/agent/role.rs:36-48`）：

```rust
#[derive(Default, Serialize)]
struct AgentRoleOverrides {
    developer_instructions: Option<String>,      // ← 角色专属提示词
    model: Option<String>,                       // ← 角色专属模型
    model_reasoning_effort: Option<ReasoningEffort>,
    model_reasoning_summary: Option<ReasoningSummary>,
    model_verbosity: Option<Verbosity>,
    personality: Option<Personality>,
    service_tier: Option<String>,
    features: BTreeMap<String, bool>,            // ← 角色专属能力开关
    skills: Option<SkillsConfig>,                // ← 角色专属技能集
}
```

**默认角色名**（`role.rs:33`）：
```rust
pub const DEFAULT_ROLE_NAME: &str = "default";
```

**关键安全设计 —— 角色只能"减能"不能"增权"**（`role.rs:1-4` 模块注释）：
> "Roles may customize the child or reduce its capabilities, but **never replace the parent session's authority**."

代码层面强制（`role.rs:91-106`）：只有 `!enabled`（关闭）的 feature 才会被写入 overrides，且仅限白名单：
```rust
if !enabled && let Some(feature @ (Feature::ShellTool | Feature::Apps
    | Feature::Personality | Feature::Plugins | Feature::MemoryTool
    | Feature::RequestPermissionsTool)) = feature_for_key(&key)
{
    overrides.features.insert(feature.key().to_string(), false);
}
```

Skills 同理（`role.rs:107-118`）：`skills.config.retain(|skill| !skill.enabled)` —— 只保留"禁用"项。

**应用方式**：角色配置作为一个 `ConfigLayerEntry` 插入配置层栈（`role.rs:249-252`），而非粗暴覆盖，保持了配置系统的一致性。

**运行时不可覆盖的项**：`ensure_v2_agent_loaded` 在应用角色后，会强制恢复运行时的 approval_policy / cwd / permission_profile（`agent/control/spawn.rs:308-341`）——角色不能突破沙箱。

### 4.6 ★ 角色定义的发现机制

`core/src/config/agent_roles.rs:20` `load_agent_roles`，两条发现路径：

**路径一：显式声明**（`agent_roles.rs:43-69`）—— 在 config 的 `[agents.roles]` 表里声明：
```rust
if let Some(agents_toml) = agents_toml {
    for (declared_role_name, role_toml) in &agents_toml.roles {
        let (role_name, role) = read_declared_role(fs, declared_role_name, role_toml).await?;
        ...
    }
}
```

**路径二：目录自动发现**（`agent_roles.rs:72-95`）—— 扫描每个配置层的 `agents/` 子目录：
```rust
if let Some(config_folder) = layer.config_folder() {
    for (role_name, role) in discover_agent_roles_in_dir(
        fs, &config_folder.join("agents"), &declared_role_files, startup_warnings,
    ).await? { ... }
}
```

**分层合并**（`agent_roles.rs:97-110`）：低优先级层先加载，高优先级层的同名角色通过 `merge_missing_role_fields` 继承缺失字段。同层重名会 warn 并跳过（`agent_roles.rs:56-67`）。角色**必须有 description**，否则被拒（`agent_roles.rs:102-108`）。

**对 Axon 的直接价值**：Axon 的 5 个角色（进度管理/架构设计/开发执行/测试/人机对齐）只需在 `<codex_home>/agents/` 放 5 个 TOML：

```toml
# agents/architect.toml
model = "gpt-5-codex"
model_reasoning_effort = "high"
developer_instructions = """
你是架构设计 Agent。只输出设计方案与接口契约，不直接写实现代码。
"""
[features]
shell_tool = false   # 架构师不需要执行 shell
```

零代码改动即可生效。

### 4.7 内置角色

`core/src/agent/builtins/` 有两个文件：`explorer.toml` 和 `awaiter.toml`。

`role.rs:419-427` 用 `include_str!` 编译期嵌入：
```rust
pub(super) fn config_file_contents(path: &Path) -> Option<&'static str> {
    const EXPLORER: &str = include_str!("builtins/explorer.toml");
    const AWAITER: &str = include_str!("builtins/awaiter.toml");
    match path.to_str()? {
        "explorer.toml" => Some(EXPLORER),
        "awaiter.toml" => Some(AWAITER),
        _ => None,
    }
}
```

**内置角色注册表**（`role.rs:355-416`）共三个：

1. **`default`** — "Default agent."，无 config_file
2. **`explorer`** — 只读代码库问答。提示词强调"Explorers are fast and authoritative"，鼓励并行派生多个 explorer 问不同问题（`role.rs:369-378`）
3. **`worker`** — 执行与生产工作。提示词强调**显式分配 ownership**（文件/职责），并告知 worker"你不是代码库里唯一的人"，不要回滚别人的修改（`role.rs:383-390`）

> 注：`explorer.toml` 文件当前**内容为空**（0 字节），说明 explorer 角色目前只靠 `description` 中的提示词生效，没有额外的模型/feature 覆盖。`awaiter.toml` 有完整内容（35 行，`model_reasoning_effort = "low"` + 详细的等待行为规则），但 `awaiter` 角色在注册表中**被注释掉了**（`role.rs:395-412`，注释写着 "Awaiter is temp removed"）。

**给模型看的角色清单**由 `spawn_tool_spec::build` 动态生成（`role.rs:270-294`），会把"该角色的 model 已锁定、不可更改"这类约束写进工具描述（`role.rs:318-341`）。

### 4.8 Agent 注册表与资源限制

`AgentRegistry`（`core/src/agent/registry.rs:25-28`）：

```rust
pub(crate) struct AgentRegistry {
    active_agents: Mutex<ActiveAgents>,
    total_count: AtomicUsize,
}
```

内部三张表（`registry.rs:31-36`）：`agent_tree`（路径→元数据）、`thread_paths`（线程ID→路径）、`used_agent_nicknames`（昵称去重）。

**并发上限**：`reserve_spawn_slot(max_threads)` 用 CAS 循环原子占位（`registry.rs:337-353`），超限返回 `AgentLimitReached`（`registry.rs:102`）。配置项 `agent_max_threads`（`core/src/config/mod.rs:834`）。

**深度上限**（`registry.rs:87-93`）：
```rust
pub(crate) fn next_thread_spawn_depth(session_source: &SessionSource) -> i32 {
    session_depth(session_source).saturating_add(1)
}
pub(crate) fn exceeds_thread_spawn_depth_limit(depth: i32, max_depth: i32) -> bool {
    depth > max_depth
}
```

**RAII 预留**：`SpawnReservation` 实现 `Drop`（`registry.rs:393-402`），spawn 失败自动回滚计数与路径占用。工程质量很高。

**昵称池**：`agent_names.txt` 提供人类友好昵称，用尽后自动加序数后缀（"Alice the 2nd"，`registry.rs:60-77`）。

### 4.9 `AgentControl` —— 多 Agent 控制面

`core/src/agent/control.rs:106-121`：

```rust
#[derive(Clone)]
pub(crate) struct AgentControl {
    session_id: SessionId,                       // 整棵树共享
    manager: Weak<ThreadManagerState>,           // ← Weak 打破引用环
    thread_id_generator: ThreadIdGenerator,
    state: Arc<AgentRegistry>,
    v2_residency: Arc<V2Residency>,              // 驻留管理（LRU 卸载）
    agent_execution_limiter: Arc<AgentExecutionLimiter>,
    rollout_budget: Arc<RolloutBudget>,
}
```

注释说明了 `Weak` 的必要性（`control.rs:111-113`）：避免 `ThreadManagerState -> CodexThread -> Session -> SessionServices -> ThreadManagerState` 的循环引用。

核心方法：`send_input`(:174)、`send_inter_agent_communication`(:210)、`interrupt_agent`(:296)、`get_status`(:331)、`subscribe_status`(:406，返回 `watch::Receiver<AgentStatus>`)、`list_agents`(:437)、`resolve_agent_reference`(:384)。

**完成通知**（`control.rs:513-602` `maybe_start_completion_watcher`）：子 Agent 达终态时，自动向父 Agent 投递 `InterAgentCommunication`（V2）或注入用户消息（V1）。

**驻留管理**（`ensure_v2_agent_loaded`，`agent/control/spawn.rs:267-401`）：子 Agent 可被"卸载"以省内存，需要时从持久化历史重新加载。对 Axon 管理大量并发子 Agent 很有价值。

### 4.10 Review 模式：完全纯净的独立上下文子任务

`core/src/tasks/review.rs:97-141` `start_review_conversation`：

```rust
let mut sub_agent_config = config.as_ref().clone();
sub_agent_config.web_search_mode.set(WebSearchMode::Disabled);
sub_agent_config.features.disable(Feature::Collab);
sub_agent_config.features.disable(Feature::MultiAgentV2);
sub_agent_config.base_instructions = Some(crate::REVIEW_PROMPT.to_string());   // ← 完全替换系统提示词
sub_agent_config.base_instructions_provenance = Some(BaseInstructionsProvenance::Custom);
sub_agent_config.permissions.approval_policy = Constrained::allow_only(AskForApproval::Never);
let model = config.review_model.clone().unwrap_or_else(|| ctx.model_info.slug.clone());  // ← 可配独立模型
sub_agent_config.model = Some(model);

run_codex_thread_one_shot(..., initial_history: None, ...)  // ← 空历史 = 纯净
```

事件过滤（`review.rs:143-184`）：子会话事件被选择性转发给父 session，assistant 消息被抑制，只在 `TurnComplete` 时解析结构化 JSON 输出（`review.rs:191-206`，带容错的 JSON 提取）。

**这是"纯净分身 + 独立提示词 + 独立模型 + 结构化返回"的完整范本**，Axon 的测试 Agent / 架构 Agent 可以照此模式实现。

底层是 `codex_delegate`（`core/src/codex_delegate.rs`）：
- `run_codex_thread_interactive`(:50) — 交互式子线程
- `run_codex_thread_one_shot` — 一次性子线程

子线程**共享**父的服务（`codex_delegate.rs:95-117`）：environment_manager、skills_service、plugins_manager、mcp_manager、exec_policy 都是 `Arc::clone` 复用——避免重复初始化 MCP 等重资源。同时强制 `approval_policy = Never`（`codex_delegate.rs:63-68`），子 Agent 不能弹审批框。

### 4.11 配置项与 Hook

**子 Agent 默认模型**（`config/src/config_toml.rs:673-675`）：
```rust
pub default_subagent_model: Option<String>,
pub default_subagent_reasoning_effort: Option<ReasoningEffort>,
```
解析到 `Config`（`core/src/config/mod.rs:837-840`）：`agent_default_subagent_model` / `agent_default_subagent_reasoning_effort`。

**Feature 开关**（`features/src/lib.rs:175, 1119-1120`）：
```rust
MultiAgentV2,            // enum 变体
key: "multi_agent_v2",   // 配置键
```
带结构化配置 `MultiAgentV2ConfigToml`（`features/src/lib.rs:28, 717`），可配 `subagent_developer_instructions` 等（见 `agent/control/spawn.rs:645-648`）。

**生命周期 Hook**（`hooks/src/lib.rs:32-33, 102-103`；`hooks/src/schema.rs:115-118`）：
```rust
HookEventName::SubagentStart => "subagent_start",
HookEventName::SubagentStop  => "subagent_stop",
```

**对 Axon 的价值**：子 Agent 启停可挂外部脚本 —— 进度管理 Agent 可以通过 hook 自动记录各子 Agent 的启停时间线，无需改内核代码。

---

## 5. 工具系统、审批与沙箱

### 5.1 工具注册

`ToolRegistry`（`core/src/tools/registry.rs`，823 行）：

```rust
pub struct ToolRegistry {
    tools: IndexMap<ToolName, RegisteredTool>,   // ← IndexMap 保序
    first_collision: Option<ToolName>,
}
```

注册 API：`add`(:287) / `add_with_exposure`(:293) / `register_trusted`(:299) / `prepend_trusted`(:318)。重名会 `error_or_panic`（:314）。

工具实现 `CoreToolRuntime` trait（`registry.rs:55-127`），它扩展了 `codex_tools::ToolExecutor`，额外提供 hook payload、telemetry tags、MCP 归属、code-mode 定义等元数据。

### 5.2 内置工具清单

`core/src/tools/handlers/` 目录：

| 工具 | 文件 |
|---|---|
| `shell` / `unified_exec` | `unified_exec.rs`, `shell_spec.rs` |
| `apply_patch` | `apply_patch.rs`（含 `apply_patch.lark` 语法定义） |
| `view_image` | `view_image.rs` |
| `update_plan` | `plan.rs` |
| `request_user_input` | `request_user_input.rs` ← **人机对齐** |
| `request_permissions` | `request_permissions.rs` ← **人机对齐** |
| `current_time` | `current_time.rs` |
| `get_context_remaining` | `get_context_remaining.rs` |
| `new_context_window` | `new_context_window.rs` |
| `tool_search` | `tool_search.rs`（工具太多时的检索） |
| `sleep` | `sleep.rs` |
| `wait_for_environment` | `wait_for_environment.rs` |
| MCP 系列 | `mcp.rs`, `mcp_resource.rs` |
| 多 Agent 系列 | `multi_agents_v2/`（6 个）, `multi_agents.rs`（V1） |
| 插件系列 | `request_plugin_install.rs`, `list_available_plugins_to_install.rs` |
| 动态工具 | `dynamic.rs`, `extension_tools.rs` |
| Code Mode | `code_mode/`（把工具暴露为可执行代码） |

### 5.3 审批策略

`AskForApproval`（`protocol/src/protocol.rs:916-939`）：

```rust
pub enum AskForApproval {
    UnlessTrusted,                      // :921  不受信项目，除非 execpolicy 放行否则都要批
    #[default] OnRequest,               // :926  模型自己决定何时请求
    Granular(GranularApprovalConfig),   // :934  细粒度
    Never,                              // :938  永不询问，失败直接回给模型
}
```

`GranularApprovalConfig`（`protocol.rs:942-956`）五个独立开关：`sandbox_approval` / `rules` / `skill_approval` / `request_permissions` / `mcp_elicitations`。

配套：`execpolicy` crate（Starlark 编写的命令放行规则）、`guardian`（`core/src/guardian/`，自动审批评审器，含 `policy.md` 提示词模板）、`shell-escalation` crate。

### 5.4 沙箱

`sandboxing` crate（8,322 行）：

| 平台 | 实现 | 文件 |
|---|---|---|
| macOS | Seatbelt (SBPL) | `seatbelt.rs` + `seatbelt_base_policy.sbpl` / `seatbelt_network_policy.sbpl` / `seatbelt_preferences_policy.sbpl` |
| Linux | Landlock + seccomp | `landlock.rs`（`landlock = "0.4.4"`, `seccompiler = "0.5.0"`） |
| Linux | bubblewrap | `bwrap.rs` + `bwrap` crate |
| Windows | AppContainer | `windows.rs` + `windows-sandbox-rs` crate |

`SandboxPolicy`（`protocol/src/protocol.rs:1002-1045+`）：
```rust
DangerFullAccess,                                    // :1005
ReadOnly { network_access },                         // :1009
ExternalSandbox { network_access },                  // :1019  已在外部沙箱中
WorkspaceWrite { writable_roots, network_access, exclude_tmpdir, ... },  // :1028
```

另有 `network-proxy` crate 做域名级网络管控（`NetworkDomainPermission`，`core/src/lib.rs:35-37`）。

### 5.5 MCP 支持：双向

**作为 Client**：`rmcp-client` crate（24,780 行），基于官方 `rmcp = "3.1.3"`。core 侧有 `McpManager`（`core/src/lib.rs:74`）、`session/mcp.rs`（1,063 行）、`mcp_prewarm.rs`（预热）、`mcp_refresh.rs`、`Op::RefreshMcpServers`（`protocol.rs:655`）。支持 OAuth 登录（app-server 有 `mcpServer/oauth/login` 方法）。

**作为 Server**：`mcp-server` crate（4,164 行）—— codex 自己可作为 MCP server 被别的 Agent 调用。

**Elicitation**：MCP server 可反向向用户提问，经 `Op::ResolveElicitation`（`protocol.rs:617`）应答。

---

## 6. 模型抽象

### 6.1 `ModelProviderInfo`

`model-provider-info/src/lib.rs:95-150`，配置项包括：`base_url` / `env_key` / `experimental_bearer_token` / `auth`（命令式 token）/ `aws`（SigV4）/ `wire_api` / `query_params` / `http_headers` / `env_http_headers` / `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms` / `requires_openai_auth` / `supports_websockets` / `supports_standalone_web_search`。

### 6.2 ⚠️ 重大限制：只支持 Responses API

`model-provider-info/src/lib.rs:63-67`：
```rust
pub enum WireApi {
    #[default]
    Responses,          // ← 只有这一个变体
}
```

反序列化时显式拒绝 `chat`（`:86`）：
```rust
"chat" => Err(serde::de::Error::custom(CHAT_WIRE_API_REMOVED_ERROR)),
```

全仓库 grep `chat/completions` / `ChatCompletions` **零命中**。**Chat Completions 支持已被彻底移除。**

**对 Axon 的影响**：
- ✅ OpenAI 官方模型：直接可用
- ✅ Azure OpenAI（支持 Responses API）：可用
- ✅ 任何 Responses-API-兼容网关（如 LiteLLM 的 responses 端点）：可用
- ❌ Anthropic Claude / Google Gemini / DeepSeek 原生 API：**需要自己写 Responses 适配层或架代理**
- ⚠️ 本地模型：有 `ollama` / `lmstudio` crate，但需确认其是否走 Responses 格式

有个 `responses-api-proxy` crate 可以参考/复用作为适配层落点。

### 6.3 每任务配不同模型 —— 完全支持

四个层级都能指定模型：

1. **角色级**（`agent/role.rs:41`）：`AgentRoleOverrides.model` + `model_reasoning_effort`
2. **spawn 调用级**（`multi_agents_spec.rs:653-665`）：`spawn_agent` 工具的 `model` / `reasoning_effort` / `service_tier` 参数
3. **全局子 Agent 默认**（`config_toml.rs:673-675`）：`default_subagent_model`
4. **特殊任务**：`config.review_model`（`tasks/review.rs:121-125`）、compact 有专门的 `compact_model_fallback.rs`

模型清单由 `models-manager` crate 管理，`ModelPreset` 含 `supported_reasoning_efforts` / `service_tiers` / `show_in_picker`，会动态渲染进 spawn_agent 的工具描述（`multi_agents_spec.rs:781-846`）。

---

## 7. 持久化与协议 —— **Axon 集成的关键**

### 7.1 Rollout 文件格式

**路径**（`rollout/src/lib.rs:67-68`）：
```rust
pub const SESSIONS_SUBDIR: &str = "sessions";
pub const ARCHIVED_SESSIONS_SUBDIR: &str = "archived_sessions";
```
即 `~/.codex/sessions/` 与 `~/.codex/archived_sessions/`，下按日期分目录（`rollout_date_parts`，`core/src/lib.rs:176`）。

**文件名**（`rollout/src/rollout_file_name.rs:39-57`）：
```
rollout-<YYYY-MM-DDTHH-MM-SS>-<thread_id>.jsonl
rollout-<YYYY-MM-DDTHH-MM-SS>-<thread_id>_<rollout_id>.jsonl   # 被 revert 过的线程
```
解析：去 `rollout-` 前缀、`.jsonl` 后缀，前 19 字符是时间戳，第 20 字符必须是 `-`，其后是 ID（可能含 `_` 分隔的两个 ID）。

**压缩**：支持 `.jsonl.zst`（`rollout/src/compression.rs`），读取时透明处理，追加时先解压回 `.jsonl`。

**行格式** —— `RolloutItem` 枚举（`history/src/lib.rs:95-105`）：
```rust
pub enum RolloutItem {
    SessionMeta(SessionMetaLine),                       // 首行：会话元数据
    ResponseItem(ResponseItemEnvelope),                 // 模型可见的对话项
    InterAgentCommunication(InterAgentCommunication),   // ★ Agent 间通信
    InterAgentCommunicationMetadata { trigger_turn: bool },
    Compacted(CompactedItem),                           // 压缩检查点（含 replacement_history）
    TurnContext(TurnContextItem),                       // 上下文快照（diff 基线）
    WorldState(WorldStateItem),                         // 世界状态
    SecurityRiskScore(SecurityRiskScore),
    EventMsg(EventMsg),                                 // UI 事件回放
}
```
有独立的 wire 格式层 `RolloutItemWire`（`history/src/lib.rs:107-123`），序列化与内存表示解耦——便于版本演进。

**注意**：`RolloutItem` 同时承载"模型可见历史"与"UI 事件流"，重放时需按用途过滤（`fork` 时的过滤逻辑见 `agent/control/spawn.rs:785-831`）。

### 7.2 SQLite 状态库

除 JSONL 外还有 SQLite（`state` crate 21,920 行 + `rollout/src/state_db.rs`），用 `sqlx` + bundled SQLite。存索引、线程元数据、Agent 图谱（`agent-graph-store` crate，存 `thread_spawn_edge` 父子关系）。

`ThreadHistoryMode`（`protocol/src/protocol.rs:710-714`）：
```rust
Legacy,      // 全量读 JSONL
Paginated,   // 分页读 SQLite
```

### 7.3 Resume / Fork

**内核 API**（`core/src/lib.rs:115-118`）：
```rust
pub use thread_manager::ForkSnapshot;
pub use thread_manager::NewThread;
pub use thread_manager::StartThreadOptions;
pub use thread_manager::ThreadManager;
```

`InitialHistory` 三态（`codex_history`）：`New` / `Resumed(ResumedHistory)` / `Forked(Vec<RolloutItem>)`。

**Resume**：`resume_thread_with_history_with_source`（`agent/control.rs:22` 导入，`spawn.rs:372` 调用），参数 `ResumeThreadWithHistoryOptions { config, initial_history, agent_control, session_source, parent_thread_id, environment_selections, inherited_environments, inherited_exec_policy }`。

**递归恢复整棵 Agent 树**（`agent/control/spawn.rs:888-961` `resume_agent_from_rollout`）：BFS 遍历 `agent_graph_store` 中的 `thread_spawn_children`，逐个恢复子 Agent。**Axon 可以整树恢复上次的多 Agent 协作现场。**

**截断工具**（`core/src/lib.rs:148-149`）：
```rust
pub use thread_rollout_truncation::truncate_rollout_after_turn_id;
pub use thread_rollout_truncation::truncate_rollout_before_turn_id;
```
以及 `truncate_rollout_to_last_n_fork_turns`（`agent/control.rs:26`）——`LastNTurns` fork 模式的实现基础。

### 7.4 ★★ app-server / JSON-RPC 协议（重点展开）

**这是 Axon 最推荐的集成方式。**

#### 7.4.1 协议定义文件

| 文件 | 内容 |
|---|---|
| `app-server-protocol/src/rpc.rs` | JSON-RPC 消息信封（84 行） |
| `app-server-protocol/src/protocol/common.rs` | **主注册表**：`client_request_definitions!` (:487) 与 `server_notification_definitions!` (:1819) 两个宏，声明全部方法 |
| `app-server-protocol/src/protocol/v2/*.rs` | v2 参数/响应类型：`thread.rs`(1914) / `item.rs`(1701) / `config.rs`(1040) / `plugin.rs`(1007) / `mcp.rs`(833) / `permissions.rs`(807) / `account.rs`(711) / `turn.rs`(467) 等 |
| `app-server-protocol/src/protocol/v1.rs` | v1 遗留类型（243 行） |
| `app-server-protocol/src/export.rs` | **TypeScript 类型导出**（`ts-rs`） |
| `app-server-protocol/src/protocol/event_mapping.rs` | core `EventMsg` → app-server 通知的映射 |

#### 7.4.2 消息信封

`rpc.rs:1-2` 有个重要说明：
> "We do **not** do true JSON-RPC 2.0, as we neither send nor expect the `jsonrpc: 2.0` field."

```rust
pub enum JSONRPCMessage {        // :36-41
    Request(JSONRPCRequest),
    Notification(JSONRPCNotification),
    Response(JSONRPCResponse),
    Error(JSONRPCError),
}

pub struct JSONRPCRequest {       // :45-56
    pub id: RequestId,            // String | Integer (untagged)
    pub method: String,
    pub params: Option<Value>,
    pub trace: Option<W3cTraceContext>,   // ← W3C 分布式追踪
}

pub struct JSONRPCNotification {  // :60-65
    pub method: String,
    pub params: Option<Value>,
}
```

#### 7.4.3 方法清单（约 230 个）

**线程生命周期**（`common.rs:505-560+`）：
```
thread/start          thread/resume        thread/fork          thread/archive
thread/delete         thread/unarchive     thread/unsubscribe   thread/read
thread/list           thread/search        thread/rollback      thread/revert
thread/name/set       thread/metadata/update                    thread/items/list
thread/turns/list     thread/compact/start thread/memoryMode/set
thread/goal/set       thread/goal/get      thread/goal/clear
thread/queue/add      thread/queue/start   thread/queue/reorder thread/queue/list
thread/settings/update                     thread/shellCommand
thread/backgroundTerminals/{list,clean,terminate}
threadSection/{create,update,delete,list}  thread/section/move
```

**Turn 控制**：
```
turn/start      turn/interrupt      turn/steer      review/start
```

**服务端通知**（`common.rs:1819+`）：
```
thread/started            thread/status/changed     thread/closed
thread/archived           thread/deleted            thread/reverted
thread/name/updated       thread/goal/updated       thread/queue/changed
thread/tokenUsage/updated thread/compacted          thread/rolled...
turn/started              turn/completed            turn/diff/updated
turn/plan/updated         turn/moderationMetadata
item/started              item/completed
item/agentMessage/delta   ← 流式文本
item/reasoning/textDelta  item/reasoning/summaryTextDelta  item/reasoning/summaryPartAdded
item/plan/delta
item/commandExecution/outputDelta    ← 流式命令输出
item/commandExecution/requestApproval ← 审批请求
item/commandExecution/terminalInteraction
item/fileChange/outputDelta  item/fileChange/patchUpdated  item/fileChange/requestApproval
item/permissions/requestApproval     ← 权限请求
item/tool/requestUserInput           ← ★ 人机对齐：模型追问
item/tool/call           item/mcpToolCall/progress
item/autoApprovalReview/{started,completed}
model/rerouted   model/verification   model/safetyBuffering/updated
hook/started     hook/completed
error
```

**其他域**：
```
account/*        (login/start, login/cancel, logout, read, usage/read, rateLimits/read, bedrock/*)
config/*         (read, value/write, batchWrite, mcpServer/reload)
model/list       modelProvider/capabilities/read     collaborationMode/list
mcpServer/*      (tool/call, resource/read, oauth/login, startupStatus/updated, elicitation/request)
plugin/*         (list, install, uninstall, search, read, share/*)
marketplace/*    (add, remove, upgrade)
skills/*         (list, config/write, extraRoots/set, changed)
fs/*             (readFile, writeFile, readDirectory, getMetadata, copy, remove, watch, unwatch, changed)
process/*        (spawn, kill, writeStdin, resizePty, outputDelta, exited)
command/exec     (exec, write, resize, terminate, outputDelta)
project/*        (create, read, update, delete, list, import, move, changed)
environment/*    (add, info, status)
permissionProfile/list       hooks/list          experimentalFeature/list
remoteControl/*  (enable, disable, pairing/start, client/list, client/revoke)
windowsSandbox/* fuzzyFileSearch/*   feedback/upload    externalAgentConfig/*
server/diagnostics           currentTime/read     memory/reset
```

**评价**：`fs/*` 和 `process/*` 的存在意味着 **GUI 可以把 app-server 当作统一的文件系统与进程后端**，不必自己实现文件读写和终端——省掉大量跨平台工作。

#### 7.4.4 如何 spawn 与通信

**三种传输**（`app-server/src/main.rs:28-35`）：
```rust
/// Transport endpoint URL. Supported values: `stdio://` (default),
/// `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`.
#[arg(long = "listen", value_name = "URL", default_value = AppServerTransport::DEFAULT_LISTEN_URL)]
listen: AppServerTransport,
```

**关键 CLI 参数**（`app-server/src/main.rs`）：
| 参数 | 说明 |
|---|---|
| `--listen <URL>` | `stdio://`（默认）/ `unix://PATH` / `ws://IP:PORT` / `off` |
| `--session-source <SOURCE>` | 默认 `vscode`，派生产品限制与元数据。**Axon 可传自己的 source** |
| `--strict-config` | config.toml 含未知字段时报错 |
| `-c key=value` | `CliConfigOverrides`，命令行覆盖配置 |
| `--enable-remote-control` | 开启远程控制 |

**Axon 的典型 spawn（stdio 模式）**：
```
codex app-server --listen stdio:// --session-source <axon> \
  -c agents.default_subagent_model=gpt-5-codex \
  -c features.multi_agent_v2.enabled=true
```
然后在 stdin/stdout 上按行收发 JSON。

**Unix socket 模式**（多客户端共享一个后端，更适合 GUI）：
```
codex app-server --listen unix:///tmp/axon.sock
```
配套有 `app-server-daemon` crate（守护进程生命周期管理）、`stdio-to-uds` crate（stdio↔unix socket 桥接）、`uds` crate。CLI 有 `codex app-server-daemon` 子命令（`cli/src/main.rs:162`）。

**握手流程**：
1. Axon spawn 子进程
2. 发 `initialize` 请求（`common.rs:488-492`，`v1::InitializeParams`）
3. 收 `InitializeResponse`
4. 发 `thread/start` → 收 `thread/started` 通知 + 响应（含 `threadId`）
5. 发 `turn/start` → 持续收 `item/started` / `item/agentMessage/delta` / `item/completed` / `turn/completed`
6. 遇 `item/commandExecution/requestApproval` → 弹 GUI 审批框 → 回响应
7. 遇 `item/tool/requestUserInput` → 弹 GUI 输入框 → 回响应

**多 Agent 场景**：子 Agent spawn 后会发 `thread/started` 通知（`agent/control/spawn.rs:557` `state.notify_thread_created`），Axon 收到后自动为它开一个 UI 面板并订阅其事件流。`thread/status/changed` 驱动状态指示灯。

**配套客户端库**（可直接参考或复用）：
- `app-server-client` crate — Rust 客户端
- `app-server-test-client` crate — 测试客户端
- `app-server-transport` crate — 传输层抽象

#### 7.4.5 TypeScript 类型导出

`app-server-protocol` 用 `ts-rs = "11"`，所有协议类型标注 `#[derive(TS)]`。`export.rs` + `precomputed_exports.rs` 负责导出。

**对 Axon（若前端是 Electron/Tauri + TS）**：可以从 Rust 协议定义自动生成 TypeScript 类型，**前后端类型零漂移**。这是很大的工程收益。

同时所有类型都 `#[derive(JsonSchema)]`（`schemars`），有 `schema_fixtures.rs` 做契约快照测试。

---

## 8. SDK

### 8.1 TypeScript SDK（`sdk/typescript/`）

源文件：`codex.ts` / `thread.ts` / `exec.ts` / `events.ts` / `items.ts` / `codexOptions.ts` / `threadOptions.ts` / `turnOptions.ts` / `outputSchemaFile.ts`。

API 极简（`sdk/typescript/src/codex.ts:11-39`）：
```typescript
export class Codex {
  constructor(options: CodexOptions = {}) {
    const { codexPathOverride, env, config, configOverrides } = options;
    this.exec = new CodexExec(codexPathOverride, env, config, configOverrides);
  }
  startThread(options: ThreadOptions = {}): Thread { ... }
  /**
   * Resumes a conversation with an agent based on the thread id.
   * Threads are persisted in ~/.codex/sessions.
   */
  resumeThread(id: string, options: ThreadOptions = {}): Thread { ... }
}
```

**实现方式**：spawn `codex exec` 子进程（`exec.ts`），解析其 JSON 事件流。样例见 `samples/basic_streaming.ts` / `structured_output_zod.ts`。

**局限**：这是**单 Agent** 的薄封装，**没有暴露多 Agent / 角色 / fork 能力**。Axon 不能直接用它。

### 8.2 Python SDK（`sdk/python/`）

明显更完整。`tests/` 目录暴露了它的实现方式——它驱动的是 **app-server**：
```
app_server_harness.py          test_app_server_approvals.py
test_app_server_lifecycle.py   test_app_server_streaming.py
test_app_server_turn_controls.py  test_app_server_goal_operations.py
test_app_server_run.py         test_app_server_login.py
test_real_app_server_integration.py
test_contract_generation.py    test_mcp_conformance_fixtures.py
```

还有 15 个 examples（`01_quickstart_constructor` ~ `15_login_and_account`）和 `notebooks/sdk_walkthrough.ipynb`。配套 `sdk/python-runtime/`（打包 codex 二进制的 Python wheel）。

**结论**：**Python SDK（走 app-server）是官方推荐的完整集成路径的最佳参考实现**。Axon 若用 TS，应参照 Python SDK 的 app-server 用法自己写客户端，而非扩展现有 TS SDK。

### 8.3 推荐集成方式排序

1. **直接说 app-server JSON-RPC**（Axon 首选）—— 全部能力可达
2. 参考 `app-server-client` crate（Rust）或 Python SDK 实现自己的客户端
3. TS SDK —— 仅适合单 Agent 简单场景

---

## 9. 代码规模、质量、许可证与构建

### 9.1 规模

| 指标 | 数值 |
|---|---|
| `.rs` 文件总数 | **3,241** |
| 总行数 | **约 1,440,000** |
| `core` | 326,478 |
| `tui` | 270,222 |
| `app-server` | 144,829 |
| `ext/*` | 44,868 |
| `app-server-protocol` | 32,339 |
| `thread-store` | 29,563 |
| `protocol` | 25,856 |
| `rmcp-client` | 24,780 |
| `config` | 24,188 |
| `state` | 21,920 |
| `rollout` | 14,835 |
| `exec` | 10,991 |
| `sandboxing` | 8,322 |
| `tools` | 6,926 |
| `mcp-server` | 4,164 |

**Axon 实际需要的内核部分**（core + protocol + config + state + thread-store + rollout + tools + sandboxing + app-server-protocol）约 **48 万行**；丢掉 tui 可省 27 万行。

### 9.2 测试

- 含测试的文件：**1,971 个**
- 测试函数：**约 14,058 个**
- 测试组织：大量 `#[path = "xxx_tests.rs"] mod tests;` 侧挂模式（源文件与测试文件分离但同模块）
- 单 `core/src/session/tests.rs` 就有 **11,461 行**
- 快照测试：`insta = "1.46.3"`（`core/src/session/snapshots/`、`core/src/guardian/snapshots/`）
- HTTP mock：`wiremock = "0.6"`
- 契约测试：`app-server-protocol/src/schema_fixtures_tests.rs`

**测试覆盖非常充分，属于生产级工程质量。**

### 9.3 代码质量信号

`Cargo.toml:504-540` 有 **37 条 clippy deny 规则**，包括：
```toml
expect_used = "deny"
unwrap_used = "deny"
await_holding_lock = "deny"
redundant_clone = "deny"
uninlined_format_args = "deny"
```

`core/src/lib.rs:6`：
```rust
#![deny(clippy::print_stdout, clippy::print_stderr)]
```
—— 库代码禁止直接打印，所有输出必须走抽象层。**这对 Axon 复用 core 极友好**（不会有杂散输出污染协议流）。

其他信号：
- Edition **2024**（`Cargo.toml:146`）
- `deny.toml`（cargo-deny 供应链审计）
- `clippy.toml` 自定义规则（含 SQLite 构造器 deny list）
- 全面的 OpenTelemetry 埋点（`otel` crate）
- Bazel 构建支持（每个 crate 都有 `BUILD.bazel`）

### 9.4 许可证

**Apache License 2.0**（`LICENSE` 第 1-3 行）。workspace 统一声明（`Cargo.toml:147`）：
```toml
license = "Apache-2.0"
```

**对 Axon 的意义**：
- ✅ 可商用、可闭源分发
- ✅ 可 fork 修改
- ⚠️ 必须保留版权声明与 NOTICE 文件（仓库根有 `NOTICE`）
- ⚠️ 需说明所做修改
- ✅ 附带专利授权（比 MIT 更有保障）

**Apache-2.0 是几个主流 Agent 内核里对商业化最友好的选择之一。**

### 9.5 构建难度

**工具链**（`rust-toolchain.toml`）：
```toml
[toolchain]
channel = "1.95.0"
components = ["clippy", "rustfmt", "rust-src"]
```
版本被钉死，`rustup` 会自动拉取。

**构建难点**：

| 难点 | 说明 |
|---|---|
| **规模** | 144 万行 + 137 crate。冷构建（release）预计 **20-45 分钟**（取决于机器） |
| **Git 依赖** | `nucleo`（helix-editor）、`runfiles`（dzbarsky/rules_rust）、三个 `openai-oss-forks`（crossterm / tokio-tungstenite / tungstenite）—— **需要网络访问 GitHub**，且是 fork 仓库 |
| **重依赖** | `v8 = "150.4.0"`（V8 引擎，`v8-poc` crate）—— 单这一个就可能编译很久。`deno_core_icudata` 同理 |
| **原生依赖** | `sqlx` bundled SQLite（编译 C）、`aws-lc-rs`（需 CMake + C 编译器）、`landlock`/`seccompiler`（Linux）、`symphonia`（音频） |
| **平台差异** | macOS 需 Seatbelt；Linux 需 landlock/bwrap；Windows 需 AppContainer |

**缓解手段**：
- 有 `flake.nix` / `default.nix`（Nix 可复现构建）
- 有 `justfile`（任务快捷方式）
- 有 `[profile.dev-small]`（`Cargo.toml:556-561`，`opt-level=0` + `strip=symbols`，加快迭代）
- `[profile.release]` 用 `lto = "thin"` + `codegen-units = 4`（已在编译速度与产物大小间做过权衡）
- **可以只构建需要的 crate**：`cargo build -p codex-app-server` 能跳过 tui 和 v8-poc

**难度评级：中等偏高**。不是"clone 完 5 分钟跑起来"，但也没有不可逾越的障碍。首次构建准备好耐心和 20GB 磁盘。

---

## 10. 作为 Axon 内核的适配度评分

# **9 / 10**

### 为什么是 9 分

**Axon 的核心需求，codex 几乎全部有一等实现，而不是"能改出来"：**

| Axon 需求 | 满足度 | 关键证据 |
|---|---|---|
| 5+ 角色化子 Agent | **10/10** | `agent_roles` 系统，每角色独立 model/instructions/features/skills（`agent/role.rs:36-48`）；TOML 文件声明式定义，零代码（`config/agent_roles.rs:20`） |
| 纯净上下文分身 | **10/10** | `fork_turns="none"`（`multi_agents_v2/spawn.rs:298`） |
| 继承全部上下文分身 | **10/10** | `fork_turns="all"` → `FullHistory`（`agent/control.rs:71`），且 fork 时做了精细的角色指令替换（`control/spawn.rs:729-784`） |
| 子 Agent 间协作 | **10/10** | 六个 V2 工具 + AgentPath 路径寻址 + mailbox 机制 |
| GUI 后端驱动 | **10/10** | app-server 230+ 方法，含 fs/process/command 全套 |
| 人机对齐 | **9/10** | `request_user_input` / `request_permissions` / 三类审批事件；但"对齐"的编排逻辑仍需 Axon 自己设计 |
| 流式输出 | **10/10** | delta 级事件完备 |
| 持久化与恢复 | **10/10** | JSONL + SQLite 双写，支持整棵 Agent 树递归恢复 |
| 安全沙箱 | **10/10** | 三平台原生沙箱 + execpolicy + guardian |
| 多模型 | **6/10** | 架构上完全支持每任务配不同模型；但 **WireApi 只剩 Responses**，非 OpenAI 系需自建适配 |

### 扣掉的 1 分

1. **Chat Completions 被移除**（`model-provider-info/src/lib.rs:63-67, 86`）——接 Claude/Gemini/本地模型需要额外工作。这是唯一的硬伤。
2. **代码规模巨大**（144 万行）——学习曲线陡峭，fork 后跟上游同步成本高。
3. **TS SDK 能力不足**——不暴露多 Agent，Axon 必须自己写 app-server 客户端。
4. **`core` 是 32.6 万行的单体 crate**——内部模块边界清晰，但作为依赖引入时无法只取一部分。

### 对比同类的位置

在"自研多 Agent 客户端的内核"这个命题下，codex 的独特优势是：**它是唯一一个把"多 Agent 树 + 角色系统 + 上下文 fork 粒度控制 + GUI 协议"四件事同时做完并测试充分的开源 Agent 内核**。多数同类要么没有多 Agent（只有单 Agent + 工具），要么多 Agent 是玩具级（无隔离策略、无角色、无持久化）。

---

## 11. 三种集成路径的可行性

### 路径 a) Fork 改造 —— ⭐⭐⭐ 可行但需谨慎

**做法**：fork 整个仓库，删掉 `tui` / `cloud-tasks` / `v8-poc` 等无关 crate，在 `core` 上直接改。

**优势**：
- 完全掌控，可深度定制多 Agent 编排逻辑
- 可直接在 `core/src/tasks/` 加自己的 `SessionTask`
- 可改 `WireApi` 加回 Chat Completions 支持
- Apache-2.0 允许闭源分发

**代价**：
- **上游同步噩梦**：codex 迭代很快（V1/V2 多 Agent 并存说明正在演进），144 万行的 fork 想跟上游 merge 极痛苦
- 需要至少 1-2 名熟练 Rust 工程师长期维护
- 构建时间拖慢整个团队迭代

**建议**：**仅在确认必须改内核时采用**。且应做成"最小 fork"——只改必须改的地方，用 patch 文件管理差异（仓库根有 `patches/` 目录，说明上游自己也这么干）。

### 路径 b) 作为子进程/协议后端驱动 —— ⭐⭐⭐⭐⭐ **强烈推荐**

**做法**：Axon 是纯前端（Electron / Tauri / Web），spawn `codex app-server` 作为后端，通过 JSON-RPC 通信。

**为什么这是最优解**：

1. **能力覆盖足够**：多 Agent 的全部能力（spawn/fork_turns/角色/通信/中断）都能通过配置 + `turn/start` 的自然语言指令触达。Axon 不需要碰 Rust。

2. **角色系统纯配置**：Axon 在自己的配置目录下放 5 个角色 TOML，`codex app-server` 启动时自动发现（`config/agent_roles.rs:72-95`）。**零代码实现 5 个角色化子 Agent。**

3. **上下文隔离纯参数**：`fork_turns` 是 `spawn_agent` 工具的参数，由模型按 Axon 的提示词指引选择。Axon 也可以通过 `developer_instructions` 强制约定："进度管理 Agent 必须用 fork_turns=none"。

4. **UI 事件齐全**：`thread/started` 自动通知新子 Agent，`thread/status/changed` 驱动状态，`item/*/delta` 驱动流式渲染，`CollabAgent*` 事件驱动协作可视化。

5. **类型安全**：`ts-rs` 导出 TypeScript 类型，前后端零漂移。

6. **升级即换二进制**：上游发新版，Axon 换个二进制就行。

7. **附赠基础设施**：`fs/*`、`process/*`、`command/exec` 让 Axon 不用自己写跨平台文件与进程管理。

**风险**：
- 协议中大量方法标 `#[experimental(...)]`，可能变更 → 用 `experimentalFeature/list` 探测，做优雅降级
- 进程崩溃需要 Axon 自己做重启与状态恢复（好在 `thread/resume` 能恢复）
- 非 OpenAI 模型的问题依然存在

**实施建议**：
```
Axon (TS/Electron)
  │
  ├─ spawn: codex app-server --listen unix:///tmp/axon-<pid>.sock
  │          --session-source axon
  │          -c features.multi_agent_v2.enabled=true
  │          -c agents.max_threads=8
  │
  ├─ 配置目录 ~/.axon/agents/{planner,architect,developer,tester,aligner}.toml
  │
  └─ JSON-RPC 客户端（参考 sdk/python/ 的 app_server_harness.py）
```

### 路径 c) 只借鉴设计 —— ⭐⭐ 成本远超预期

**值得借鉴的设计**（无论走哪条路都该学）：
1. **`SessionTask` trait** —— 极简的任务抽象（`tasks/mod.rs:187-200`）
2. **类型化上下文片段** —— `core/src/context/` 下 40+ 个可寻址、可剥离的片段
3. **`reference_context_item` diff 机制** —— 只注入变化部分（`context_manager/history.rs:53-61`）
4. **`SpawnAgentForkMode` 三态** —— none/N/all 是很好的抽象
5. **角色只能减能不能增权** —— 安全模型（`agent/role.rs:1-4, 91-106`）
6. **AgentPath 路径寻址** —— 类文件系统的 Agent 命名
7. **`SpawnReservation` RAII** —— 失败自动回滚（`agent/registry.rs:393-402`）
8. **`Weak` 打破引用环** —— `AgentControl.manager`（`agent/control.rs:111-113`）
9. **fork 时的上下文清洗策略** —— `keep_forked_rollout_item`（`control/spawn.rs:54-91`）

**为什么不推荐只借鉴**：codex 在这些地方踩过的坑（中断后的历史标记、压缩的两种注入策略、fork 时的开发者指令替换、多 Agent 的驻留管理）都是**几个人月级别**的经验沉淀。从零复现至少 6-12 人月，且质量大概率不如。

### 推荐决策

**主路径 b（app-server 驱动），保留向 a 演进的可能。**

具体：
1. **阶段一（1-2 周）**：构建 `codex app-server`，写最小 JSON-RPC 客户端，跑通 `initialize` → `thread/start` → `turn/start` → 流式渲染
2. **阶段二（2-3 周）**：写 5 个角色 TOML，验证 `spawn_agent` + `fork_turns` 行为符合预期，接上 `CollabAgent*` 事件做多 Agent 面板
3. **阶段三（2-4 周）**：审批/追问 UI、持久化恢复、`subagent_start/stop` hook 接入进度管理
4. **阶段四（按需）**：若发现必须改内核（如模型适配），再做最小 fork

---

## 12. 拿来即用 vs 必须自己补

### ✅ 拿来即用（零/极少改动）

| 能力 | 出处 |
|---|---|
| **Agent turn 主循环 + 工具调用编排** | `core/src/session/turn.rs`, `core/src/tasks/` |
| **多 Agent 树：spawn/消息/等待/中断/列举** | `core/src/tools/handlers/multi_agents_v2/`（6 工具） |
| **上下文隔离三态 none/N/all** | `agent/control.rs:70-73`, `multi_agents_v2/spawn.rs:279-313` |
| **角色系统（TOML 声明式）** | `agent/role.rs`, `config/agent_roles.rs` |
| **Agent 路径寻址与通信** | `protocol.rs:738-754`, `agent/control.rs:384-403` |
| **并发/深度限制 + RAII 回滚** | `agent/registry.rs` |
| **上下文压缩（本地 + 远程）** | `core/src/compact.rs`, `compact_remote*.rs` |
| **AGENTS.md 层级发现与合并** | `core/src/agents_md.rs` |
| **三平台沙箱** | `sandboxing/`（seatbelt/landlock/bwrap/windows） |
| **审批策略（4 档 + 细粒度）** | `protocol.rs:916-956`, `execpolicy/`, `guardian/` |
| **MCP 双向（client + server）** | `rmcp-client/`, `mcp-server/`, `core/src/session/mcp.rs` |
| **持久化（JSONL + SQLite）** | `rollout/`, `state/`, `thread-store/` |
| **Resume/Fork（含整树恢复）** | `thread_manager.rs`, `agent/control/spawn.rs:888-961` |
| **app-server JSON-RPC（230+ 方法）** | `app-server/`, `app-server-protocol/` |
| **TypeScript 类型自动导出** | `app-server-protocol/src/export.rs`（ts-rs） |
| **流式事件（delta 级）** | `protocol.rs:1470-1473` + app-server `item/*/delta` |
| **人机对齐工具** | `request_user_input.rs`, `request_permissions.rs` |
| **Hook 系统（含 subagent_start/stop）** | `hooks/`（`lib.rs:32-33`） |
| **Skills / Plugins / Apps 生态** | `skills/`, `plugin/`, `ext/skills`, `ext/plugins` |
| **文件系统与进程后端** | app-server `fs/*`, `process/*`, `command/exec` |
| **OpenTelemetry 埋点** | `otel/` |
| **apply_patch 编辑引擎** | `apply-patch/`（含 lark 语法） |
| **模糊文件搜索** | `file-search/`, app-server `fuzzyFileSearch/*` |

### ❌ 必须自己补

| 缺口 | 工作量 | 说明 |
|---|---|---|
| **Axon 的全部 GUI** | 大 | tui 是终端 UI，Axon 要的桌面 GUI 完全另起炉灶 |
| **非 OpenAI 模型适配** | **中-大** | `WireApi` 只剩 Responses（`model-provider-info/src/lib.rs:63-67`）。要接 Claude/Gemini 需写 Responses 适配代理，或 fork 加回 chat 分支。可参考 `responses-api-proxy` crate |
| **5 个角色的提示词工程** | 中 | 角色**机制**有了，但"进度管理/架构设计/开发执行/测试/人机对齐"各自的 `developer_instructions` 是 Axon 的核心知识产权，需反复打磨 |
| **多 Agent 编排策略层** | **中-大** | codex 提供的是**机制**（spawn/wait/message），**策略**（什么时候派生谁、如何分配任务、如何汇总、冲突如何仲裁）是 Axon 要写的。内置的 `explorer`/`worker` 提示词只是起点 |
| **进度管理/看板可视化** | 中 | 数据源有（`list_agents` / `thread/status/changed` / `subagent_*` hook / `agent-graph-store`），但聚合与可视化要自己做 |
| **人机对齐的交互设计** | 中 | 工具与事件有了，但"何时打断用户、如何呈现选项、如何降低打扰"的产品设计是 Axon 的差异化 |
| **Axon 自己的会话/项目管理** | 中 | codex 的 thread/project 模型未必匹配 Axon 的产品概念，可能需要上层映射 |
| **app-server 进程生命周期管理** | 小-中 | 崩溃检测、自动重启、状态恢复、多实例管理（`app-server-daemon` 可参考） |
| **实验性 API 的降级处理** | 小 | 大量方法标 `#[experimental]`，需用 `experimentalFeature/list` 探测并优雅降级 |
| **鉴权与账号体系** | 小-中 | codex 绑定 ChatGPT/OpenAI 账号（`account/*` 方法、`login/` crate）。Axon 若要自己的账号体系需另做 |
| **`explorer.toml` 补全** | 极小 | 该文件当前为空，若要用 explorer 角色的模型/feature 覆盖需自己填 |

---

## 13. 给 Axon 的具体落地建议

### 13.1 立即可做的验证（1 周内）

```bash
# 1. 只构建 app-server，跳过 tui/v8
cd codex-rs && cargo build --release -p codex-app-server

# 2. 准备角色目录
mkdir -p ~/.axon/agents

# 3. 写第一个角色试水
cat > ~/.axon/agents/architect.toml <<'EOF'
description = "架构设计 Agent。负责方案设计与接口契约，不写实现。"
model = "gpt-5-codex"
model_reasoning_effort = "high"
developer_instructions = """
你是 Axon 的架构设计 Agent。
职责：输出技术方案、模块划分、接口契约、风险评估。
禁止：直接编写实现代码、执行 shell 命令。
输出：结构化 Markdown 设计文档。
"""
[features]
shell_tool = false
EOF

# 4. 启动并握手
codex app-server --listen stdio:// --session-source axon \
  -c features.multi_agent_v2.enabled=true
```

### 13.2 角色设计映射

| Axon 角色 | 建议 fork_turns | 建议 features | 理由 |
|---|---|---|---|
| 进度管理 | `none` | 关 `shell_tool` | 纯净上下文，只看汇总信息，避免被实现细节污染 |
| 架构设计 | `all` | 关 `shell_tool` | 需要全部上下文才能做正确的架构决策 |
| 开发执行 | `N`（如 5） | 全开 | 需要近期上下文，但不需要早期讨论；写代码需完整工具 |
| 测试 | `none` 或 `N` | 开 `shell_tool`，关 `apply_patch` | 独立视角更能发现问题；参考 `ReviewTask` 的纯净模式 |
| 人机对齐 | `all` | 开 `request_user_input` / `request_permissions` | 需要全上下文才能准确向用户提问 |

### 13.3 需要重点关注的上游演进

- **V1 → V2 迁移**：`multi_agents.rs`（V1）与 `multi_agents_v2/`（V2）并存，V2 是未来。Axon 应直接用 V2（`features.multi_agent_v2.enabled=true`）
- **`awaiter` 角色被临时移除**（`agent/role.rs:395-412`）—— 说明角色注册表在演进，Axon 不要依赖内置角色，自己定义全部 5 个
- **`#[experimental]` 标记**的方法随时可能变
- **`ConversationManager` 等已 `#[deprecated]`**（`core/src/lib.rs:126-131`）→ 用 `ThreadManager`

---

## 附录：关键文件速查表

| 主题 | 路径 | 行号 |
|---|---|---|
| Workspace 成员清单 | `codex-rs/Cargo.toml` | 2-137 |
| Rust 版本 | `codex-rs/rust-toolchain.toml` | 2 |
| clippy 规则 | `codex-rs/Cargo.toml` | 504-540 |
| core 模块总览 | `core/src/lib.rs` | 1-207 |
| **SessionTask trait** | `core/src/tasks/mod.rs` | 187-200 |
| 外层 steering 循环 | `core/src/tasks/regular.rs` | 76-90 |
| 内层 turn 循环 | `core/src/session/turn.rs` | 153, 301 |
| **Op 枚举** | `protocol/src/protocol.rs` | 543-698 |
| **EventMsg 枚举** | `protocol/src/protocol.rs` | 1288-1500+ |
| Collab 事件 | `protocol/src/protocol.rs` | 1476-1488 |
| InterAgentCommunication | `protocol/src/protocol.rs` | 738-754 |
| AskForApproval | `protocol/src/protocol.rs` | 916-956 |
| SandboxPolicy | `protocol/src/protocol.rs` | 1002-1045 |
| ThreadHistoryMode | `protocol/src/protocol.rs` | 710-714 |
| **SpawnAgentForkMode** | `core/src/agent/control.rs` | 69-73 |
| **AgentControl** | `core/src/agent/control.rs` | 106-121 |
| fork 实现 | `core/src/agent/control/spawn.rs` | 609-885 |
| fork 保留规则 | `core/src/agent/control/spawn.rs` | 54-91 |
| fork_turns 解析 | `core/src/tools/handlers/multi_agents_v2/spawn.rs` | 279-313 |
| 整树恢复 | `core/src/agent/control/spawn.rs` | 888-961 |
| **AgentRoleOverrides** | `core/src/agent/role.rs` | 36-48 |
| DEFAULT_ROLE_NAME | `core/src/agent/role.rs` | 33 |
| 角色减能白名单 | `core/src/agent/role.rs` | 91-106 |
| 内置角色注册表 | `core/src/agent/role.rs` | 355-416 |
| 内置角色嵌入 | `core/src/agent/role.rs` | 419-427 |
| **load_agent_roles** | `core/src/config/agent_roles.rs` | 20 |
| 角色目录发现 | `core/src/config/agent_roles.rs` | 72-95 |
| AgentRegistry | `core/src/agent/registry.rs` | 25-36 |
| SpawnReservation Drop | `core/src/agent/registry.rs` | 393-402 |
| 六个 V2 工具 | `core/src/tools/handlers/multi_agents_v2/` | — |
| V2 工具 Schema | `core/src/tools/handlers/multi_agents_spec.rs` | 102-358 |
| AgentPath 说明 | `core/src/tools/handlers/multi_agents_spec.rs` | 760-762 |
| **ContextManager** | `core/src/context_manager/history.rs` | 44-65 |
| 上下文片段目录 | `core/src/context/` | — |
| **AGENTS.md 规则** | `core/src/agents_md.rs` | 1-16 |
| AGENTS.md 文件名优先级 | `core/src/agents_md.rs` | 283-297 |
| AGENTS.md 分隔符 | `core/src/agents_md.rs` | 48 |
| **compact 注入策略** | `core/src/compact.rs` | 59-74 |
| Prompt 结构 | `core/src/client_common.rs` | 19-37 |
| **Review 纯净子会话** | `core/src/tasks/review.rs` | 97-141 |
| codex_delegate | `core/src/codex_delegate.rs` | 50, 95-117 |
| ToolRegistry | `core/src/tools/registry.rs` | 268-330 |
| CoreToolRuntime | `core/src/tools/registry.rs` | 55-127 |
| **WireApi（只剩 Responses）** | `model-provider-info/src/lib.rs` | 63-67, 86 |
| ModelProviderInfo | `model-provider-info/src/lib.rs` | 95-150 |
| default_subagent_model | `config/src/config_toml.rs` | 673-675 |
| agent_max_threads | `core/src/config/mod.rs` | 834-840 |
| MultiAgentV2 feature | `features/src/lib.rs` | 175, 1119-1120 |
| subagent hooks | `hooks/src/lib.rs` | 32-33, 102-103 |
| **JSON-RPC 信封** | `app-server-protocol/src/rpc.rs` | 1-84 |
| **方法注册表** | `app-server-protocol/src/protocol/common.rs` | 487（请求）, 1819（通知） |
| thread/start 定义 | `app-server-protocol/src/protocol/common.rs` | 505-510 |
| TS 类型导出 | `app-server-protocol/src/export.rs` | — |
| **app-server CLI** | `app-server/src/main.rs` | 20-60 |
| transport 选项 | `app-server/src/main.rs` | 28-35 |
| RolloutItem | `history/src/lib.rs` | 95-105 |
| rollout 路径常量 | `rollout/src/lib.rs` | 67-68 |
| rollout 文件名解析 | `rollout/src/rollout_file_name.rs` | 39-57 |
| TS SDK 入口 | `sdk/typescript/src/codex.ts` | 11-39 |
| Python SDK 测试 | `sdk/python/tests/app_server_*.py` | — |
| 许可证 | `LICENSE` | 1-3 |

---

*报告生成于只读源码调研，未修改仓库任何文件。*

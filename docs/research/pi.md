# Pi Agent Harness 深度调研报告（面向 Axon 多子 Agent 客户端内核选型）

> 调研对象：`/Users/lucaszhou/works/prjs/agents/pi`
> 版本：monorepo `0.0.3` / 各 package `0.84.2`，License **MIT**（`LICENSE:1`，Copyright 2025 Mario Zechner）
> 调研方式：**只读**，以源码为准（README 与源码不一致处以源码为准）

---

## 0. 执行摘要（先看这段）

Pi 实际包含 **10 个 package**（任务描述里的 5 个只是子集）：
`agent`、`ai`、`coding-agent`、`tui`、`telemetry`、`protocol`、`client`、`server`、`session-backends/sqlite-node`、`evals`。

三个必须先知道的结论：

1. **真正能跑的内核是 `packages/agent/src/agent-loop.ts` + `packages/coding-agent/src/core/agent-session.ts`**，不是 `packages/agent/src/harness/`。
   `harness/agent-harness.ts` 是一份**写得极好但尚未实现的规格 + 空壳**：几乎所有方法都 `return this.unavailable(...)` 抛 `HarnessNotImplemented`（`agent-harness.ts:355-357`、`:363-421`）。它对应 2941 行的设计文档 `packages/agent/docs/harness.md`。**这是本次调研最重要的陷阱**——按文档选型会严重高估现状。
2. **Pi 明确、主动地不做子 Agent，也不做 MCP**。README `packages/coding-agent/README.md:498-500` 原文：「**No MCP.**」「**No sub-agents.** There's many ways to do this... build your own with extensions」。子 Agent 只是一个 **1038 行的 example 扩展**（`examples/extensions/subagent/index.ts`），实现方式是 **spawn 独立 `pi` 子进程**。
3. **但是**：Pi 的 `harness/docs` 里已经设计好了 **Lane（多泳道）** 模型——明确写着「Additional lanes support Slack threads, **subagents**, and other parallel work over shared history」（`docs/harness.md:98`）。也就是说 Axon 想要的多子 Agent 架构，Pi **设计了但没实现**。

**一句话结论**：Pi 是一个**极优质的「单 Agent 内核 + 扩展宿主」**，模型抽象层（`packages/ai`）是全仓最大资产，但**多子 Agent 编排层需要 Axon 完全自建**。

---

## 1. Agent 主循环

### 1.1 位置与分层

| 层 | 文件 | 行数 | 职责 |
|---|---|---|---|
| L0 低阶循环 | `packages/agent/src/agent-loop.ts` | 796 | 纯函数式循环，消息→LLM→tool→回灌 |
| L1 有状态封装 | `packages/agent/src/agent.ts` | 592 | `Agent` 类，持有 transcript、事件、队列 |
| L2 应用会话 | `packages/coding-agent/src/core/agent-session.ts` | 3469 | 持久化、压缩、扩展、工具管理 |
| L3（未实现） | `packages/agent/src/harness/agent-harness.ts` | 508 | 持久化状态机空壳 |

### 1.2 循环组织

核心是**双层 while**（`agent-loop.ts:170-272`）：

```ts
// agent-loop.ts:170-174
while (true) {                                    // 外层：follow-up 消息到达则重启
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pendingMessages.length > 0) {   // 内层：tool call + steering
```

一轮 turn 的完整链路（`agent-loop.ts:193-224`）：

```ts
// agent-loop.ts:193
const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
newMessages.push(message);
// agent-loop.ts:196-200 —— 错误/中止立即终止
if (message.stopReason === "error" || message.stopReason === "aborted") { ... return; }
// agent-loop.ts:203
const toolCalls = message.content.filter((c) => c.type === "toolCall");
// agent-loop.ts:211-214 —— 关键细节：length 截断时不执行任何 tool call
const executedToolBatch = message.stopReason === "length"
    ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
    : await executeToolCalls(currentContext, message, config, signal, emit);
// agent-loop.ts:218-221 —— 结果回灌
for (const result of toolResults) { currentContext.messages.push(result); newMessages.push(result); }
```

> 值得借鉴的工程细节：`stopReason === "length"` 时**所有** tool call 全部标记失败（`agent-loop.ts:381-406`），理由写在注释里——流式 JSON 的 salvage parser 会让被截断的参数「看起来合法」，执行它们是危险的。这是很多自研 agent 会踩的坑。

### 1.3 可中断性 —— ✅ 优秀

- `AbortSignal` 贯穿全链路：`streamAssistantResponse` → `tool.execute(id, args, signal, onUpdate)`（`agent-loop.ts:679-683`）。
- `Agent.abort()`（`agent.ts:319-321`）触发 `activeRun.abortController.abort()`。
- 顺序执行时每个 tool 后检查 `signal?.aborted` 并 break（`agent-loop.ts:478-480`）。
- `waitForIdle()`（`agent.ts:328-330`）等待**所有 listener settle**，而非仅 `agent_end` 事件——这个语义在注释里明确声明（`agent.ts:323-327`）。

### 1.4 可恢复性 —— ⚠️ 弱（进程内），设计已有但未实现（持久化）

- **进程内恢复**：`agentLoopContinue()`（`agent-loop.ts:64-93`）可从现有 context 续跑，要求最后一条消息不是 assistant（`agent-loop.ts:74-76`）。
- **跨进程恢复**：仅靠 session JSONL 重放消息（见 §6），**不保存「执行到哪一步」**。若在 tool 执行中途崩溃，重启后该 tool call 没有对应 result，历史是残缺的。
- **设计已存在但未实现**：`docs/harness.md:127` 的「durable program counter」——每步后覆写 `op.state/{operationId}` 寄存器；`docs/harness.md:186-205` 甚至给出了「tool 删文件删到一半崩溃」的恢复语义（`replay: "never"` → 写合成错误结果，不重跑）。**这套东西一行都没实现**。

### 1.5 流式处理 —— ✅ 优秀

事件驱动，`EventStream` 抽象（`agent-loop.ts:145-150`）：

```ts
// agent-loop.ts:317-344
for await (const event of response) {
    switch (event.type) {
        case "start":
            partialMessage = event.partial;
            context.messages.push(partialMessage);   // 部分消息先进 context
            await emit({ type: "message_start", message: { ...partialMessage } });
            break;
        case "text_delta": case "thinking_delta": case "toolcall_delta": /* ...9 种 */
            partialMessage = event.partial;
            context.messages[context.messages.length - 1] = partialMessage;  // 原地替换
            await emit({ type: "message_update", assistantMessageEvent: event, message: {...partialMessage} });
```

事件类型共 10 种（`types.ts:428-443`）：`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`。
**工具也能流式**：`AgentToolUpdateCallback`（`types.ts:383`）让 tool 在执行中推送 `partialResult`。

### 1.6 对 Axon 的意义

主循环质量高、可直接复用，但它是**单 Agent 单 transcript** 的。Axon 的 5 个角色 = 5 个 `Agent` 实例，编排逻辑（谁调谁、结果如何汇总）**完全在循环之外**，需自建。

---

## 2. 上下文与状态管理

### 2.1 数据结构

三层，职责清晰：

```ts
// packages/agent/src/types.ts:412-419 —— 传给 LLM 的最小快照
export interface AgentContext {
    systemPrompt: string;
    messages: AgentMessage[];
    tools?: AgentTool<any>[];
}
```

```ts
// packages/agent/src/types.ts:333-358 —— 运行时状态
export interface AgentState {
    systemPrompt: string;
    model: Model<any>;
    thinkingLevel: ThinkingLevel;
    set tools(tools: AgentTool<any>[]);  get tools(): AgentTool<any>[];
    set messages(messages: AgentMessage[]);  get messages(): AgentMessage[];
    readonly isStreaming: boolean;
    readonly streamingMessage?: AgentMessage;
    readonly pendingToolCalls: ReadonlySet<string>;
    readonly errorMessage?: string;
}
```

**消息类型可扩展**（对 Axon 很关键）——通过 TS declaration merging：

```ts
// packages/agent/src/types.ts:316-325
export interface CustomAgentMessages {
    // Empty by default - apps extend via declaration merging
}
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

Axon 可借此加入 `plan`、`handoff`、`review` 等自定义消息类型，再通过 `convertToLlm`（`types.ts:178`）决定是否投喂给 LLM。

### 2.2 系统提示词组装 —— ✅ 有分层，但是「拼接式」非「模板式」

入口：`packages/coding-agent/src/core/system-prompt.ts:28` `buildSystemPrompt()`。

**分层顺序**（`system-prompt.ts:121-159`）：

| 层 | 来源 | 代码位置 |
|---|---|---|
| 1. 内核提示 | 硬编码字符串 `You are an expert coding assistant operating inside pi...` | `system-prompt.ts:121-138` |
| 2. 工具清单 | `toolSnippets` 逐行渲染 | `system-prompt.ts:83-84` |
| 3. Guidelines | 内置 + `promptGuidelines` 扩展注入，带去重 | `system-prompt.ts:87-119` |
| 4. appendSystemPrompt | CLI `--append-system-prompt` | `system-prompt.ts:140-142` |
| 5. **项目上下文** | AGENTS.md 家族 | `system-prompt.ts:144-152` |
| 6. Skills | `formatSkillsForPrompt(skills)`，仅当 read 工具可用 | `system-prompt.ts:154-157` |
| 7. cwd | `Current working directory: ...` | `system-prompt.ts:159` |

**customPrompt 可整体替换 1-3 层**，但 4-7 层仍然追加（`system-prompt.ts:46-72`）——这个语义对 Axon 的「纯净分身 vs 继承分身」非常有用。

**AGENTS.md 发现逻辑**（`packages/coding-agent/src/core/resource-loader.ts:72`）：

```ts
const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
```

从 cwd **逐级向上遍历到根**，全局 context 优先，祖先目录 `unshift` 保证由远及近（`resource-loader.ts:126-156`），并有 shadowing 机制（`resource-loader.ts:143`）。

渲染格式（`system-prompt.ts:146-151`）：
```
<project_context>
<project_instructions path="/path/AGENTS.md">...</project_instructions>
</project_context>
```

### 2.3 Compaction —— ✅ 实现完整且成熟

位置：`packages/coding-agent/src/core/compaction/compaction.ts`（997 行）+ `branch-summarization.ts`（379 行）+ `utils.ts`（158 行）。

**配置**（`compaction.ts:126-136`）：
```ts
export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; }
export const DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
```

**触发**：自动检查在 `agent-session.ts:2150` `shouldCompact(contextTokens, contextWindow, settings)`，手动入口 `agent-session.ts:1864 async compact(customInstructions?)`。有独立的 `_autoCompactionAbortController`（`agent-session.ts:333`）——压缩本身可中断。

**Token 计算**（`compaction.ts:146-148`）：
```ts
export function calculateContextTokens(usage: Usage): number {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
```
优先用 provider 返回的真实 usage，尾部新消息才用估算（`compaction.ts:183-200` `ContextUsageEstimate`）——比纯 tokenizer 估算准得多。

**特色：文件操作追踪**（`compaction.ts:33-70`）。压缩时从 tool call 中提取 `readFiles` / `modifiedFiles`，写进 `CompactionEntry.details`，并且**跨多次压缩累积继承**（`compaction.ts:50-62`）。这样即使对话被压缩，「改过哪些文件」也不丢。Axon 的进度管理 Agent 可以直接复用这个思路。

**压缩结果结构**（`compaction.ts:88-97`）：
```ts
export interface CompactionResult<T = unknown> {
    summary: string; firstKeptEntryId: string; tokensBefore: number;
    estimatedTokensAfter?: number; usage?: Usage; details?: T;   // details 供扩展塞结构化数据
}
```

**上下文投影规则**（`docs/harness.md:753-761`，coding-agent 中已按此实现）：扫到 compaction 就停，`summary` + `retainedTail` + 其后所有条目，**更早的一律不读**；并丢弃 stopReason 为 `error`/`aborted`/`deferred` 的 assistant 消息。

---

## 3. 多 Agent / 子 Agent 能力 —— ❌ **最大短板**

### 3.1 结论：无内置

`packages/coding-agent/src/core/tools/` 完整清单：`bash.ts` `edit.ts` `find.ts` `grep.ts` `ls.ts` `read.ts` `write.ts` + 辅助文件。**没有 `task.ts`，没有 `subagent.ts`，没有 `agent.ts`**。

官方明确表态（`packages/coding-agent/README.md:500`）：
> **No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way.

以及 `packages/coding-agent/docs/usage.md:304`：
> It intentionally does not include built-in MCP, **sub-agents**, permission popups, plan mode, to-dos, or background bash.

### 3.2 官方 example 扩展的做法

`packages/coding-agent/examples/extensions/subagent/`（`index.ts` 1038 行 + `agents.ts` 157 行 + 4 个角色 md + 3 个 prompt md）。

**角色定义 = Markdown + YAML frontmatter**（`agents.ts:11-19`）：
```ts
export interface AgentConfig {
    name: string; description: string;
    tools?: string[];           // 工具白名单
    model?: string;             // 独立模型
    systemPrompt: string;       // = md 正文
    source: "user" | "project";
    filePath: string;
}
```
发现路径（`agents.ts:128-133`）：用户级 `~/.pi/agent/agents/` + 项目级 `<cwd>/.pi/agents/`（向上查找，`agents.ts:116-126`），`scope` 支持 `user`/`project`/`both`，项目级覆盖用户级（`agents.ts:137-140`）。

自带 4 个角色：`planner.md` `scout.md` `reviewer.md` `worker.md` —— **和 Axon 的 5 角色设想高度同构**。

**执行 = spawn 子进程**（`index.ts:300-350`）：
```ts
// index.ts:300-307
const args: string[] = ["--mode", "json", "-p", "--no-session"];
const inheritsDispatchConfig = !agent.model;
const model = agent.model ?? dispatchDefaults.model;
if (model) args.push("--model", model);
if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
// index.ts:334-339 —— systemPrompt 走临时文件（mode 0o600）
const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
args.push("--append-system-prompt", tmpPromptPath);
// index.ts:346-350
const proc = spawn(invocation.command, invocation.args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore","pipe","pipe"] });
```

### 3.3 上下文：**完全隔离，无继承**

- `--no-session`（`index.ts:300`）→ 子进程不读也不写会话文件。
- 父 transcript **一个字都不传**，唯一输入是 `args.push(\`Task: ${task}\`)`（`index.ts:341`）。
- 继承的只有：cwd、model、thinkingLevel（`index.ts:301-306`）——**是配置继承，不是上下文继承**。
- 注意：子进程在自己的 cwd 里仍会**重新加载 AGENTS.md**（走完整 `resource-loader` 流程），所以「项目级内置上下文」是间接继承的，但父会话的对话历史绝对不继承。

> **对 Axon 直接命中**：这正好只实现了你要的「**纯净上下文轻量分身**」。「**继承内核全部内置上下文的分身**」在 Pi 里**没有任何现成实现**——`--no-session` 是写死的，没有「导出父 transcript 并注入子 agent」的通路。

### 3.4 结果回传

子进程 `--mode json` 输出 JSONL，父进程逐行解析（`index.ts:353-388`）：
```ts
if (event.type === "message_end" && event.message) {
    currentResult.messages.push(msg);
    if (msg.role === "assistant") {
        currentResult.usage.turns++;
        currentResult.usage.input += usage.input || 0;   // 逐项累加 token/cost
        ...
    }
    emitUpdate();     // 实时回流到父 TUI
}
```
最终取最后一条 assistant 的 text（`index.ts:170-180` `getFinalOutput`），单任务输出上限 50KB（`index.ts:36` `PER_TASK_OUTPUT_CAP`）。

**三种编排模式**（`index.ts:459-469` schema）：
- single：`{agent, task}`
- parallel：`{tasks: [...]}`，上限 8 个（`index.ts:33`），并发 4（`index.ts:34`），自建信号量 `mapWithConcurrencyLimit`（`index.ts:219-237`）
- chain：`{chain: [...]}`，支持 `{previous}` 占位符传递上一步输出（`index.ts:450`）

### 3.5 「设计了但没实现」的 Lane 模型

这是 Axon 最该关注的部分。`packages/agent/docs/harness.md:98`：
> **Lanes.** Named cursors into the tree. Every session has `main`. A lane owns its leaf, model configuration, queues, and at most one operation. Additional lanes support Slack threads, **subagents**, and other parallel work over shared history.

API 已定义（`agent-harness.ts:271-303` `interface AgentLane`），包含 `createLane(name, at)`（`:447`）、`lanes()`（`:450`）、`lane(name)`（`:444`）。

**但全部未实现**：
```ts
// agent-harness.ts:355-357
private unavailable<T>(operation: string): Promise<T> {
    return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
}
// agent-harness.ts:447-449
async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
    return this.unavailable("createLane");
}
```
连 `create()` 都拒绝恢复已有会话：
```ts
// agent-harness.ts:350-352
const [record] = await options.session.findRecords({ limit: 1 });
if (record !== undefined) throw new HarnessNotImplemented("create.restore");
```

Lane 模型若实现，将天然支持「共享历史树 + 多分支并行」——即 Axon 想要的「继承内核上下文的分身」。**Axon 可以照着这份 2941 行规格自己实现**，这是本仓最大的「设计资产」。

### 3.6 扩展成本估算

| 目标 | 成本 | 说明 |
|---|---|---|
| 纯净分身（进程级） | **极低**，1-2 天 | 抄 example 扩展即可 |
| 纯净分身（进程内） | **低**，3-5 天 | `new Agent({...})` + 独立 systemPrompt/tools，无需 spawn |
| 继承上下文分身 | **中**，1-2 周 | 需实现 transcript 切片/投影 + 注入；无现成机制 |
| 共享历史树 + Lane | **高**，4-8 周 | 需按 harness.md 自建 entry tree + register 存储 |
| 5 角色编排调度器 | **中高**，2-4 周 | 状态机、handoff 协议、结果汇总，Pi 零支持 |

---

## 4. 工具系统

### 4.1 定义 —— TypeBox schema，类型安全

```ts
// packages/agent/src/types.ts:386-409
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
    label: string;
    prepareArguments?: (args: unknown) => Static<TParameters>;   // 校验前的兼容性修补
    execute: (toolCallId: string, params: Static<TParameters>,
              signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
    executionMode?: ToolExecutionMode;   // 每工具级 sequential/parallel 覆盖
}
```

返回值（`types.ts:361-375`）：
```ts
export interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];   // 给模型看的
    details: T;                                // 给 UI/日志看的结构化数据
    usage?: Usage;
    addedToolNames?: string[];                 // 动态注册新工具！
    terminate?: boolean;                       // 提示 agent 停止
}
```

> `addedToolNames` 很有意思——工具可以在运行中往会话里引入新工具，从该 transcript 点起可用。这是「self-extensible」的一个具体机制。

### 4.2 注册 —— 三条路径

1. 内置：`createCodingTools()` / `createReadOnlyTools()` 等工厂（`packages/coding-agent/src/core/sdk.ts:116-128` 导出）
2. SDK 注入：`CreateAgentSessionOptions.customTools?: ToolDefinition[]`（`sdk.ts:75`）
3. 扩展注册：`pi.registerTool(...)`（`extensions/types.ts:1268-1270`）

工具启停（`extensions/types.ts:1360-1366`）：`getActiveTools()` / `getAllTools()` / `setActiveTools(names)` —— **运行时可切换**。CLI 侧有 `--tools` 白名单 / `--exclude-tools` 黑名单 / `--no-tools`（`sdk.ts:54-73`），组合逻辑见 `sdk.ts:254-261`。

### 4.3 鉴权/审批 —— ⚠️ 只有 hook，无内置 UI

**没有内置权限弹窗**（`docs/usage.md:304` 明确列为 non-goal）。机制是 `beforeToolCall` 钩子：

```ts
// packages/agent/src/agent-loop.ts:619-646
if (config.beforeToolCall) {
    const beforeResult = await config.beforeToolCall({ assistantMessage, toolCall, args: validatedArgs, context }, signal);
    if (signal?.aborted) { return { kind:"immediate", result: createErrorToolResult("Operation aborted"), isError: true }; }
    if (beforeResult?.block) {
        const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
        if (beforeResult.terminate === true) result.terminate = true;
        return { kind: "immediate", result, isError: true };
    }
}
```

会话层桥接到扩展事件（`agent-session.ts:485-492`）：
```ts
this.agent.beforeToolCall = async ({ toolCall, args }) => {
    ...
    return await runner.emitToolCall({ ... });
};
this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => { ... };   // :506
```

扩展侧返回值（`extensions/types.ts:1087-1096`）：
```ts
export interface ToolCallEventResult {
    block?: boolean;      // 阻止执行；改参数请直接原地 mutate event.input
    reason?: string;
    terminate?: boolean;
}
```

另有项目信任机制：`core/project-trust.ts`、`core/trust-manager.ts`、`cli/project-trust.ts`（README `### Project Trust`）。

**对 Axon**：审批 UI 必须自建，但 hook 点齐全（block + 改参 + 改结果），足够。

### 4.4 动态加载自定义工具 —— ✅ 强

扩展用 **jiti** 直接运行 TypeScript，无需编译（`extensions/loader.ts:2, 17, 452-463`）：
```ts
// loader.ts:2
* Extension loader - loads TypeScript extension modules using jiti.
// loader.ts:452-463
const jiti = createJiti(import.meta.url, { ... });
const module = await jiti.import(extensionPath, { default: true });
```
发现路径（`loader.ts:718-723`）：
- 项目级 `<cwd>/.pi/extensions/`
- 全局 `~/.pi/agent/extensions/`
- npm 包 `package.json` 的 `pi.extensions` 字段（`loader.ts:613`）
- git 源：`.pi/git/github.com/<org>/<repo>/extensions/...`（见 `test/interactive-mode-status.test.ts:667-686`）

### 4.5 MCP —— ❌ 完全不支持

全仓 grep `mcp` 只命中：一个测试 fixture 字符串 `"npm:pi-mcp-adapter"`、两处注释、README 的拒绝声明。

`packages/coding-agent/README.md:498`：
> **No MCP.** Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support.

**Axon 若需要 MCP，100% 自建**（可作为扩展，工作量中等：MCP client + 工具映射到 `AgentTool`）。

### 4.6 并发与错误处理 —— ✅ 设计精细

**两种模式**（`types.ts:42`，默认 `parallel`，见 `agent.ts:237`）。调度决策（`agent-loop.ts:419-426`）：
```ts
const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential");
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```
> 注意语义：**只要批次里有任何一个 sequential 工具，整批降级为串行**。

并行实现（`agent-loop.ts:489-554`）分两阶段——**preparation 阶段严格串行**（`:499-538`，保证 `beforeToolCall` 钩子按顺序触发、审批不乱序），**execute 阶段并发**（`:540-542` `Promise.all`）。结果消息按 assistant 原始顺序发出（`:543-548`），但 `tool_execution_end` 事件按完成顺序发（见 `types.ts:37-40` 注释）。

**错误处理四层**：
1. 工具未找到 → `createErrorToolResult(\`Tool ${name} not found\`)`（`agent-loop.ts:608-614`）
2. schema 校验失败 → catch 转错误结果（`agent-loop.ts:661-667`）
3. execute 抛异常 → catch 转错误结果（`agent-loop.ts:701-707`），**并且仍 await 已排队的 update 事件**（`:703`），防止事件丢失
4. `afterToolCall` 钩子自身抛异常 → 也被 catch（`agent-loop.ts:747-750`）

**提前终止规则**（`agent-loop.ts:582-584`）——很克制：
```ts
function shouldTerminateToolBatch(finalizedCalls) {
    return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```
必须**全部** tool 都要求 terminate 才终止，避免单个工具绑架整个 agent。

**文件互斥**：`core/tools/file-mutation-queue.ts`，导出 `withFileMutationQueue`（`sdk.ts:117`），并行写同一文件时串行化。

---

## 5. 模型抽象层（packages/ai）—— ⭐ **全仓最大资产**

### 5.1 规模

- 源码 **23,555 行 / 177 文件**；测试 **34,856 行 / 136 文件**（测试量是源码的 1.48 倍）
- **约 40 个 provider**（`src/providers/`）：anthropic、openai、google、google-vertex、amazon-bedrock、azure-openai-responses、github-copilot、openai-codex、openrouter、groq、cerebras、deepseek、mistral、fireworks、together、xai、nvidia、huggingface、baseten、cloudflare-workers-ai、cloudflare-ai-gateway、vercel-ai-gateway、moonshotai(+cn)、minimax(+cn)、zai(+coding-cn)、qwen-token-plan(+cn/individual)、xiaomi(+cn/sgp/ams)、kimi-coding、ant-ling、opencode(+go)、faux（测试用）
- **约 15 种 API 方言**（`src/api/`）：anthropic-messages、openai-completions、openai-responses、openai-codex-responses、azure-openai-responses、google-generative-ai、google-vertex、bedrock-converse-stream、mistral-conversations、openrouter-images、pi-messages、cloudflare…每种都有 `.lazy.ts` 变体做 tree-shaking

### 5.2 统一方式

`Model<TApi>` 是一等描述符（`packages/ai/src/types.ts:821-850`）：
```ts
export interface Model<TApi extends Api> {
    id: string; name: string;
    api: TApi;                    // ← API 方言（决定用哪个 transport 实现）
    provider: ProviderId;         // ← 供应商（决定 baseUrl/auth/header）
    baseUrl: string;
    reasoning: boolean;
    thinkingLevelMap?: ThinkingLevelMap;   // pi 的 7 档 thinking 映射到各家私有值
    input: ("text" | "image")[];
    cost: ModelCost;
    contextWindow: number; maxTokens: number;
    samplingParams?: Record<string, unknown>;
    headers?: Record<string, string>;
    compat?: /* 按 TApi 条件类型收窄的兼容性覆盖 */;
}
```

**关键设计：`api` 与 `provider` 正交**。一个 provider 可以说 openai-completions 方言，换 baseUrl 即可接入——这是 Pi 能支持 40 个 provider 而代码不爆炸的原因。

统一入口是 `StreamFn`（`packages/agent/src/types.ts:28-32`）：
```ts
export type StreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions)
    => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```
契约写得极严（`types.ts:23-27`）：**不得抛异常**，失败必须编码进返回流里（`stopReason: "error" | "aborted"` + `errorMessage`）。

具体实现 `streamSimple`（`packages/ai/src/compat.ts:275`）。`packages/agent` **不依赖** `pi-ai/compat`（保持 provider 无关），由 coding-agent 在 `sdk.ts:36` 注入：
```ts
setDefaultStreamFn(streamSimple);
```

### 5.3 切换模型成本 —— ✅ 极低

- 运行时：`agent.state.model = newModel`，或循环中 `prepareNextTurn` 返回 `{ model }`（`agent-loop.ts:232-244`）——**每 turn 都能换模型**：
```ts
// agent-loop.ts:233-244
if (nextTurnSnapshot) {
    currentContext = nextTurnSnapshot.context ?? currentContext;
    config = { ...config, model: nextTurnSnapshot.model ?? config.model, reasoning: ... };
}
```
- 认证：`getApiKey?: (provider) => ...`，**每次 LLM 调用前重新解析**（`agent-loop.ts:305-306`），注释说明是为 GitHub Copilot 这类短时 OAuth token 准备的。
- 模型目录：`models.generated.ts` 自动生成 + `~/.pi/agent/models.json` 用户自定义 + 远程 catalog（`core/remote-catalog-provider.ts`）。

### 5.4 不同子 Agent 配不同模型 —— ✅ 天然支持

`Model` 是纯数据 + `StreamFn` 是纯函数，每个 `Agent` 实例持有自己的 `state.model`。example 扩展已经这么做（`agents.ts:15` frontmatter 的 `model` 字段 → `index.ts:302-303` 传 `--model`）。

**Axon 可直接**：进度管理 Agent 用便宜快模型，架构设计 Agent 用 opus/thinking-high，测试 Agent 用中档——零额外成本。

---

## 6. 会话持久化

### 6.1 格式与路径

- 格式：**JSONL**，`CURRENT_SESSION_VERSION = 3`（`packages/coding-agent/src/core/session-manager.ts:30`）
- 路径（`session-manager.ts:476-489`）：
```ts
function getDefaultSessionDirPath(cwd, agentDir = getDefaultAgentDir()) {
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(resolvedAgentDir, "sessions", safePath);
}
```
即 `~/.pi/agent/sessions/--Users-xxx-proj--/<sessionId>.jsonl` —— **按 cwd 分目录**。

### 6.2 条目模型 —— 树，不是线性表

`SessionEntry` 联合类型（`session-manager.ts:144-155`），10 种：
`SessionMessageEntry`(:53)、`ThinkingLevelChangeEntry`(:58)、`ModelChangeEntry`(:63)、`CompactionEntry<T>`(:69)、`BranchSummaryEntry<T>`(:82)、`CustomEntry<T>`(:104)、`LabelEntry`(:111)、`SessionInfoEntry`(:118)、`CustomMessageEntry<T>`(:135)、`SessionHeader`(:32)。

每条带 `uuid` / `parentUuid` → 构成 `SessionTreeNode`（`session-manager.ts:159-166`），支持分支/回溯（README `### Branching`）。

上下文重建：`buildSessionContext()`（`session-manager.ts:461`）+ `buildContextEntries()`（`:418`，遇 compaction 即停，`:427`）+ `sessionEntryToContextMessages()`（`:383-416`）。

> **注意版本割裂**：coding-agent 用的是 **format 3**（线性 JSONL + parentUuid）。`docs/harness.md` 设计的是 **format 4**（entries + registers + usage ledger，三存储模型），并在 Appendix B 里规划了 v3 兼容。`docs/harness.md:496` 甚至坦承：「The incompatible format-4 code currently in the source tree is **unfinished**」。

### 6.3 恢复 —— ✅ 可用

`sdk.ts:189-234`：
```ts
const existingSession = sessionManager.buildSessionContext();
const hasExistingSession = existingSession.messages.length > 0;
// 恢复模型
const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) model = restoredModel;
// 恢复 thinking level（:230-234）
// 回灌消息（:373-374）
agent.state.messages = existingSession.messages;
```
模型不可用时优雅降级并给 `modelFallbackMessage`（`sdk.ts:204, 220-224`）。

### 6.4 Fork —— ✅ 支持

- `SessionManager.forkFrom(...)`（`session-manager.ts:1580`），跨项目目录 fork（`:1574` 注释），新 ID 但继承内容（`:1603`）
- `SessionEntryBase` 有 `parentSessionPath`（`session-manager.ts:181` 注释「Path to the parent session (if this session was forked)」）
- RPC 暴露三个相关方法：`fork`(`rpc-mode.ts:609`)、`clone`(`:617`)、`get_fork_messages`(`:629`)
- 扩展可拦截：`session_before_fork` / `session_fork` 事件（`extensions/types.ts:1227-1231`）

**对 Axon**：fork 是实现「继承内核全部内置上下文的分身」**最现成的原语**——fork 会话 → 新 Agent 实例挂上去 → 换 systemPrompt/tools。这条路比自建 Lane 便宜得多。

---

## 7. 扩展点 / Hook / Plugin —— ⭐ **第二大资产**

### 7.1 「self-extensible」的具体实现

没有 `self-extensible` 字面词，官方表述是（`README.md:496`）：
> Pi is **aggressively extensible** so it doesn't have to dictate your workflow.

由四层机制构成：

| 机制 | 实现 | 位置 |
|---|---|---|
| Extensions | jiti 直跑 TS，无编译 | `core/extensions/loader.ts:452-463` |
| Skills | Markdown 技能包，注入 system prompt | `core/skills.ts`（507 行） |
| Prompt Templates | Markdown 模板 + 参数 | `core/prompt-templates.ts` |
| Pi Packages | npm/git 分发扩展 | `core/package-manager.ts`、`loader.ts:613` |

再加上「文档即能力」——system prompt 里直接告诉模型去读 pi 自己的 docs/examples（`system-prompt.ts:131-138`），**模型能自己学会写 pi 扩展**。这才是 self-extensible 的真意。

### 7.2 事件 Hook 全清单（`extensions/types.ts:1219-1261`，共 30 个）

**会话生命周期**：`project_trust`(:1219)、`resources_discover`(:1220)、`session_start`(:1221)、`session_info_changed`(:1222)、`session_before_fork`(:1227)、`session_compact`(:1232)、`session_compact_failed`(:1233)、`session_shutdown`(:1234)、`session_before_tree`(:1235)、`session_tree`(:1236)

**上下文与请求**：`context`(:1237)、`before_provider_headers`(:1242)、`after_provider_response`(:1243)

**Agent 循环**：`before_agent_start`(:1244)、`agent_start`(:1245)、`agent_end`(:1246)、`agent_settled`(:1247)、`turn_start`(:1248)、`turn_end`(:1249)

**消息**：`message_start`(:1250)、`message_update`(:1251)、`message_end`(:1252)

**工具**：`tool_execution_start`(:1253)、`tool_execution_update`(:1254)、`tool_execution_end`(:1255)、`tool_call`(:1258)、`tool_result`(:1259)

**其他**：`model_select`(:1256)、`thinking_level_select`(:1257)、`user_bash`(:1260)、`input`(:1261)

**可改写（非只读）的 hook**：`context`(→`ContextEventResult`)、`tool_call`(→ block/改参)、`tool_result`(→ 改 content/details/isError/usage)、`message_end`、`before_agent_start`、`user_bash`(→ 可完全接管 bash 执行)、`input`、`session_before_fork`、`session_before_tree`、`resources_discover`。

### 7.3 注册类 API

`registerTool`(:1268)、`registerCommand`(:1277)、`registerShortcut`(:1280)、`registerFlag`(:1289)、`registerMessageRenderer`(:1312)、`registerMarkdownTransformer`(:1315)、`registerEntryRenderer`(:1318)

### 7.4 UI 扩展 API（TUI 内）

`setStatus`(:148)、`setWorkingMessage`(:151)、`setWidget`(:170)、`setFooter`(:183)、`setHeader`(:190)、`setTitle`(:193)、`addAutocompleteProvider`(:225)、`setEditorComponent`(:260)、`getTheme`/`setTheme`(:272/:275)、`onTerminalInput`(:145)

### 7.5 会话控制 API

`getContextUsage`(:342)、`getSystemPrompt`(:346)、`getSystemPromptOptions`(:355)、`setSessionName`(:1348)、`setLabel`(:1354)、`getActiveTools`(:1360)、`setActiveTools`(:1366)、`setModel`(:1376)

> **对 Axon**：`context` hook（`sdk.ts:360-364` 接到 `transformContext`）是实现「上下文注入/分身继承」的**天然切入点**：
> ```ts
> transformContext: async (messages) => {
>     const runner = extensionRunnerRef.current;
>     if (!runner) return messages;
>     return runner.emitContext(messages);
> }
> ```

### 7.6 官方 example 扩展

`packages/coding-agent/examples/extensions/` 含 `subagent/`、`sandbox/`、`gondolin/`、`custom-provider-anthropic/`、`custom-provider-gitlab-duo/`、`with-deps/`、`overlay-qa-tests.ts` 等，且这些都在 root `package.json:workspaces` 里——**作为真实 workspace 参与构建与测试**，不是死代码。

---

## 8. TUI / 前端

### 8.1 packages/tui 架构

16,772 行 / 39 文件，**零重量依赖**（仅 `get-east-asian-width` + `marked`）。

- 核心：`tui.ts`、`tui-main-screen.ts`、`tui-alt-screen.ts`、`terminal.ts`、`layout.ts`、`layout-node.ts`
- 组件（17 个）：`box` `editor` `h-stack` `v-stack` `image` `input` `loader` `markdown` `scroll-view` `select-list` `settings-list` `spacer` `stack` `text` `truncated-text` `cancellable-loader` `alt-screen-flash`
- 输入：`keys.ts` `keybindings.ts` `stdin-buffer.ts` `kill-ring.ts`（Emacs 风格）`undo-stack.ts` `word-navigation.ts`
- 渲染：**differential rendering**（package.json description 明示），只重绘变化行
- 有原生加速模块：`native/darwin/*.c`、`native/win32/*.c`（prebuilds）

### 8.2 可复用性 —— ❌ 对 GUI 客户端不可复用

纯终端：ANSI 转义、`terminal-colors.ts`、`terminal-image.ts`（iTerm/Kitty 协议）、east-asian-width 列宽计算。**没有任何 DOM/Canvas/RN 抽象**。Axon 若是 GUI（Electron/Tauri/Web），TUI 层整个丢弃。

**唯一可借鉴**：`layout.ts` / `layout-node.ts` 的布局模型，以及 `components/markdown.ts` 的流式 markdown 增量渲染思路。

### 8.3 Headless / SDK 模式 —— ✅ **四条通路，这是 Axon 嵌入的关键**

| 通路 | 入口 | 规模 | 适用 |
|---|---|---|---|
| **① SDK（进程内）** | `createAgentSession()` `core/sdk.ts:171` | 408 行 | Node/Bun 宿主，**Axon 首选** |
| **② JSON 流** | `--mode json` `modes/json-event.ts` | 61 行 | 一次性任务、脚本 |
| **③ Print** | `-p` `modes/print-mode.ts` | 169 行 | CLI 管道 |
| **④ RPC（JSONL over stdio）** | `--mode rpc` `modes/rpc/rpc-mode.ts` | 817 + 601(client) + 289(types) | **非 Node 宿主，GUI 首选** |

**SDK 用法**（`README.md:463-474`）：
```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), modelRuntime });
await session.prompt("What files are in the current directory?");
```
多会话运行时替换用 `createAgentSessionRuntime()` / `AgentSessionRuntime`（`README.md:476`，实现在 `core/agent-session-runtime.ts` 441 行）。

**RPC 方法全集**（`rpc-mode.ts:394-678`，32 个）：
`prompt` `steer` `follow_up` `abort` `new_session` `get_state` `set_model` `cycle_model` `get_available_models` `set_thinking_level` `cycle_thinking_level` `get_available_thinking_levels` `set_steering_mode` `set_follow_up_mode` `compact` `set_auto_compaction` `set_auto_retry` `abort_retry` `bash` `abort_bash` `get_session_stats` `export_html` `switch_session` `fork` `clone` `get_fork_messages` `get_entries` `get_tree` `get_last_assistant_text` `set_session_name` `get_messages` `get_commands`

> 协议警告（`README.md:488`）：严格 LF 分隔，**不能用 Node `readline`**（它还会在 Unicode 分隔符上切分，导致 JSON 载荷被截断）。

**⑤ 远程会话**：`packages/server`（2299 行）+ `packages/client`（1225 行）+ `packages/protocol`（1236 行），**framed CBOR over Unix socket**。`packages/coding-agent/src/client/remote-session.ts` 是消费端。这是把 pi 做成后台 daemon、GUI 连上去的官方路径。

---

## 9. 代码规模与质量

### 9.1 规模统计（实测，不含 node_modules/dist）

| Package | 源码行 | 源文件 | 测试行 | 测试文件 | 测试/源码比 |
|---|---:|---:|---:|---:|---:|
| **coding-agent** | 59,900 | 203 | 48,583 | 235 | 0.81 |
| **ai** | 23,555 | 177 | 34,856 | 136 | **1.48** |
| **tui** | 16,772 | 39 | 16,058 | 32 | 0.96 |
| **agent** | 12,635 | 50 | 8,582 | 23 | 0.68 |
| server | 2,299 | 17 | 1,447 | 7 | 0.63 |
| session-backends/sqlite-node | 2,389 | 18 | 1,663 | 11 | 0.70 |
| protocol | 1,236 | 8 | 716 | 3 | 0.58 |
| client | 1,225 | 10 | 1,079 | 6 | 0.88 |
| telemetry | 935 | 6 | 243 | 2 | 0.26 |
| **合计** | **~120,946** | **528** | **~113,227** | **455** | **0.94** |

**总计约 23.4 万行 TS**。测试与源码近 1:1，`packages/ai` 测试量甚至超过源码 48%。

### 9.2 质量信号 —— ✅ 很高

- **测试栈**：vitest（各 package）+ `node --test`（tui）+ `packages/evals`（vitest-evals，模型行为评测）+ `test/suite/regressions/` 按 issue 编号归档回归用例（如 `8261-subagent-project-trust.test.ts`）
- **质量门禁**（root `package.json:scripts.check`）：
  ```
  biome check --write --error-on-warnings . && check:pinned-deps && check:ts-imports
  && check:shrinkwrap && check:install-lock:coding-agent && tsgo --noEmit && check:browser-smoke
  ```
  自定义校验脚本 6 个：依赖必须锁定精确版本、TS 相对导入规范、lockfile 提交校验、shrinkwrap、install-lock、浏览器 smoke
- **工具链**：Biome（lint+format）、`@typescript/native-preview`(tsgo) 做类型检查、husky pre-commit、esbuild、Bun 单文件二进制（`build:binary`）
- **文档**：`packages/agent/docs/harness.md` 2941 行规格（含 mermaid 状态机、不变量、竞态目录、测试分层），`packages/coding-agent/docs/` 十余篇专题文档
- **可观测性**：独立 `packages/telemetry`，schema 自动生成文档（`packages/agent/scripts/generate-telemetry-docs.ts` + `check:telemetry-docs`）
- **注释质量**：不是「这行做什么」，而是「**为什么这么做**」。例如 `agent-loop.ts:374-380` 解释为何截断消息的 tool call 全部作废、`agents.ts:41-52` 解释为何 YAML tools 字段要兼容两种写法。这是成熟工程的标志。

### 9.3 依赖复杂度

| Package | 运行时依赖数 | 重量级依赖 |
|---|---:|---|
| telemetry | **0** | — |
| tui | **2** | `marked`、`get-east-asian-width` |
| agent | **6**（含 2 个内部） | `typebox` `diff` `ignore` `yaml` |
| ai | **10**（含 1 内部） | `@anthropic-ai/sdk` `openai` `@google/genai` `@aws-sdk/client-bedrock-runtime` |
| coding-agent | **22**（含 5 内部） | `highlight.js` `photon-node`(wasm) `grok-mermaid` `undici` `jiti` `glob` |

**梯度非常健康**：`telemetry`(0) → `tui`(2) → `agent`(6) → `ai`(10) → `coding-agent`(22)。
**`packages/agent` 只依赖 typebox + diff + ignore + yaml，不碰任何 provider SDK** —— 内核保持纯净，这是刻意设计（`sdk.ts:33-36` 注释明说：「Agent core remains provider-agnostic and does not import pi-ai/compat itself」）。

`packages/ai` 的 4 个官方 SDK 是重量来源，但都有 `.lazy.ts` 变体 + `sideEffects` 白名单做 tree-shaking。

### 9.4 许可证 —— ✅ 无忧

**所有 package 统一 MIT**（agent / ai / coding-agent / tui / telemetry / protocol / client / server 均已确认 `"license": "MIT"`）。
根 `LICENSE:1-3`：MIT License, Copyright (c) 2025 Mario Zechner。
**fork、闭源商用、重新分发均无障碍**，仅需保留版权声明。

### 9.5 风险点

| 风险 | 严重度 | 说明 |
|---|---|---|
| harness 未实现 | **高** | 最好的设计（Lane/durable state）是空壳，`agent-harness.ts:355` |
| session format 割裂 | 中 | v3 在用、v4 「unfinished」（`harness.md:496`） |
| 版本迭代快 | 中 | CHANGELOG 已 4800+ 行，API 变动频繁 |
| `agent-session.ts` 3469 行 | 中 | 单文件过大，fork 后维护成本高 |
| 无 MCP / 无子 Agent | 中 | 是**刻意的哲学选择**，不会被官方补上 |
| Bus factor | 中 | 主要作者 Mario Zechner，社区 PR 存在但集中度高 |

---

## 10. 作为 Axon 内核的适配度评分

# **6.5 / 10**

### 分项打分

| 维度 | 分 | 理由 |
|---|:--:|---|
| 模型抽象层 | **10** | 40 provider / 15 API 方言 / 3.5 万行测试。**这一项单独就值得引入** |
| 工具系统 | **9** | TypeBox 类型安全、并行/串行、流式更新、动态注册、四层错误处理 |
| 扩展/Hook 机制 | **9** | 30 个事件、jiti 免编译、可改写 context/tool_call/tool_result |
| 主循环质量 | **8** | 清晰、可中断、流式完备；steering/follow-up 队列是亮点 |
| Headless/SDK | **8** | SDK + JSON + print + RPC(32 方法) + CBOR 远程，通路齐全 |
| 上下文管理 | **8** | 分层 prompt、AGENTS.md 向上查找、compaction 成熟（含文件追踪） |
| 会话持久化 | **7** | JSONL 树结构、fork/clone 可用；但格式 v3/v4 割裂 |
| 代码质量 | **9** | 测试比 0.94、严格门禁、注释讲「为什么」 |
| 许可证 | **10** | 全 MIT |
| **多子 Agent 编排** | **2** | **官方明确不做**。仅有 spawn 子进程的 example |
| **上下文继承分身** | **2** | `--no-session` 写死；Lane 模型只有规格无实现 |
| 持久化恢复（崩溃） | **3** | durable program counter 设计完备，实现为零 |
| GUI 前端复用 | **2** | TUI 纯终端，GUI 场景整体丢弃 |
| MCP | **1** | 完全不支持，且官方拒绝 |

### 综合判断

Pi 是一个**卓越的单 Agent 内核**，但 Axon 的核心诉求——**多角色子 Agent 协作 + 两种分身语义**——恰好落在 Pi 明确划为 non-goal 的区域。

- 如果 Axon 的重心是「**好用的 LLM 接入 + 工具执行 + 扩展宿主**」→ Pi 值 **9 分**
- 如果重心是「**开箱即用的多 Agent 编排**」→ Pi 值 **2 分**
- 加权（编排是 Axon 的立身之本，权重最高）→ **6.5**

**但要注意**：市面上没有哪个开源内核能同时给你「40 provider 抽象 + 成熟工具系统 + 现成多 Agent 编排」。Pi 的取舍是「把最难做对的底层做到极致，把上层留白」。对 Axon 而言，**留白的那部分正是你的产品差异化所在**——这未必是坏事。

---

## 11. 三种集成路径可行性

### 路径 a) Fork 改造 —— ⭐⭐⭐⭐ 推荐度 4/5

**可行性：高**

优势：
- MIT，法律零风险
- 可直接在 `packages/agent/src/agent-loop.ts` 内部加多 Agent 调度，不受公开 API 约束
- 可按 `docs/harness.md` 规格实现 Lane（**这份 2941 行规格本身就是 fork 的最大理由**）
- 可删掉不需要的：TUI(16.7k 行)、export-html、image 处理、package-manager 等，瘦身 30-40%

劣势：
- 上游迭代快（CHANGELOG 4800+ 行），rebase 成本持续存在
- `coding-agent` 5.9 万行，全量接手心智负担大
- `agent-session.ts` 单文件 3469 行，是改造痛点

**建议做法**：**部分 fork**——
- `packages/ai` + `packages/agent` + `packages/telemetry`（约 3.7 万行）**作为依赖直接用 npm 版本，不 fork**
- `packages/coding-agent` 只**摘取**需要的：`core/tools/`、`core/compaction/`、`core/session-manager.ts`、`core/system-prompt.ts`、`core/resource-loader.ts`、`core/extensions/`（约 1.5 万行）
- 丢弃：`modes/interactive/`、`packages/tui`、`export-html`、`package-manager`、`cli/`

### 路径 b) 作为依赖库调用 —— ⭐⭐⭐⭐ 推荐度 4/5

**可行性：高（但有天花板）**

npm 上可用：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-telemetry`、`@earendil-works/pi-protocol`、`@earendil-works/pi-client`、`@earendil-works/pi-server`

两种粒度：

**b1. 低阶（推荐）**：只依赖 `pi-ai` + `pi-agent-core`
```ts
const roleAgent = new Agent({
    initialState: { systemPrompt: buildAxonRolePrompt("architect"), model: opusModel, thinkingLevel: "high", tools: [...] },
    streamFn: streamSimple,
    transformContext: axonContextInjector,   // ← 分身上下文注入点
    beforeToolCall: axonApprovalGate,
});
```
- 拿到：40 provider、主循环、工具执行、流式、队列
- 自建：会话存储、角色编排、分身语义、UI
- **约 1.2 万行依赖，极轻**

**b2. 高阶**：依赖 `pi-coding-agent` 的 `createAgentSession()`
- 额外拿到：session JSONL + fork、compaction、AGENTS.md、扩展系统、内置工具
- 代价：拖入 22 个依赖（含 wasm、highlight.js）、绑定 `.pi` 目录约定、绑定「coding agent」的 system prompt 语义

天花板：
- Lane / 多 Agent 共享历史树 **拿不到**（未实现）
- `Agent` 类一次只允许一个 run（`agent.ts:351-355` 抛错），多角色必须多实例
- 崩溃恢复能力拿不到

### 路径 c) 只借鉴设计 —— ⭐⭐ 推荐度 2/5

**可行性：高，但性价比低**

值得借鉴的设计（无论选哪条路都该读）：
1. **`docs/harness.md` 全文**（2941 行）—— 三存储模型、durable program counter、effect sandwich、Lane。这是本仓**最高价值的非代码资产**
2. `AgentContext` / `AgentState` / `AgentMessage` 的三层切分（`types.ts:333-419`）
3. `StreamFn` 的「不得抛异常」契约（`types.ts:23-27`）
4. tool 并行的两阶段调度（prepare 串行 / execute 并行，`agent-loop.ts:489-554`）
5. `stopReason === "length"` 作废全批 tool call（`agent-loop.ts:381-406`）
6. compaction 的文件操作跨代继承（`compaction.ts:33-70`）
7. 角色 = Markdown + frontmatter（`agents.ts:11-19`）

**为什么不推荐**：`packages/ai` 的 2.3 万行 + 40 provider 适配，重写至少 3-6 人月，且会持续掉队（新模型、新 API 版本层出不穷）。**没有任何理由重造这个轮子。**

### 推荐组合

> **b1 为主 + a 的选择性摘取 + c 的 harness.md 指导**
>
> 1. `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` 作为 npm 依赖（不 fork）
> 2. Vendoring `coding-agent` 的 `core/tools/`、`core/compaction/`、`core/system-prompt.ts`、`core/resource-loader.ts`（保留 MIT 声明）
> 3. **Axon 自建**：多角色编排器 + 分身管理器 + 会话存储（按 harness.md 的三存储模型设计）+ GUI

---

## 12. 拿来即用 vs 必须自建

### ✅ 拿来即用（零改动或极小改动）

| 能力 | 位置 | 说明 |
|---|---|---|
| **40+ provider / 15 API 方言统一** | `packages/ai/src/providers/`、`api/` | 最大资产，3.5 万行测试兜底 |
| **模型目录 + 成本/上下文窗口元数据** | `packages/ai/src/models.generated.ts` | 含 cost、contextWindow、thinkingLevelMap |
| **OAuth / API key 管理** | `packages/ai/src/oauth.ts`、`auth/` | 含 Copilot 等短时 token 刷新 |
| **Agent 主循环** | `packages/agent/src/agent-loop.ts:155-275` | 消息→LLM→tool→回灌 |
| **流式事件协议（10 种）** | `packages/agent/src/types.ts:428-443` | 含 thinking/toolcall delta |
| **AbortSignal 全链路中断** | `agent.ts:319-321` + 全 loop | |
| **Steering / Follow-up 队列** | `agent.ts:125-159`、`agent-loop.ts:167,259,263` | 运行中插话，罕见且好用 |
| **工具定义与执行（TypeBox）** | `packages/agent/src/types.ts:386-409` | 类型安全、流式更新 |
| **并行/串行工具调度** | `agent-loop.ts:419-554` | 两阶段设计 |
| **7 个编码工具** | `coding-agent/src/core/tools/` | read/bash/edit/write/grep/find/ls，含 diff、截断、文件互斥队列 |
| **上下文压缩（含文件追踪）** | `coding-agent/src/core/compaction/` | 997+379+158 行 |
| **AGENTS.md 分层加载** | `core/resource-loader.ts:72-156` | 向上遍历 + shadowing |
| **系统提示词分层组装** | `core/system-prompt.ts:28-162` | 7 层，customPrompt 可替换前 3 层 |
| **会话 JSONL 树存储 + fork/clone** | `core/session-manager.ts` | 1715 行 |
| **扩展系统（30 hook + jiti）** | `core/extensions/` | 4159 行 |
| **Skills / Prompt Templates** | `core/skills.ts`、`core/prompt-templates.ts` | Markdown 驱动 |
| **RPC headless（32 方法）** | `modes/rpc/` | GUI 嵌入通路 |
| **CBOR 远程会话** | `packages/protocol` + `client` + `server` | daemon 化 |
| **Telemetry 契约** | `packages/telemetry` | 零依赖 |
| **子 Agent 参考实现** | `examples/extensions/subagent/` | 1195 行，直接改 |

### ❌ 必须自建

| 缺口 | 严重度 | 工作量估算 | 说明 |
|---|:--:|---|---|
| **多角色 Agent 编排器** | 🔴 致命 | 3-5 周 | 5 角色的调度状态机、handoff 协议、结果汇总、冲突仲裁。Pi 零支持 |
| **「继承内核上下文」的分身** | 🔴 致命 | 2-3 周 | 需 transcript 切片/投影 + 注入。可基于 `transformContext` hook + session fork 实现 |
| **子 Agent 间通信 / 共享状态** | 🔴 高 | 2-3 周 | 无黑板、无消息总线、无共享 memory |
| **Lane（共享历史树多泳道）** | 🟠 高 | 4-8 周 | `harness.md` 有完整规格，`agent-harness.ts` 是空壳 |
| **崩溃恢复 / durable state** | 🟠 高 | 3-6 周 | `op.state` program counter 设计完备但零实现 |
| **GUI 前端** | 🔴 致命 | 视形态而定 | TUI 完全不可复用 |
| **工具审批 UI / 权限模型** | 🟠 中高 | 1-2 周 | 只有 `beforeToolCall` hook，无策略引擎、无 UI、无持久化白名单 |
| **MCP 支持** | 🟡 中 | 2-3 周 | 完全没有；可做成扩展 |
| **子 Agent 成本/配额治理** | 🟡 中 | 1-2 周 | 有 usage 数据（`AgentToolResult.usage`、example 里的累加），无预算/限流/熔断 |
| **角色定义的 Schema 与校验** | 🟡 中 | 3-5 天 | example 里的 frontmatter 解析很薄（`agents.ts:53-60`），生产需强校验 |
| **可视化：多 Agent 执行图 / 时序** | 🟡 中 | 1-2 周 | 无 |
| **人机对齐 Agent 的交互原语** | 🟠 中高 | 2-3 周 | 打断、确认、澄清、选项呈现 —— 只有 steering 队列这一块基础 |
| **多 Agent 并发下的文件冲突治理** | 🟡 中 | 1 周 | `file-mutation-queue` 仅进程内单会话；跨 Agent 需升级 |
| **session format v4 / 三存储模型** | 🟡 中 | 3-6 周 | 若要 Lane 则必须先做；v3 撑不住多泳道 |

---

## 13. 给 Axon 的落地建议

### 13.1 架构分层建议

```
┌─────────────────────────────────────────────────┐
│  Axon GUI (Electron/Tauri/Web)          [自建]  │
├─────────────────────────────────────────────────┤
│  Axon Orchestrator                      [自建]  │
│   · 5 角色状态机（进度/架构/开发/测试/对齐）      │
│   · Clone Manager（纯净分身 / 继承分身）         │
│   · 共享黑板 (Blackboard) + 消息总线             │
│   · 成本治理 / 审批策略引擎                      │
├─────────────────────────────────────────────────┤
│  Axon Session Store                     [自建]  │
│   · 参考 harness.md 三存储模型                   │
│   · entries(树) + registers + usage ledger      │
├─────────────────────────────────────────────────┤
│  N × Agent 实例              [pi-agent-core 直用]│
│   · 每角色一个 Agent，独立 model/tools/prompt    │
├─────────────────────────────────────────────────┤
│  工具层        [pi coding-agent tools vendoring] │
├─────────────────────────────────────────────────┤
│  模型层                        [pi-ai 直接依赖]  │
└─────────────────────────────────────────────────┘
```

### 13.2 两种分身的实现路径

**纯净上下文轻量分身** —— 成本极低：
```ts
new Agent({
    initialState: {
        systemPrompt: buildSystemPrompt({ customPrompt: role.prompt, cwd, contextFiles: [], skills: [] }),
        //                                ↑ customPrompt 替换内核层    ↑ 显式清空
        model: role.model ?? parentModel,
        tools: role.tools.map(resolveTool),
    },
    streamFn: streamSimple,
});
```
关键：`system-prompt.ts:46-72` 的 `customPrompt` 分支 + `contextFiles: []` + `skills: []`。

**继承内核全部内置上下文的分身** —— 三选一：

1. **Session fork 路线（推荐，最省）**：`SessionManager.forkFrom()`（`session-manager.ts:1580`）→ `buildSessionContext()` → 新 Agent 挂载 → 覆盖 systemPrompt/tools。**复用 Pi 现成能力，约 3-5 天**
2. **transformContext 注入路线**：父 Agent 的 `state.messages` 经投影后注入子 Agent 的 `transformContext`（`types.ts:180-200`）。灵活但需自己管一致性
3. **Lane 路线（最正确，最贵）**：按 `harness.md` 实现共享 entry tree + 多 lane cursor。4-8 周

### 13.3 第一阶段 MVP 建议（4-6 周）

1. 依赖 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`（**不 fork**）
2. Vendoring `core/tools/` + `core/system-prompt.ts` + `core/resource-loader.ts`
3. 角色定义照抄 `examples/extensions/subagent/agents.ts` 的 Markdown+frontmatter 方案，但加 schema 校验
4. 编排器先做**最简单的两种模式**：sequential chain + parallel fan-out（照 `index.ts:219-237` 的并发限流）
5. 分身先只做「纯净」+「session fork 继承」两种
6. 存储先用简化 JSONL（参考 v3），**但 entry 结构按 v4 设计**，为将来 Lane 留路

### 13.4 必读源码清单（给团队）

| 优先级 | 文件 | 行数 | 为什么 |
|:--:|---|---:|---|
| P0 | `packages/agent/src/agent-loop.ts` | 796 | 内核循环，必须完全理解 |
| P0 | `packages/agent/src/types.ts` | 443 | 全部核心类型 |
| P0 | `packages/agent/docs/harness.md` | 2941 | **最高价值资产**，多 Agent 持久化的完整答案 |
| P1 | `packages/agent/src/agent.ts` | 592 | 状态封装、队列 |
| P1 | `packages/coding-agent/examples/extensions/subagent/` | 1195 | 子 Agent 参考实现 |
| P1 | `packages/coding-agent/src/core/sdk.ts` | 408 | 如何组装一个完整 session |
| P1 | `packages/coding-agent/src/core/system-prompt.ts` | 162 | prompt 分层 |
| P2 | `packages/coding-agent/src/core/extensions/types.ts` | 1751 | 30 个 hook 的完整语义 |
| P2 | `packages/coding-agent/src/core/compaction/compaction.ts` | 997 | 压缩算法 |
| P2 | `packages/coding-agent/src/core/session-manager.ts` | 1715 | 树存储 + fork |
| P3 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 817 | headless 协议参考 |

---

## 附录 A：关键路径速查

| 主题 | 路径 | 行 |
|---|---|---|
| 主循环 | `packages/agent/src/agent-loop.ts` | 155-275 |
| 流式处理 | 同上 | 281-372 |
| 截断保护 | 同上 | 381-406 |
| 并行工具 | 同上 | 489-554 |
| beforeToolCall | 同上 | 619-646 |
| 批次终止规则 | 同上 | 582-584 |
| Agent 类 | `packages/agent/src/agent.ts` | 173-591 |
| abort / waitForIdle | 同上 | 319-330 |
| AgentTool | `packages/agent/src/types.ts` | 386-409 |
| AgentState | 同上 | 333-358 |
| AgentContext | 同上 | 412-419 |
| CustomAgentMessages | 同上 | 316-325 |
| StreamFn 契约 | 同上 | 18-32 |
| **Harness 空壳** | `packages/agent/src/harness/agent-harness.ts` | 355-357, 447-449 |
| Harness 规格 | `packages/agent/docs/harness.md` | 全文 |
| Lane 定义 | 同上 | 98 |
| 三存储模型 | 同上 | 115-137 |
| 上下文投影规则 | 同上 | 753-763 |
| Model 类型 | `packages/ai/src/types.ts` | 821-850 |
| streamSimple | `packages/ai/src/compat.ts` | 275 |
| system prompt | `packages/coding-agent/src/core/system-prompt.ts` | 28-162 |
| AGENTS.md 发现 | `packages/coding-agent/src/core/resource-loader.ts` | 72, 126-156 |
| compaction | `packages/coding-agent/src/core/compaction/compaction.ts` | 126-136, 146-148 |
| 会话路径 | `packages/coding-agent/src/core/session-manager.ts` | 476-489 |
| SessionEntry | 同上 | 144-155 |
| forkFrom | 同上 | 1580 |
| createAgentSession | `packages/coding-agent/src/core/sdk.ts` | 171-408 |
| setDefaultStreamFn | 同上 | 36 |
| 扩展 hook 列表 | `packages/coding-agent/src/core/extensions/types.ts` | 1219-1261 |
| ToolCallEventResult | 同上 | 1087-1096 |
| jiti 加载 | `packages/coding-agent/src/core/extensions/loader.ts` | 452-463 |
| 扩展发现路径 | 同上 | 718-723 |
| 子 Agent 角色定义 | `packages/coding-agent/examples/extensions/subagent/agents.ts` | 11-19, 128-133 |
| 子 Agent spawn | `.../subagent/index.ts` | 300-350 |
| 子 Agent 结果解析 | 同上 | 353-388 |
| 并发限流 | 同上 | 219-237 |
| RPC 方法 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 394-678 |
| 「No sub-agents」声明 | `packages/coding-agent/README.md` | 498-500 |

## 附录 B：Pi 明确的 Non-Goals（引自源码/文档）

来自 `packages/coding-agent/docs/usage.md:304`：
> 不含内置 MCP、**sub-agents**、权限弹窗、plan mode、to-dos、后台 bash。

来自 `packages/agent/docs/harness.md:207-214`：
> - 外部副作用的 exactly-once
> - Provider 流恢复
> - 多写者（一个 session 一个进程）
> - 复制/副本
> - 寄存器写历史
> - 删除作为运行时特性

这些 non-goal 里，**sub-agents、权限弹窗、to-dos** 三项正是 Axon 的核心需求 —— 必须自建，且不要指望上游。

# M9 外部引擎接入：方案设计与实施计划

> 状态：**已实现，待用户验收**（2026-10-01；实现与原设计的出入见「〇、实施修订」）
> 日期：2026-10-01
> 对应架构：01 §5（适配器边界）| 依赖里程碑：M8（leaf-tools，设计评审中），可并行

---

## 〇、实施修订（实现后回填，以本节为准）

实现过程中有四处偏离了下文的原设计，原文保留以便追溯，冲突处以本节为准。

1. **不另起 `ExternalEngine` 接口，Claude 运行时直接实现 `AxonEngine`**（取代 §4.2、§4.3、§4.5 的 `wireExternal`）。
   `wire()`（`apps/desktop/src/main/host.ts`）只依赖 pi 事件的少数字段，`engine-claude.ts` 产出同形事件后，
   消息落盘、用量记账、预算熔断、并发闸门、空闲计时全部原样复用，不需要第二份记账逻辑。
   `AxonEngine` 为此加了两个可选成员：`externalEngineId`、`dispose()`（`packages/kernel/src/engine.ts`）。
   `engine-claude.ts` 不 import pi，事件类型经 `@axon/kernel` 转出，guard 白名单不变。
2. **流式看门狗对外部引擎关闭。** `runWatchdog`（10s 无流式增量即中断）会误杀跑长命令的 Claude；
   `wire()` 按 `engine.externalEngineId` 跳过它。卡死由空闲超时兜底：SDK 的 `tool_progress` 帧被映射成
   `tool_execution_update`，每个事件都会刷新空闲计时。
3. **成本差分以「进程」为基线，不是「会话」。** SDK 注释说 resume 后 `total_cost_usd` 从 transcript 存的总额接着算，
   实测（claude 2.1.92 与 2.1.179，`resume` 后首轮）是从 0 重新计。按文档实现会在重启后少记成本。
   `resumeCursor.totalCostUsd` 存的是本会话各轮增量之和。
4. **`resumeSessionAt` 只存不传。** 游标形状与 tutti 一致，但恢复时只传 `resume`：
   `resumeSessionAt` 指向的 uuid 一旦不在链上，恢复会直接失败，而只传 `resume` 已实测可恢复上下文。

另有三处原设计没写到的补充：

- `SdkMessage` 等类型在 `engine-claude.ts` 里按结构自行声明，不 import SDK 的 `.d.ts`（它牵着三个未安装的 peer 类型包）；这同时让单测能注入假 SDK。
- `verify-lazy` 里 SDK 放在 `FORBIDDEN`（不得内联）而不是 `MUST_BE_EXTERNAL`：它经动态 `import()` 加载，产物里没有顶层 import 语句可断言。
- 普通会话的工作目录是临时目录、退出即清；重启恢复前 `index.ts` 会把目录建回来，否则 Claude 在原路径下找不到会话记录。
- 探测结果加了 `runnable` 字段（已安装且 Axon 已接入），渲染层据此决定哪一行可选，不自己维护名单。

**验证记录（2026-10-01，真实 claude 2.1.92）：** 选 Claude Code 新建会话 → Write 工具触发 Axon 审批 → 允许后 `hello.txt` 落盘 →
成本 $0.223 进会话用量 → 重启 → 历史 4 条消息回放 → 追问上一轮内容，Claude 正确作答（上下文已恢复）→ 累计成本 $0.260。
自动化：`engine-claude.test.ts` 12 例 + `host.external-engine.test.ts` 5 例；全量 617 例通过。

**未做 / 遗留：** `ui-smoke` 未跑（会 pkill 用户正在运行的 dev 实例）；Windows 的 `.cmd` shim 未处理；
打包产物（`pack.mjs` 复制 SDK）未实测安装包；Codex / ACP（Hermes、Opencode）留待后续里程碑。

---

## 一、目标与范围

**用户可见能力：** 在新建会话的「执行引擎」popover 里选择 Claude Code（或 Hermes / ACP 类工具）后，会话由该工具而非 Axon 内置 pi 内核执行；工具调用审批、消息流、成本统计在 UI 里与现有会话体验一致。

**本里程碑做：**

- Claude Code 路径（`claude_sdk`，底层 `@anthropic-ai/claude-agent-sdk`）可用，因为它是本机检测到的主力工具。
- 在 `SessionExecutor` 旁新增 `externalEngine` 概念（只在新建时选，会话期间锁定，与 tutti 一致）。
- 协议扩展：`CreateSessionPayload` 新增 `engineId` 字段，`SessionRecord` 落盘这个字段。
- 消息流、工具调用、审批 HITL 接进现有 `wire()` 翻译层（或其替代）。
- 重启恢复：把 Claude Agent SDK 返回的 `providerSessionId` 存到会话记录里，重启后用 `resume` 模式重接。
- `EnginePicker` 里选了已安装的工具后「新建会话」会真正用它。

**本里程碑不做：**

- Codex / ACP 路径（OpenCode、Hermes 走 ACP 协议），留下次里程碑。
- 外部引擎的多 Agent 编排（sub-agents，外部工具里已有自己的 sub-agent 能力，与 Axon L2 打通是独立题目）。
- 模型选择从外部工具动态拉取（先硬编码 Claude Code 的常用模型列表）。
- Windows 支持（`pathToClaudeCodeExecutable` 需要处理 `.cmd` shim，不在本次范围）。

---

## 二、现状盘点

### 适配器边界（`packages/kernel/src/engine.ts`）

`AxonEngine` 接口目前有 8 个成员，其中 `setModel(Model<any>)` 和事件类型 `AgentEvent` 都是 pi 重导出类型。这意味着**任何实现 `AxonEngine` 的对象都必须能生产 pi 的内部类型**，这是外部引擎最大的阻力。

`EngineSpec` 没有 `externalSessionId` 字段，`SessionRecord` 同样没有。

### 会话创建（`apps/desktop/src/main/host.ts:617`）

`executor = 'engine'` → `planFor('engine')` → `buildRootEngine()` → `createAxonEngine()` → `wire()`。这条路完全绑在 pi 上。

### `wire()` 翻译层（`host.ts:2144`）

把 pi 的 `AgentEvent` 翻译成协议事件（`agent.message.start/delta/end`，`agent.tool.*`，`agent.turn.end`）。翻译是可以复用的，只要能提供兼容形状的事件流。

### 构建/打包

`EXTERNAL` 列表里已有 `@anthropic-ai/sdk`（并且 `verify-lazy` 把它列在 FORBIDDEN —— 不能被内联）。新增 `@anthropic-ai/claude-agent-sdk` 需要加入 `EXTERNAL`、`MUST_BE_EXTERNAL`，并在 `pack.mjs` 里复制其依赖树。这是打包上最重的工作。

---

## 三、设计依据

1. **适配器边界的定位**（`docs/01-架构决策-方案B.md §5`）：「pi 的 Agent 类型不得泄漏到编排层（风险 A 保险丝）」—— 外部引擎恰恰是这个边界存在的理由，可以在不改 L2 逻辑的前提下换掉底层。

2. **tutti 的做法**（`packages/agent/daemon/providerregistry/types.go:14`）：三种 runtime（`codex_app_server`、`standard_acp`、`claude_sdk`）全部实现同一个 `Adapter` 接口，主要方法是 `Start`、`Exec`、`Cancel`、`Resume`、`Close`。Axon 的 `AxonEngine` 接口语义上等价，但绑了 pi 类型——需要一个 pi-free 的外部引擎变体接口。

3. **Claude Agent SDK 的调用方式**（`packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts:1030`）：`query({ cwd, pathToClaudeCodeExecutable, includePartialMessages: true, canUseTool: …, sessionId/resume: …, model, permissionMode, settings: … })`，生产 `SDKMessage` 的异步迭代。Axon 主进程可以直接在 TypeScript 里调（不需要 tutti 那套 sidecar/IPC 分层，因为 Axon 本来就是单进程 TypeScript）。

4. **审批路由**（`host.ts:…`，`approval.ts:157`）：`ApprovalBroker.gate(path, toolName, args)` 已有异步等待用户回应的机制，Claude SDK 的 `canUseTool` 回调刚好可以把这个 `gate()` Promise 穿进去，与现有 HITL 完全复用。

5. **重启恢复**（`host.restart.test.ts:274`）：目前恢复方式是把 `MessageLike[]` 重新喂给新的 pi engine。外部引擎不能这样恢复——需要一个 `providerSessionId`，传给 `resume` 参数，让 Claude Code 自己重接上下文。这要求 `SessionRecord` 新增字段（`docs/02 §4` 的风险 A 保险丝其实是给这个改动留口子的）。

6. **verify-lazy 里的 FORBIDDEN 规则**（`scripts/verify-lazy-loading.mjs`）：`@anthropic-ai/sdk` 已在列，`@anthropic-ai/claude-agent-sdk` 也需要以 external 形式加载（dynamic `import()`），否则内联进 `main.mjs` 会触发 FORBIDDEN 检查并破坏 pi 懒加载的保险丝。

---

## 四、总体设计

### 4.1 数据模型扩展

```ts
// packages/protocol/src/session.ts
// SessionExecutor 不动 —— 会话的「协作模式」(engine/team/adhoc) 与「运行时」正交
// 新增字段：
export interface CreateSessionPayload {
  // ... 现有字段 ...
  /** 若指定，用这个外部工具替代内置 pi 引擎；不指定 = 继续用 pi */
  engineId?: ExternalEngineId;  // 'claude' | 'hermes' | ... 复用 AgentToolId
}

export interface SessionRecord {
  // ... 现有字段 ...
  engineId?: ExternalEngineId;          // 落盘，告诉恢复路径用哪个 runtime
  externalSessionId?: string;           // 外部工具返回的 providerSessionId，用于 resume
}
```

`SessionRecord` 写盘在 `session-files.ts` 的 `StoredSessionFile`，`schemaVersion` 随之递增。

### 4.2 外部引擎接口（pi-free）

新增文件 `apps/desktop/src/main/external-engine.ts`：

```ts
// 与 AxonEngine 同构，但不依赖任何 pi 类型
export interface ExternalEngineEvent { /* 见 4.3 */ }
export interface ExternalEngine {
  start(): Promise<string>;         // 返回 providerSessionId
  resume(id: string): Promise<void>;
  prompt(text: string): Promise<void>;
  abort(): void;
  subscribe(listener: (e: ExternalEngineEvent) => void): () => void;
  messages(): MessageLike[];        // 用于回放，外部引擎可返回空数组（sdk 自管历史）
}
```

### 4.3 事件形状

`ExternalEngineEvent` 是协议事件的前一步，形状对齐 `wire()` 的翻译入参：

```ts
type ExternalEngineEvent =
  | { kind: 'message_start' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'message_end'; message: MessageLike }
  | { kind: 'tool_start'; callId: string; tool: string; args: unknown }
  | { kind: 'tool_update'; callId: string; chunk: string }
  | { kind: 'tool_end'; callId: string; ok: boolean; result?: unknown; error?: string }
  | { kind: 'turn_end'; usage: { inputTokens: number; outputTokens: number; costUsd: number } }
  | { kind: 'error'; message: string };
```

### 4.4 Claude Code 运行时实现

新增文件 `apps/desktop/src/main/engine-claude.ts`，实现 `ExternalEngine`：

核心：用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 或其 `ClaudeCode` 类（取决于 SDK 版本 API），把 SDK message 流翻译成 `ExternalEngineEvent`。

关键点：
- `canUseTool` 回调里调 `approvalGate(path, tool, args)` —— 这是唯一需要从外部注入的依赖，构造时以函数形式传入。
- `pathToClaudeCodeExecutable` 从 `AgentToolsRegistry.snapshot().tools` 取，如果 claude 未安装则拒绝创建。
- SDK 消息类型映射（对齐 tutti `messageRouter.ts` 的做法）：
  - `assistant` content block `text` → `text_delta`
  - `assistant` content block `thinking` → `thinking_delta`
  - `tool_use` → `tool_start`，`tool_result` → `tool_end`
  - `result` → `turn_end`（usage 从 result.usage 读）
  - `system` 错误 → `error`

### 4.5 与 host.ts 的装配

在 `buildRootEngine()` 里加一个分支：

```ts
if (record.engineId) {
  const ext = await createClaudeEngine({
    cwd, sessionId: record.externalSessionId,
    approvalGate: (tool, args) => this.approvals.gate(rootPath, tool, args),
    claudePath: agentToolsRegistry.snapshot().tools.find(t => t.id === 'claude')?.path ?? null,
    model: lead.role.model?.id,
  });
  const id = await ext.start();   // 或 ext.resume(record.externalSessionId)
  record.externalSessionId = id;  // 落盘
  this.wireExternal(rootPath, ext);
} else {
  // 现有 pi 路径不变
}
```

`wireExternal(path, ext)` 是 `wire()` 的外部引擎版本，把 `ExternalEngineEvent` 翻译成相同的协议事件，逻辑几乎一致。

### 4.6 构建/打包

- `apps/desktop/scripts/build.mjs`：`@anthropic-ai/claude-agent-sdk` 加入 `EXTERNAL` 列表（不内联）。
- `scripts/verify-lazy-loading.mjs`：加入 `MUST_BE_EXTERNAL`；它的 transitive dep 里如果有 `@anthropic-ai/sdk`，要确认不被内联（FORBIDDEN 检查已在）。
- `scripts/pack.mjs`：在 `PI_PACKAGES` 旁边复制 SDK 及其依赖到 `dist-staging/node_modules`。
- `scripts/check-bun-only.mjs` 的 pi import 白名单**不需要改**，因为新文件不 import pi。

### 4.7 EnginePicker 行为变化

目前「已安装」的工具整行置灰。改成：
- 已安装且本里程碑支持 → 可点击，点击后触发意图 `setEngineId(id)`（新增 store 意图）。
- 已安装但未接入（Codex/Hermes）→ 置灰，注释「下一版本支持」。
- 未安装 → 置灰，提示安装方式（todo：之后里程碑）。

`CreateSessionPayload` 带上 `engineId`，S0/S2 的 `start()` 把它传进去。

---

## 五、关键流程

### 新建会话（选了 Claude Code）

1. 用户在 EnginePicker 选 Claude Code → store 里设 `pendingEngineId = 'claude'`。
2. 发送任务 → `createSession({ ..., engineId: 'claude', executor: 'engine' })`。
3. 主进程收到 → `buildRootEngine` 走外部引擎分支 → `createClaudeEngine()` → `ext.start()` → 得到 `providerSessionId`。
4. `providerSessionId` 写进 `SessionRecord.externalSessionId` → 落盘。
5. `wireExternal(rootPath, ext)` → SDK 流翻译 → 渲染层照常收 `agent.message.*`、`agent.tool.*` 事件。

### 工具调用审批

1. Claude Code 在执行工具前回调 `canUseTool(tool, input, options)`。
2. 实现里 `await approvalGate(tool, args)` → `ApprovalBroker.gate()` → 发 `approval.request` 事件 → 渲染层弹框。
3. 用户点「允许/拒绝」→ `ApprovalBroker.respond()` → gate 解析 → `canUseTool` 返回 `{ behavior: 'allow' | 'deny' }`。

### 重启恢复

1. `restoreEngines()` 读到 `record.engineId = 'claude'` → 走外部引擎分支。
2. `record.externalSessionId` 非空 → `ext.resume(externalSessionId)`（SDK `{ resume: id }` 模式）。
3. SDK 重接上下文，继续流式输出，`wireExternal` 同样工作。
4. 若 `externalSessionId` 为空（意外情况）→ 记一条 note「无法恢复外部引擎会话，请重新发送」，状态标 `failed`。

---

## 六、边界情况与风险

| 情况 | 处理 |
|---|---|
| claude 可执行文件被用户卸载 | `createClaudeEngine` 检查 `AgentToolsRegistry` 里的 `installed` 标志，未安装时直接向渲染层返回错误，不创建会话 |
| SDK `resume` 失败（providerSessionId 过期） | 捕获异常，写 note，状态标 `failed`，让用户手动新建会话 |
| 外部引擎会话里用户再点「叫人」（escalate） | 暂不支持（外部引擎 + 团队模式的交集还没设计），escalate 按钮在外部引擎会话里禁用 |
| `canUseTool` 超时（用户长时间不回应） | ApprovalBroker 已有超时/拒绝逻辑，照常工作 |
| SDK 版本升级（`@anthropic-ai/claude-agent-sdk` API 变化） | SDK 包版本在 `package.json` 里 pin 住（与 pi 同一条纪律），升级需手动测试 |
| verify-lazy 误报（SDK 依赖链带入 `@anthropic-ai/sdk`） | 如果 SDK 本身已 bundle，则无问题；否则要确认 sdk 包也加入 EXTERNAL。需要在第一步 build 时确认。 |
| `tool_execution_update` 事件缺失 | pi wire() 本身也忽略了 `tool_execution_update`，外部引擎版本同样忽略，不是回退 |
| S2 的 ModelPicker 在外部引擎模式下 | 外部引擎不走 Axon 的模型选择器（provider.models）。M9 里 picker 在外部引擎会话里隐藏，之后单独做 per-engine 模型列表。 |

**风险 R1（高）：SDK 打包复杂度。** `@anthropic-ai/claude-agent-sdk` 附带 Claude Code 的 CLI 二进制，包体很大，依赖闭包未知。pack.mjs 可能需要较多工作。**缓解：** 第一步先只做 external 声明和 verify-lazy，用 `import('@anthropic-ai/claude-agent-sdk')` 动态加载，看构建是否通过，再处理 pack。

**风险 R2（中）：AxonEngine 接口泄漏 pi 类型。** `setModel(Model<any>)` 现在没人调到外部引擎，可以在 `wireExternal` 里忽略。但如果 host 的其他代码路径（如 `agent.setModel` 命令）走到了外部引擎，会出错。**缓解：** 外部引擎不注册进 `registry.attachEngine`（它接受 `AxonEngine`），而是单独存一个 `Map<AgentPath, ExternalEngine>`，host 路由命令时按这个 map 判断。

**风险 R3（低）：M8 leaf-tools 并行开发冲突。** M8 改 `createLeafTools`；外部引擎不用 leaf-tools，两者文件不重叠，可以并行，但 session-files.ts 的 `schemaVersion` 两个里程碑都要递增，需要约定好谁来改。

---

## 七、实施计划

### 阶段 0：协议与数据模型（主线做，约 1 天）

1. `packages/protocol/src/session.ts`：`CreateSessionPayload` 加 `engineId?: AgentToolId`；`SessionRecord` 加 `engineId?` 和 `externalSessionId?`；`schemaVersion` +1。
2. `apps/desktop/src/main/session-files.ts`：`StoredSessionFile` 同步更新（新字段可选，旧数据兼容）。
3. 协议扩展不影响现有流程（字段可选），`bun run typecheck && bun run test` 保持绿。

**怎么验证：** 创建一个不带 `engineId` 的会话，落盘文件里不出现新字段；单测里构造带 `engineId` 的 payload，序列化/反序列化后字段保留。

### 阶段 1：构建保险丝（主线做，约 0.5 天）

4. 安装 SDK：`bun add @anthropic-ai/claude-agent-sdk`（pin 到当前最新版本）。
5. `scripts/build.mjs`：SDK 加入 `EXTERNAL`。
6. `scripts/verify-lazy-loading.mjs`：加入 `MUST_BE_EXTERNAL`。
7. `scripts/pack.mjs`：复制 SDK 包到 `dist-staging/node_modules`（与 pi-agent-core 同方式）。
8. `bun run build:desktop && bun run verify-lazy` 通过。

**怎么验证：** `verify-lazy` 不报新的 FORBIDDEN 命中；`dist/main.mjs` 里搜不到 claude-agent-sdk 的内联代码。

### 阶段 2：外部引擎接口与 Claude 实现（主线做，约 2 天）

9. 新增 `apps/desktop/src/main/external-engine.ts`：`ExternalEngine` 接口 + `ExternalEngineEvent` 类型（§4.2、§4.3）。
10. 新增 `apps/desktop/src/main/engine-claude.ts`：`createClaudeEngine()` 实现（§4.4）。
11. 新增 `apps/desktop/src/main/engine-claude.test.ts`：用 `scriptedSource` 风格的 mock SDK 跑：文本流、工具调用、canUseTool approve/deny、turn_end usage。

**怎么验证：** `bun run test` 里 engine-claude 单测全绿，不需要真的 claude 可执行文件。

### 阶段 3：host 接线（主线做，约 1.5 天）

12. `host.ts`：`buildRootEngine` 加外部引擎分支；新增 `wireExternal()`；`restoreEngines()` 加 resume 分支；`execute('agent.setModel')` 在外部引擎路径下 no-op（或透传给 SDK 的 `apply_settings`）；escalate 在外部引擎下拒绝。
13. `host.ts`：新增 `externalEngines: Map<AgentPath, ExternalEngine>` 字段，命令路由时判断。

**怎么验证：** `bun run test`（host.test.ts / host.session.test.ts）补一个「外部引擎会话走 wireExternal」的单测，用注入的 mock ExternalEngine。

### 阶段 4：主进程 IPC 接线（主线做，约 0.5 天）

14. `apps/desktop/src/main/index.ts`：`session.create` 已经在这里做 `attachments` 剥离；加同样的 `engineId` 传递（protocol 不认识 engineId，但 host 认识）。

**怎么验证：** `bun run guard && bun run typecheck` 通过。

### 阶段 5：渲染层与 EnginePicker（主线做，约 1 天）

15. `apps/desktop/src/renderer/state/store.tsx`：store 新增 `pendingEngineId: AgentToolId | null` 状态和 `setEngineId(id)` 意图；`createSession` 传入 `engineId`；S2 的 ModelPicker 在外部引擎会话（`current.record.engineId != null`）时隐藏。
16. `apps/desktop/src/renderer/components/EnginePicker.tsx`：已安装且支持（`id === 'claude'`）的工具变为可点击，点击调 `setEngineId`；按钮显示当前选中的引擎名。
17. S0 的 `start()` 把 `pendingEngineId` 带进 `createSession`。

**怎么验证：** `bun run dev`，在 EnginePicker 里选 Claude Code，输入任务，观察消息流是真实的 claude 输出而不是 pi faux。

### 阶段 6：质量门（主线做，约 0.5 天）

18. `bun run guard && bun run typecheck && bun run test`（目标：600+ 全绿，新增约 15 个单测）。
19. `bun run build:desktop && bun run verify-lazy`。
20. `bun run ui-smoke`（ui-smoke 里不测试外部引擎路径，但需要保证冒烟脚本里 `AXON_PROVIDER=faux` 路径不受影响）。
21. 手工验证（`bun run dev`）：新建 Claude Code 会话 → 消息流 → 工具调用 + 审批 → 重启 → 恢复继续。

---

## 八、测试策略

| 层 | 什么测 | 用什么 |
|---|---|---|
| 单元（engine-claude.test.ts） | SDK 消息映射、canUseTool approve/deny、turn_end usage 转换、resume 参数构造 | mock SDK（注入假的 query 迭代器） |
| 单元（host.session.test.ts 新增） | buildRootEngine 走外部分支、wireExternal 产生正确协议事件、restoreEngines resume 分支 | mock ExternalEngine（stub start/resume/subscribe） |
| 集成（bun run dev 手工） | 真实 claude 可执行文件运行一次完整会话、重启恢复 | 真机 |
| 回归（现有 600 测试） | pi 路径不受影响 | 照常 |

---

## 九、验收标准（可勾选）

- [ ] `bun run check` 全绿（guard / typecheck / test / build / verify-lazy）
- [ ] 在 `bun run dev` 里，选 Claude Code 新建会话，能看到真实流式输出
- [ ] 工具调用（bash / read_file 等）触发 HITL 审批弹框，approve 后工具执行，结果出现在消息流里
- [ ] 应用重启后，用 `resume` 模式恢复 Claude Code 会话（检查：重启后状态变 idle，再次发消息能得到回应）
- [ ] 未安装 claude 时选择 Claude Code，UI 给出明确错误，不创建残缺会话
- [ ] 不带 `engineId` 的会话走 pi 路径，行为与 M8 前完全一致（回归）
- [ ] `ui-smoke` 全绿（冒烟不测外部引擎，但 faux 路径不能被破坏）

---

## 十、文档同步

1. 完成后在 `docs/03-实施框架与里程碑.md §1` 加入 M9 行，状态标 ✅。
2. 在 `docs/01-架构决策-方案B.md §5` 补一句：「外部引擎通过 `ExternalEngine` 接口接入，不实现 `AxonEngine`，独立注册在 `host.externalEngines` Map 里，以保持 pi 类型不泄漏的不变量。」
3. 本文档状态改为「已完成」。

---

## 需要用户拍板的决策

**D-M9-1：优先 Claude Code（`claude_sdk`）。** ✅ 拍板（2026-10-01）

**D-M9-2：`externalSessionId` 的持久化策略。**
Claude Code 的 `providerSessionId` 是 SDK 管理的；当 SDK 版本升级后，旧的 id 是否还能 resume 是未知的。是否要在会话记录里存完整的 `resumeCursor`（`{ kind, version, resume, resumeSessionAt, turnCount }`，如 tutti 所做），还是只存一个 sessionId（更简单但更脆弱）？**拍板（2026-10-01）：完整 resumeCursor（`{ kind, version, resume, resumeSessionAt, turnCount }`）。** 参照 tutti 的实现。

**D-M9-3：外部引擎会话的成本计算。**
Claude Code 有自己的计费，Axon 的 `BudgetGuard` 只有当 API 成本从 turn_end 的 usage 读到时才能工作。Claude Code 的成本是否要统计进 Axon 的预算面板？`result.usage.total_cost_usd` 可以读到。**拍板（2026-10-01）：成本接入预算面板，展示 + 熔断。** `result.usage.total_cost_usd` 读到后走现有 `budget.record()` 路径。


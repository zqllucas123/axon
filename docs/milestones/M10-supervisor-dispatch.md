# M10 主管驱动的动态任务调度与执行透明化

> 状态：**已实施（2026-10-01/02）** —— 阶段 A~D 全部落地并通过自动化门；阶段 E 的手工验收（6 条）仍待用户过目，见 §十一 实施回填
> 日期：2026-10-01
> 对应架构：01 §5 适配器边界、M3 编排内核 | 依赖里程碑：M9（外部引擎接入）

---

## 〇、设计理念（来自用户）

截图引用的产品哲学：**Conversation 是交互方式，Task 才是真正持续存在的执行状态。**

用户只和主管 Agent 对齐——你想做什么、进展如何、哪里需要拍板。
团队成员怎么执行、是新建 session 还是复用同一 session，这些是主管 Agent 的内部调度决策，用户不需要关心。
但为了透明度，用户可以随时深入看某个成员的执行状态。

**这个理念对 Axon 的具体含义：**
- 用户的入口永远是「给主管发一条消息」
- 主管 Agent 动态决定「把这件事派给谁、用什么引擎、在哪个目录下执行」
- 每个成员的执行在自己的隔离 session 里进行（有独立的消息历史、用量、审批记录）
- 成员 session 由主管自动生命周期管理（创建、等待、回收结果）
- 用户可以从主管 session 的「成员视图」钻进任意成员 session 看详情

---

## 一、目标与范围

**用户可见能力：**
1. 主管 Agent 可以在执行过程中动态派出成员，并指定成员的 `cwd`、`model`、`engineId`（外部引擎）
2. 每个成员在自己的隔离 session 里执行，有独立的消息历史和用量
3. 主管 session 的 UI 里能看到「当前派出了哪些成员、状态如何」
4. 用户点进任意成员 session 能看到完整的执行对话
5. 成员需要用户拍板时，审批请求浮到主管 session 的收件箱

**明确不做：**
- 成员 session 之间的横向通信（成员 A 把结果直接传给成员 B，由主管中转）
- 主管 session 的「暂停/继续」语义（按中断处理）
- 跨用户的成员 session 共享
- 成员 session 的嵌套子团队（成员本身又带子成员）

---

## 二、现状盘点

### 现有编排工具（`apps/desktop/src/main/orchestrator.ts`）

| 工具 | 语义 | 限制 |
|---|---|---|
| `agent` | spawn 子节点（同一 session 树） | 只接 role/task/forkMode，不能指定 cwd/engineId |
| `agent_wait` | 主管挂起等子节点终态 | 只能等同 session 树的节点 |
| `agent_check` | 读子节点快照 | 同上 |
| `agent_message` | 给子节点 steer | 同上 |
| `agent_resume` | 重跑终态子节点 | 同上 |
| `agent_interrupt` | 中断子节点 | 同上 |

**现有模型的核心约束：** 所有成员都在同一 session 树里（`/<sessionId>/…`），共享同一个 cwd、同一个预算视图。主管没有办法让成员「在另一个 session 里独立执行」。

### 缺失的能力

1. **主管发出任务 → 成员在隔离 session 执行** 这条路径不存在
2. **`agent` 工具无法传 cwd / engineId**，所以 M9 的团队成员引擎虽然能配置但主管没法动态指定
3. **成员 session 的生命周期管理**（自动创建、结果回收、自动关闭）没有
4. **透明化 UI**：S2 只显示当前 session 树的成员状态，没有「成员 session 列表」视图

---

## 三、设计依据

1. **截图产品哲学**：Conversation 是交互方式，Task 是持续执行状态。主管管理 Task，用户管理 Conversation。
2. **M9 外部引擎**：成员可能跑在不同的外部引擎上（Claude Code、Hermes），这些引擎有自己的 session id 和上下文，必须在隔离的 Axon session 里才能保持各自的游标和恢复能力。
3. **现有编排工具**：`agent` + `agent_wait` 对已经打通了「主管派活 → 等结果」的基本回路，M10 是在这个基础上加新语义，不是重写。
4. **审批穿透**：`ApprovalBroker` 的穿透链（父代批后代）在跨 session 场景下需要调整：子 session 的审批应该穿透到父 session（主管），而不是在子 session 里孤立等待。

---

## 四、总体设计

### 4.1 新概念：SubSession（子任务 session）

```
主管 Session (S_lead)
    └── 成员 SubSession (S_worker_1)   ← 由主管的 task_spawn 工具创建
    └── 成员 SubSession (S_worker_2)   ← 有独立 cwd、engineId、消息历史
```

`SubSession` 不是新的协议类型，它就是普通的 `SessionRecord`，只是多了两个字段：
```ts
// SessionRecord 新增（对普通会话为 undefined）
parentSessionId?: string;   // 由哪个会话的主管 Agent 派生
parentAgentPath?: AgentPath; // 派生它的那个主管 Agent 的路径（用于审批穿透）
```

主管 session 通过 `SessionRecord.childSessionIds: string[]` 知道自己派了哪些子 session（反向索引）。

### 4.2 新编排工具：`task_spawn` 和 `task_wait`

`task_spawn`（替代或扩展现有 `agent` 工具）：

```ts
{
  role: string;        // Agent 角色
  task: string;        // 任务描述（成员的 initialPrompt）
  cwd?: string;        // 工作目录；缺省继承主管 session 的 cwd
  engineId?: string;   // 外部引擎（缺省 Axon 内置）
  model?: string;      // 模型覆写
  context?: string;    // 注入到成员 session 的额外上下文（主管摘要）
}
```

返回：`{ sessionId: string; path: AgentPath }` ——子 session id 和根路径。

`task_wait`（替代或扩展现有 `agent_wait`）：接受 session id 数组，主管挂起直到所有子 session 终态（done/failed/interrupted）。

`task_result`（新）：读取子 session 的最终输出（最后一条助手消息）。

### 4.3 与现有工具的关系

现有 `agent` / `agent_wait` 保留，用于同 session 树的子节点（轻量级调度）。
新 `task_spawn` / `task_wait` 用于跨 session 的重量级任务分发。

主管可以混用两种方式：短暂的协作（问一个问题、快速转包）用 `agent`；需要隔离上下文、独立记账、外部引擎的用 `task_spawn`。

### 4.4 审批穿透跨 session

子 session 里的审批请求会带上 `parentSessionId`，Axon 把它投递到父 session 的审批队列（`ApprovalBroker` 需要支持跨 session 转发）。用户在主管 session 的收件箱里看到「成员 X 的会话请求批准 Bash 命令」。

### 4.5 透明化 UI（S2 扩展）

主管 session 的 S2 界面加一个「任务看板」侧栏：
- 列出所有子 session，每个显示：成员名、状态、最后一条输出摘要、成本
- 点进去跳转到子 session 的 S2 详情（只读快照，不把用户焦点切过去）
- 有待批审批的子 session 加红点

子 session 的 S2 也有「回到主管 session」的入口（面包屑）。

---

## 五、关键流程

### 主管发任务 → 成员执行 → 结果回收

```
用户 → "帮我做这个功能"
主管 Agent:
  1. task_spawn({ role: '架构师', task: '设计接口', cwd: '/prj' })
     → 创建 SubSession S_arch，返回 sessionId
  2. task_spawn({ role: '实现', task: '写代码', engineId: 'claude', cwd: '/prj' })
     → 创建 SubSession S_impl，Claude Code 执行
  3. task_wait([S_arch, S_impl])
     → 主管挂起（suspended），让出并发额度
  4. 两个 SubSession 各自执行（有独立审批、独立记账）
  5. 审批请求穿透到主管 session 收件箱
  6. 两者都 done → 主管恢复
  7. task_result(S_arch) + task_result(S_impl) → 整合结果告知用户
```

### 重启恢复

主管 session 恢复时，检查 `childSessionIds`，对每个还在 running/waiting 的子 session 也恢复（按已有的 `restoreEngines` 路径）。主管继续等待子 session 结果（`task_wait` 重接 wait 图）。

---

## 六、边界情况与风险

| 情况 | 处理 |
|---|---|
| 主管被中断时有子 session 正在跑 | 子 session 继续跑（不级联中断）；用户重启主管后可以继续 task_wait |
| 子 session 失败 | `task_wait` 返回 `{ sessionId, status: 'failed', error }`;主管决定重试还是告知用户 |
| 子 session 里也想 task_spawn（嵌套） | 本里程碑明确不做；`task_spawn` 在子 session 里调用时返回错误「不支持嵌套任务」 |
| 审批穿透跨 session 时用户同时有多个主管 session 的审批 | 每个审批带 sessionId 标签，用户能分辨；不合并 |
| 子 session 数量失控（主管一次派几十个） | `task_spawn` 在主管的并发限额里计数；达到上限时排队，不直接报错 |
| 子 session 的 cwd 不存在 | 同 M9 的处理：在首次 prompt 时创建目录 |

**风险 R1（高）：审批穿透跨 session 的实现复杂度。** `ApprovalBroker` 目前按 session 路由，跨 session 转发需要在 host 层加一个「父 session 的 broker 代理子 session 的请求」的机制。建议阶段 1 先实现子 session 独立审批（不穿透），阶段 2 再加穿透。

**风险 R2（中）：wait 图跨 session 后的并发调度。** 现有的 `waits` 图是 session 内的路径 → 路径映射；跨 session 的等待要求主管 session 能挂起等外部 session 的状态变化，需要新增一个 session-level 的 wait 订阅机制。

---

## 七、实施计划

### 阶段 A：协议 + SubSession 数据模型（约 1 天）

1. `packages/protocol/src/session.ts`：`SessionRecord` 加 `parentSessionId?`、`parentAgentPath?`、`childSessionIds?: string[]`；`SESSION_SCHEMA_VERSION` 递增。
2. `packages/protocol/src/ipc.ts`：加 `subsession.list`（查主管的子 session 列表）命令；加 `subsession.created`、`subsession.changed` 事件。
3. `apps/desktop/src/main/session-files.ts`：落盘兼容新字段。

**验证：** 单测序列化/反序列化，旧数据（无新字段）正常读出。

### 阶段 B：主进程 task_spawn / task_wait（约 2 天）

4. `apps/desktop/src/main/orchestrator.ts`：新增 `task_spawn`、`task_wait`、`task_result` 三个工具；`task_spawn` 通过 `OrchestrationDriver` 回调创建新 session。
5. `apps/desktop/src/main/host.ts`：`OrchestrationDriver` 加 `createSubSession(spec)` 和 `waitSubSession(ids)` 回调；实现跨 session wait 订阅（`subSessionWaits` map）；子 session 终态时通知等待的主管 session。
6. `apps/desktop/src/main/index.ts`：`subsession.list` IPC 命令接线。

**验证：** 新建一个带 `task_spawn` 的主管 session，用 faux provider 跑，验证子 session 创建、主管挂起等待、子 session 完成后主管恢复的全链路。单测 8 例以上。

### 阶段 C：审批穿透（约 1 天）

7. `apps/desktop/src/main/approval.ts`：`gate()` 支持跨 session 转发（子 session 的审批发到父 session 的 broker）。
8. `packages/protocol/src/ipc.ts`：`approval.request` 事件加 `originSessionId` 字段，渲染层能区分来源。

**验证：** 子 session 发出审批请求，主管 session 的收件箱里能看到，回应后子 session 正常继续。

### 阶段 D：透明化 UI（约 1.5 天）

9. `apps/desktop/src/renderer/components/S2Session.tsx`：加「子任务」折叠区，列出子 session 及其状态。
10. 点进子 session 跳转到其 S2 详情。
11. 子 session 的 S2 顶部加「主管：<session 标题>」面包屑。
12. `apps/desktop/src/renderer/state/store.tsx`：订阅 `subsession.created`/`subsession.changed`，维护子 session 快照。

**验证：** `bun run dev`，手工跑一个多成员团队 session，验证子任务列表实时更新、可以钻入子 session 查看。

### 阶段 E：质量门（约 0.5 天）

13. `bun run guard && bun run typecheck && bun run test && bun run build:desktop && bun run verify-lazy`
14. 手工验收：完整跑一次「主管派两个成员、一个外部引擎一个内置、有审批请求、重启恢复」的场景。

---

## 八、测试策略

| 层 | 内容 | 方式 |
|---|---|---|
| 单元 | `task_spawn` 工具体：调用 driver、返回 sessionId | mock driver |
| 单元 | `task_wait` 跨 session：主管挂起、子 session 终态解挂 | mock host + SessionStore |
| 单元 | 审批穿透：子 session 的 gate() 发到父 session | mock broker |
| 集成 | 主管 + 两个子 session 的完整生命周期 | faux provider，真实 host |
| 集成 | 重启恢复：子 session 重启后主管继续等待 | 真实磁盘 |

---

## 九、验收标准（可勾选）

- [ ] `bun run check` 全绿
- [ ] `bun run dev`：主管可以通过 `task_spawn` 创建子 session，子 session 在列表里可见
- [ ] 子 session 里有审批请求时，主管 session 的收件箱里能看到（带来源标识）
- [ ] 重启 Axon 后，主管 session 继续等待子 session 结果，最终收到正确输出
- [ ] 点进子 session 能看到成员的完整对话历史
- [ ] 不带 `task_spawn` 的普通会话行为与之前完全一致（回归）

---

## 十、需要用户拍板的决策

**D-M10-1：✅ 拍板（2026-10-01）：保留两个工具。** `agent`（同 session 树，轻量）/ `task_spawn`（跨 session，隔离）。两种调度模式语义不同，不压缩到同一个参数里。

**D-M10-2：✅ 拍板（2026-10-01）：全部可见，折叠控制。** 已完成的子 session 历史本身有价值，用户随时能追溯主管派了什么任务、结果是什么。

**D-M10-3：✅ 拍板（2026-10-01）：分阶段，阶段 B 子 session 独立审批，阶段 C 再穿透到主管收件箱。**

---

## 十一、实施回填（2026-10-10 补齐）

> 落地时没有回填本文档，状态一直停在「设计评审中」。此处只补可复核的客观项。

| 项 | 值 |
|---|---|
| 落地 commit | `e35c3e1`（阶段 A/B：协议 + 跨 session 派发）、`a19cc66`（阶段 C/D：审批穿透 + 子任务透明化 UI） |
| 工具落点 | `apps/desktop/src/main/orchestrator.ts:137`（`task_spawn`）、`:138`（`task_wait`）；后端在 `apps/desktop/src/main/host.ts:2248`（建子 session）与 `:2295`（等终态） |
| 测试 | `apps/desktop/src/main/host.subsession.test.ts`（8 例）；全量 681 例在 2026-10-10 复跑全绿 |
| 拍板落实 | D-M10-1 两个工具并存 ✅；D-M10-2 子 session 全部可见 ✅；D-M10-3 分阶段（先独立审批、后穿透）✅ |
| 已知限制 | 子 session 不允许再次嵌套 `task_spawn`（`apps/desktop/src/main/host.ts:2272` throw）——与「嵌套禁止」决策一致 |

**仍未做的（阶段 E 的手工验收 6 条，无人代跑）**：主管用 `task_spawn` 建子 session 并在列表可见 /
子 session 审批出现在主管收件箱 / **重启后主管继续等子 session 结果** / 点进子 session 看完整对话 /
不带 `task_spawn` 的普通会话回归。置 ✅ 需要用户点过。

# M11 主管 Agent 能力体系

> 状态：**已实施（2026-10-02）** —— Phase 1~4 全部落地，含一条端到端验收测试；手工验收（3 人团队跑通全流程）仍待用户过目，见 §十 实施回填
> 依赖里程碑：M10（跨 session 任务派发）、M3（编排内核）、M4（协作账本）
> 负责人：自用

---

## 〇、背景与目标

M10 打通了主管 Agent 动态派发子任务、等待结果、透明化给用户看的全链路。
但主管的「智慧」还只靠提示词约束，缺少结构化的工具支撑和行为框架。

本里程碑补齐主管 Agent 的五个能力维度：

| 编号 | 维度 | 核心价值 | 当前缺口 |
|---|---|---|---|
| C1 | **对齐**（Align） | 执行前和执行中和用户对齐预期 | `question.request` 事件没有触发路径 |
| C2 | **分解**（Decompose） | 把目标切成可验收的子任务 | 完全靠提示词，缺结构化约束 |
| C3 | **调度**（Dispatch） | 正确选用 `agent` vs `task_spawn` | 主管没有选择框架 |
| C4 | **进度感知**（Monitor） | 主动发现成员卡住 | 没有 idle 通知机制 |
| C5 | **交付**（Deliver） | 验收结果、汇报进展 | 缺失验收闸门和增量汇报 |

---

## 一、设计决策（已拍板）

### D-M11-1：主动巡检机制
**选 C（宿主 push 通知）**：宿主在成员空闲超过阈值时自动向主管发一条 steer 消息，主管不需要写轮询逻辑。实现路径：`setStatus` 进 `done/failed/interrupted` 时，检查父路径是否是主管 session 的根，是就 steer。

### D-M11-2：系统提示结构
**选 C（自然语言 + 动态任务板）**：`rosterPrompt` 扩展为「任务上下文摘要」，每轮注入最新成员状态。主管不需要记忆哪些成员已完成。

### D-M11-3：`ask_user` 工具是否阻塞主管执行
**是**：主管调用 `ask_user` 后进入 `waiting` 状态（退位让额），用户回答后恢复 `running`。与审批机制复用同一条 `question.respond` 命令。

### D-M11-4：`ask_user` 的超时行为
**超时不自动拒绝**：主管会话是长期任务，用户可能隔天回来继续。超时只做日志，不中断主管。配置 `approvalTimeoutMs` 对 `ask_user` 无效（`question.request` 与 `approval.request` 超时策略独立）。

---

## 二、新工具：ask_user

### 2.1 工具定义

```ts
ask_user({
  question: string;       // 向用户提出的问题（简洁、可直接行动）
  context?: string;       // 为什么要问这个（可选，帮用户理解背景）
  options?: string[];     // 建议选项（可选，最多 4 个；用户也可以自由回答）
}): string                // 用户的回答文本
```

适用场景：
- 任务开始前澄清关键预期（「这个功能需要兼容 Safari 吗？」）
- 执行中遇到歧义的技术决策（「发现两种架构方案，哪种更符合你的预期？」）
- 遇到风险点请用户拍板（「将覆盖现有数据库迁移文件，确认继续？」）

不适用场景：
- 能从上下文推断答案的（主管自己决策）
- 纯粹执行层的问题（把工具执行交给成员，成员触发审批）
- 礼貌性确认（「你好，我现在开始了」——不要问）

### 2.2 实现路径

```
主管调用 ask_user
  → host 调用 QuestionBroker.ask(origin, message, options?)
    → 发 question.request 事件（渲染层收到，在收件箱显示）
    → 主管进入 waiting 状态（beginWait 空集合，退位让额）
  → 用户在收件箱回答
    → question.respond IPC 命令
      → QuestionBroker.respond(requestId, answer)
        → resolve Promise，answer 回灌给模型
        → endWait，主管恢复 running
```

### 2.3 与审批的区别

| | `ask_user`（问用户） | `approval.request`（批工具） |
|---|---|---|
| 触发方 | 主管主动 | 工具执行前自动 |
| 内容 | 任意问题 | 特定工具的参数 |
| 回答形式 | 自由文本 | 允许/拒绝 |
| 超时行为 | 不超时 | 超时按拒绝 |
| 渲染层入口 | 收件箱 | 收件箱（同位置） |

---

## 三、动态任务板（rosterPrompt 扩展）

### 3.1 现有 rosterPrompt 的问题

当前只在建会话时注入一次（静态），主管在执行过程中不知道：
- 哪些成员已经完成
- 哪些成员的最新输出是什么
- 当前有哪些审批请求在等待

### 3.2 新的 rosterPrompt 结构

每轮 prompt 开始前，宿主把以下信息拼进 systemPromptExtra（或作为第一条 user 消息注入）：

```
[团队状态快照 · 2026-10-02 14:32]

成员：
- 架构师（/sess123/arch）：✓ done — 输出：「建议用 Repository 模式，接口见 spec/api.md」
- 实现（/sess123/impl）：⏳ running — 已运行 3 分钟
- 测试（/sess123/test）：待命（还未接到任务）

子任务 session：
- S_claude_1（Claude Code）：⏳ running — 正在写 user.service.ts

待处理审批：
- /sess123/impl 请求执行 bash: npm install express（等待 2 分钟）

工作目录：/Users/me/prj
```

### 3.3 实现方式

方案：**注入为对话里的 `user` 消息**（而不是修改 system prompt）。

理由：
- system prompt 在 turn 开始时已经固化，不能中途改
- pi 支持在 `query()` 的 `messages` 里插入非对话内容
- 开销低：不需要改 engine 接口，只需要在 `requestRun` 时 prepend 一条 `[状态快照]` 消息

注入时机：每次 `requestRun` 前，宿主把 `buildStatusSnapshot(sessionId)` 的输出前置到 messages。
控制开关：只对 `orchestration: true` 的会话注入（单兵不注入）。

---

## 四、主管系统提示重写（LEAD_ROLE.instructions）

### 4.1 现有指令的问题

现有指令告诉主管「先拆解再分派」，但没有：
- 区分什么时候问用户 vs 自己决策
- 区分 `agent` vs `task_spawn` 的使用场景
- 指定汇报节奏（什么时候该主动告知用户进展）
- 失败时的决策框架

### 4.2 新的 LEAD_ROLE.instructions 草稿

```
你是团队主控，负责「理解用户意图 → 拆解任务 → 调度成员 → 验收交付」这条链。

## 对齐（先做这一步）
任务复杂或目标模糊时，先用 ask_user 澄清 1-2 个关键点，再开始执行。
不要问能推断的；不要一次问超过 2 个问题；不要礼貌性确认。

## 拆解
每个子任务要有：做什么（output）、验收标准（done when）、依赖（needs）。
能并行的并行，改同一文件的串行。

## 调度
选工具的规则：
- agent：需要主管上下文、短暂协作、秒级任务 → agent + agent_wait
- task_spawn：隔离执行、外部引擎（Claude Code）、有独立文件产出 → task_spawn + task_wait
成员卡超过 10 分钟无进展：用 agent_check 查状态，决定继续等 / 重新指令 / 换人。

## 汇报
- 每完成一个主要里程碑，主动向用户发一句进展说明（不要沉默到全部完成）
- 用户问进展时：给结论，不给过程列表

## 交付
完成前逐条对照最初目标：「用户说要做 X，我们做了 Y，差异是 Z」。
发现遗漏时：补做，或用 ask_user 问用户是否还需要。
```

---

## 五、idle 通知机制（D-M11-1 实现）

### 5.1 触发条件

当一个**非主管**成员（`!member.lead`）进入终态（`done/failed/interrupted`），
且它的**直接父路径**是主管 session 的根路径时，
宿主向主管 session 的根路径 steer 一条通知消息。

### 5.2 通知消息格式

```
[成员通知] /sess123/arch 已完成（done）
最后输出：「建议用 Repository 模式，接口见 spec/api.md」（节选 300 字）
```

### 5.3 实现位置

在 `host.ts` 的 `onStatusChanged` 里，`isTerminal(status)` 分支后追加：

```ts
// M11：成员进终态时通知主管
const parentPath = parentPath(path);
const parentIsRoot = parentPath === sessionRootPath(sessionId);
if (parentIsRoot && !snapshot.lead) {
  const preview = lastAssistantPreview(this.messagesOf(path), 300);
  void this.steer(parentPath,
    `[成员通知] ${path} 已${statusLabel(status)}${preview ? `\n最后输出：「${preview}」` : ''}`
  ).catch(() => undefined);
}
```

---

## 六、实施计划

### Phase 1：ask_user 工具（优先级最高，2 天）

1. `apps/desktop/src/main/question-broker.ts`：新建 `QuestionBroker` 类，封装 `question.request` 事件发送和 `question.respond` 响应的 Promise 对
2. `apps/desktop/src/main/orchestrator.ts`：`OrchestrationDriver` 加 `askUser` 方法；加 `ask_user` 工具（ORCHESTRATION_TOOL_NAMES 扩到 11 件）
3. `apps/desktop/src/main/host.ts`：`driverFor` 接线 `askUser`；主管调用时进入 waiting 状态
4. `apps/desktop/src/main/index.ts`：`question.respond` 命令接线（已有命令，确认接到 QuestionBroker）
5. 渲染层：`S2Views.tsx` 里的收件箱 `QuestionCard` 组件（问题文本 + 自由文本输入 + 可选的建议选项按钮）
6. `store.tsx`：`question.request` 订阅已接，确认带到 pending 列表并在收件箱显示
7. 测试：6 例（QuestionBroker 单元测试 + host 集成测试）

### Phase 2：动态任务板（1.5 天）

8. `session-instantiate.ts`：新增 `buildStatusSnapshot(sessionId, host)` 函数
9. `host.ts`：`requestRun` 前对 orchestration 会话 prepend 状态快照消息
10. 测试：快照内容格式单测 3 例

### Phase 3：LEAD_ROLE 指令重写（0.5 天）

11. `roles.ts`：按 §4.2 草稿重写 `LEAD_ROLE.instructions`
12. 手工验收：跑一个真实团队 session，验证主管能主动问用户、能在关键节点汇报

### Phase 4：idle 通知机制（1 天）

13. `host.ts`：`onStatusChanged` 里加成员终态通知逻辑
14. 测试：3 例（通知触发、非主管成员跳过、主管本身不触发）

---

## 七、测试策略

| 场景 | 测试方式 |
|---|---|
| `ask_user` 挂起主管、用户回答后恢复 | host 集成测试，mock QuestionBroker |
| `ask_user` 超时不中断主管 | 单元测试，注入 timeoutMs=10ms，验证主管仍 running |
| 动态快照内容格式正确 | `buildStatusSnapshot` 单元测试 |
| 成员 done 后主管收到通知 | host.steer 调用次数断言 |
| lead 成员进终态不触发通知（避免自通知） | 反向断言 |

---

## 八、验收标准

- [ ] 主管可以用 `ask_user` 向用户提问，用户在收件箱回答，主管恢复执行并用答案继续
- [ ] 成员完成任务后，主管自动收到通知消息（不需要主管轮询）
- [ ] 每轮执行前主管能看到最新的团队状态快照（哪些完成、哪些在跑、有没有待批）
- [ ] `bun run test` 全绿，新增测试 12+ 例
- [ ] 手工验收：一个需要主管问用户的 3 人团队任务跑通全流程

---

## 九、遗留与已知限制

- `ask_user` 的 `options` 字段在渲染层只是建议按钮，用户仍可以自由输入（不强制选）
- 动态任务板注入的是纯文本快照，不是结构化 JSON（避免模型把它当代码处理）
- Phase 4 的 idle 通知只覆盖「成员进终态」，不覆盖「成员长时间 running 无输出」（那个属于更复杂的 watchdog 扩展，留 M12）
- `ask_user` 在子 session 里不可用（子 session 的审批穿透是阶段 C 已做的路径，问题穿透留 M12）

---

## 十、实施回填（2026-10-10 补齐）

> 落地时没有回填本文档，状态一直停在「设计定稿」。此处只补可复核的客观项。

| 项 | 值 |
|---|---|
| 落地 commit | `aa67df0` + `54a204c`（Phase 1 `ask_user`）、`88e01a0`（Phase 2 动态任务板）、`0c127d3`（Phase 3 LEAD_ROLE 指令重写）、`af10e3f`（Phase 4 idle 通知）、`8e4aeaa`（端到端验收测试） |
| 工具落点 | `apps/desktop/src/main/orchestrator.ts:626`（`ask_user`），后端 `apps/desktop/src/main/host.ts:2387` |
| 测试 | `host.ask-user.test.ts`（4 例）+ `host.m11-e2e.test.ts`（主管完整能力链路的端到端）；全量 681 例在 2026-10-10 复跑全绿 |
| 验收项对照 | 四工具（ask_user / 任务板 / 指令重写 / idle 通知）均已落地；「新增测试 12+ 例」由上述两个测试文件满足 |

**仍未做的**：手工验收「一个需要主管问用户的 3 人团队任务跑通全流程」需要用户点过。
§九 的四条已知限制仍然成立（其中「idle 通知不覆盖长时间 running」「ask_user 在子 session 不可用」
两条当时记为「留 M12」，而 M12 转做了知识库，**这两条实际被滑到了后面，目前无归属里程碑**）。

# M4 协作动作与落账：方案设计与实施计划

> 状态：**设计评审中** → 实施中 → 已完成
> 对应架构：01 §6.4 MessageBus ｜ 依赖里程碑：M3（编排内核）
> 并行输入：`docs/ux/00-信息架构与屏幕清单.md`（MX，§6.6「M4 必补清单」）、`docs/spikes/S1-真实模型尖峰报告.md`

---

## 〇、需要用户拍板的决策（评审时逐条过）

MX 文档列出 13 个开放问题，其中 6 个是真正需要用户拿主意的（其余我在 §4 直接给了技术答案）。
每条给推荐项 + 反方理由，**请逐条确认或否决**。

| # | 决策 | 推荐 | 反方理由（为什么可能选另一个） |
|---|---|---|---|
| D1 | **人能不能手动发起协作动作**（把 A 的活 handoff 给 B） | ❌ **M4 不做**，只做 Agent 工具触发 | 反方：用户会想手动接管。但 tutti 的协作记录全部由「哪个 turn 的哪次 tool call 派生」定义（02 §3.2），引入 `actor: user` 会让账本出现一类**没有发起方转录**的记录，from 字段语义分裂。留到 MU 有了会话视图再谈 |
| D2 | **adoption 由谁表态** | **只有人能表态**（UI 发 `ledger.adopt`） | 反方：让父 Agent 自动表态更省事。但"Agent 自己批准自己的协作成果"就是给编排层开天窗（01 §6.4 反对特权角色的同一条理由）。代价：没人点就永远 pending |
| D3 | **`agent.message.received` 事件的去留** | **删掉**，账本是唯一口径 | 反方：保留可承载"轻通知"。但 MX §6.1 明确警告双口径风险，而这个事件**从未有过发射方**（死声明），删掉零成本 |
| D4 | **`orchestration.deadlock` 事件的去留** | **删掉** | M3 决策 #3（wait 仅限后代）之后死锁结构性不可能（`host.ts:20-24`）。留着会误导 MU 去设计一个永不出现的界面 |
| D5 | **审批默认档的实际行为**——`always_ask` 现在是七个内置角色里 4 个的配置值（`roles.ts:83,99,134,151`），但**从未执行过**。M4 接线后它会立刻生效 | **生效，但只拦「叶子工具」，不拦六个编排工具** | 反方：编排工具（spawn/interrupt）也该问人。但现在 tools universe 里叶子工具是空的（`host.ts:116` `options.tools ?? []`），若拦编排工具，`always_ask` 的四个角色一 spawn 就卡住等人批，M3 的 E2E 与真模型尖峰全部失效。等 M6/M7 有了真叶子工具再放开 |
| D6 | **账本落在哪** | **纯内存 + 协议暴露，M4 不落盘** | 反方：重启即丢。但落盘布局是 M5 的正题（03 §7 已决「M5 schema 带版本号并为 M4 账本预留扩展位」）。M4 把 `LedgerRecord` 带上 `version` 外箱，M5 直接序列化 |

---

## 一、目标与范围

**用户可见能力**：两个 Agent 之间的每一次协作都留下一行可查询的账；子 Agent 要动手时，
审批请求沿父链冒泡到人，人批了才动。

### 本里程碑做什么

1. **协作动作枚举化 + 落账**：`consult | fork | delegate | handoff` 四种动作，
   由六个编排工具的调用派生，每笔进账本（`LedgerRecord`），可按 agent/子树/动作/adoption 查询
2. **adoption 裁决**：`pending → adopted | rejected | not_applicable`，人在 UI 表态
3. **审批父链穿透**：工具执行前的 HITL 门，请求沿父链向上直到人；响应端三件套
   （`approval.respond` / `question.respond` / `pending.list`）全部接线
4. **协议数据正确性修订**：预算事件的 `limitUsd` 语义 bug（G9.1）、`budget.get`（G7.3）、
   `AgentSnapshot` 补 `sessionId`/`forkMode`/`waitingOn`（G4.1/G4.4/G4.6）

### 明确不做（防蔓延）

- **不做自由 pub/sub 消息总线**（03 §3 M4 非目标、01 §6.4）
- **不做特权 planning/review 角色**（01 §6.4、02 §3.2 tutti 明示反对）
- **不做人手发起协作**（D1）、**不落盘**（D6，M5 的事）
- **不做 UI 重写**：M4 只交付「能在现有调试控制台里点出来」的最小呈现
  （账本列表 + 审批 banner），产品化 UI 是 MU（03 §1 UX 支线定序）
- **不做流式 delta 接线**（G2.2/G2.3 属 MU/M6）；M4 只在协议上**定形状**不接线

---

## 二、现状盘点

| 组件 | 文件 | 已有能力 | M4 要动什么 |
|---|---|---|---|
| 编排六工具 | `apps/desktop/src/main/orchestrator.ts:148-334` | per-spawn 双闭包，`driver.selfPath` 已 bind 发起方身份 | 在 execute 里加落账调用 |
| 驱动面 | `host.ts:509-526` `driverFor()` | 9 个方法的窄接口 | 加 `record()`（落账）与 `requestApproval()` |
| 工具闸门 | `host.ts:216-219` `onBeforeTool` | 只做白名单拦截 | 加 HITL 门（审批穿透） |
| 预算 | `kernel/budget.ts`、`host.ts:625-639` | 80%/100% 跃迁 + 事件 | 修 `limitUsd` 语义 + 加 `budget.get` |
| 协议 | `protocol/src/ipc.ts:90-110,133-146` | 3 条死命令、5 个死事件 | 实现/重定义/删除 |
| 快照 | `protocol/src/agent.ts:251-262` | 10 字段 | 补 3 字段 |

**关键既有资产**：`driver.selfPath` 让「谁发起的协作」零成本可得（`orchestrator.ts:44`），
这是落账点选在编排工具层而非 host 层的根本原因。

---

## 三、设计依据

| 结论 | 出处 |
|---|---|
| 协作动作枚举化 `consult\|fork\|delegate\|handoff`，落库含 `context_scope/adoption/usage` | tutti `biz/collabrun/model.go:17-27`，经 02 §3.2 |
| `Adoption = pending\|adopted\|rejected\|not_applicable`，consult/delegate 默认等人表态 | 02 §3.2 |
| 交接用 `mention://agent-session/<id>` URI，**不拷贝 transcript** | 01 §6.4、02 §3.2 |
| 反对特权 planning/review 角色 | tutti `workspace-agents-and-automation.md:459`，经 02 §3.2 |
| 审批穿透父级 | TabTin `permissions/subagent-hitl.ts:9-17`，经 01 §6.4 |
| 协作边由「哪个 turn 的哪次 tool call 派生」定义 | tutti `session_types.go:288-293`，经 02 §3.2 |
| UI 数据需求与协议缺口逐条 | `docs/ux/00-信息架构与屏幕清单.md` §5 G1~G9、§6.6 |
| 真实成本量级（一次编排约 $0.02）、thinking 是独立 content block | `docs/spikes/S1-真实模型尖峰报告.md` §三/§四 |

---

## 四、总体设计

### 4.1 数据模型（schema 先行）

新增 `packages/protocol/src/ledger.ts`：

```ts
/** 协作动作四枚举（对齐 tutti collabrun.Mode）。 */
export type CollabAction = 'consult' | 'fork' | 'delegate' | 'handoff';

/** 裁决状态。consult/delegate 默认 pending 等人表态；fork/handoff 为 not_applicable。 */
export type Adoption = 'pending' | 'adopted' | 'rejected' | 'not_applicable';

/** 账本 schema 版本外箱 —— M5 落盘时不用改形状（03 §7）。 */
export const LEDGER_SCHEMA_VERSION = 1;

export interface LedgerRecord {
  version: number;              // = LEDGER_SCHEMA_VERSION
  id: string;                   // 单调递增 + 随机后缀，排序稳定
  action: CollabAction;
  from: AgentPath;              // driver.selfPath，永远是 agent（D1：不做 user）
  to: AgentPath;
  /** 派生这笔协作的工具调用（tutti session_types.go:288-293 的「哪次 tool call」）。 */
  origin: { tool: string; toolCallId: string };
  /** 交接载体：URI 引用，不拷贝 transcript。 */
  mention: string;              // mention://agent-session/<sessionId>
  /** 上下文口径，与 AgentSnapshot.forkMode 同源（G4.4）。 */
  contextScope?: ForkModeSpec;
  adoption: Adoption;
  adoptedAt?: number;
  adoptedNote?: string;
  /** 这笔协作**增量**消耗（子树 usage 快照差值，非累计）。 */
  usage?: UsageTotals;
  at: number;
  /** 协作生命周期：发起 → 目标终态。 */
  status: 'open' | 'settled';
  settledAt?: number;
  summary?: string;             // 目标终态时的最后一条 assistant 文本预览（截断）
}
```

**四个动作怎么从六个工具派生**（这是 M4 最需要拍死的映射）：

| 工具调用 | 动作 | 理由 |
|---|---|---|
| `agent(role, task, forkMode)` 且 `forkMode` 解析为 `none` | `delegate` | 给一个干净上下文的下属派活 = 委派 |
| `agent(...)` 且 `forkMode` 非 `none`（`all`/`lastRounds`） | `fork` | 带着上下文分身 = 分叉（tutti 的 context_scope 正是此维度） |
| `agent_wait(targets)` | —（不新增记录） | wait 不是协作动作，是等待；它让对应记录 `open → settled` |
| `agent_check(target)` | —（不新增记录） | 只读查看，落账会淹没账本 |
| `agent_message(target, text)` | `consult` | 运行中向下投递指导并期待其纳入 = 咨询（默认 `pending` 等人表态） |
| `agent_resume(target, task)` | `handoff` | 向已终态的 Agent 交接新一段任务 |
| `agent_interrupt(target)` | —（不新增记录） | 中断是控制动作；会让 open 记录 `settled` |

> 这个映射的争议点是 `agent_message → consult`：它也可以算"指令"而非"咨询"。
> 选 consult 的理由是 tutti 的 consult 语义就是「问一句并期待结果被采纳」，
> 而 `agent_message` 的 pi 语义是 steer（下一轮生效，不保证被采纳）——正需要 adoption 来裁决。

### 4.2 模块与文件布局

```
packages/protocol/src/
  ledger.ts            [新] CollabAction / Adoption / LedgerRecord / 查询过滤器类型
  ipc.ts               [改] CommandMap +4、EventMap +2 -2、PendingRequest 重定义
  agent.ts             [改] AgentSnapshot +3 字段

packages/kernel/src/
  ledger.ts            [新] Ledger 类（纯内存，electron-free，可 headless 测）
                            record() / settle() / adopt() / query()

apps/desktop/src/main/
  orchestrator.ts      [改] driver 加 record()；六工具在成功路径调它
  approval.ts          [新] ApprovalBroker：父链穿透 + 挂起表 + 幂等 respond
  host.ts              [改] 装配 Ledger + ApprovalBroker；onBeforeTool 加 HITL 门；
                            补快照字段；修预算事件；execute 加 4 条命令
```

**为什么 `Ledger` 放 kernel 而 `ApprovalBroker` 放 app**：账本是纯数据结构（进出都是值），
属于可复用内核；审批穿透要读角色的 `approval` 档、要沿 registry 的父链走、要发 IPC 事件，
是宿主编排职责。分错了会把 registry 依赖拖进 kernel。

### 4.3 协议扩展

**新增命令**（对齐 MX §6.6）：

```ts
'ledger.query': { payload: LedgerQuery; result: { records: LedgerRecord[]; total: number } };
'ledger.get':   { payload: { id: string }; result: LedgerRecord | null };
'ledger.adopt': { payload: { id: string; adoption: Adoption; note?: string };
                  result: { record: LedgerRecord } };
'budget.get':   { payload: {}; result: BudgetState };  // G7.3 + G9.2
```

`LedgerQuery = { agent?: AgentPath; subtree?: boolean; action?: CollabAction[];
adoption?: Adoption[]; limit?: number; before?: string }`。

**实现已声明的三条死命令**：`approval.respond` / `question.respond` / `pending.list`（G1.1~G1.3）。

**新增事件**：

```ts
'ledger.recorded': { record: LedgerRecord };          // G8.1
'ledger.updated':  { record: LedgerRecord };          // G8.2（合并 settle 与 adopt 两种变化）
```

> G8.2 在 MX 里叫 `ledger.adoption.updated`（文档自注"名字再议"）。
> 改叫 `ledger.updated` 的理由：`settled` 状态变化和 adoption 变化都是"同一笔记录变了"，
> 两个事件会让 UI 写两套相同的 upsert 逻辑。

**重定义**：

```ts
'approval.request': {
  requestId: string;
  origin: AgentPath;          // 谁要动手
  chain: AgentPath[];         // 父链穿透路径（origin → … → root）
  tool: string; args: unknown;
  approvalMode: ApprovalMode; // 该 agent 生效的档
  message: string;
  expiresAt?: number;
};
```

`PendingRequest` 同步扩为 `{ requestId, kind, origin, chain, tool?, args?, approvalMode?,
message, detail?, at, expiresAt?, state: 'pending' | 'resolved' }`（G5.1）。

**删除**：`agent.message.received`（D3）、`orchestration.deadlock`（D4）。

**修订**（G9.1，数据正确性）：

```ts
'budget.warning': { usage: UsageTotals; spentUsd: number; limits: BudgetLimits };
'budget.frozen':  { usage: UsageTotals; spentUsd: number; limits: BudgetLimits };
```

现在 `limitUsd` 里放的是 `this.budget.spent`（`host.ts:630,636`），
于是 UI banner 的「已用 $X ／上限 $X」两个数同源同值（`App.tsx:215-219`）——这是个真 bug，M4 一并修。

**`AgentSnapshot` 补三字段**：

```ts
sessionId: string;             // G4.1；M4 = path，M5 落盘时解耦（留出替换位）
forkMode?: ForkModeSpec;       // G4.4；spawn 时解析结果落快照，与账本 contextScope 同源
waitingOn?: AgentPath[];       // G4.6；waits 图当前边，UI 显示"在等谁"
```

G4.2（当前任务文本）**不进快照**：任务文本长度无上限，快照是高频全量广播的
（`agent.list` + 每次 `agent.status`），把它塞进去等于每次状态变化都重传一遍任务全文。
协议答案是「UI 用 `agent.messages` 取 transcript 首条 user 文本」——已有命令够用（G3.1）。

### 4.4 装配关系

```
编排工具 execute 成功
    │ driver.record({action, to, origin, contextScope})
    ▼
AxonHost.recordCollab() ──► Ledger.record() ──► emit('ledger.recorded')
    │
    └─ 注册「目标终态时 settle」的回调（复用 M3 已有的 wait 图 / 状态机钩子）

目标 → 终态（onStatusChanged）
    │
    ▼
Ledger.settle(id, {usage 增量, summary}) ──► emit('ledger.updated')

UI 表态 ledger.adopt ──► Ledger.adopt() ──► emit('ledger.updated')
```

审批链路：

```
engine.onBeforeTool(name, args)            ← 已有闸门（host.ts:216-219）
    │ ① 白名单（已有）：不在 allowSet → deny
    │ ② HITL 门（新）：ApprovalBroker.gate(path, name, args)
    ▼
ApprovalBroker
    │ 查该 agent 生效的 ApprovalMode（角色 approval 档）
    │  full_access → allow
    │  auto        → allow（但仍落一条 auto-approved 的挂起记录？→ 不落，见下）
    │  always_ask  → 沿父链向上找第一个"能替它做主"的节点
    │                 （父的档为 full_access/auto ⇒ 父代批；否则继续向上）
    │                 到 root 仍没人代批 ⇒ emit('approval.request') 给人
    ▼
人在 UI 批/拒 → approval.respond → resolve 挂起的 Promise → allow/deny
```

**父代批的语义来自 TabTin**（`subagent-hitl.ts:9-17` 包装父 channel）：子 Agent 的审批请求
不是独立的，它走父亲的通道；父亲若已获授权，就无需再惊动人。

`auto` 档**不落挂起记录**：`auto` 的语义是"放手"，为它记一条"已自动批准"的待办
会让 S5 收件箱被噪音淹没。要审计走账本，不走挂起表。

---

## 五、关键流程

### 5.1 一次 delegate 的完整生命周期

```
planner 调 agent(role='developer', task='写方案', forkMode 缺省→none)
  → orchestrator.agentTool.execute
      → driver.spawnChild()            [M3 已有] → /root/planner-1/developer-1
      → driver.record({                [M4 新增]
            action: 'delegate',         (forkMode=none ⇒ delegate)
            to: '/root/planner-1/developer-1',
            origin: { tool: 'agent', toolCallId: 'call_xxx' },
            contextScope: {kind:'none'} })
      → Ledger.record → id=L1, status='open', adoption='pending'
      → emit ledger.recorded
  → 工具返回（M3 原样）

developer-1 跑完 → setStatus(done)
  → onStatusChanged 钩子发现 L1.to 命中且未 settled
  → usage 增量 = 目标子树当前 usage − 记录时快照
  → Ledger.settle(L1, {usage, summary: 最后一条 assistant 文本前 500 字})
  → emit ledger.updated

人在账本里点「采纳」
  → ledger.adopt(L1, 'adopted') → emit ledger.updated
```

### 5.2 审批父链穿透（developer 要跑 shell）

```
/root/planner-1/developer-1 (role=developer, approval=auto)  → 直接放行
/root/planner-1/tester-1    (role=tester,    approval=always_ask)
   → 向上找：planner(auto) ⇒ 父代批 ⇒ 放行，账本无关，但记 debug 日志
/root/aligner-1             (role=aligner,   approval=always_ask)，父是 root
   → root 无角色/无档 ⇒ 惊动人
   → emit approval.request { origin:'/root/aligner-1',
                             chain:['/root/aligner-1','/root'], tool:'shell', … }
   → UI banner；人点批准 → approval.respond{requestId, approved:true}
   → gate 的 Promise resolve(true) → 工具执行
```

**超时与幂等**：请求带 `expiresAt`（默认 300s）；超时视为拒绝并把原因回灌给模型
（pi 约定：deny reason 变成 error toolResult，模型自行纠偏）。重复 respond 同一 requestId
直接返回 `{accepted:true}` 不重复 resolve（G1.1 要求的幂等）。

---

## 六、边界情况与风险

| 情况 | 处理 |
|---|---|
| **审批门与 M3 看门狗打架**：等人批时 agent 仍是 `running`，idle 看门狗（默认超时）会 abort 它 | HITL 等待期间调 `touch(path)` 保活 **或** 把 agent 标记为"等审批"不计入 idle。**选后者**：保活是骗看门狗，语义上不诚实。新增内部标记（不进 `AgentStatus` 枚举，避免状态机爆炸） |
| **审批门与预算熔断**：frozen 后拒新活，但已挂起的审批请求怎么办 | frozen 只拒**新**活（M3 决策 #4「不杀在跑」）；已挂起的审批照常可批，批了继续跑完当前轮 |
| **目标被删（`agent.remove` 级联）而账本记录还 open** | `settle(status='settled', summary='目标已删除')`，不留悬空 open 记录 |
| **同一 toolCall 重复落账**（模型重试/引擎重放） | `origin.toolCallId` 做幂等键，重复 record 返回已有记录 |
| **账本无上限增长** | 纯内存，单次会话可控（S1 实测一次编排 4~5 轮 LLM 调用产生 1~2 笔）。设 10000 条上限，超出丢最旧并计数；M5 落盘后改为分页读 |
| **usage 增量取不准**：子树 usage 是累计值，两笔协作并发时差值会串 | 以「记录时刻的子树 usage 快照」为基线，settle 时取差。并发下可能重叠计数 —— **接受这个不精确**并在协议注释里写明：账本 usage 是归因估算，唯一权威是 root 累计（预算熔断吃的那个） |
| **删事件的兼容性** | `agent.message.received` / `orchestration.deadlock` 都是死声明，无发射方无订阅方，删除零风险（guard 会在 typecheck 阶段抓出任何残留引用） |

---

## 七、实施计划（每步带验证方式）

| # | 切片 | 验证 |
|---|---|---|
| 1 | `protocol/ledger.ts` + `ipc.ts`/`agent.ts` 协议扩展（含删两个死事件、修预算事件形状） | `bun run typecheck` 全绿；guard 无新增 pi import |
| 2 | `kernel/ledger.ts` Ledger 类（record/settle/adopt/query + 幂等 + 上限） | 单测 ~18 例：四动作映射、幂等键、查询过滤（agent/subtree/action/adoption/分页）、上限淘汰 |
| 3 | `orchestrator.ts` driver 加 `record`，六工具接落账（三个工具不落账） | 单测：FakeDriver 断言"哪些工具落账、动作是什么、forkMode 如何决定 delegate/fork" |
| 4 | `host.ts` 装配 Ledger + settle 钩子 + usage 增量归因 + 三条 `ledger.*` 命令 | host 单测：spawn→跑完→记录 open→settled；remove 时 settle |
| 5 | `approval.ts` ApprovalBroker（父链穿透 + 挂起表 + 幂等 + 超时） | 单测 ~14 例：三档行为、父代批、到 root 惊动人、超时拒绝、重复 respond 幂等 |
| 6 | `host.ts` onBeforeTool 接 HITL 门 + 看门狗豁免 + 三条响应命令 | host 单测 + E2E：always_ask 角色的工具调用挂起→respond→继续 |
| 7 | `budget.get` + 预算事件修订接线 | 单测：事件 payload 的 spent 与 limits 是两个不同的数 |
| 8 | 最小 UI：账本面板（列表 + 表态按钮）+ 审批 banner（批/拒） | ui-smoke 新增 2 幕：落账出现在 DOM；审批 banner 点批准后 agent 继续 |
| 9 | 真模型 E2E：`examples/real-orchestration-spike.ts` 扩一问「账本是否落账」 | `bun run example:orchestration` 五问全过 |

---

## 八、测试策略

- **单测**（kernel/ledger、orchestrator 落账映射、approval broker）：纯函数与窄接口，FakeDriver 驱动
- **契约测试**：不涉及（M4 不碰 pi 边界）
- **集成测试**（host）：账本生命周期 + 审批穿透，用 `scriptedSource` 保持确定性（M3 纪律）
- **E2E**（`orchestration.e2e.test.ts` 扩幕）：真实 pi 引擎下 delegate→settle→adopt 全链路
- **UI 冒烟**：CDP 两新幕
- **真模型尖峰**：S1 的编排脚本加第五问

预计测试总数 176 → 约 225。

---

## 九、验收标准

- [ ] 四种协作动作按 §4.1 映射表落账，`origin.toolCallId` 幂等
- [ ] `ledger.query` 支持 agent/子树/动作/adoption 过滤与分页
- [ ] 每笔记录在目标终态时自动 `settled`，带 usage 增量与摘要
- [ ] 人可对 consult/delegate 记录表态，状态变化实时推到 UI
- [ ] `always_ask` 角色的工具调用会挂起并冒泡到人；父有权时父代批不惊动人
- [ ] `approval.respond` 幂等；超时视为拒绝且原因回灌给模型
- [ ] `pending.list` 能在 UI 刷新后补拉挂起请求
- [ ] 预算事件的 spent 与 limits 是两个不同的数；`budget.get` 可拉当前档位
- [ ] `AgentSnapshot` 带 sessionId/forkMode/waitingOn
- [ ] 两个死事件已删除，无残留引用
- [ ] `bun run check` 全绿 + `ui-smoke` 七幕 + `example:orchestration` 五问

## 十、文档同步

- `docs/03-实施框架与里程碑.md` §1 状态列（M4 → ✅）
- `docs/01-架构决策-方案B.md` §1 进度表 + §6.4 落地说明
- 本文件状态行 + §五「设计 vs 实测出入」回写（M3 的惯例）
- `docs/ux/00-信息架构与屏幕清单.md`：M4 已定的协议面回写（由 MX 会话或主线收口）

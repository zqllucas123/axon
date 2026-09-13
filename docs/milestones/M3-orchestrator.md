# M3 编排内核：方案设计与实施计划

> 状态：实施中（2026-09-13 拍板通过，按 §〇 决策执行）
> 对应架构：01 §6.5（Orchestrator）+ 01 §8（预算熔断遗留项）｜ 依赖里程碑：M2 ✅
> 前置条件：无 API key 要求（faux 驱动全链路）

## 〇、需拍板的决策（读完全文后作答）

| # | 决策 | 拍板（2026-09-13） | 备注 |
|---|---|---|---|
| 1 | 编排工具授权矩阵 | **全员全件套**（7 个内置角色全给 6 工具） | 用户否决推荐矩阵，取最大自由度；token 风险交给预算熔断（#4）与个人自觉；用户自定义角色仍自由裁剪 |
| 2 | 并发闸门语义重构 | ✅ 按推荐 | running-only 计数 + parked FIFO + 父退位 + 免检 promote |
| 3 | wait 目标限制 | ✅ 按推荐 | 仅限后代，死锁结构性不可能 |
| 4 | 预算熔断行为 | ✅ 按推荐 | 80% 警告 / 100% 冻结拒绝新活 / 不杀在跑 |
| 5 | wait 超时 + 看门狗 | ✅ 按推荐 | 超时不杀子；idle 看门狗 5min 专治卡死 |

## 一、目标与范围

**用户可见**：一个父 Agent 在对话中自行把任务派给子 Agent（自动 spawn），等它做完拿到结果继续；整个树在 UI 实时更新，含「waiting（排队等额度）」新状态，预算超限有明确告警。

**做什么**：
1. 六个编排工具（抄 TabTin 五件套 + spawn，§4.1）——挂起-等待的主干 = pi 原生 `AgentTool.execute()` 的 async 语义，**不需要改 pi 源码**
2. 并发闸门语义重构（§4.2）——parked 队列 + 免检 promote，解决「父等子 + 上游 6 上限」的结构性死锁
3. wait 图与防死锁（§4.3）
4. 预算熔断（§4.4，01 §8 遗留项「多 Agent token 成本失控」的落地）
5. 活性保障：wait 超时 + idle 看门狗（§4.5）

**明确不做什么**（防蔓延）：
- ❌ 叶子工具（read / write / grep / bash 等）——pi 的 `harness/tools/*` 是 `AgentHarnessTool`（execute 签名与 `AgentTool` 不同，`dist/harness/types.d.ts:78-80`），且 harness 本身 22 方法未实现（风险 A）。M3 的树上没有任何叶子工具，角色白名单里的 `read/grep/...` 名只是未来钩子，universe 未挂载即不解出
- ❌ 跨树通信 / mention:// URI / 落账（M4）
- ❌ 持久化 / 崩溃恢复（M5）
- ❌ 自主派发（Agent 未经工具指名 spawn）：不在 M3，等 M4/M6 之后再议（01 §7 已定「先手动」，且树深度上限本身就是防自主递归的闸）
- ❌ 真实模型接入（M6）

## 二、现状盘点

| 组件 | 现状 | 与本里程碑的关系 |
|---|---|---|
| `apps/desktop/src/main/host.ts` | `AxonHost.spawn/prompt/interrupt/remove`；`prompt()` 直接 `setStatus('running')` 后 engine.prompt+waitForIdle；onBeforeTool 白名单闸门；wire 事件流 | 编排工具从这里拿「子 Agent 生命周期」能力；`prompt()` 需要重构成 requestRun + parked 队列（§4.2） |
| `packages/kernel/src/registry.ts` | 状态机 TRANSITIONS（`registry.ts:45-46` waiting↔running 已合法）；闸门= `activeCount()`（running+waiting，`:135-140`）+ `setStatus` 新历位时检查（`:237-239`）；`waiting→running` 已免检（`:238` 注释）；`DEFAULT_MAX_DEPTH=2` | 闸门语义要改：只数 running；新增 `idle→waiting`（parked）与 `promote()` 免检方法 |
| `packages/kernel/src/fork.ts` | `assertWaitable(self, target, exists)`：拦自己 / 祖先 / 不存在（`:176-190`） | §4.3 在其上加「非后代也不行」，成为 `assertSteerable` 的 wait 版 |
| `packages/kernel/src/engine.ts` | `AxonEngine` 接口 5 方法（无 steer）；`wrapEngine` 直接透传 | 需加 `steer(text)`：pi `Agent.steer()`（`dist/agent.d.ts:84`）「injected after the current assistant turn finishes」——正合 message 工具的「下一轮生效」 |
| `packages/protocol/src/ipc.ts` | `budget.warning` / `budget.frozen` / `orchestration.deadlock` 事件**已声明未实现**；`agent.status` 事件已声明 | 预算事件直接启用；deadlock 事件留 M4（§4.3 论证 M3 结构性无环） |
| `apps/desktop/src/main/roles.ts` | roles 白名单引用 `read/grep/...` 等叶子工具名；approval 维度已定义未强制 | §4.1 授权矩阵在此文件落地；approval 强制不在 M3 范围（工具全为进程内编排，无副作用面） |
| `packages/kernel/src/provider.ts` | `createFauxSource` + `FauxResponseFactory`（`pi-ai/dist/providers/faux.d.ts:75-78`，factory 可读 `context.messages/tools/systemPrompt`） | M3 集成测试的驱动源：脚本化「planner spawn developer」全流程（§八） |

**已知缺陷（M3 顺手修）**：
- `host.prompt()` 对 done Agent 直接 `setStatus('running')`——非法跃迁被 `setStatus` 吞掉后，引擎照样在跑而快照状态不同步（状态真相漂移）。M3 的 `requestRun` 统一入口会先归位 idle 再走闸门。

## 三、设计依据（带出处）

1. **挂起-等待不需要改 pi 源码**：`AgentTool.execute` 在 agent-loop 里被 `await`（`pi-agent-core/dist/agent-loop.js:137-139` `executeToolCalls(...)` 的 Promise 不 resolve 本轮就不继续；`:313,363` `await executePreparedToolCall`）——工具在 execute 里阻塞，父 Agent 就挂起；resolve 时 toolResult 回灌（`:142-145`），父 Agent 带着子结果续跑。这正是 01 §5「L2 接入 L1 的主干」与 02 §1.2 复核后的措辞。
2. **五件套抄 TabTin**（02 §3.3，`TabTin/packages/agent-wire/subagent/agent-tool.ts:126-232`）：一个 `agent` 工具 spawn（`background` 异步立返）→ `wait_agent_ids`（挂起等到终态）→ `check_agent_id`（只读查）→ `message_agent_id`（运行中投递，下一轮生效）→ `resume` / `interrupt`。我们在其上做两处裁剪：wait 参数化为多目标 + 超时；message 的「下一轮生效」用 pi 的 `steer()`（`agent.d.ts:84`「injected after the current assistant turn finishes」），对 parked 子 Agent 是「下一轮开始时生效」。
3. **完成判定**：`waitForIdle()`（`agent.d.ts:105-108`，agent_end 及全部监听器 settle 后才 resolve）= kalo 的 `waitForIdle() 等 agent_end && !willRetry`（02 §2.3 表）。pi 的 provider 重试是 loop 内部自愈，我们不需要 `!willRetry` 那半句。
4. **resume 跳过并发信号量防死锁**（02 §2.3 表，kalo）：`waiting→running` 免检已在 registry 实现（`registry.ts:238`），M3 把它升级为「等子 Agent 时父级整体退位」（§4.2）。
5. **并发上限 6**：`DEFAULT_MAX_CONCURRENCY = 6`（kalo 子 agent 信号量同值，02 §2.3）。M3 不改变数值，只改「数什么」。
6. **树深度上限 2**：`DEFAULT_MAX_DEPTH = 2`（TabTin `MAX_SUBAGENT_DEPTH=2` 的复盘：默认不继承父上下文的前提下才敢放到 2）。M3 的工具 spawn 只继承这一闸，不做提升。
7. **预算熔断**：01 §8「多 Agent 并发下的 token 成本失控——预算熔断待 6.5」；事件名 `budget.warning/frozen` 在协议里已备好（M1 预留）。熔断只挡「新起点」（spawn / prompt），不杀在跑——类比 kalo 子 Agent 挂起保护（>100 pending 直接 deny，02 §3.3）的「入口闸」思路。
8. **watchdog 5 分钟**：kalo `IDLE_TIMEOUT_MS = 5min` 按空闲而非总时长（02 §2.3 表「活性」行）；M3 照抄数值与吃法（每个 running Agent 独立计时，有事件即归零）。

## 四、总体设计

### 4.1 六个编排工具（schema）

工具全是「只有 name/params 差异、实现闭包在驱动上」的 `AgentTool`（`pi-agent-core/dist/types.d.ts:340-349`）。参数 schema 用 `Type`（typebox，经 kernel/provider re-export）。**错误一律 throw**（pi 约定：throw 转 error toolResult 回模型，模型知道失败并自己决策，`types.d.ts:349` 注释「Throw on failure instead of encoding errors in content」）。

| 工具 | 参数 | 行为 | 失败面 |
|---|---|---|---|
| `agent` | `{role, task, forkMode?}` | 立即 spawn 子 Agent（挂在**调用者**名下）并投喂 task；返回 `{id, role}` 后马上 resolve（异步立返，await 是 `agent_wait` 的事） | 角色不存在 / 超深度 / 熔断冻结 / 调用者非该角色授权 |
| `agent_wait` | `{ids: string[], timeoutSec?}` | 注册 wait 边（§4.3）→ 每个目标到达终态（done/failed/interrupted）或超时；返回 `{statuses: {id,status,lastError?,timedOut?}[]}` | 目标不是自己的后代 / 目标不存在 / 等待自己 |
| `agent_check` | `{id: string}` | 只读：目标快照摘要 `{status, usage, children, lastError, 最近一条 assistant 文本预览(≤500字)}` | 后代校验同上 |
| `agent_message` | `{id: string, text: string}` | 目标在跑 → `engine.steer(text)`（本轮结束后注入，下一轮生效）；目标在 parked/waiting → 入队待其恢复后首轮生效；目标已终态 → throw（提示改用 `agent_resume`） | 目标终态 / 非后代 |
| `agent_resume` | `{id: string, text: string}` | 对**终态**目标：归位 idle 后走 requestRun（重新入闸门，超限则再次 park）。语义 = 追加任务（registry `done→idle` 原生支持） | 目标在跑 / 非后代 |
| `agent_interrupt` | `{id: string}` | 终端下游取消：`engine.abort()` + 状态打 interrupted；目标在 parked → 出队并丢任务 | 非后代 |

**要点**：
- 工具的「身体」放在 `apps/desktop/src/main/orchestrator.ts`，只面向一个 `OrchestrationDriver` 接口（§4.6），不 import electron，可 headless 测试。
- 6 个工具是**双闭包**：`host`（生命周期）+ `selfPath`（调用者）。因为 `AgentTool.execute(toolCallId, params, ...)` 签名里没有「谁在调我」，必须每个 engine 生成时 bind 自己的 path。leaf 工具是共享单例，编排工具必须 per-spawn 现造。
- 若角色白名单中含编排工具名，host 在 `spawn()` 时现造并 bind path；白名单中的叶子工具名在 universe 里查找，查不到即跳过（现状查不到一切叶子工具，M3 合法空集）。

**授权矩阵（决策 #1 拍板：全员全件套，2026-09-13）**：

| 角色 | agent | agent_wait | agent_check | agent_message | agent_resume | agent_interrupt |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 全部 7 个内置角色（planner/architect/developer/tester/aligner/blank/clone） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

> 用户否决了推荐矩阵，取最大自由度。token 风险改由两条底线兜住：预算熔断（§4.4）硬线冻结新活；树深上限 2（registry `DEFAULT_MAX_DEPTH`）限制递归 spawn。用户自定义角色仍可按白名单自由裁剪（`tools` 字段为数据，非代码）。

### 4.2 并发闸门语义重构（本里程碑的机制核心）

**现状的死锁**：`activeCount` 数 running+waiting，上限 6。父 running(占1) + spawn 6 子：第 6 子的 `setStatus('running')` 被 gate 拦（throw 被 setStatus 吞 → 引擎照跑但状态失同步），父的 `agent_wait` 永远等不来第 6 子 ⇒ 结构死锁 + 状态漂移。

**重构为三段语义**：

```
running = 真正在烧 token，占额度；gate = maxConcurrent 只数 running
waiting = 两个来源：
  (a) parked —— 拿到任务但暂无线程额度（spawn 后/追加任务/用户 prompt 时 gate 满，排队）
  (b) suspended —— 父 Agent 正在 agent_wait 里等后代，主动退位让出额度
promote(path) = waiting→running 免检通道（额度已由「它等的子刚结束」释出）
```

- `registry.setStatus` 不变，新增：TRANSITIONS `idle: [...'waiting']`、`promote(path)`（waiting→running 免 gate）、`activeCount` 只数 running。
- 新增 host 内 parked FIFO（`pendingRuns: Map<path, {text}>` + 队列序）。`requestRun(path, text)`：终态先归 idle → `canRun()`? → 有额度进 running 直接 engine.prompt / 没额度进 parked(waiting)。
- 完成时（`waitForIdle` resolve 后）调 `drain()`：**先 promote「已无待等边」的 suspended 父**（它们等的子刚腾出额度，优先级高于新人），再按 FIFO 从 parked 队首填空额。

**谁也不能死锁的论证**：等边只沿树向下（§4.3），所以每逢子终态 → 其父们先解挂；解挂后父要么继续等别的子（suspended 仍是 waiting，不占额）要么跑完释放。额度只从「子跑完」产生，而 deepest 层没有任何等待者（叶子无子）⇒ 叶子必跑 ⇒ 逐层解挂，链上任意深度都有进展。这就是 kalo「resume 跳过信号量避免死锁」在我们的共享额度模型里的正确定式。

### 4.3 wait 图与防死锁

wait 目标加**后代**校验（在 `assertWaitable` 之后）：`assertDescendantOf(self → target)`。wait 图节点=path，有向边=父→子（suspended 时注册，resolve/finally 必摘边）。

- 边只能沿树向下 ⇒ 图必无环 ⇒ 结构死锁不存在。协议里的 `orchestration.deadlock` 事件**M3 不实现**（留 M4：跨树消息引入横向等边时才出现环的可能性，届时再上环检测）。
- `agent_wait` 超时路径：resolve 但不杀子（决策 #5）；子照常跑，父可从 `agent_check` 追结果。

### 4.4 预算熔断（BudgetGuard）

新增 `packages/kernel/src/budget.ts`（纯函数类，无 pi import）：

```
class BudgetGuard {
  constructor({ softUsd, hardUsd })       // soft 省缺 = hard × 0.8
  record(costUsd): 'ok' | 'warning' | 'frozen'   // 沿阈值只报一次状态跃迁
  get state(): 'ok' | 'warning' | 'frozen'
}
```

接线：`host.wire` 里 `turn_end` 已 `addUsage`（父链累计，root 即全局总账）→ 追加 `guard.record(usage.cost.total)`，跃迁时发 `budget.warning` / `budget.frozen`（协议事件字段现成）。闸点：`requestRun`、`spawn`、`agent` 工具 execute——frozen 时 throw / 返回 `{accepted:false, reason:'budget_frozen'}`。不杀在跑 Agent（决策 #4）。复位不在 M3（重启进程即复位；M6 起再看）。

### 4.5 活性保障

- `agent_wait` 的 `timeoutSec`：每目标独立计总时长，默认 600s；超时的目标返回 `timedOut:true`（status 照实时）。
- idle 看门狗：host 记 per-path `lastActivity`（wire 的 message/tool/turn 事件即刷）；每 30s sweep，running 且 `now-lastActivity > idleTimeoutMs`（默认 5min，可配 0 关）→ `interrupt(path)`。suspended(waiting) 不在 sweep 范围：它不烧 token，活性由 wait 超时管。

### 4.6 模块/文件布局

```
packages/kernel/src/
  budget.ts             新增：BudgetGuard（纯逻辑 + 单测）
  registry.ts           改：activeCount 只数 running；idle→waiting；promote()
  fork.ts               改：assertWaitable 之上加 assertDescendantOf（或新 assertSteerableFamily）
  engine.ts             改：AxonEngine + steer(text)
apps/desktop/src/main/
  orchestrator.ts       新增：OrchestrationDriver 接口 + 六工具工厂（无 electron）
  host.ts               改：SystemDriver 实现；requestRun/parked/drain；wait 图；watchdog；预算接线
  roles.ts              改：授权矩阵（§4.1 表）
  index.ts              改：HostOptions 传 budgetUsd / idleTimeoutMs / maxConcurrent
apps/desktop/src/renderer/
  App.tsx               改：预算条（budget.warning/frozen 事件 → banner；frozen 禁 composer）
packages/protocol/      不动（事件面早已备好）
```

`OrchestrationDriver` 接口（host 实现，测试用 fake 实现）：

```ts
interface OrchestrationDriver {
  selfPath: AgentPath;                       // spawn 出的子挂在它名下
  spawnChild(spec: {role; task; forkMode?}): AgentPath;
  requestRun(path, text): Promise<void>;     // 闸门 + parked 全包
  interrupt(path): void;
  snapshot(path): AgentSnapshot | null;      // check 用
  canSee(path: AgentPath): boolean;          // 后代校验
  beginWait(targets: AgentPath[]): (idsDone: AgentPath[]) => void;  // 注册边+挂起，返回回调
  steerTo(path, text): void;                 // message 工具
}
```

### 4.7 协议面

- 不动 CommandMap；启用事件 `budget.warning` / `budget.frozen`（字段现成：usage + limitUsd）。
- `agent.status` 已有 waiting（`AgentStatus` 含 waiting，UI dot 直接吃）。
- `orchestration.deadlock` 继续留空，文档注明 M4 启用。

## 五、关键流程

planner 派活全链路（faux 集成测试同款脚本）：

```
root: requestRun('/root/planner-1', '做 X')
  └ engine.prompt → 模型(faux factory) 输出 toolCall agent{role:'developer', task:'实现 A'}
      └ agent.execute → driver.spawnChild → host.spawn('/root/planner-1/developer-1', initialPrompt='实现 A')
          └ requestRun(child)：gate 有空(父running占1, <2) → child running
      └ toolResult{id, role} 回灌 → 模型继续
  └ 模型(factory call#2) 输出 toolCall agent_wait{ids:['/root/planner-1/developer-1']}
      └ agent_wait.execute → beginWait([child])：
          setStatus(planner, 'waiting')        // 父退位，额度-1
          把「父 → 子」边挂进 wait 图
      └ generator 轮询子快照（500ms），子终态：
          └ host: 子 'done' → drain():
              promote(planner)                  // waiting→running 免检（决策 #2）
              wait 图摘边，agent_wait.resolve({statuses:[{id:'developer-1',status:'done'}]})
      └ toolResult 回灌 → 模型(final factory call) 输出总结文本
      └ turn_end → addUsage(+预算) → host.prompt 收敛：planner 'done'
```

闸门满路径（gate=1，M3 测试重点）：

```
planner running(占满) → spawn 2 子：child1 running…child2 gate 满 → parked(waiting)
→ planner agent_wait([child1, child2]) → 退位 suspended(waiting)，额度空出
→ drain(): 先 promote 出队 child2（队首填额）→ child2 running
→ 子终态逐个：先规划其父（无待等边后）promote(planner) → planner 续跑
```

## 六、边界情况与风险

| # | 边界/风险 | 处理 |
|---|---|---|
| 1 | 模型忘 wait：spawn 后直接结束本轮 | 子继续跑（额度独立），父已 done 拿不到结果——模型可从 `agent_check` 追；虚弱模型兜底在 M6 用真实模型检验后议 |
| 2 | 模型 spawn 一个不存在的角色 | tool throw → error toolResult 回灌，模型自己纠偏（pi 约定 throw，`types.d.ts:349`） |
| 3 | 用户 interrupt 父 | 父 `abort()` → 其 wait tool 收到 signal → resolve 摘边；子**继续跑**（M3 不级联；remove() 级联已有） |
| 4 | 用户 interrupt 子 | 子终态 interrupted → 父 wait 正常 resolve（见子 status）；suspended 父照常 promote |
| 5 | 树上节点 remove 时 parked 队列残留 | drain/remove 双清：出队前 `registry.has(path)` 兜底 |
| 6 | wait 图边泄漏 | beginWait 返回的闭包带 finally 语义；host 销毁（wipe）时清空 |
| 7 | 上游 AgentTool 签名漂移 | contract test 断言 execute/waitForIdle/steer 的可观测行为（M1 已有的契约式护栏，M3 扩样本） |
| 8 | 状态漂移（prompt 非法跃迁被吞）| 用 requestRun 单一入口收敛：终态归位 → 闸门 → running/parked，杜绝 `setStatus 吞错` |
| 9 | budget frozen 后用户想继续 | 明确拒绝 + 事件提示；复苏走重启（M3 明确如此，不做 UI 开关） |

## 七、实施计划（切片，每步可独立验证）

> **进度（2026-09-13）**：切片 1–7 ✅，收尾/验收待做。

- [x] **切片 1 ✅**（kernel）：`budget.ts`（BudgetGuard 阀值跃迁一次性）+ registry 闸门重构（running-only 计数 / idle→waiting / `promote()` 免检）+ fork 后代校验（`assertWaitable` 限后代 + `isDescendantOf`）。单测 75 例全绿。
- [x] **切片 2 ✅**（kernel）：`engine.steer()` 进 AxonEngine 五方法之一（pi `Agent.steer` 的透传，0.85.1 dist 已确认「injected after the current assistant turn finishes」）。契约测试改用 `createAxonEngine` + steer 时序（9 例）。
- [x] **切片 3 ✅**（host）：`requestRun`（终态归位 + 闸门 + parked FIFO）/ `beginWait`/`endWait`（退位让额 + wait 图）/ `drain()`（先解父后补位）/ BudgetGuard 接线 / per-agent idle 看门狗 / `dispose()`。`host.orchestration.test.ts` 10 例全绿。
  - **两个实测逼出的补丁**（都进了 kernel/provider.ts）：
    1. faux `setResponses` 的消费语义是「每轮 LLM 调用 shift 一条」，多 Agent 交错时与引擎异步启动有竞态——新增 `scriptedSource`（按最近一条 user 消息文本路由，永不耗尽）作为多 Agent 测试的确定性来源。
    2. `withTurnCost` 漏 await async streamFn（`for await` 不会 await 裸 Promise）→ 全链路 TypeError——补 await。且 `agent-loop` 的 done 分支用 `response.result()`（EventStream 的 `resolveFinalResult` 由 done 事件的 `isComplete` 触发）而非事件 payload——终值与 done 事件要双写成本。
- [x] **切片 4 ✅**（main/orchestrator.ts）：`OrchestrationDriver` 接口 + 六工具双闭包工厂（agent / agent_wait / agent_check / agent_message / agent_resume / agent_interrupt）。不 import electron/host，FakeDriver 单测 13 例全绿。
  - **两个落地时定型的小决策**（与 §4.6 草案的微调，测试钉死）：
    1. driver.beginWait 改为 Promise 形态（`beginWait(targets): Promise<void>` + `endWait()`），工具 execute 里 `await` 即挂起——宿主已实测支撑；§4.6 草案的「返回回调」形态没采纳。
    2. `agent_resume` **不 await** requestRun（fire 语义）：额满时目标进 parked 排队、Promise 直到跑完才 resolve，工具若 await = 父占着额度等一个没额度的子，`maxConcurrent=1` 时结构性死锁。等结果必须走 agent_wait（退位让额）。
- [x] **切片 5 ✅**（roles.ts + host 装配）：七个内置角色全部白名单 + 六件套（决策 #1 全员全件套）；host `spawn` 现造并 bind 工具集——`toolsFor` = 宇宙叶子工具 + 白名单裁剪后的编排工具；`steer()` / `driverFor()` / `orchestrationToolsFor(path, allowSet)` 公开面。集成测试 6 例（真实 host × 真工具：agent spawn 子 → 子跑完 → wait 拿终态 → check 摘要 → resume 拉起 → 冻结直达 agent 工具拒 spawn）。
- [x] **切片 6 ✅**（UI 预算条）：App 订阅 budget.warning / budget.frozen → banner（黄→红）+ 日志；frozen 禁用 Composer 输入与发送（中断保留）；冒烟钩子 `AXON_SMOKE_SCRIPT` / `AXON_SMOKE_BUDGET_COST` / `_HARD`（只冒烟生效）；ui-smoke 新增第 5 幕「两轮 prompt 走完 warning→frozen」（banner + 输入框禁用断言）。
- [x] **切片 7 ✅** E2E 集成测试（`main/orchestration.e2e.test.ts`，真实 pi 引擎 × AxonHost）：幕 1 三幕 happy path（spawn→wait→resume→wait→收尾，工具参数从 LLM 转录 toolResult 文本解析，回复门钉死 wait 挂起点）；幕 2 gate=1 死锁免检（父占唯一额度 spawn 双子全 parked → 父退位 → FIFO 串行补位 → 父唤醒收尾，铁证 d1 done 事件先于 d2 running 事件）。配套升级 `scriptedSource` 路由工厂签名为 `(context, callIndex)`（读转录 + 同文本多轮序列）。
- [ ] **切片 8** 收尾：`bun run check` 全绿 + 文档同步（§十）+ 语义化 commit

## 八、测试策略

- **单测（kernel）**：BudgetGuard（阈值、跃迁只报一次、record 返回状态）；registry 闸门新语义（6 例）；fork 后代校验（4 例，含边界）
- **单测（main/orchestrator.ts × fake driver）**：六工具逐一 + 组合（spawn→wait、wait 超时、message 时序、interrupt/resume 边界、非后代全抛）
- **集成（host.test.ts 扩）**：真实 `AxonHost`（模式=faux）跑 `host.execute('agent.spawn' ...)`、`agent.prompt` 新语义 → 状态序列断言；gate=1 死锁路径；budget 事件序列
- **契约测试**：engine.steer 与 AgentTool.execute 行为的真实现实对齐（用真实 pi Agent + faux provider 跑真实 transcript）
- **端到端**：`scripts/ui-smoke.mjs` 扩展开预算/仪表开关；`bun run ui-smoke` 一次命令全链路（含 planner→developer 假流程）

## 九、验收标准

- [ ] 6 个编排工具在 faux 下真实可用：模型（脚本）spawn 子 Agent → 子跑完 → 父等到结果继续，全事件流正确
- [ ] gate=1 下「父等 2 子」完跑（无死锁、无状态漂移、waiting 状态正确出现在 UI 快照）
- [ ] 预算熔断：记录到 80% 发 warning、100% 发 frozen、frozen 拒绝新 spawn/prompt、在跑不受影响
- [ ] 死锁不可能性：非后代 wait 全部被 struct 抛错（4 例单测外，集成随一条）
- [ ] watchdog：无活动 5min 的 running Agent 被 interrupt（测试用缩时 5s；断言「按空闲而非总时长」：拍拍即归零）
- [ ] `bun run check` 全绿，**114 例以上**
- [ ] `bun run ui-smoke` 通过
- [ ] 文档同步（§十）+ M3 状态收尾

## 十、文档同步（完工后）

- `docs/03-实施框架与里程碑.md`：§1 表 M3 → 已完成+证据；§2 完成区补 M3 条目；§3 规划区删除 M3 段
- `docs/01-架构决策-方案B.md`：§1 表格 6.5 行 → ✅（含证据）；§8 风险表「预算熔断待 6.5」→ 🔒；§9「接下来」M3 移除
- `docs/milestones/M3-orchestrator.md`：状态改已完成；§四/五与实际代码同步（如有出入）；验收清单打钩
- `AGENTS.md`：不变量 §5 补充「编排工具只能由 host/orchestrator 发放；tools universe 必须由 roles whitelist 解出」

## 十一、里程碑决策记录

- **开工拍板（2026-09-13）**：M3 是「自主派发（工具驱动）」的第一个里程碑——手动指派（用户在 UI spawn）M2 已交付；01 §7「两者都要、先手动」因此落账：手动 ✅（M2），自主 ✅（M3）。§〇 五条决策全部拍板：编排工具全员全件套（用户否决推荐矩阵，取最大自由度，风险交预算熔断抢底）、闸门重构、wait 限后代、熔断不杀在跑、超时不杀子 + idle 看门狗。
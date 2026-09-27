# M8 叶子工具层：方案设计与实施计划

> 状态：**设计评审中** → 实施中 → 已完成
> 日期：2026-09-27
> 对应架构：01 §6（工具层）｜ 依赖里程碑：M7（打包）+ M6（真实模型）+ M4（审批门）
> 前置文档：`03-实施框架与里程碑.md`（§4 模板、§0 工作流约定）

---

## 〇、缘起（本里程碑为什么现在做）

M3 以来所有里程碑做的都是「Agent 编排 + 产品化 UI + 真模型接入」，**始终没有交付叶子工具层**。`apps/desktop/src/main/index.ts:400` 明确写着「叶子工具：生产路径下为空（M4 不交付叶子工具）」，`AxonHost` 只在 `SMOKE` 冒烟模式下注入一个 `smoke_echo`（`index.ts:429`）。

后果是**声明与实现不对齐**：`roles.ts:25-28` 的角色白名单声明了 `read/grep/glob/ls/edit/write/bash`，模型据此以为自己能动手，于是发出 `bash` 调用；但宿主 `toolsFor`（`host.ts:2003-2014`）拼出的工具集里只有 7 个编排工具，agent-loop 按名精确匹配失败，回灌 `Tool bash not found`（现象见用户截图）。

本里程碑补齐这一层，让 Agent 能真正读写文件、跑命令、检索代码。

---

## 一、目标与范围

**用户可见能力（一句话）**：在会话里问「当前工作目录是什么」「改一下这个文件」，Agent 能真正执行 `bash`/`read`/`edit` 等工具并给出真实结果，而不是 `Tool X not found`；危险操作按会话审批档弹 HITL banner。

**本里程碑内做什么**：
1. 实现 7 个叶子工具的**身体**：`read` / `write` / `edit` / `ls` / `glob` / `grep` / `bash`（名字与 `roles.ts` 白名单严格对齐）。
2. 叶子工具**按会话 cwd 现造**（per-spawn bind，与编排工具 bind `selfPath` 同构），所有路径解析与命令执行都锁在会话工作目录内。
3. 接通既有 M4 审批门：叶子工具默认受 HITL 拦截（`approval.ts` §D5 已把「非编排工具 = 叶子工具」判定好），`always_ask` 角色动手前弹 banner。
4. `write`/`edit`/`bash` 走审批；`read`/`ls`/`glob`/`grep` 为只读，按审批档决定是否豁免。

**明确不做什么（防蔓延）**：
- **不做**多执行器后端（`SessionExecutor` 的 `team`/`adhoc` 语义不变，本期只让 `engine` 路径拿到工具）。
- **不做**沙箱/容器隔离（bash 直接在 cwd 下跑；越权防护靠 cwd 收敛 + 审批门，容器化留给后续里程碑）。
- **不做**流式工具输出（工具结果整块返回，与 MU-2「不接流式工具」台账一致）。
- **不做**工具级细粒度权限配置 UI（本期沿用角色白名单 + 审批档两道闸）。
- **不做**跨会话/跨 cwd 的文件访问（路径逃逸一律拒绝）。

---

## 二、现状盘点

| 组件 | 当前形态 | 文件:行 |
|---|---|---|
| 工具集装配 | `toolsFor` = 叶子工具（空）+ 编排工具，按白名单过滤 | `host.ts:2003-2014` |
| 叶子工具 universe | 生产为空，冒烟注入 `smoke_echo` | `index.ts:400,429` |
| 工具样板 | `smokeEchoTool()` 演示了 `{name,description,parameters,execute}` 形状 | `index.ts:344-353` |
| 编排工具（同构参照） | per-spawn bind `selfPath`，`createOrchestrationTools(driver)` | `orchestrator.ts:423-433` |
| AgentTool 类型 | `execute(toolCallId, params, signal) => AgentToolResult` | `orchestrator.ts:43-45,104-106` |
| 审批门 D5 | 非编排工具即叶子工具 → 过 HITL | `approval.ts:19-24,36-38` |
| 审批门接线 | `onBeforeTool` 白名单 + HITL | `host.ts:814,1204` |
| 会话 cwd | 建会话时解析并固化到 record.cwd，透传 systemPrompt | `host.ts:621,648,806-808` |
| 角色白名单 | `READ_ONLY`/`READ_WRITE` 已含叶子工具名 | `roles.ts:25-28` |
| DSML 工具名归一 | 解析时统一小写，工具 id 必须全小写 | `provider.ts:416-419` |

**关键缺口**：`this.tools` 是构造期一次性设定的**扁平 universe**，全会话共享，不带 cwd。而 `bash`/`read`/`edit` 必须知道「在哪个目录里跑」。所以叶子工具不能像现在这样塞进 universe，必须改成**按 path 现造并 bind 该会话的 cwd**——这是本里程碑最核心的结构改动。

---

## 三、设计依据（同类产品调研）

用户指定参照 `~/works/prjs/agents/pi` 与 `~/works/prjs/agents/codex`。结论：**pi 的 `@earendil-works/pi-coding-agent` 是可直接照搬结构的一等参照，codex 是安全模型的二等参照**。

### 3.1 pi：`packages/coding-agent/src/core/tools/`（主参照）

pi 的工具层与 axon 高度同构，且共用同一个 `@earendil-works/pi-agent-core` 的 `AgentTool` 接口（axon kernel 已经 re-export 它，见 `orchestrator.ts:43`）。可直接借鉴的四个模式：

1. **cwd-bound 工厂**（`tools/index.ts:91`）：`createTool(toolName, cwd, options)` / `createToolDefinition(...)`——工具在「知道 cwd」的那一刻现造。这正是 §二 缺口要的东西，axon 的 per-spawn 绑定照抄此形。
2. **可插拔执行后端**（`bash.ts:60` `BashOperations.exec(command, cwd, {onData,signal,timeout,env})`）：把「怎么跑命令」抽成可注入接口，`createLocalBashOperations()` 是默认本地实现。**测试用假 ops、未来 `team`/`adhoc` 执行器换后端**都靠它，不用改工具本体。axon 直接采纳这个 DI 边界。
3. **cwd 收敛与路径解析**（`path-utils.ts:52` `resolveToCwd(filePath, cwd)`）：所有相对路径都相对会话 cwd 解析，含 macOS NFD/窄空格等健壮性处理。axon 的越权防护第一道闸就靠它。
4. **输出截断**（`truncate.ts` / `output-accumulator.ts`）：`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES` 防止大输出撑爆 transcript。axon 沿用。

**关键取舍 D1：移植，不整包 import。**
- pi-coding-agent 把工具执行体与 `@earendil-works/pi-tui` 的渲染（`theme.ts`、interactive components，见 `bash.ts:4-8`）耦合在一个包里；axon 只依赖 `pi-agent-core` + `pi-ai`（`kernel/package.json:12`），有自己的 React UI，不想拖进 TUI 渲染栈。
- 因此：在 `packages/kernel/src/tools/` **按 pi 的结构移植逻辑**（工厂签名、`BashOperations` DI、`resolveToCwd`、截断），**丢弃 TUI 渲染层**，`execute` 只产出 `AgentToolResult`（`{content, details}`），渲染交给 axon 现有前端。接口用共享的 `AgentTool`，天然兼容引擎。

**命名对齐**：pi 用 `find`，axon 的 `roles.ts:25` 白名单写的是 `glob`。本期以 **axon 白名单为准**（`read/write/edit/ls/glob/grep/bash`），移植 pi 的 `find` 逻辑但对外注册名为 `glob`，语义为「按 glob 模式列文件」。避免动 roles.ts 造成白名单漂移。

### 3.2 codex：`codex-rs/execpolicy` + `sandboxing`（安全模型参照）

codex 是 Rust，不能复用代码，但其安全分层印证了 axon 的方向、并给出后续演进锚点：
- `execpolicy/`（`policy.rs`/`rule.rs`）：命令级白/黑名单策略——对应 axon 本期的「角色白名单 + 审批门」两道闸，本期不做命令级策略，记为后续。
- `linux-sandbox` / seatbelt / `bwrap`：进程级沙箱。axon 本期**不做**沙箱（决策 §一），靠 cwd 收敛 + HITL 兜底；codex 的分层证明沙箱应是独立里程碑，不塞进 M8。
- `apply-patch/`：codex 的结构化补丁工具，比裸 `edit` 更安全。axon 的 `edit` 本期用「精确串替换」（对齐 pi 的 `edit.ts` 做法），apply-patch 式留待后续。

**采纳清单**：cwd-bound 工厂 + BashOperations DI + resolveToCwd 收敛 + 输出截断（全部来自 pi）；命令级 execpolicy 与进程沙箱**明确延后**（codex 证明其应独立成里程碑）。

---

## 四、总体设计

### 4.1 模块落点

```
packages/kernel/src/tools/           # 新增：叶子工具层（移植自 pi，去 TUI）
  index.ts        # createLeafTool(name, cwd, ops?) / createLeafTools(cwd, ops?)
  path-utils.ts   # resolveToCwd —— cwd 收敛与逃逸拒绝
  truncate.ts     # 输出截断（DEFAULT_MAX_BYTES/LINES）
  read.ts write.ts edit.ts ls.ts glob.ts grep.ts bash.ts
  ops.ts          # BashOperations 等可注入后端 + createLocalOps()
```

工具只依赖 `pi-agent-core` 的 `AgentTool` 类型 + Node fs/child_process，**不引 pi-tui、不引 Electron**——保证 kernel 纯净、可单测。

### 4.2 核心结构改动：叶子工具按 cwd 现造

现状 `this.tools` 是构造期扁平 universe（`host.ts:300`），不带 cwd，无法承载叶子工具。改法与编排工具 `createOrchestrationTools(driver)` 同构：

- `toolsFor(path, roleTools)`（`host.ts:2003`）改为：
  1. 由 path 定位其所属会话，取 `record.cwd`（`host.ts:648` 已固化）。
  2. `createLeafTools(cwd, ops)` 现造该会话的叶子工具集。
  3. 与编排工具合并，再按 `roleTools` 白名单过滤。
- `AxonHost` 构造不再持有叶子工具 universe；`smokeEchoTool` 保留但改为经同一工厂注入，冒烟链路不变。

### 4.3 审批与安全（复用 M4，不新建机制）

- 审批门 `approval.ts` §D5 已判定「非编排工具 = 叶子工具 → 过 HITL」（`approval.ts:19,36`），叶子工具落地后**自动**受管，无需改审批代码。这正是 M4 注释里预告的「等 M6/M7 有了真叶子工具再谈放开」。
- 只读工具（`read/ls/glob/grep`）与写工具（`write/edit/bash`）都过 `onBeforeTool`；是否豁免只读由**会话审批档**决定（`always_ask` 全拦，`auto` 放只读、拦写，`full_access` 全放）——档位语义沿用 M4，本期只在门内按「工具是否只读」分流。
- 越权防护两道闸：① `resolveToCwd` 把路径钉死在会话 cwd 子树内，逃逸（`../` 越界、绝对路径越界）直接返回 error toolResult；② bash 的 cwd 固定为会话 cwd，env 走 `createLocalOps` 的受控环境。

---

## 五、关键流程

### 5.1 一次 bash 调用的完整链路

```
模型发 DSML bash 调用
  → provider 解析、工具名归一为小写 (provider.ts:419)
  → agent-loop 按 name 匹配 → 命中 createLeafTools 现造的 bash（不再 not found）
  → onBeforeTool(name='bash', args) 闸门 (host.ts:814)
      · 白名单：bash 是否在该角色 tools 内？否 → deny(reason)
      · HITL：审批档决定拦/放，always_ask → 弹 banner 等人批
  → 放行后 execute(id, {command}, signal)
      · ops.exec(command, 会话cwd, {onData, signal, timeout, env})
      · 输出经 OutputAccumulator 截断
  → 返回 { content:[{type:'text', text: 输出}], details:{exitCode, truncation} }
  → 引擎回灌 toolResult，模型据此续答
```

### 5.2 越权拒绝流程（read/edit/write/ls/glob/grep）

```
execute 收到 path
  → resolveToCwd(path, cwd)
  → 解析结果若逃出 cwd 子树 → 不落盘，返回 error toolResult
    "path escapes session working directory: <path>"
  → 否则正常读写
```

### 5.3 冒烟兼容

`smoke_echo` 改由叶子工具工厂注入（无害、无 fs/exec 副作用），`SMOKE` 链路与 `ui-smoke.mjs` 断言不变；同时新增一条冒烟：`动手` 前缀触发真实 `read` 一个固定只读文件，验证叶子工具端到端跑通 + 审批 banner。

---

## 六、边界情况与风险

| # | 情况 | 处理 |
|---|---|---|
| B1 | 路径逃逸（`../`、绝对路径越界） | `resolveToCwd` 拦截，返回 error toolResult，不落盘 |
| B2 | bash 长跑/挂死 | `signal` + `timeout`（默认无超时，模型可传）；abort 时 `killProcessTree` 清子进程（照抄 pi `shell.ts`） |
| B3 | 大输出撑爆 transcript | `truncate` 头/尾截断 + `details.truncation` 标注，超限写全量到临时文件并回 `fullOutputPath` |
| B4 | `edit` 的 old_string 不唯一/不存在 | 对齐 pi `edit.ts`：非唯一或零匹配报错，不做模糊替换 |
| B5 | 会话 record 无 cwd（异常态） | 回退 `runtime.defaultCwd ?? process.cwd()`（与 `host.ts:621` 一致），并记 issue |
| B6 | 并发写同一文件 | 复用 pi `file-mutation-queue.ts` 串行化，避免交错写 |
| B7 | `always_ask` 角色被叶子工具卡住 | 这是**预期**行为（M4 D5）；审批 banner + 超时（`approvalTimeoutMs`，默认 5min）兜底 |

**风险**：
- **R1 移植工作量**：pi 工具带截断/健壮性细节多。缓解：分工具增量交付（先 read/ls/glob/grep 只读四件，再 write/edit/bash 三件），每件独立可测。
- **R2 pi-tui 耦合残留**：移植时须剔净 `theme`/interactive import。缓解：kernel 的 lint 加禁止 import `pi-tui`/`electron` 的规则，CI 卡住。
- **R3 白名单命名漂移**（find vs glob）：以 roles.ts 为准，移植层做名字映射，加一条单测断言注册名集合 == `roles.ts` 白名单集合。

---

## 七、实施计划（增量、可回退）

> 每步独立提交、独立可测；只读工具先行，写/执行工具压后（风险递增）。

- **S1 脚手架 + cwd 现造**：建 `packages/kernel/src/tools/`，落 `path-utils`（resolveToCwd）、`truncate`、`index`（`createLeafTools(cwd, ops)`）；改 `toolsFor` 从 record.cwd 现造叶子工具并合并过滤。此步先只注册 `read`，端到端打通「not found → 有结果」。
- **S2 只读四件**：`read` / `ls` / `glob`(移植 find) / `grep`。移植 pi 逻辑去 TUI，补 cwd 收敛。
- **S3 写两件**：`write` / `edit`（含 file-mutation-queue 串行化、edit 唯一匹配约束）。
- **S4 bash**：移植 `BashOperations` + `createLocalOps`（shell env、killProcessTree、超时）。
- **S5 审批联调**：验证 D5 对七件工具生效；只读/写在各审批档下的拦放分流。
- **S6 冒烟兼容**：`smoke_echo` 改经工厂注入 + 新增「动手→真实 read」冒烟断言，`ui-smoke.mjs` 绿。
- **S7 lint 护栏**：kernel 禁 import `pi-tui`/`electron`；名集合一致性单测。

---

## 八、测试策略

- **单元**（`packages/kernel/src/tools/*.test.ts`）：每件工具注入**假 ops**测纯逻辑——read 命中/缺失、edit 唯一/非唯一/零匹配、glob 模式、grep 命中、bash 退出码/超时/abort、截断阈值；`resolveToCwd` 逃逸用例矩阵（`../`、绝对路径、符号链接）。
- **契约**：断言 `createLeafTools(cwd)` 注册名集合 === `roles.ts` 白名单叶子工具集合（防漂移，R3）。
- **审批集成**：三档 × (只读/写) 的拦放矩阵，复用 M4 审批测试骨架。
- **E2E/冒烟**：`ui-smoke.mjs` 走「动手→真实 read→结果回灌」；对齐 §5.3。
- **越权安全**：路径逃逸、bash cwd 固定、大输出截断三类必测。
- 全程 `bun test` + 既有 lint/typecheck；CI 卡 R2/R3 护栏。

## 九、验收标准

1. 会话里问「当前工作目录是什么」→ Agent 调 `bash pwd` 得到真实 cwd，**不再 `Tool bash not found`**（复现用户截图场景并转绿）。
2. 七件叶子工具全部注册、可执行、名字与 `roles.ts` 白名单一致。
3. `always_ask` 角色执行写/bash 前弹 HITL banner；`auto` 放只读拦写；`full_access` 全放。
4. 路径逃逸、大输出、bash 超时/abort 均有明确、非崩溃的降级。
5. kernel 不含 `pi-tui`/`electron` import；单测 + 冒烟 + lint/typecheck 全绿。

## 十、文档同步（§0.2 收口）

- 更新 `03-实施框架与里程碑.md` 里程碑清单：M8 状态与「叶子工具层」条目。
- 更新 `01` §6 工具层：从「编排七件套 + 叶子留空」改为「编排 + 七件叶子工具（cwd-bound）」。
- `index.ts:400` 的「M4 不交付叶子工具」注释改为指向本文档与实际交付状态。
- 完成后本文件头部状态置「已完成」，补「实际与设计的偏差」小节（若有）。


# M16 成本熔断下线：方案设计、实施计划与实测

> 状态：**已完成（2026-10-10）**
> 决策来源：用户口述 —— 2026-10-09「你不要受新建会话中的任务预算上限功能限制呀，这个功能我后期会干掉」、
> 2026-10-10「现在就帮我把预算功能删掉吧」
> 依赖里程碑：M3（预算熔断首次落地）、MU-1（三层限额）、MU-3（S6 预算屏）
> 纪律：本片**动了四层**（kernel / protocol / 主进程 / 渲染），跨层删字段的清单逐条列在 §二，越界即返工

---

## 一、目标与范围

**用户可见能力（一句话）**：Axon 不再有「花超了就不许开工」这回事 —— 顶栏不再有预算档位 chip、
S6 从「预算与用量」缩成纯「用量」、团队与会话编辑器里不再有软线/硬线输入框；
花了多少钱照旧看得见。

### 1.1 做什么

1. **删熔断本体**：`BudgetGuard`（软/硬线、ok/warning/frozen 三档、frozen 终态）整块删除，
   连同 `spawn` / `prompt` / `升级` 三个入口上的 `assertCanStart` 拒止
2. **删三档限额的协议面**：`SessionBudgetSpec` / `BudgetTier` / `SessionBudgetView` /
   `BudgetSnapshot` / `budget.warning` / `budget.frozen` / `budget.get`
3. **删配置项与团队档**：`AxonConfig.budgetUsd` / `budgetSoftUsd`、`TeamDefinition.budget`
4. **保留用量**：`UsageTotals` 与记账链路一行不动 —— 「花了多少」与「拦不拦」是两件事

### 1.2 明确不做（防蔓延）

- **不动并发闸门**：`maxConcurrent` 那条线（running-only + parked FIFO）与成本无关，是防打爆网关的，**留**
- **不做用量历史/账期**：不引入按日切分、不做趋势图。协议里没有带时间戳的用量序列，
  画出来就是假数据（`apps/desktop/src/renderer/components/S6Usage.tsx:1-13` 的文案纪律）
- **不迁移旧数据**：旧 `config.json` / 旧团队文件 / 旧会话记录里的 `budget` 字段**读出即忽略**，
  不迁移、不报错、`SESSION_SCHEMA_VERSION` 不升（`packages/protocol/src/session.ts:258-266`），
  因为没有任何字段改变语义或需要回填

---

## 二、删除清单（按层）

| 层 | 文件 | 删掉的东西 |
|---|---|---|
| L1 kernel | `packages/kernel/src/budget.ts`（整文件） | `BudgetGuard` / `BudgetLimits` / `BudgetState`；`index.ts:55` 留指路注释 |
| 协议 | `packages/protocol/src/session.ts:258` | `SessionBudgetSpec` / `BudgetTier` / `SessionBudgetView`；`SessionRecord.budget` / `SessionSummary.budget` / `CreateSessionPayload.budget` |
| 协议 | `packages/protocol/src/config.ts:202` | `AxonConfig.budgetUsd` / `budgetSoftUsd`（含 `ConfigPatchPath` 与 `CONFIG_FIELD_SPECS` 两条） |
| 协议 | `packages/protocol/src/team.ts` / `ipc.ts` | `TeamDefinition.budget` + `budgetLabel` / `BUDGET_TIER_LABEL`；`budget.get` / `BudgetSnapshot` / `BudgetEventPayload` / 两条 `budget.*` 事件 |
| L2 主进程 | `apps/desktop/src/main/host.ts` | `budgetState()` / `budgetSnapshot()` / `budgetViewOf()` / `assertSessionCanStart()`、`sessionTiers` 观测表、`RuntimeConfig.globalBudget`、turn.end 里的两段跃迁播报 |
| L2 主进程 | `session-store.ts` / `team-loader.ts:271` / `teams.ts` | `computeEffectiveBudget()`；团队预算校验（内核不再有该字段）；三个内置团队卡上的 `budget` 字面量 |
| L3 渲染 | `components/S6Budget.tsx`（整文件） | 换成新的 `components/S6Usage.tsx`（纯用量：三指标 + 按会话排行 + 成本构成 + 已结束会话） |
| L3 渲染 | `Chips / S1Workbench / S2Views / S3Teams / Shell / Sidebar / selectors / store / Models.tsx` | 档位 chip 三态类名与限额文案、成员树上的预算卡、团队表单的软硬线输入框、设置页「预算」一节、`strictestTier()` 选择器、`budgetAlert` 状态与两条事件订阅 |
| 冒烟 | `scripts/ui-smoke.mjs` | 第 7 幕「预算熔断」整幕（warning→frozen 两段 UI 断言）；`budget-*` 挂点改 `usage-*`；env 由 `AXON_SMOKE_BUDGET_COST/_HARD` 改为 `AXON_SMOKE_TURN_COST` |

---

## 三、实施中发现并修掉的问题（设计 vs 实测偏离）

### 3.1 `usage.get` 快照是个「只会读一次的谎」（本片新增并撤掉）

上一轮删预算时新开了 `usage.get` 命令 + `UsageSnapshot`，S6 的「累计已用」/顶栏 chip / S1 都读它。
**实测发现它是坏的**：该快照只在 store 启动那一次拉取（`store.tsx` bootstrap），
此后**没有任何事件推它** —— 开机后花的每一分钱都进不去，屏上永远停在开机值。

- 为什么 `budget.get` 当年可以有快照：frozen 是**终态**，没有事件通道，UI 刷新后就瞎了，
  所以必须有查询通道（MU-3 拍板 P-8 的上下文）。
- 用量没有这个问题：会话摘要本来就有 `session.changed` 推着走，是**实时**的；
  再叠一份只读一次的快照，等于给同一个数造两个真相源，其中一个还是死的。

**处置**：整条快照链路撤掉（`usage.get` / `UsageSnapshot` / `AxonHost.usageSnapshot()` /
构造期的 `restoredUsage` 种子），渲染层三个消费点改为从 `session.list` 摘要现算
（`totalUsage(sessions)`）。唯一真相源 = 会话摘要（含已结束会话的落盘 `rollup`）。
冷启动「累计不是 0」这条不变量由摘要承接，断言随之改打在摘要上
（`apps/desktop/src/main/host.restart.test.ts` 的「累计用量接着上次算」一例）。

### 3.2 冒烟里的用量变成空壳

删掉成本注入后 faux 的 `cost` 恒为 0（`pi-ai/dist/providers/faux.js:147`），
而 S6 的会话行有 `costUsd > 0` 过滤 —— 断言会「假绿成空态在」。
故把注入改名为 `AXON_SMOKE_TURN_COST`（`apps/desktop/src/main/index.ts:351`）并对**每一轮**计费
（原先只给含「烧钱」的 prompt 计费，理由是 frozen 是终态、会把后面的幕次一起冻住 —— 现在没终态了），
断言从「结构在」升格为「取真值（非 `$0.00`）」。

### 3.3 一处被顺手改对的口径重复

S1 的「累计花费」卡里原本有两行同值数（卡面 `totalCost` 与副题「全局已用 `budget.spentUsd`」）。
两者现在是**可证相等**（同一个和的两种算法），故副题里那半句删掉，只留「跨 N 个会话」。

---

## 四、质量门结果

| 检查 | 结果 |
|---|---|
| `bun run guard` | ✅ 全部通过（pi import 白名单未放宽） |
| `bun run typecheck` | ✅ root + renderer 双绿 |
| `bun run test` | ✅ **681 例全绿**（删掉的预算用例不计，无回退） |
| `bun run build:desktop && bun run verify-lazy` | ✅ main.mjs 404 KB / renderer.js 1518 KB，懒加载未被破坏 |
| `bun run ui-smoke` | ✅ 全幕通过；S6 幕取真值 **$0.30**（6 轮 × $0.05，faux 无成本，靠注入） |
| `bun run dev` 手工 | 🟡 待用户验收（S6 导航名「用量」、设置页无「预算」一节、团队表单无软硬线） |

---

## 五、残留与台账

1. **03 §1 状态表缺 M10~M14 行**（M10/M11 督导能力、M12~M14 知识库）——
   属既有文档漂移，非本片引入。本片先补 M15/M16 两行，**M10~M14 五行于同日单独回填**
   （含三份文档的状态行与「实施回填」段，依据是代码取证与 commit，而非当时的文档勾选）
2. **冒烟断言计数口径已经不统一**：MU-3 文档记的「41 条断言」是当时的数，
   而脚本现在的 `log()` 调用点已远多于它（`git show HEAD:scripts/ui-smoke.mjs` 里 71 处）。
   本片只删第 7 幕的 3 条、把 S6 幕由 1 条扩成 2 条 —— **不做全量数字回填**，
   数字口径等下一次冒烟大改时一起收口
3. **`test.py`**（仓库根，未跟踪）：一个调阿里云百炼 embedding 的临时脚本，内含明文 API key，
   待用户决定去留
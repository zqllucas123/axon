# MU-1 会话容器与团队层：方案设计与实施计划

> 状态：**设计评审中**（2026-09-15）→ 实施中 → 已完成
> 对应架构：01 §5（分层与适配器边界）/§6.1（AgentRegistry）/§6.3（RoleLoader 同族）；UX `02-团队与会话模型.md` §2.2 四层模型
> 依赖里程碑：M4（已完成，274 测试 + ui-smoke 九幕）
> 上游拍板：用户 2026-09-15（见 §〇）；UX 缺口：G10.1~G10.6、G11.1~G11.3、G11.12
> 纪律：所有论断带 `文件路径:行号`；行号以 2026-09-15 工作树（commit `97213d9`）为准

---

## 〇、用户拍板记录（2026-09-15）

| # | 决策 | 结论 |
|---|---|---|
| 1 | MU 切分 | **三段推进**：MU-1 协议与主进程 → **M5 持久化** → MU-2 渲染主干（S0/S2-solo/S2/S1/S3）→ MU-3 收尾屏（S5/S6/S8）。每段独立收口（方案文档 + 质量门 + commit） |
| 2 | 主题 D-3（UX 03 §7） | **以设计稿浅色为准**：实现换 `axon.css` 的暖灰三层令牌，深色留 `[data-theme=dark]` 后补 |
| 3 | M5 位置 | **MU-1 → M5 → MU-2/MU-3**：会话容器落地后立刻接持久化，再做 UI（左栏「最近」与 S7 从第一天就是真的） |
| 4 | 审批链问题（UX 03 §7.1） | **本次一并修 ②**（lead 一律 `always_ask` + 代批规则显式化）；①（档位不按工具）与③（生产路径叶子工具为空）留给 M6 前单独立项 |
| 5 | 团队模型五条（UX 02 §6） | **全部按原型倾向**：Agent 私有（团队 JSON 内嵌）/ 团队不嵌套 / 临时编队默认丢弃 + 会话尾提示 / 团队预算与全局取更严者 / 临时分身不算团队成员 |

---

## 一、目标与范围

### 目标（一句话）

把「会话」变成一等公民：新建会话（内置引擎 / 指定团队 / 临时编队）→ 会话内实例化成员树 → 账本与用量按会话切片 → 团队可持久化编辑；协议面补齐 G10，主进程具备 `config` 读写能力，为 M5 落盘与 MU-2 的 12 屏 UI 提供**真数据**。

### 本里程碑做什么

1. **协议**：新增 `session.*`（6 命令）/`team.*`（4 命令）/`config.get|patch`；`LedgerRecord.sessionId`、`LedgerQuery.sessionId|participant`、`PendingRequest.sessionId`；事件 `session.*`/`teams.changed`/`config.changed`/`approval.delegated`；信封加 `sessionId?`
2. **内核**：`AgentRegistry` 支持**多根**（一个会话一棵树）；账本加会话过滤；预算支持**三层限额**（全局 / 团队 / 会话，取更严者）
3. **主进程**：`SessionStore`（会话元数据 + rollup）、`TeamLoader`（`~/.axon/teams/*.json`，抄 role-loader 的校验/热重载/原子写）、`ConfigStore`（读写器 + env 覆盖报告）、host 装配（会话创建/升级/删除、spawn 按会话、审批修复②）
4. **最小可用会话壳**（临时，MU-2 整体替换）：左栏加会话列表 + 新建会话，spawn 挂到当前会话，面板按会话过滤 —— 目的只有一个：**质量门在本里程碑仍可过**（`bun run dev` 与 `ui-smoke` 不掉）
5. 测试与文档：新增单测/集成测试；01 §1、03 §1/§3、UX 02 §5 缺口状态回填

### 明确不做什么

- **不做 UI 设计稿落地**（S0/S2/S1/S3 的视觉与交互全在 MU-2；S5/S6/S8 在 MU-3）——本里程碑的壳是调试台风格的临时件
- **不做落盘**（M5；本里程碑只把 schema 与目录布局预埋好）
- **不引入真叶子工具**（问题③：`read`/`write`/`bash` 等；单独立项，M6 前）
- **不做工具风险分级**（问题①：档位仍按 Agent 不按工具）
- **不做团队嵌套**、不做「Agent 跨团队共享实体」（拍板 #5）
- **不做 session 级审批档**（审批仍按角色；链仍沿树向上）
---

## 二、现状盘点

### 2.1 协议层（`packages/protocol/src/`，699 行，无测试）

- 20 条命令 / 19 个事件，**没有任何 session 或 team 概念**：`ipc.ts:73-127`（CommandMap）、`:171-235`（EventMap）
- `AgentSnapshot.sessionId` **已存在**：`agent.ts:266`，注释写明「M4 取值 = path；M5 落盘后与 path 解耦」（`:262-265`）；实现 `packages/kernel/src/registry.ts:116,193`、`host.ts:448`
- `LedgerRecord` **无 sessionId**：`ledger.ts:64-96`（过滤维度只有 agent/subtree/action/adoption/status，`:108-120`）
- `NotificationEnvelope.source: AgentPath` **是必填**（`ipc.ts:49-55`）；`roles.changed`（`:194`）已经是「没有 agent 源」的先例
- 唯一的版本机制在账本：`LEDGER_SCHEMA_VERSION = 1`（`ledger.ts:42`）+ `LedgerRecord.version`（`:65`）；协议本身无版本号

### 2.2 内核层

- **单根注册表**：构造时恒建 `/root`（`registry.ts:108-118`），`remove(ROOT_PATH)` 直接抛（`:310`）；`depthOf` 相对 ROOT 计（`:158-163`）；`addUsage` 沿父链累加 ⇒ 根=全局总账（`:293-306`）；闸门 `activeCount` 全局计数、只数 running（`:141-153`、`:269-274`）
- 预算：`BudgetGuard` 单实例，`record(cumulativeUsd)` 按累计值判跃迁（`budget.ts:61-80`），`assertCanStart` 只拦新起点（`:83-96`）
- 账本：`record(spec)`（`ledger.ts:105`）/`settle`（`:156`）/`adopt`（`:178`）/`query`（`:207`）

### 2.3 主进程

- `host.ts` 982 行：`spawn` 默认挂 `/root`（`:415-479`）、三角合成（角色 → 父∩子白名单 → ForkMode）、`execute` switch（`:923-980`）、emit 点分布在 `:197/258/297/464/578/719/795/858/868/901/913`
- `index.ts:191-206` 构造 `AxonHost` 时 **`maxConcurrent` / `idleTimeoutMs` / `approvalTimeoutMs` / `adoptionPolicy` 一个都没传**，全走默认（`host.ts:149/150/152`）⇒ G11.2
- 唯一 IPC 出口：`index.ts:244-296`（`role.*` 三条 fs 类命令在 `index.ts` 直接处理，其余落 `host.execute`）
- 配置只读：`model-config.ts:56` `loadConfig` 无写入器；env 覆盖链 `:74-97`；脱敏 `:113`
- 团队层**完全不存在**：`roles.ts:38-156` 只有六内置角色；`~/.axon/` 下只有 `roles/`（`index.ts:58`）

### 2.4 渲染层（本次只做最小适配，MU-2 重写）

- 调试控制台三区布局：`App.tsx:289-317`（左 300px：RolePanel/AgentTree/LedgerPanel）；无导航、无右栏、无会话概念
- 深色硬编码：`renderer/index.html:11-20`（9 个颜色令牌）、`:23-26`；窗口底色 `index.ts:213`
- ui-smoke 依赖的契约：`scripts/ui-smoke.mjs`（`.role .name`、`data-smoke` 钩子、`/root/blank-1` 路径断言）

### 2.5 缺口对照（设计稿 → 本里程碑）

| 缺口 | 现状 | MU-1 后 |
|---|---|---|
| G10.1 `session.create` | 无 | ✅ 三执行方式 + 预算 + initialPrompt |
| G10.2 `team.list/save/delete` | 无 | ✅ + 内置团队（3 支） |
| G10.3 `session.get/list`（成员树） | 无 | ✅（`session.get` 直接返回 `members`） |
| G10.4 团队/会话级预算 | 只有全局 | ✅ 三层取更严者 |
| G10.5 `session.escalate` | 无 | ✅ 重建 lead 引擎（保 transcript）+ 实例化成员 |
| G10.6 `ledger.query` 会话过滤 | 无 | ✅ `sessionId` + `participant` |
| G11.1 config 写入器 | 无 | ✅ `config.get/patch`（白名单 + 原子写 + env 覆盖保护） |
| G11.2 HostOptions 未接线 | `index.ts:191` 没传 | ✅ 从 config 读（含 `approvalTimeoutMs`） |
| G11.3 `maxDepth` 无注入点 | `registry.ts:74` | ✅ 经 config → RegistryOptions |
| G11.12 全局默认审批档 | 无 | ✅ `defaultApproval`（角色未写时兜底，「只能更严」仍成立） |
| G11.9 主题 | 深色硬编码 |  MU-2（拍板 #2） |
| 问题② 静默代批 | `approval.ts:95-108` 放行无事件 | ✅ 见 §4.9 |

---

## 三、设计依据

| # | 依据 | 出处 |
|---|---|---|
| 1 | 四层模型：Agent 类型 → Agent（团队成员）→ Team → Session；团队不引入提权路径 | UX `02-团队与会话模型.md` §2.2 |
| 2 | 默认不组队（协作是成本不是福利）；单兵会话没有账本/穿透链 | UX 02 §3.1/§3.2 |
| 3 | 账本与用量主键是 `sessionId` ⇒ 全部进会话；作用域判据「看主键」 | UX 02 §3.4 |
| 4 | 左=会话之间 / 右=会话之内；会话列表不得展开子树 | UX 02 §3.6（用户拍板）+ 01 §2.1 硬规矩 0 |
| 5 | 落盘最小集 = 会话元数据 + `AgentSnapshot[]` + 各分身消息 + 账本切片 + 挂起请求 | UX `mockups/s7-sessions.html:80-84` |
| 6 | 分层与不变量：三角合成顺序、工具白名单父∩子、`Agent` 类型不泄漏、pi import 白名单 | AGENTS.md §5、01 §5 |
| 7 | M3 闸门语义：只数 running；parked FIFO；父退位免检 promote；wait 仅后代 ⇒ 死锁结构性不可能 | 03 §2 M3 记录、`registry.ts:141-153` |
| 8 | 审批两道闸互不覆盖：白名单管能碰什么，HITL 管多大程度放手；编排工具豁免（D5） | M4 §〇、`approval.ts:128-130` |
| 9 | 团队/角色文件纪律：校验纯函数 + 坏文件隔离 + 原子写 + watch 去重 | `role-loader.ts:43/115/217`、`role-bridge.ts:69` |
| 10 | 配置生效性必须可见（env > 文件，被覆盖的控件置灰说明） | UX 03 §4.2 |

---

## 四、总体设计

### 4.1 会话路径与多根注册表（本里程碑最关键的结构决策）

**决策：`AgentRegistry` 支持多根；一个会话 = 一棵树，会话根路径 = `/<sessionId>`；删除恒存在的 `/root`。**

理由（三条）：

1. **与设计稿一致**：S2/S1 的成员树顶层就是会话的 lead（单兵会话就是「内置引擎」一行），没有「应用根」这一层（`mockups/assets/shell.js:172-203`）；UI 展示 `sessionId` 相对路径（根 → `/0`，子 → `/0/<role>-<n>`）。
2. **深度语义干净**：`maxDepth` 以会话根为 0 计（lead=0 → 成员=1 → 孙=2），与今天 `/root` 为 0 完全同构；若保留 `/root` 再挂会话节点，深度计算要跳两层。
3. **M5 对齐**：落盘单位是会话，会话根 = 消息文件与树结构的天然锚点（`s7:80-84`）。

接口变化（`registry.ts`）：

```ts
createRoot(sessionId: string, spec: { role: string; displayName: string; forkMode?: ForkModeSpec }): AgentSnapshot
removeRoot(sessionId: string): AgentPath[]          // 级联删除整棵树；会话关闭用
roots(): AgentPath[]
sessionIdOf(path: AgentPath): string | undefined    // 前缀归属
listOf(sessionId: string): AgentSnapshot[]          // 只列本会话
activeCount(sessionId?: string): number             // 全局或会话内
register(spec): AgentSnapshot                       // parent 必填（不再默认 /root）
```

`ROOT_PATH` 从 `agent.ts:137` 删除，替换为 `sessionRootPath(sessionId) = '/' + sessionId` 与 `relativePathOf(path, sessionId)`（UI 用）。**影响面已量化**：`src/` 与测试共 ~50 处引用 `/root`/`ROOT_PATH`，集中在 `registry.ts`(9)、`host.ts`(11)、`App.tsx`(4)、各测试与 `ui-smoke.mjs`；`dist/` 里的命中是构建产物，忽略。

### 4.2 数据模型（schema 先行）

```ts
// packages/protocol/src/session.ts（新）
export type SessionExecutor = 'engine' | 'team' | 'adhoc';
export type SessionStatus = 'open' | 'closed';

export interface SessionRecord {
  id: string;              // 's' + base36(ts) + '-' + 4位随机；同时是路径前缀 /<id>
  title: string;           // 首条任务截断（≤60 字）；可改名
  cwd: string;
  executor: SessionExecutor;
  teamId?: string;         // executor=team
  adhoc?: Array<{ role: string; name?: string }>;  // executor=adhoc
  status: SessionStatus;
  createdAt: number; updatedAt: number;
  schemaVersion: number;   // SESSION_SCHEMA_VERSION = 1（M5 落盘用）
}

export interface SessionCounts { members: number; running: number; parked: number; suspended: number; ledger: number; pending: number }
export interface SessionBudgetSpec { softUsd?: number; hardUsd?: number }
export interface SessionBudgetView {
  spentUsd: number;
  global: SessionBudgetSpec; team?: SessionBudgetSpec; self?: SessionBudgetSpec;
  effectiveSoftUsd: number; effectiveHardUsd: number;   // 取更严者（§4.7）
  tier: 'ok' | 'warning' | 'frozen';
}
export interface SessionSummary {
  record: SessionRecord;
  rootPath: AgentPath;
  team?: { id: string; name: string; memberCount: number; tempCount: number };
  counts: SessionCounts;
  usage: UsageTotals;          // = 会话根快照的 usage（父链已汇总）
  budget: SessionBudgetView;
}
export interface SessionDetail extends SessionSummary { members: AgentSnapshot[] }
```

```ts
// packages/protocol/src/team.ts（新）
export interface TeamMember {
  name: string;                 // 显示名（「架构师」）
  role: string;                 // Agent 类型（roles/*.json 的 name）
  lead?: boolean;               // 恰好一个
  parent?: string;              // formation='custom' 时的父成员 name
  overrides?: { displayName?: string; model?: string; approval?: ApprovalMode; tools?: string[] };
  description?: string;
}
export type TeamFormation = 'star' | 'chain' | 'custom';
export interface TeamDefinition {
  name: string; description?: string;
  members: TeamMember[];
  formation?: TeamFormation;    // 默认 star
  maxConcurrent?: number;       // 会话级并发上限；0/未设 = 不限（§4.8）
  budget?: SessionBudgetSpec;
  defaultForkMode?: ForkModeSpec;
}
export interface TeamEntry { team: TeamDefinition; source: 'builtin' | 'user'; overridesBuiltin?: boolean; filePath?: string; errors: TeamIssue[] }
export interface TeamIssue { level: 'error' | 'warn'; code: string; message: string; filePath?: string }
```

```ts
// packages/protocol/src/config.ts（新）
export interface ConfigSnapshot {
  config: AxonConfigView;                       // 文件里的值（脱敏 apiKey）
  envOverrides: Array<{ path: string; env: string; value?: string }>;  // 被 env 覆盖的字段
  paths: { config: string; roles: string; teams: string };
  resolution: { degraded: boolean; reason?: string; effectiveModel?: string };  // 与顶栏 faux 原因同源（UX 03 §4.3）
}
export type ConfigPatch = Partial<Record<ConfigPatchPath, unknown>>;  // 白名单路径，见 §4.5
```

字段语义（存疑处一律按现有代码）：

- `AgentSnapshot.sessionId` **改为真会话 id**（不再是 path）；`relativePathOf` 是 UI 唯一需要的换算
- `LedgerRecord.sessionId` 必填（构造点 `kernel/src/ledger.ts:118` 从 path 解出）；`LedgerQuery` 加 `sessionId?`、`participant?: AgentPath`（`from === participant || to === participant`）；`subtree` 语义收敛为「同一会话内前缀」
- `PendingRequest.sessionId` 必填（`ipc.ts:136-152`），S5 跨会话聚合的数据源
- 信封 `NotificationEnvelope`：`source` 改可选、新增 `sessionId?`（会话/团队/配置级事件没有 agent 源）

### 4.3 存储布局（M5 预埋，本里程碑只定死不在磁盘上实现）

```
~/.axon/
  config.json              # 既有（model-config.ts:53）
  roles/*.json             # 既有（index.ts:58）
  teams/*.json             # 新：TeamDefinition（文件名 = 团队名，抄 roles 约定）
  sessions/<enc(cwd)>/<sessionId>/        # M5 落地
    session.json           # SessionRecord + schemaVersion
    agents/<childId>.jsonl # 每人一个 transcript（childId = path 末段）
    ledger.jsonl           # 本会话账本切片
```

`SESSION_SCHEMA_VERSION = 1` 与账本的 `LEDGER_SCHEMA_VERSION`（`ledger.ts:42`）各自独立；M5 只加读侧迁移分支。

### 4.4 协议扩展（全部新增，命令/事件名不带版本段）

**命令（12 条新增）**

| 命令 | payload | result |
|---|---|---|
| `session.create` | `{ title, cwd?, executor, teamId?, members?, budget?, initialPrompt? }` | `SessionSummary` |
| `session.get` | `{ sessionId }` | `SessionDetail \| null` |
| `session.list` | `{ status?: SessionStatus \| 'all', limit? }` | `SessionSummary[]` |
| `session.escalate` | `{ sessionId, teamId?, members?, carryMessages? }` | `SessionDetail` |
| `session.rename` | `{ sessionId, title }` | `SessionSummary` |
| `session.remove` | `{ sessionId }` | `{ removedPaths: AgentPath[] }` |
| `team.list` | `{}` | `{ entries: TeamEntry[]; issues: TeamIssue[] }` |
| `team.save` | `{ team: TeamDefinition }` | `{ accepted: boolean; errors: TeamIssue[] }` |
| `team.delete` | `{ name: string }` | `{ deleted: boolean; errors: TeamIssue[] }` |
| `team.openDir` | `{}` | `{ path: string }` |
| `config.get` | `{}` | `ConfigSnapshot` |
| `config.patch` | `{ patch: ConfigPatch }` | `{ config: ConfigSnapshot }` |

**事件（6 条新增 + 2 条扩字段）**

| 事件 | payload | 说明 |
|---|---|---|
| `session.created` | `{ summary }` | 建会话成功后 |
| `session.changed` | `{ summary }` | 任何 rollup 变化（成员状态/账本/待批/预算）；**节流 ≤ 4Hz/会话**，实现放 `index.ts` 转发层 |
| `session.removed` | `{ sessionId, paths }` | 含被级联删除的路径（UI 摘节点用，顺序子先父后） |
| `teams.changed` | `{ entries, issues }` | 抄 `roles.changed`（`ipc.ts:194`） |
| `config.changed` | `{ config: ConfigSnapshot }` | 写入成功后 |
| `approval.delegated` | `{ origin, tool, approver, mode, at }` | 修②配套：代批不再静默（§4.9） |
| `budget.warning` / `budget.frozen` | 原字段 + `{ scope: 'global' \| 'session', sessionId? }` | 三层限额的消费口径（G10.4） |

### 4.5 主进程模块布局与装配

| 新文件 | 职责 | 参照 |
|---|---|---|
| `main/session-store.ts` | 会话元数据 CRUD + rollup（从 registry/ledger/approvals 算 `SessionCounts`/`SessionBudgetView`）；纯逻辑，electron-free | `role-loader.ts` 的分层（纯函数 + IO 类） |
| `main/team-loader.ts` | `validateTeam` / `mergeTeamFiles` / `TeamLoader`（watch + 原子写 + 坏文件隔离）；内置团队常量在 `main/teams.ts` | `role-loader.ts:43/115/217` |
| `main/team-bridge.ts` | init/save/remove → 同步 host + watch 去重 | `role-bridge.ts:35-69` |
| `main/config-store.ts` | `loadConfigSnapshot`（含 envOverrides + resolution，复用 `model-config.ts`）/ `patchConfig`（白名单 + 原子写 + 0600 + 保留未知字段 + env 覆盖时拒绝改） | `model-config.ts:56`、`role-loader.ts` 的写盘纪律 |
| `main/session-instantiate.ts` | 三种执行方式的实例化 + `escalate` 重建 lead 引擎 | `host.ts:415-479` 的三角合成 |

`config.patch` 白名单（第一批，与设计稿字段名对齐）：`defaultApproval`、`approvalTimeoutMs`、`defaultCwd`、`defaultExecutor`、`maxConcurrent`、`maxDepth`、`idleTimeoutMs`、`budgetUsd`、`budgetSoftUsd`、`provider.baseUrl|apiKey|defaultModel|name|headers|models`。**UI 专有项（主题/密度/字号）不在此批**（MU-2/MU-3 再定，避免留死配置）。

`AxonConfig` 类型从 `main/model-config.ts:25-38` **上移到 protocol**（`config.ts`），主进程复用 —— 这是 UX 03 §6 指出的既有障碍（协议层拿不到配置形状）。

### 4.6 会话创建与升级流程

**创建（`session.create`）**

1. 校验：`executor='team'` 必须有 `teamId` 且团队存在；`adhoc` 必须有 `members`（2~6）；`title` 非空、`cwd` 目录存在
2. `createRoot(sessionId, { role: leadRole, displayName: leadName })`，其中 `engine` 模式 = 内置引擎角色 `builtin`（新增，见下），`team` = 团队 lead 成员，`adhoc` = 第一个成员
3. `executor='engine'`：只建根，`initialPrompt` → `requestRun`
4. `executor='team'|'adhoc'`：按 `formation` 逐层 spawn 成员（star=全部挂根；chain=依次为父；custom=按 `parent` 字段），每个成员走既有三角合成（父∩子白名单 ⇒ 团队须自证「lead 的 whitelist ⊇ 成员」）
5. lead 的 systemPrompt 追加一行 roster（「你的团队成员（已实例化）：架构师 `/sX/architect-1` …」），这是设计稿「已实例化」的语义来源；`initialPrompt` 交给 lead
6. `SessionStore.create` → `session.created` 事件

**新增内置角色 `builtin`（内置引擎）**：`displayName='内置引擎'`，`instructions` 为通用执行者提示词，`tools: undefined`（**不限制**，与今天 `/root` 无角色时 `toolNamesOf` 返回 undefined 等价），`approval: 'always_ask'`，`defaultForkMode: 'none'`。它没有编排工具 ⇒ 单兵会话自然没有分身树（UX 02 §3.2）。

**升级（`session.escalate`，solo → 团队）**

1. 前置：会话 `executor='engine'` 且根处于终态/idle（running 拒绝 —— 不打断在跑的任务）
2. 取团队（或 adhoc 成员表）的 lead 成员：**把会话根的角色换成 lead**——用 `messagesOf(root)` 灌回新建引擎（transcript 不丢，即设计稿的「当前 N 条消息作为 lead 的初始上下文 / fork: all」），`attachEngine` 替换
3. 其余成员按 formation spawn
4. 更新 `SessionRecord.executor/teamId/adhoc` → `session.changed`
5. 边界：`carryMessages=false` 时（逃生门）只换角色不带历史；`budget` 重新计算（团队可能在全局之内取更严者）

**删除（`session.remove`）**：`removeRoot` 级联删除（子先父后）→ 清理该会话的账本切片、挂起请求（`approvals.cancelFor`，`approval.ts:193`）、等待图与队列 → `session.removed`

### 4.7 三层预算（G10.4）

- **真相**：全局 `spentUsd` 由既有 `BudgetGuard` 累计（`budget.ts:61-80`）；会话 `spentUsd` = 会话根快照的 `usage.costUsd`（`registry.ts:293-306` 的父链汇总天然给出）
- **限额**：`effectiveHard = min(全局 hard(>0), 团队 hard(>0), 会话 hard(>0))`；`effectiveSoft = min(显式 soft，缺省 hard×0.8)`；**`0` 一律表示「不设」**（与全局 hard `0`=关闭熔断同义，`budget.ts:38-40`）
- **实现**：host 持 `globalBudget`（既有）+ 每会话一个 `sessionBudget`（上限 = `effectiveHard`）；每轮 `turn.end` 同时 `record` 两个口径；跃迁事件带 `scope`/`sessionId`
- **语义照旧**：到线只挡**新起点**（`spawn`/`requestRun`），在跑的不杀（`budget.ts:83-96`）；会话冻结只挡本会话的新起点，全局冻结挡所有

### 4.8 并发：全局 + 会话级（团队 `maxConcurrent`）

- 全局闸门语义**不变**（M3 不变量：只数 running、parked FIFO、父退位免检 promote）
- 会话级限额是**附加准入条件**：`canRun(sessionId)` = 全局有余 **且**（会话未设限 或 会话内 running < 会话上限）
- `drain()` 由「取队首」改为「**扫描 FIFO 找第一个当前可准入的**」；`promote()`（waiting→running 的免检路径）保持免检 —— 它是「父等子」的死锁解药，不受会话限额影响
- 死锁复核写进测试：会话限 1 + 父 spawn 子并 wait，父退位 ⇒ 子仍能 promote（对齐 M3 的 `gate=1` 回归，`orchestration.e2e.test.ts`）

### 4.9 审批修复②：代批不再静默

**问题**：`resolveDelegation`（`approval.ts:95-108`）只要链上有 `auto`/`full_access` 祖先就直接 `{allow:true}`，**不发事件、无记录**；而内置 `planner`/`architect`/`aligner` 都是 `auto`（`roles.ts:52,68,115`），aligner 又常当 lead ⇒ 默认配置下 HITL 形同虚设（UX 03 §7.1 B）。

**修法（两条，不引入工具风险分级）**：

1. **默认值收紧**：团队 lead 不得是 `auto` —— `validateTeam` 拒绝解析后审批档为 `auto` 的 lead 成员（错误码 `lead-approval-too-loose`）；内置 `aligner` 的角色默认档位从 `auto` 改为 `always_ask`（`roles.ts:115`），内置团队按此自证。规则可解释：「主控能代批全部后代请求」是权力，默认不给（与 D5「编排工具豁免」同样是显式例外）
2. **代批必须留痕**：`resolveDelegation` 命中祖先时，broker 发射 `approval.delegated`（payload 见 §4.4），返回的 `ApprovalDecision.decidedBy/ancestor` 保持既有语义（`approval.ts:61-67`）；S5 的「已处理流水」与调试台都因此能看见「谁替你批的」

**回归测试**：`approval.test.ts` 补两幕 —— ①链上有 `auto` 祖先时发射 `approval.delegated` 且 `ancestor` 正确；②`validateTeam` 拒绝 lead=auto 的团队。

### 4.10 渲染层最小适配（临时壳，MU-2 整体替换）

只做四件事，保证质量门可过、能手工演示会话概念：

1. `App.tsx` 启动补拉加 `session.list`；无会话时自动建一个 `engine` 会话（调试台友好），有则选最近一个
2. 左栏顶部加「会话」区：会话列表（名 + 状态点 + 成员数）+ `新建会话`；`session.changed` 驱动刷新
3. `RolePanel` 的 spawn 改为挂当前会话根；`AgentTree` 只渲染当前会话的成员
4. `LedgerPanel` 的 `ledger.query` 带 `sessionId`；预算 banner 用会话口径 + 全局口径两行

`ui-smoke.mjs` 同步改：开场先 `session.create`，路径断言从 `/root/blank-1` 改为 `/<sid>/blank-1`；其余九幕断言不变。

---

## 五、关键流程

```
① 创建（team 模式）
renderer ─ session.create{executor:'team',teamId:'全栈小队',initialPrompt}
   → host.createSession
       ├─ SessionStore.create  (id/title/cwd/executor/teamId/status=open)
       ├─ registry.createRoot(<id>, {role: leadRole, displayName: lead})
       ├─ instantiateTeam(formation)  → 逐层 spawn（父∩子白名单）
       ├─ lead.systemPrompt += roster
       └─ requestRun(lead, initialPrompt)     ← 闸门/预算在此把关
   → 事件 session.created → session.changed(rollup) → renderer

② 单兵升级
s2-solo「叫人」─ session.escalate{sessionId,teamId}
   → 校验根 idle/终态 → 取 lead 成员
   → 新建引擎(messages=messagesOf(root), tools=lead 工具集) → attachEngine(root)
   → 其余成员 spawn → SessionRecord.executor='team' → session.changed

③ 会话删除
session.remove → approvals.cancelFor(会话内全部挂起)
   → registry.removeRoot → SessionStore.remove → ledger 切片清理
   → session.removed{paths}（子先父后）

④ 代批留痕（修②）
leaf tool 触发 → broker.gate → resolveDelegation 命中祖先
   → emit approval.delegated{origin,tool,approver,mode} → allow
   →（无祖先可代批时）emit approval.request → 人工
```

---

## 六、边界情况与风险

| # | 风险 / 边界 | 应对 |
|---|---|---|
| 1 | **多根改造波及 `/root` 约 50 处 + 274 测试** | 先改 kernel + kernel 测试（纯函数级），再改 host 与测试 harness；`ROOT_PATH` 删除后 `grep` 清零作为完成判据；影响面已在 §4.1 量化 |
| 2 | **会话级并发可能动摇 M3 死锁不变量** | drain 改「扫描首个可准入」、promote 保持免检；补「会话限 1 + 父等子」回归；实施中若发现语义继续变复杂，**回退方案**：团队 `maxConcurrent` 暂不生效并在 UX 03 标缺口（不许假数据） |
| 3 | **escalate 换引擎会丢 transcript** | `messagesOf` 已是真相源（`host.ts:212`），重建后灌回；测试断言「升级前后消息条数/内容一致」 |
| 4 | **删除会话时挂起请求与等待图残留** | `approvals.cancelFor`（`approval.ts:193`）+ `waits`/`pendingRuns`/`waitPromises` 按会话清理；dispose 路径复用（`host.ts:174-190`） |
| 5 | **配置写入损坏文件 / 覆盖 env** | 原子写 + 0600 + 未知字段保留 + 校验失败不落盘；被 `AXON_*` 覆盖的字段**拒绝写入并报错**（UX 03 §4.2） |
| 6 | **会话内存态重启即丢**（M5 前的诚实边界） | 设计稿 S7 本就是 M5 占位屏（UX 01 §1 表）；设置页「会话与账本」照实写「目前全在内存」（UX 03 §3.5） |
| 7 | **G11.12 全局默认审批档与「只能更严」的冲突** | `defaultApproval` 只作**角色未写 approval** 时的兜底；角色写了以角色为准（`agent.ts:210` 语义不变） |
| 8 | **协议无版本机制，信封改 `source` 可选** | 全仓 `typecheck` 兜底；事件名不改（改名即 wire 破坏） |
| 9 | **roster 注入 lead systemPrompt 属「动态提示词」** | 只注入已实例化成员的**名字与路径**（不含内容），且仅在团队模式；记进本文件与代码注释，避免与「角色模板不可变」混淆 |
| 10 | **会话 id 与路径的唯一性**（跨重启） | id 含时间戳与随机段；M5 落盘时以 id 为目录名，天然不撞 |

---

## 七、实施计划（六片，每片可独立验证）

| 片 | 内容 | 验证方式 |
|---|---|---|
| 1 | 协议：`session.ts`/`team.ts`/`config.ts` + `ipc.ts` 命令/事件 + ledger 字段 + 信封；删除 `ROOT_PATH` 相关常量 | `bun run typecheck`；纯类型改动，保证全仓编译 |
| 2 | 内核：`registry` 多根 + `activeCount(sessionId?)` + 会话级准入；`ledger` 的 `sessionId`/`participant` 过滤；`budget` 多口径 `record` | `registry.test.ts` / `ledger.test.ts` / `budget.test.ts` 新增用例；274 例中受影响者同步改（harness 建会话） |
| 3 | 主进程模块：`session-store` / `team-loader` + `teams.ts`（3 支内置团队）/ `team-bridge` / `config-store` | 各自单测（校验/合并/原子写/env 覆盖/rollup 计算） |
| 4 | host 装配：`createSession` / `escalate` / `remove` / spawn 按会话 / 三层预算 / 会话级并发 / 审批修② | `host.session.test.ts`（新）+ `host.test` / `host.orchestration.test` / `host.ledger.test` / `orchestration.e2e.test` 适配；修②两幕进 `approval.test.ts` |
| 5 | 接线：`index.ts`（`session.*`/`team.*`/`config.*` handler、HostOptions 从 config 读、`session.changed` 节流转发）+ 渲染层最小壳 + `ui-smoke.mjs` 适配 | `bun run ui-smoke` 九幕（改开场）；`bun run dev` 手工：建会话 → spawn → 看会话列表 |
| 6 | 文档同步 + 质量门 + commit | §十 清单逐条；`bun run guard/typecheck/test/build:desktop/verify-lazy/ui-smoke` 全绿 |

---

## 八、测试策略

- **纯函数/单测**：registry 多根与深度、会话级准入、ledger 会话过滤、budget 三层取严、`validateTeam`（lead 数量 / role 存在 / 越权覆写 / lead=auto 拒绝）、`validateConfigPatch`（白名单 / 越界 / env 保护）、session rollup 计算
- **集成（host 级，faux/scripted 源）**：三执行方式建会话；escalate 保 transcript；删除会话清挂起；会话级并发（限 1 + 父等子）；三层预算跃迁事件的 scope；代批留痕事件
- **E2E（真 pi 引擎，现有 `orchestration.e2e.test.ts` 模式）**：团队会话全链路（lead spawn 成员 → wait → 收尾），断言账本带正确 `sessionId`
- **UI 冒烟**：`ui-smoke.mjs` 九幕保持，开场加建会话；路径断言改为会话相对
- **不新建测试类型**：沿用 vitest 2.1.8，不引入新框架

---

## 九、验收标准

- [ ] `session.create/get/list/escalate/rename/remove` 六命令可用，`session.get` 返回成员树（G10.1/G10.3/G10.5）
- [ ] `team.list/save/delete/openDir` 可用 + 3 支内置团队（G10.2）
- [ ] `config.get/patch` 可用；`maxConcurrent`/`idleTimeoutMs`/`approvalTimeoutMs`/`maxDepth` 从 config 生效（G11.1/G11.2/G11.3/G11.12）
- [ ] 账本每笔带 `sessionId`，`ledger.query` 支持 `sessionId`+`participant`（G10.6）
- [ ] 三层预算取更严者，事件带 `scope`/`sessionId`（G10.4）
- [ ] lead 默认不再静默代批；代批发射 `approval.delegated`（问题②）
- [ ] `bun run guard / typecheck / test / build:desktop / verify-lazy / ui-smoke` 全绿；测试总数不回退（≥274，预计 ~320）
- [ ] `bun run dev` 手工演示：新建会话（engine/team）→ 成员树 → 账本按会话过滤 → 删除会话
- [ ] 无任何 `.tsx` 视觉重写（MU-2 的活）；临时壳有清晰注释与替换点

---

## 十、文档同步

| 文档 | 更新内容 |
|---|---|
| `docs/01-架构决策-方案B.md` §1 进度表 | 新增「6.7 会话容器与团队层」行（MU-1 落点）+ `AgentRegistry` 多根说明 |
| `docs/03-实施框架与里程碑.md` §1/§3 | 里程碑表加 MU-1/M5/MU-2/MU-3；§3 加 MU-1 预告与顺序说明（M4→M5 主干不变，M5 后插入 MU-2/MU-3） |
| `docs/ux/02-团队与会话模型.md` §5 | G10.1~G10.6 状态回填 ✅（含 `session.create` 字段最终形状与设计稿的出入） |
| `docs/ux/00-信息架构与屏幕清单.md` §7 附 | 缺口表注明由 MU-1 兑现的部分 |
| `docs/ux/03-设置界面设计.md` §5 | G11.1/G11.2/G11.3/G11.12 状态回填；G11.9（主题）标 MU-2 |
| 本文件 | 状态行 + 「设计 vs 实测出入」小节（沿用 M3/M4 惯例） |

---

## 十一、遗留与后续

- **问题①（档位不按工具）**：要「只读放行、写必问」就得给 tools 加风险标注 —— 新协议面，独立立项（M6 前）
- **问题③（生产路径叶子工具为空）**：审批门对最终用户不可达；`read`/`write`/`bash` 等真工具 + 沙箱策略独立立项（M6 前）
- **MU-2**：渲染主干（S0/S2-solo/S2/S1/S3）+ 浅色令牌落地 + 六元件会话流
- **MU-3**：S5 收件箱 / S6 预算 / S8 设置窗（消费本里程碑的 `config.get` 与 `PendingRequest.sessionId`）
- **M5**：会话/树/消息/账本落盘（目录布局见 §4.3；S7 屏据此细化）

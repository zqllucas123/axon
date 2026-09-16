# MU-2 渲染主干（S0 / S1 / S2 / S2-solo / S3）：方案设计与实施计划

> 状态：**已评审通过**（2026-09-16，用户拍板 5 项见 §十一；延期项台账见 §十二）
> 对应里程碑：MU-2（03 §1 MU 支线）｜ 依赖：MU-1（会话容器与团队层，`4212546`）+ M5（会话持久化，`docs/milestones/M5-tree-persistence.md`）
> 设计依据：`docs/ux/{00,01,02,03}` + `docs/ux/mockups/`（12 屏高保真原型）
> 用户拍板（2026-09-15）：MU 分三段 —— MU-1 协议+主进程 → M5 落盘 → **MU-2 渲染主干** → MU-3 收尾屏（S5/S6/S7/S8）；设计稿**浅色主题胜出**
> 纪律：本里程碑**只动 `apps/desktop/src/renderer/**` 与构建接线**；主进程/协议/内核零改动（发现缺口记进 §十一，不在本片补）

---

## 一、目标与范围

**用户可见能力（一句话）**：应用启动落在「新建会话」屏，选执行方式建会话 → 进会话屏（单兵或团队）看消息流、成员树与会话账本 → 左栏在全局屏之间切换（会话总览 / 团队管理）。

### 1.1 本里程碑做什么

| # | 内容 | 对应原型 |
|---|---|---|
| 1 | **设计令牌全量落地**（暖灰三层 + 零阴影 + 字阶/半径/语义色）与外壳（左栏 / 顶栏 chips / 主区 / 右栏检视栏） | 全部屏共用 |
| 2 | **S0 新建会话**：任务输入 + 三张执行方式模式卡 + 团队选择 + 建会话 | `s0-new-session.html` |
| 3 | **S2 会话屏（团队）**：会话条 + 会话内 seg（对话/账本/用量）+ 消息流六元件（用户气泡/助手正文/活动行/折叠块/卡片/输入区）+ 右栏（成员树 → 成员详情 → 会话账本精简面板） | `s2-session.html` |
| 4 | **S2-solo 单兵会话**：会话条差异 + 右栏单兵态 + 「叫人」升级（`session.escalate`） | `s2-solo.html` |
| 5 | **S1 会话总览**：活跃会话列表 + 当前会话分身列表 + 三张 stat + 右栏（团队面板 / 并发闸门） | `s1-workbench.html` |
| 6 | **S3 团队管理**：三 tab（团队 / Agent / Agent 类型）；团队详情（成员列表 + 编队策略 + 团队预算）+ 新建团队 + 成员编辑 + 类型编辑器迁移 | `s3-teams.html` |
| 7 | 左栏会话列表（进行中 / 最近）+ 6 项一级导航（含 M5 已交付的落盘面） | `shell.js:66-76,91-99` |

### 1.2 明确不做（防蔓延）

1. **不接流式**（G2.2 `agent.message.delta` 仍是死声明）：助手消息在 `agent.message.end` 时**整块出现**，`message.start` 只用来插一张「正在生成…」占位。
2. **不做 thinking 折叠块**（G6.1 无形状）：只做「工具长输出」一种折叠块。
3. **不做工具分块输出与进度条**（G2.3 `agent.tool.update` 是死声明）：工具卡只有 `start` → `end` 两态。
4. **不做逐条消息成本**（G6.2）：`MessageLike`（`packages/protocol/src/agent.ts:35-43`）无 usage 字段。
5. **不做 S5 收件箱 / S6 全局预算 / S7 会话恢复 / S8 设置窗**（MU-3）。
6. **不做暗色主题与主题切换器**（用户拍板：设计稿浅色胜出；设置项留 MU-3）。
7. **不做手动作协作发起**（MX §4 候选意图，M4 未开）。
8. **不做窄窗/响应式**（原型按 1440×900 设计，01 §6）。
9. **不改主进程与协议**：本片不新增命令/事件/字段，只消费 MU-1/M5 已交付的面。

> 以上每一条的「后续落点」都已登记在 **§十二 遗留工作台账**（用户 2026-09-16 要求：延期工作必须进文档）。实施期间若再产生新的删/降级项，**当场补进台账**。

---

## 二、现状盘点

### 2.1 渲染层现状（要被本里程碑整体替换）

| 文件 | 行数 | 现状 | MU-2 处置 |
|---|---|---|---|
| `renderer/components/App.tsx` | 496 | 单组件扛全部：状态（`roles/sessions/currentId/selected/log/editor/budget/ledger/policy/pending`，`App.tsx:62-79`）+ 事件订阅（`App.tsx:116-315`）+ 三栏调试布局 | **重写**：拆成 shell + screens + parts + state |
| `renderer/components/EventLog.tsx` | 32 | 全 agent 混流打平 | **删**（01 §2.1 硬规矩 2 正式否定混流） |
| `renderer/components/SessionPanel.tsx` | 76 | MU-1 的临时壳（`SessionPanel.tsx:1-8` 自述「MU-2 会被 S0/S1 整体替换」） | **删**：拆成 S0 与 S1 + 左栏会话列表 |
| `renderer/components/AgentTree.tsx` | 47 | 递归树，只显示 displayName + 状态点 | **重写**为 `parts/MemberTree.tsx` |
| `renderer/components/LedgerPanel.tsx` | 111 | 账本表 + 采纳按钮（调试样式） | **重写**为 `parts/LedgerMini.tsx` + `screens/S2Ledger.tsx` |
| `renderer/components/ApprovalInbox.tsx` | 53 | 审批 banner | **重写**为消息流内审批卡（`parts/ApprovalCard.tsx`）；S5 收件箱留 MU-3 |
| `renderer/components/Composer.tsx` | 61 | 输入条（发送/中断/删除） | **重写**为 `parts/Composer.tsx` |
| `renderer/components/RolePanel.tsx` | 154 | 角色卡片列表 | **迁移**为 S3「Agent 类型」tab 列表 |
| `renderer/components/RoleEditor.tsx` | 175 | 角色编辑器模态 | **迁移**为类型编辑器（样式重做） |
| `renderer/index.html` | 20 | 深色令牌写死在内联 `<style>`（`index.html:10-18`） | **改**：浅色 token 走外链 CSS |
| `renderer/main.tsx` | 11 | 挂 `<App/>` | 保留（改挂新根组件） |

### 2.2 已就绪的数据面（MU-1 + M5 交付，本片直接用）

- **会话**：`session.create/get/list/rename/remove/escalate`（`packages/protocol/src/ipc.ts:178-186`）；`SessionSummary`（`session.ts:246-263`：`record/rootPath/status/team/counts/usage/budget`）+ `SessionDetail`（`session.ts:266-269`：+ `members: AgentSnapshot[]`）。
- **团队**：`team.list/save/delete/openDir`（`ipc.ts:190-197`）+ `TeamEntry`；`teams.changed`（`ipc.ts:349`）。
- **Agent 类型**：`role.list/save/delete/openDir`（`ipc.ts:129-135`）。
- **账本**：`ledger.query/get/adopt`（`ipc.ts:158-166`）+ `ledger.recorded/updated`（`ipc.ts:275-283`）；`LedgerQuery` 已带 `sessionId`/`participant`（G10.6 已交付）。
- **待办**：`pending.list` + `approval.respond` + `question.respond`（`ipc.ts:118-124,155`）+ `approval.request`（`ipc.ts:290`）+ `pending.resolved`（`ipc.ts:306`）+ `approval.delegated`（`ipc.ts:361`）。
- **预算**：`budget.get`（`ipc.ts:173`）+ `budget.warning/frozen`（`ipc.ts:331-332`，载荷已拆 spent/soft/hard + `scope`/`limitedBy`）。
- **落盘**：`storage.status`（`ipc.ts:108-115`）。
- **事件**：`session.created/changed/removed`（`ipc.ts:337-346`，`session.changed` 携带**完整快照**、主进程 ≤4Hz 节流 —— MU-1 实测出入 ③，`docs/ux/02` §5.1）。

### 2.3 构建与冒烟现状（要接线的地方）

- renderer 由 esbuild 单入口打包为 `dist/renderer/renderer.js`（`apps/desktop/scripts/build.mjs`：platform browser / jsx automatic / minify），`index.html` 是**原样 cp**（同文件末行）→ **CSS 必须显式接线**（§4.3）。
- 冒烟（`scripts/ui-smoke.mjs`）用 CDP 打 DOM 断言，依赖这些钩子：`[data-smoke="session-row"][data-session=…]`（`:241,:360`）、`[data-smoke="ledger-row"]`（`:265`）、`[data-smoke="ledger-adopt"]`（`:270,:274`）、`[data-smoke="approval-banner"]`（`:285`）、`[data-smoke="approval-approve"]`（`:289`）。**这些钩子在本片必须继续存在**（同名同义，见 §八）。
- `verify-lazy`（`scripts/verify-lazy-loading.mjs:94-103`）会检查 `renderer.js` 不含 pi 包名、不含 `node:`/`require(`。

---

## 三、设计依据

1. **设计语言（01 §2）**：三层暖灰（`#f2f1ee` 侧栏 / `#fcfcfb` 画布 / `#fff` 卡片）、**只用 1px 描边、全局零投影**、图标 24 视窗/1.6px/currentColor/仅 14·16·18·20、主按钮近黑、语义色降饱和且永不铺大面积、半径 6→8→12→16→20、字阶 11/12/13/14/15/17/20。**令牌真相是 `docs/ux/mockups/assets/axon.css:8-58`**，实现抄它、不另立。
2. **四条硬规矩（01 §2.1）**：① 左栏管「会话之间」、右栏管「会话之内」（用户 2026-09-14 拍板，02 §3.6）；② 分身身份靠缩进 + 引导竖线，**不给分身分配主题色**；③ **一屏一个焦点分身**（混流被正式否定）；④ 需要你决策的东西永远有 chip（顶栏三枚，且 chip **随屏切作用域**：会话屏读本会话口径、全局屏读跨会话口径，两套数字永不混用）。
3. **会话流只有六种元件（01 §3）**：用户气泡 / 助手正文 / 活动行 / 折叠块 / 卡片（工具·审批·协作·错误四类共用骨架）/ 输入区。**新增信息一律做成卡片，不许新开区块。**
4. **换轴（02 §2-§4）**：S0 是应用启动的落地屏；团队是模板、会话是实例；会话内 seg = 对话/账本/用量；单兵会话的「账本」置灰并写明「单兵会话没有协作，自然没有账本」。
5. **懒加载纪律（M5 §4.5）**：`session.list` 永不读树 —— 渲染层**不许**在列表渲染里逐个 `session.get`（否则重启后左栏一屏就把全部会话读进内存，M5 的懒加载等于白做）。
6. **L3 薄壳纪律**（AGENTS.md §4.3 / 01 §5）：组件只做「渲染 + 发意图」；状态真相在主进程；渲染层不得有编排判断（kalo `chat-store.ts` 1405 行的教训）。
7. **不填假数据（01 §4 末）**：凡「协议给不出但用户一定会问」的位置，原型保留位置并标红；**实现若拿不到数据，整块删掉**。

---

## 四、总体设计

### 4.1 屏幕模型与导航

- **两轴**：`screen`（全局屏）× `sessionView`（会话内视图）。
- `screen: 's0' | 's1' | 's2' | 's3'` —— 本地导航状态（不做 URL、不做 history）；启动落在 `s0`（§4.7）。
- `sessionView: 'chat' | 'ledger' | 'usage'` —— 会话条 seg；**会话切换时重建**（02 §3.6：右栏与会话内视图都按会话粒度重建）。
- **焦点成员** `focusPath: AgentPath` —— 默认 = 当前会话根（`summary.rootPath`）；右栏成员树点选即改；顶栏 tag 与右栏「当前成员」都跟随它（原型 `s2-session.html:16-17,214-226`）。
- **左栏**：6 项一级导航（新建会话 / 会话总览 / 收件箱 / 预算与用量 / 团队管理 / 会话恢复）+ 「进行中」「最近」两组会话行（`shell.js:66-76,91-99`）。MU-2 只有前三项进本片的屏，其余三项**置灰并注明「MU-3」**（不隐藏，保证 M5 的 `storage.status` / 收件箱入口可见）。
- 一级导航顺序照抄原型（团队管理沉到倒数第二 —— 它是配置不是日常动线，02 §4）。

### 4.2 目录与文件布局（渲染层新结构）

```
apps/desktop/src/renderer/
├── index.html                  改：外链浅色令牌 CSS；保留 CSP 与 #root
├── main.tsx                    改：挂 <Shell/>
├── globals.d.ts                不动
├── styles/
│   ├── tokens.css              新：抄 mockups/assets/axon.css §1（:root 全量令牌）
│   ├── base.css                新：reset + .window/.sidebar/.main/.topbar/.canvas/.inspector 骨架
│   ├── components.css          新：.btn/.tag/.card/.panel/.list-row/.chip/.seg/.sdot/.bubble/.activity/.fold/.composer/.tree
│   └── screens.css             新：S0/S1/S2/S3 屏内专有（.mode-grid/.team-card/.ledger…）
├── icons.tsx                   新：从 mockups/assets/shell.js 图标表搬线性图标 → React 组件
├── state/
│   ├── store.tsx               新：单一订阅 + 缓存 + 意图（AppProvider / useApp）
│   └── selectors.ts            新：纯函数（成员树组装 / 状态映射 / chip 口径 / 账本过滤 / 用量聚合）
└── components/
    ├── Shell.tsx               新：四块骨架（Sidebar / Topbar / 主区 / Inspector）+ 屏路由
    ├── Sidebar.tsx             新：导航 + 会话列表 + 账号菜单
    ├── Topbar.tsx              新：标题/焦点 tag + Chips
    ├── Chips.tsx               新：三枚 chip（作用域随屏切换）
    ├── Inspector.tsx           新：右栏容器 + 按屏/会话装配面板
    ├── screens/{S0NewSession,S1Workbench,S2Session,S2Chat,S2Ledger,S2Usage,S3Teams}.tsx
    ├── parts/
    │   ├── MessageStream.tsx   六元件渲染
    │   ├── ToolCard.tsx / ApprovalCard.tsx / LedgerCard.tsx / ErrorCard.tsx
    │   ├── MemberTree.tsx / MemberDetail.tsx / LedgerMini.tsx / Composer.tsx
    │   └── TeamCard.tsx / MemberRow.tsx / TypeRow.tsx
    └── RoleEditor.tsx          留守（样式重做，S3 类型编辑器）
（删）App.tsx / EventLog.tsx / SessionPanel.tsx / AgentTree.tsx / LedgerPanel.tsx / ApprovalInbox.tsx / RolePanel.tsx
```

### 4.3 样式与构建接线

1. `styles/tokens.css` **逐值**抄 `mockups/assets/axon.css:8-58`（`--bg-sidebar/--bg-canvas/--bg-elev/--bg-sunken/--bg-hover/--bg-active`、`--line/--line-strong`、`--text/--text-secondary/--text-muted/--text-dim`、`--accent/--accent-hover`、`--sem-{run,ok,wait,err,info}`、`--r-xs…--r-pill`、`--fs-11…--fs-20`、`--sidebar-w/--inspector-w`、`--font/--font-mono`）。
2. 组件 class 名**与原型保持一致**（`.btn.sm.primary`、`.tag.ok`、`.card.attn`、`.chip.danger`、`.sdot.run`…）：原型是唯一样式真相，同名才好逐值对齐与日后 diff。
3. 构建：`apps/desktop/scripts/build.mjs` 增加一步 —— 读 `src/renderer/styles/{tokens,base,components,screens}.css` **按序拼成** `dist/renderer/axon.css`，`index.html` 里一个 `<link>`。不引入 `@import`（多一次请求 + 顺序难控），也不走 esbuild（CSS 不属于它这一段的输入）。
4. CSP：`index.html` 现有 CSP 若含 `style-src 'unsafe-inline'`（为旧内联样式）则本片删掉内联后**同步收紧为 `'self'`**；只改 HTML 的 meta，不动主进程 `BrowserWindow` 配置。

### 4.4 状态层（L3 薄壳纪律怎么守）

一条纪律把住边界：**`state/store.tsx` 只做三件事 —— 拉取、订阅、转发意图**；任何「能不能 / 该不该 / 先重试还是先报错」的判断留在主进程。

- **一次性拉取**（启动 / 屏首次进入）：`role.list`、`team.list`、`session.list`、`budget.get`、`pending.list`、`storage.status`。
- **订阅**（`bridge.subscribe`，聚合在 store 一处）：`roles.changed`/`teams.changed`/`config.changed`/`session.created|changed|removed`/`agent.created|status|removed`/`agent.message.start|end`/`agent.tool.start|end`/`agent.turn.end`/`ledger.recorded|updated`/`approval.request`/`pending.resolved`/`budget.warning|frozen`。
- **缓存形状**（只缓存「按 id/path 索引的实体 + 事件流水」，**不缓存派生结果** —— 派生全部走 `selectors.ts` 纯函数）：
  - `sessions: Map<sessionId, SessionSummary>`（`session.list` 种子 + `session.changed` upsert）
  - `details: Map<sessionId, SessionDetail>`（**只在用户选中会话时** `session.get`；`session.changed` 到达时若已有 detail 则就地合并 counts/usage/budget，**不重拉树**）
  - `agents: Map<AgentPath, AgentSnapshot>`；`messages: Map<AgentPath, MessageLike[]>`（回放 + `message.end` 追加 + `tool.start/end` 合成卡片节点）
  - `pending: Map<requestId, …>`；`ledger: Map<id, LedgerRecord>`；`budget: BudgetSnapshot`；`roles/teams: { entries, issues }`
  - `lastError` / `issues`：原样透传（不吞）
- **意图函数**（store 暴露，组件只调这些）：`createSession / selectSession / escalateSession / renameSession / removeSession / prompt / interrupt / spawn / removeAgent / saveRole / deleteRole / saveTeam / deleteTeam / adopt / respondApproval / answerQuestion / setScreen / setSessionView / setFocus`。
- **派生（`selectors.ts` 纯函数）**：`buildMemberTree(detail)`、`statusDot(status)`、`statusLabel(...)`、`chipsFor(screen, ctx)`、`ledgerForSession(records, sessionId, focusPath)`、`usageByMember(detail)`、`modeCards()`。**这是唯一写展示口径的地方，全部可单测。**

### 4.5 组件与原型对照（实现时要逐值对齐的映射）

| 组件 | 原型来源（`docs/ux/mockups/`） | 关键规格（值抄自 `axon.css`） |
|---|---|---|
| `Shell` | 全部屏 | `.window{grid-template-columns:var(--sidebar-w) 1fr;height:100vh;overflow:hidden}`（`axon.css:89-96`）＋ `.body{display:flex}`（`:346`）＋ `.inspector{width:var(--inspector-w)}`（`:544-549`） |
| `Sidebar` | `assets/shell.js:101-168` | `.sidebar`（`:98-105`）+ `.traffic` h44（`:107-121`）+ `.nav`（`:139-153`）+ `.side-scroll` 独立滚（`:170-172`）+ `.side-foot`（`:251-262`） |
| `Topbar` + `Chips` | `s2-session.html:13-25` | h56 / padding `0 18px 0 22px` / `.title` fs17·500（`axon.css:301-316`）；`.chip` h28·pill·fs12（`:325-337`）+ `.warn/.danger`（`:340-344`） |
| `S0NewSession` | `s0-new-session.html` | `.page` max900 / padding `4px 28px 40px`（`:353`）+ `.mode-grid` 3 列 gap12（`:639`）+ `.mode-card`（`:640-648`）+ `.grid3` gap14（`:597`）+ `.team-card`（`:627-636`） |
| `S2Session` 会话条 | `assets/shell.js:213-231` | padding `8px 28px 10px` / fs12 muted（`:651-655`）+ `.seg`（`:657-660`） |
| `MessageStream` | `s2-session.html:30-190` | `.stream` max760 / padding `8px 28px 24px`（`:352`）+ `.bubble`（`:361-370`）+ `.assistant` fs15·1.75（`:381-393`）+ `.activity`（`:400-409`）+ `.fold`（`:412-428`）+ `.card`（`:431-463`）+ `.composer`（`:521-543`） |
| `MemberTree` / `MemberDetail` | `assets/shell.js:172-203`、`s2-session.html:213-226` | `.panel`（`:553-575`）+ 树缩进 22/34px + 引导竖线（`:218-242`）+ `.sdot` 7px（`:244-249`） |
| `LedgerMini` / `S2Ledger` | `s2-session.html:228-267` | `.led-mini .lm`（`:663-678`）+ `.chain`（`:681-684`） |
| `S3Teams` | `s3-teams.html` | `.team-card`（`:627-636`）+ `.card`（`:431-463`）+ `.form-row`（`:687-694`）+ `.list-row`（`:578-584`） |
| `Icon` | `assets/shell.js:6-64` | 24 视窗 / 1.6px 描边 / 圆头 / currentColor；尺寸仅 14·16·18·20（`axon.css:75-86`） |

### 4.6 数据面：每屏用到的命令/事件 + 缺口处置

**用到（全部已交付，零新增）**

| 屏 | 命令 | 事件 |
|---|---|---|
| 全屏外壳 | `session.list`、`budget.get`、`pending.list`、`storage.status` | `session.created/changed/removed`、`budget.warning/frozen`、`pending.resolved` |
| S0 | `team.list`、`role.list`、`session.create`（`title/cwd/executor/teamId/members/initialPrompt/budget/maxConcurrent` 见 `session.ts:275-288`） | `session.created` |
| S1 | `session.list`、（选中会话时）`session.get`、`ledger.query` | `session.changed`、`agent.status` |
| S2 | `session.get`、`agent.messages`、`agent.prompt`、`agent.interrupt`、`agent.spawn`、`agent.remove`、`ledger.query`、`ledger.adopt`、`approval.respond`、`question.respond` | `agent.message.start/end`、`agent.tool.start/end`、`agent.turn.end`、`agent.status`、`ledger.recorded/updated`、`approval.request`、`approval.delegated`、`session.changed` |
| S2-solo | 同上 + `session.escalate` | 同上 |
| S3 | `team.list/save/delete/openDir`、`role.list/save/delete/openDir` | `teams.changed`、`roles.changed` |

**缺口处置（逐条给结论；原则 = 拿不到就删，不许填假数据）**

| 缺口 | 原型位置 | 处置 |
|---|---|---|
| G2.2 流式 delta（死声明） | 助手正文 | **不接**：`message.start` 插占位「正在生成…」，`message.end` 整块替换。方言待 M6 真模型尖峰（00 §7.3） |
| G2.3 `agent.tool.update`（死声明） | 工具卡分块输出 + 进度条 | **删**：工具卡两态（running 只有名字 + 参数摘要，end 后显示结果/错误）；「中断」按钮保留（`agent.interrupt` 可用） |
| G6.1 thinking 无形状 | `.fold`「思考 12 秒」 | **删该块**；`.fold` 只用于工具长输出与本地折叠 |
| G6.2 消息级 usage | 助手正文尾 `1,842 in · 613 out · $0.031` | **删该行**；回合用量（`agent.turn.end`）放**活动行**「本轮用时 · 本轮 $X」——回合级是真实数据 |
| G4.2 当前任务文本 | S1 第二行「正在：…」/ S2 顶栏 | **删**：S1 第二行改显真实可得项（counts 摘要 + `record.cwd`）；S2 顶栏只显示标题 |
| G4.3 生效 model | S2 右栏「模型」行、输入区尾「· claude-sonnet」 | **删该行/该段**（快照无此字段） |
| G4.4 生效 forkMode | 右栏「上下文 fork: none」 | **保留**（`AgentSnapshot.forkMode` 已交付，`agent.ts:307`） |
| G4.5 生效工具集（intersect 后） | 右栏「工具 6 / 11」、成员行「11 工具」 | **降级为真实口径**：显示「角色白名单 N」（`role.list` 的 `role.tools.length`），标签写「工具（角色白名单）」，**不写「生效」** |
| G4.6 `waitingOn` ✓ / parked 位次 ✗ | 成员行「排队 1」/「在等谁」 | 「在等谁」**保留**（`waitingOn` 已交付）；**位次删掉** → 只写 `parked`（`counts.parked` 是真实数） |
| S1-1 团队头像叠层（成员名） | S1 会话行 `.ava-stack` | **降级**：`SessionTeamRef` 只有 `name/memberCount/tempCount`（`session.ts:238-245`）→ 用**团队名首字 + 成员数**的单个 `.ava`，不画叠层（叠层要 N 次 `session.get`，违反懒加载纪律） |
| S1-2 `counts` 无 failed | S1「1 error」 | **删该项**：只列 `members/running/parked/suspended`；error 只体现在状态点与 `lastError` |
| S1-3 「临时加入」成员标记 | 成员行 tag | **降级**：`tempCount` 只有数量 → 显示在团队 tag（`+N 临时`，原型 `shell.js:194` 本来就是这个口径）；成员行级标记删 |
| 消息时间戳（`MessageLike` 无 `at`） | 气泡 meta「16:02」 | **删时间戳**（连同 copy 按钮） |
| `SessionRecord/Snapshot` 无 approval | S2-solo 右栏「审批档」、输入区「审批：always_ask」 | **删**该行/该段（生效档可能被团队覆写，渲染层拿不到真相） |
| 升级提议卡的触发源 | `s2-solo.html:62-90` | **不做自动触发**（无事件载体）：升级入口只保留常驻两处 —— 会话条「叫人（升级为团队会话）」+ 右栏「叫人 →」；提议卡留到有触发源时（§十一-5） |
| 「最近用过」频次（`s0:129-132`） | S0 右栏 | **删频次**：`session.list` 给不出频次 → 改「最近会话」（按 `record.updatedAt` 倒序，真实数据） |
| 标注开关（`.ann`） | 全部屏 | **不做**（调试用，不是产品能力） |

### 4.7 启动与「落地屏」取舍

- 启动顺序：`storage.status` + `session.list` + `team.list` + `role.list` + `budget.get` + `pending.list` 并发拉取 → 首屏渲染 `screen='s0'`。
- **不做**「自动打开上次的会话」：M5 懒加载的前提是「用户点开才装」，自动打开会让每次启动都装一棵树；且 S0 是原型定的落地屏（02 §4）。左栏「进行中」第一行提供一键回到最近会话（真实数据）。
- 冷启动时被中断的会话由 M5 恢复为 `idle` + 写 note（M5 §4.6/§十二），渲染层不写特殊分支；**但**「上次中断」提示条需要 rollup（`interruptedAt`），而 `SessionSummary` 不带 rollup → **该提示条留 MU-3 的 S7**，本片不显示（不查、不猜）。

---
---

## 五、关键流程

### 5.1 启动 → S0 → 建会话 → S2

```
app ready → preload 桥建立 → Shell 挂载
  ├─ store.bootstrap(): session.list / team.list / role.list / budget.get / pending.list / storage.status
  └─ render S0（模式卡默认选中「内置引擎」；团队区列 team.list）
       │ 用户输入标题/任务 → 选执行方式 → 选团队（executor=team 时）→ 点「开始 ⌘↵」
       ↓ session.create({title, cwd, executor, teamId?, initialPrompt})
       ↓ ← SessionSummary（含 rootPath/team/counts/usage/budget）
       ↓ store: sessions.upsert + screen='s2'
       ↓ 若带 initialPrompt：主进程已 fire 该任务 → 事件流立刻开始
  S2 渲染：session.get(sessionId) 拉 SessionDetail（成员树）+ agent.messages(rootPath) 拉历史
```

### 5.2 会话屏的事件增量（六元件怎么长出来）

```
agent.message.start  → 在 focusPath 消息流尾插占位（「正在生成…」）
agent.message.end    → 替换占位为助手正文（toolCall 渲染成卡片）
agent.tool.start     → 插 running 工具卡（名字 + 参数摘要）
agent.tool.end       → 同卡就地变终态（ok/err + 结果摘要或错误文本）
agent.turn.end       → 插活动行（「本轮用时 · 本轮 $X」——回合级真实数据）
approval.request     → 插审批卡（穿透链；批准/拒绝 → approval.respond）
ledger.recorded      → 插落账卡（动作 + 参与方 + contextScope + mention）→ 右栏 LedgerMini 同步
ledger.updated       → 按 id upsert（settle / adoption 变化）
agent.status         → 状态点/标签更新（成员树 + 顶栏 tag + S1 行）
session.changed      → sessions.upsert（左栏行 / S1 行 / 会话条 counts+usage+budget 跟着变）
```

### 5.3 会话切换与懒加载边界

```
点击左栏会话行 / S1 行
  → store.selectSession(id)
      ├─ details 已有 → 直接用（切回来不重拉）
      ├─ 否则 await session.get(id)     ← 唯一触发「读树」的地方
      └─ focusPath = summary.rootPath
  → 会话切换时清空与会话无关的右栏状态（成员详情/账本过滤），messages 缓存保留
```

**反面纪律**（写进 review 清单）：左栏 / S1 渲染**只许**读 `sessions: Map<…, SessionSummary>`；任何在列表 `.map()` 里出现 `session.get` 的写法都算 bug。

### 5.4 「叫人」（单兵 → 团队）

```
S2-solo 会话条「叫人（升级为团队会话）」 / 右栏「叫人 →」
  → 弹「选团队」浮层（team.list 真实数据；原型只画了入口按钮）
  → session.escalate({sessionId, teamId, carryMessages:true})
  → ← SessionDetail（新成员树）→ details.upsert + focusPath 保持根
  → 会话条 ident 切团队态；右栏成员树重建；账本 seg 由置灰变可点
```
> M5 实测事实：升级**不重写 header**（磁盘上根身份仍是 engine），恢复时靠 `record.executor` 校正（M5 §十二-1）。渲染层不感知。

### 5.5 S3 编辑与落盘

```
S3 团队 tab：team.list → 卡片；点卡 → 详情（成员列表 + 策略）
  改策略/成员 → 本地草稿 state → 「保存」→ team.save({team}) → {accepted, errors}
      ├ accepted=false → 逐字段标红（errors 带 member 定位）
       accepted=true  → teams.changed 全量重绘
  成员「编辑」→ MemberEditor（类型 + 名字 + 覆写）→ 回草稿 → 随整份 team.save 落盘
  类型 tab：role.list 列表 → RoleEditor（复用）→ role.save → roles.changed
```
> 取舍：**无 `team.member.upsert` 单独命令** —— 成员变更随整份 `team.save` 提交（与 MU-1 落盘形状一致，避免双写口径）。

---

## 六、边界情况与风险

| # | 风险 | 应对 |
|---|---|---|
| 1 | **渲染层体量失控**：删掉的 7 个组件约 700 行，新结构预计 2500~3500 行，L3 纪律最容易丢 | ① store 只留「拉取/订阅/转发」三职责（写进 `store.tsx` 文件头）；② 派生一律进 `selectors.ts` 纯函数（可单测）；③ 组件只收「数据 + 意图回调」 |
| 2 | **懒加载被渲染层破坏** | 冒烟加反向断言：进 S1 渲染 N 个会话后 `storage.status.loadedCount` 不增；`session.get` 只出现在 `selectSession` |
| 3 | **逐值对齐漂移**（抄错色值/半径，肉眼抓不住） | ① 令牌逐值抄 `axon.css §1`；② 冒烟断言关键令牌（`getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas')`）；③ §4.5 对照表 |
| 4 | **冒烟钩子被改坏**（`:241,:265,:270,:274,:285,:289` 五处） | 把 `data-smoke` 钩子列为**契约**（同名同义迁移到新 DOM）；改钩子必须与 `scripts/ui-smoke.mjs` 同提交 |
| 5 | **faux 源下的空态**（工具无输出、成本恒 0、无审批、无账本） | 每个元件都要有「数据缺省」形态（缺就整块不渲染）；冒烟用 `AXON_SMOKE_SCRIPT` 驱动真实工具/审批/账本（M5 已有能力） |
| 6 | **`session.changed` 4Hz 节流下的瞬时不一致**（会话条 counts 与右栏树差一拍） | 右栏以 `details` 为主、counts 只当提示；不在渲染层做插值/合并（那是编排判断） |
| 7 | **多会话并发时的选中态**（焦点属旧会话） | `selectSession` 与 `session.removed` 都要重置/校验 `focusPath`（不在 `details.members` 就回落根） |
| 8 | **CSP 与外链 CSS** | 先看现 CSP，收紧 `style-src` 只留 `'self'`；若被 Electron 默认策略拦住，退回「构建期把 CSS 注入 HTML」的备选 —— 同一提交里定，不许留双通道 |
| 9 | **`verify-lazy` 被破坏** | CSS 走 cp 不参与 esbuild bundle；`renderer.js` 体积会随组件增多上涨（当前 243.8 KB），阈值逼近就换 `import()` 懒加载屏 |

---

## 七、实施计划（9 片，每片可独立验证）

| 片 | 内容 | 怎么验证它对了 |
|---|---|---|
| **1** | **令牌与外壳**：`styles/*` 四份 CSS + `icons.tsx` + `Shell/Sidebar/Topbar/Chips/Inspector` 骨架（真实数据：导航 + 会话列表 + chips），旧屏暂存主区 | `bun run dev` 看：浅色三层、1px 描边零阴影、左栏 6 项 + 会话行、三枚 chip 数字来自真实拉取；`git diff --stat` 确认删旧组件 |
| **2** | **S0 新建会话**：任务输入 + 三模式卡 + 团队卡片 + 开始 | 手工：默认「内置引擎」选中；选团队模式需选团队；点开始落 S2 且左栏多一行；冒烟加 `data-smoke="mode-card"/"start-session"` |
| **3** | **S2 消息流**：`agent.messages` 回放 + 事件增量 + 六元件（可实现四种 + 卡片四类 + 输入区） | 冒烟：选中会话 → 发 prompt → 出现用户气泡 + 助手正文；工具卡 running→ok；审批卡批准后消失（保留旧钩子 `approval-banner`/`approval-approve`） |
| **4** | **S2 右栏**：成员树（缩进/竖线/状态点）+ 成员详情（可得字段）+ LedgerMini（采纳/驳回） | 冒烟：`member-row` 数 = `session.get` 成员数；点成员切焦点（顶栏 tag 变）；点 `ledger-adopt` 后行变「已采纳」（保留旧钩子） |
| **5** | **S2-solo 与升级**：会话条单兵态 + 右栏单兵态 + 「叫人」浮层 + `session.escalate` | 手工：建 engine 会话 → 叫人 → 成员树 1 行变 N 行、消息不丢；账本 seg 由置灰变可点 |
| **6** | **会话内三视图**：账本（列表 + 四动词过滤 + 表态）/ 用量（会话预算卡 + 按成员表） | 手工：seg 三视图切换；账本过滤生效；用量表数字与 chips 一致（同一口径） |
| **7** | **S1 会话总览**：活跃会话列表 + 分身列表 + 三张 stat + 右栏（团队面板 / 并发闸门） | 手工：列表行数 = 会话数；stat 与右栏口径一致；冒烟断言「渲染 N 行后 `loadedCount` 不增」 |
| **8** | **S3 团队管理**：三 tab + 团队详情（成员/策略）+ 新建/删除/保存 + 类型编辑器迁移 | 手工：新建团队落盘 `~/.axon/teams/*.json`；保存校验失败标红；删团队后 S0 团队区少一张卡 |
| **9** | **收尾**：冒烟补幕（S0/S1/S3 + 懒加载断言）+ 文档同步 + 质量门 | §九 全绿 |

**片间纪律**：每片收口跑 `bun run typecheck && bun run guard && bun run test`；每片一个语义 commit（`feat(renderer): …`）。**不进 `main`、不推远端**（等网络恢复由主线会话统一推送）。

**完成记录（2026-09-16，九片全部落地）**：

| 片 | commit | 落地要点 |
|---|---|---|
| 1a/1b/1c | `5625770` / `1c8b9d0` / `e255a26`+`8eb01bf`+`dbe06e2`+`4717fca` | 浅色令牌 + `styles/*` 四份 CSS + `icons.tsx` + 状态容器 + Shell/Sidebar/Topbar/Chips/Inspector 骨架 + 三屏骨架 |
| 2 | `bf0034c`（+`099e962`） | S0 新建会话（三模式卡 + 团队卡片 + 屏自持右栏） |
| 3 | `d772554`（+`98eea11`、`7f5d395`） | S2 消息流六元件；两处真 bug（条目 id 用 agent 路径互相覆盖 / 回放被增量挡住）；占位收口 + 工具卡状态校正 + 待批 chip 取实时值 |
| 4/5/6 | `d5ebb68` | S2 右栏四面板 + S2-solo 与「叫人」浮层 + 会话内账本/用量两视图 |
| 7 | `2347bee`（+`963e04b`） | S1 会话总览（活跃会话 + 分身列表 + 三张 stat + 团队/并发闸门右栏）；stat 块级化 + 可点进会话视图 |
| 8 | `2d41e0b` | S3 团队管理三 tab + 团队详情编辑器 + Agent 类型编辑器；删旧 `RolePanel.tsx`/`RoleEditor.tsx` |
| 9 | 本 commit（+ 落盘竞态修复） | 冒烟补幕（S0/S1/S3 + 懒加载反向断言 + 预算 chip）+ 文档同步 + 质量门；**附修 M5 落盘竞态**（见 §九 末尾） |

附带的工具提交：`8dab438`+`7fdc9bd`+`ef9824f`（真窗口截图钩子 `AXON_SHOT_DIR`，逐值对齐的人眼验收）、`62d56dc`+`662f344`（base 层与真实表单控件字体归一）、`f8fb13a`（build.mjs 导入修正）。


---

## 八、测试策略

1. **纯函数单测（新增 `src/renderer/state/selectors.test.ts`）**：成员树组装（扁平 `AgentSnapshot[]` → 树，含孤儿/顺序兜底）、状态映射（`AgentStatus` → 圆点类 + 中文标签）、chip 口径（会话屏 vs 全局屏不混用）、账本过滤（sessionId + participant + 动作）、用量聚合（按成员 + 子树）。**这是本片唯一新增的 vitest 面**（渲染层此前无单测）。
2. **不做组件级 DOM 测试**（仓库无 jsdom，也不为此引入）：组件正确性由**冒烟**兜。
3. **ui-smoke 扩展**（`scripts/ui-smoke.mjs`）：
   - 保留幕 1–8 与全部 `data-smoke` 钩子语义；
   - 新增：① S0 落地（三模式卡存在、默认 engine 选中）；② 建团队会话后 S2 出现会话条 + 右栏成员树（`member-row` ≥ 2）；③ S1 列表行数与会话数一致；④ S3 团队卡与 `team.list` 一致；
   - 新增**反向断言**：进 S1/左栏渲染后 `storage.status.loadedCount` 不增长。
4. **契约/集成测试零改动**（本片不碰主进程）；`bun run test` 现有 **518 例**必须全绿。
5. **`verify-lazy`**：`renderer.js` 不得出现 pi 包名与 `node:`/`require(`（本片新增文件都是浏览器安全的 React/CSS）。

---

## 九、验收标准

- [x] 应用启动落在 S0，三张模式卡可切换（默认「内置引擎」），团队卡片来自 `team.list`
- [x] 建会话（engine / team）后进 S2：会话条、右栏成员树、消息流三处数据同源且一致
- [x] 消息流六元件按 §4.6 处置落地（可实现四种 + 卡片四类）；缺口一律**整块不渲染**（无假数据）
- [x] 右栏三块按会话粒度重建；点成员切换焦点，顶栏 tag 与「当前成员」跟随
- [x] 单兵会话：账本 seg 置灰 + 「叫人」可用（escalate 后消息不丢）
- [x] S1 列表 = 会话数；三张 stat 与右栏口径一致；渲染列表**不触发**会话装载（`loadedCount` 不变）
- [x] S3 三 tab 可用；团队保存/删除落盘；类型编辑器可增删改（沿用 M2 能力）
- [x] 令牌逐值对齐：`--bg-sidebar #f2f1ee` / `--bg-canvas #fcfcfb` / `--line #e7e5e0` / `--accent #2b2a27`、半径 6/8/12/16/20、字阶 11…20；全局零 `box-shadow`
- [x] 冒烟 8 + 新增幕全绿；`guard` / `typecheck` / `test` / `build:desktop` / `verify-lazy` 全绿
- [x] `bun run dev` 手工过一遍：S0 → S2 → S1 → S3 → 重启后左栏正确

**质量门实测（2026-09-16，收尾）**：`guard` 6 项全通过 / `typecheck` 双 tsc 0 错 / `test` **518 passed (24 files)** / `build:desktop` OK（`renderer.js` 324411 B，`main.mjs` 236420 B）/ `verify-lazy` ✓「provider 懒加载完好，内核未泄漏到渲染层」/ `ui-smoke` ✓ 全幕（含新增 S0/S1/S3 与懒加载反向断言 `loadedCount 1 → 1`）。

**收尾期抓到并修掉一条主进程落盘竞态**（切片 9 复跑质量门时暴露）：`SessionPersistence.appendLedger` / `appendTranscript` 原先只 `appendFile` 不建目录，而建会话的 `mkdir` 与 append **不在同一条 per-file 队列**上 —— 真盘慢时首轮对话里的 `delegate` 会撞上还没建好的会话目录（ENOENT），记录被静默记进 `issues`（症状：`host.persistence.test.ts` / `host.restart.test.ts` 随机红 2~5 例，单跑不复现）。修法三条：① append 写路径**自建目录**（`mkdir` 幂等，失败才记 issue）；② `AxonHost` 建会话分支的三笔写改成**同步入队**（`flush()` 取等待快照之前就入队）；③ 两个真盘测试收尾先 `flush()` 再删目录、`rm` 带 `maxRetries`（写入是异步的，`rm` 抢目录就是 ENOTEMPTY）。回归：`session-persistence.test.ts` 新增「会话目录还不存在时 append 也不丢」1 例（517 → 518）。

---

## 十、文档同步（完工后）

**（2026-09-16 全部完成，随切片 9 一起提交）**

- `docs/ux/00-信息架构与屏幕清单.md` §7（MU 边界行：S0/S1/S2/S3 已落地 + 实测删减项）→ ✅ 已更新
- `docs/ux/01-视觉设计语言与高保真原型.md` §5.3（令牌 → `styles/tokens.css`；组件对照表 → 本文件 §4.5）→ ✅ 已更新
- `docs/ux/02-团队与会话模型.md` §7（MU 行补「MU-2 已落地 S0/S1/S2/S2-solo/S3」）→ ✅ 已更新
- `docs/03-实施框架与里程碑.md` §1（MU 支线状态列 + 完成记录块 + 测试规模数字）→ ✅ 已更新
- `docs/01-架构决策-方案B.md` §1（进度表渲染层行）→ ✅ 已更新
- 本文件追加「§十三 设计 vs 实测」（实现期发现的原型/协议出入）→ ✅ 已追加

---

## 十一、拍板记录（2026-09-16，用户逐条拍板）

| # | 问题 | 拍板 | 落地方式 |
|---|---|---|---|
| 1 | 会话内「账本 / 用量」是否纳入 MU-2 | ✅ **纳入首版** | 切片 6 做；图表与更多过滤留 MU-3（见 §十二-C-1） |
| 2 | 是否接流式 delta | ✅ **按推荐实施**：不接流式，助手消息整块出现 | 用户附加要求：**延期工作必须落进本文档、后期不许忘** → 已登记 §十二-A/B，M6 开工时按表逐条回收 |
| 3 | 工具集行显示口径 | ✅ **接受「工具（角色白名单）N」** | §4.6 已定；生效集显示登记为 §十二-A-3 |
| 4 | S3「Agent」tab | ✅ **跨团队类型清单（只读）** | 切片 8 做；点进去复用类型编辑器 |
| 5 | 升级提议卡 | ✅ **只做常驻「叫人」入口** | 提议卡登记为 §十二-C-3（需新事件，M4/M6 后再议） |

> 结论：**本方案（含 9 片实施计划）评审通过，可开工。**

---

## 十二、遗留工作台账（延期项必须在此登记，不许口头延期）

> 用户 2026-09-16 明确要求：MU-2 里**主动删/降级**的每一项，后续工作都要写在这里，实施后按期回收。
> 回收纪律：每完成一项，把该行状态改为「✅ 已回收（commit / 轮次）」，**不删行**。

### A. 协议扩展类（需要给快照/事件补字段）

> 建议在 M6 之前单开一片「**M6 前置·快照补全**」：一次性把下列字段补进 `AgentSnapshot` / `SessionCounts` / `SessionTeamRef` / `MessageLike`，渲染层随后只做加行，不动结构。

| # | 想显示的东西 | 现在为什么没有 | 需要的字段 | MU-2 现状 |
|---|---|---|---|---|
| A-1 | 消息时间戳 | `MessageLike` 无 `at`（`agent.ts:35-43`） | `MessageLike.at` | 删（气泡无 meta 时间） |
| A-2 | 消息级 usage / 逐条成本 | 同上（G6.2） | `MessageLike.usage` | 删（成本只在活动行按回合显示） |
| A-3 | 「生效工具集」N/M | 快照无 intersect 结果（G4.5） | `AgentSnapshot.tools: string[]` | 降级为「角色白名单 N」 |
| A-4 | 生效 model | 快照无（G4.3） | `AgentSnapshot.model` | 删该行 |
| A-5 | 生效审批档 | 快照无（可能被团队覆写） | `AgentSnapshot.approval` | 删该行/该段 |
| A-6 | 当前任务文本 | 快照无（G4.2） | `AgentSnapshot.task` | 删；S1 第二行改显 counts + cwd |
| A-7 | parked 排队位次 | `counts.parked` 只有数量（G4.6） | `counts` 扩展或位次字段 | 删位次，只写 parked |
| A-8 | 会话行头像叠层 / 成员名 | `SessionTeamRef` 只有 `name/memberCount/tempCount`（S1-1） | `SessionTeamRef.members: string[]`（或只取前 3） | 降级为「团队名首字 + 成员数」 |
| A-9 | S1 的失败计数 | `SessionCounts` 无 `failed`（S1-2，`session.ts:193-206`） | `SessionCounts.failed` | 删该项 |
| A-10 | 「上次中断」提示条 | `SessionSummary` 不带 rollup（`interruptedAt`） | `SessionSummary.rollup` 或 `storage.status` 扩展 | 删（改为 MU-3/S7 一起做） |

### B. 方言依赖类（等 M6「真模型尖峰」核对 pi 方言后回收）

| # | 想做的事 | 为什么等 | 落点 |
|---|---|---|---|
| B-1 | 助手正文**流式**渲染（G2.2 `agent.message.delta` 死声明） | faux 方言下写的解析大概率返工；方言由 M6 尖峰定 | M6 后第一片：消息流改增量渲染（组件已按「整块替换」写，改起来是替换渲染函数） |
| B-2 | **thinking 折叠块**（G6.1 无形状） | 依赖思考流方言 | 同 B-1 |
| B-3 | 工具**分块输出 / 进度条**（G2.3 `agent.tool.update` 死声明） | 同上 | 同 B-1（工具卡已留两态骨架） |

> 回收前置检查（M6 开工清单）：`agent.message.delta` / `agent.tool.update` 是否在真模型下真正发出、载荷形状为何；若不发，则 B-1/B-3 直接作废，把事件声明从协议里删掉（别留死声明）。

### C. 屏与能力类

| # | 内容 | 落点 |
|---|---|---|
| C-1 | 会话内账本/用量的细化：动作过滤增强、按成员子树聚合视图、图表 | MU-3（与 S6 全局预算一起看口径） |
| C-2 | **S5 收件箱 / S6 全局预算 / S7 会话恢复 / S8 设置窗** | MU-3（已拍板） |
| C-3 | 单兵会话的**升级提议卡**（`s2-solo.html:62-90`） | 需要「建议升级」事件（协议+编排建议逻辑）→ M4/M6 后再议 |
| C-4 | 暗色主题 + 主题切换器 | MU-3/S8（用户拍板：MU-2 只做浅色） |
| C-5 | S0「最近用过」的频次统计 | 需要使用计数（本地统计即可，无协议改动）→ 后续按需 |
| C-6 | 手动作协作发起（consult/fork/delegate/handoff 的 UI） | M4 协作动作与落账 |
| C-7 | 「标注开关」（`.ann` 调试态） | 决定不做（不是产品能力）；若开发期需要，作为 dev-only 开关另议 |

---

## 附：本文件引用的关键事实来源

| 事实 | 出处 |
|---|---|
| 令牌全量值 | `docs/ux/mockups/assets/axon.css:8-58` |
| 四条硬规矩 / 六元件 / 三层暖灰 | `docs/ux/01-视觉设计语言与高保真原型.md` §2、§2.1、§3 |
| S0 为落地屏 / 左栏右栏分工 / 团队=模板、会话=实例 | `docs/ux/02-团队与会话模型.md` §2-§4 |
| MU 实现顺序与原计划 | `docs/ux/02` §7；用户 2026-09-15 拍板 |
| 协议命令/事件清单 | `packages/protocol/src/ipc.ts`（行号见 §4.6） |
| 类型形状 | `packages/protocol/src/{agent,session,ledger,team}.ts`（行号见 §4.6） |
| 懒加载纪律 | `docs/milestones/M5-tree-persistence.md` §4.5、§十二-1 |
| 冒烟钩子 | `scripts/ui-smoke.mjs:241,265,270,274,285,289` |
| 构建接线 | `apps/desktop/scripts/build.mjs`（renderer 段 + 末行 cp）；`scripts/verify-lazy-loading.mjs:94-103` |

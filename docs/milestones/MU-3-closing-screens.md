# MU-3 收尾屏（S5 收件箱 / S6 预算与用量 / S7 会话恢复 / S8 设置窗）：方案设计与实施计划

> 状态：**已完成（2026-09-16）** —— 九片全部落地，质量门七件套全绿（528 测试 / `ui-smoke` 41 条断言）；拍板见 §十一，实测偏离见 §十三
> 对应里程碑：MU-3（03 §1 MU 支线最后一片）｜ 依赖：MU-2（渲染主干，`d610476`）+ M5（落盘）+ MU-1（config/session 协议）
> 设计依据：`docs/ux/00-信息架构与屏幕清单.md`（S5/S6/S7 定义与 G1~G9）、`docs/ux/02-团队与会话模型.md`（左右栏职责切分）、`docs/ux/03-设置界面设计.md`（S8 全文 + G11 十四条）、`docs/ux/mockups/{s5-inbox,s6-budget,s7-sessions,s8-settings}.html`
> 纪律：本片**允许动主进程与协议**（S8 独立窗 + 四处最小扩展，逐条列在 §4.1），与 MU-2「只动 renderer」不同——范围边界写死在 §1.2，越界即返工

---

## 〇、拍板记录（八条，2026-09-16 用户：“按你推荐的方案实施” ⇒ **全数按推荐列执行**）

| # | 问题 | 推荐 | 代价 / 理由 |
|---|---|---|---|
| **P-1** | MU-3 屏范围是 S5/S6/S8 三屏还是含 S7 四屏？ | **四屏（含 S7）** | 03 §1 状态表写的是「S5/S6/S8」，但 MU-2 §十二 C-2 拍板的是「S5/S6/**S7**/S8」，两处不一致必须收口。含 S7 的代价 = 多一条协议扩展（`SessionSummary.rollup`）+ 约 1 片工作量；不含则左栏第三条死链要继续挂着，且 M5 的落盘成果在 UI 上没有出口 |
| **P-2** | S8 做独立窗口还是主窗内第七屏？ | **独立窗口**（照 `docs/ux/03-设置界面设计.md:25-32`） | 独立窗需要主进程新增第二个 `BrowserWindow` + 应用菜单（`⌘,`），是本片唯一一块窗口层改动（现状：`apps/desktop/src/main/index.ts:378` 只有一个窗口工厂，全仓无 `Menu`）。做成主窗一屏虽省事，但顶栏 chip 是会话作用域的，设置窗没有会话上下文，挂着会话横幅语义就是错的 |
| **P-3** | 外观四项（主题 / 密度 / 字号 / 减弱动效）落盘在哪？ | **进 `config.json` 新增 `ui.*` 白名单字段** | `packages/protocol/src/config.ts` 的白名单注释把这个决定明确留给了 MU-2/MU-3。进 config 的好处是主窗与设置窗两个渲染进程靠 `config.changed` 事件天然同步；代价是协议加 4~5 条白名单路径。备选（localStorage）在 `file://` 下双窗同步不可靠 |
| **P-4** | 暗色主题本片真做吗？ | **不做**：主题 seg 只留「浅色」可选，「深色 / 跟随系统」置灰标「未实现」 | 03 §7 的 D-3 在文档里仍记「未定」，实际已被 MU-2 拍板（浅色胜出）覆盖。真做暗色 = 全量令牌换肤 + 12 屏复核，是独立一片的量；本片只把开关位置留好 |
| **P-5** | S5 的「今天已处理」流水怎么办？ | **降级为「本次运行期内已处理」**，屏上明说刷新即清空 | 真历史需要新协议（`pending.history`）：`ApprovalBroker` 结算后 `pending.delete` 不留档。降级零协议成本，且 store 现在就把 resolved 的项留在内存里（`pending` 数组只改 state 不删元素） |
| **P-6** | S5 的提问卡（含选项式提问）做不做？ | **只做纯文本提问卡（复用 MessageStream 已有形状），不做选项式** | `question.request` 事件**全仓无发射方**（只有 `question.respond` 命令：`packages/protocol/src/ipc.ts:150`、`apps/desktop/src/main/host.ts:2083`）。画一个永远不出现的选项卡 = 填假数据，违反 01 §4 纪律 |
| **P-7** | S8 的四个「无落点动作」做哪几个？ | 做 2 个：**打开 `~/.axon` 目录 / reveal 配置文件**（扩展现有 `role.openDir` 的 kind）、**`config.reset`**；不做 `provider.test`（测试连接）与目录选择器 | `provider.test` 要主进程发真 HTTP，与 M6 真实模型接入同源，放 M6 一起做更省；目录选择器（`dialog.showOpenDialog`）不属本片主线 |
| **P-8** | S6 的「今日」维度怎么处理？ | **全部改成「累计」文案**，不做按日重置 | `BudgetGuard` 是进程内累计、无自然日切（`packages/kernel/src/budget.ts`）。要「每日预算」是内核语义改动（重置时机、跨重启的日界），不该塞进一个渲染里程碑 |

> **结论：方案（含九片实施计划）评审通过，可开工。** 逐条落实：
> P-1 四屏（含 S7）│ P-2 独立窗 │ P-3 `ui.*` 进 config 白名单 │ P-4 不做暗色 │
> P-5 已处理流水降为「本次运行期内」│ P-6 不做选项式提问 │ P-7 做 openDir 扩展 + `config.reset`，不做 `provider.test` │ P-8 「今日」全改「累计」。
> 用户附加要求：**多会话窗口并行开发** ⇒ 九片重组为三阶段（§七.0），共享文件的改动全部前置到阶段 0 由主线一次做完，并行会话只写自己的新文件。

---

## 一、目标与范围

**用户可见能力（一句话）**：左栏三条灰着的导航全部点亮 —— 跨会话的「等你拍板」收件箱、全局预算与用量总览、重启后的会话恢复面；`⌘,` 打开独立设置窗，能看见并改掉散在 `config.json` / `AXON_*` / 硬编码默认值三处的配置。

### 1.1 本片做什么

| # | 内容 | 对应原型 |
|---|---|---|
| 1 | **S5 收件箱**：跨会话聚合待批/待答 + 穿透链 + 阻塞影响 + 本次运行期已处理流水 + 空态 | `s5-inbox.html` |
| 2 | **S6 预算与用量**：全局档位卡 + 三指标 + 按会话排行 + 成本构成（降级版）+ 档位语义/三层限额右栏 | `s6-budget.html` |
| 3 | **S7 会话恢复**：全部/可恢复/已归档分段 + 会话行（含「上次中断」）+ 存储实况与 issue 清单 | `s7-sessions.html` |
| 4 | **S8 设置窗**：独立 `BrowserWindow` + `⌘,` + 五个 pane（通用/外观/模型与网关/编排与安全/关于），改完即生效 | `s8-settings.html` |
| 5 | **协议与主进程最小扩展**四处（§4.1），每处都有对应屏的硬需求 | — |
| 6 | **死链清零**：侧栏 `NAV_LATER` 三项上移为活链、账号菜单两项接线、底部「待批 N」可点进 S5、写死的 badge `'2'` 换真值 | `shell.js:66-76` |
| 7 | **CSS §11 搬运**：设置窗专有组件（`.st-*` / `.grp` / `.srow` / `.tgl` / `.sel` / `.danger-zone`）从原型 `assets/axon.css` 搬进实现，顺手清掉 `tokens.css` 与 `base.css` 的重复归一段 | `assets/axon.css` §11 |

### 1.2 明确不做（防蔓延）

1. **不做 `provider.test`（测试连接）** —— 归 M6（P-7）。
2. **不做暗色主题换肤**（P-4）；不做信息密度/字号以外的排版能力。
3. **不做 `pending.history`**（S5 已处理流水只覆盖本次运行期，P-5）。
4. **不做选项式提问**（P-6）；`question.request` 无发射方前不画。
5. **不做按日预算重置 / 协作开销占比 / 轮数统计**（P-8 + G5.2 未补）。
6. **不做孤儿目录清理**（S7 原型的「清理孤儿」按钮）：`StorageIssueKind` 里虽有 `orphan-dir`（`packages/protocol/src/session.ts:101`），但没有扫描与删除命令，删用户目录是不可逆动作，不放进收尾片。
7. **不做 Tray / 防休眠两个开关**（G11.5，无实现且不在配置白名单）。
8. **不做每角色模型覆盖**（`[M6]` 标记项）、**不做检查更新 / 开源许可证**（G11.10）。
9. **不做设置项搜索框**（G11.8）：五个 pane 共约 30 行，搜索价值低于其维护成本；原型的搜索框在实现里删掉而不是留死框。
10. **不做窄窗/响应式**（沿用 MU-2）。

> 与 MU-2 同规矩：实施期新产生的删/降级项，**当场补进 §十二 台账**，不许口头延期。

---

## 二、现状盘点

### 2.1 渲染层（MU-2 交付，22 文件）

| 关键文件 | 行数 | 与本片的关系 |
|---|---|---|
| `renderer/state/types.ts` | 12 | `Screen = 's0'｜'s1'｜'s2'｜'s3'` —— 要加 `'s5'｜'s6'｜'s7'`（S8 不走这里，它在另一个窗口） |
| `renderer/components/Shell.tsx` | 63 | 屏路由 `switch`；**`s0` 占了 `default` 分支**，新屏必须显式加 `case`，漏写会静默落回 S0 |
| `renderer/components/Sidebar.tsx` | 174 | `NAV` 三活链 + `NAV_LATER` 三死链（`disabled` + `title="MU-3 落地"`，badge 写死 `'2'`）；账号菜单「设置…」「打开配置目录」为不可点的 `<span>`；底部「待批 N」数字真但不可点 |
| `renderer/state/store.tsx` | 791 | 唯一状态容器。启动 `Promise.all` 已经拉了 `pending.list` / `budget.get` / `config.get` / `storage.status` —— **S5/S6/S8 的数据源已经在内存里了** |
| `renderer/state/selectors.ts` | 390 | 已有 `globalChips` / `splitSessions` / `statusDot` / `fmtInt`；**缺** 金额格式化（`money` 在三处各写一遍）、时间格式化、pending 分组口径、跨会话成本聚合 |
| `renderer/components/MessageStream.tsx` | 277 | 审批卡与提问卡的**唯一**实现（`ApprovalCard` / `QuestionFoot` / `Chain`），按当前会话切片；S5 要把这三块抽成可复用件 |
| `renderer/components/Inspector.tsx` | 208 | `screen !== 's2'` 直接 `return null`；新屏的右栏各自写（S0/S1/S3 都是自写 `<aside className="inspector">`） |
| `renderer/styles/components.css` | 679 | `.fold` / `.bar` / `.grid2` / `.prow.def` / `table.tbl` **已定义但无人使用** —— 正是 S5/S6 要用的；设置窗样式一条没搬（`.inp` 旁边留了字条说明 S8 随 MU-3 进） |
| `renderer/styles/screens.css` | 9 | 几乎空文件（只有 `.empty`） |

**旧调试面板残留：零。** `AgentTree.tsx` / `SessionPanel.tsx` / `EventLog.tsx` / `RolePanel.tsx` 均已在 MU-2 删除，渲染路径干净。03 §1 写的「旧调试面板退役」这项**实质已完成**，本片只做死链清零与文档核销。
一个真残留：`store.tsx` 的 `budgetAlert` 状态（写入于 budget 事件、导出于 value）**全 renderer 无人消费**，是被下线的 `.budget` 横幅的遗留口 —— S6 的「最近预算事件」正好接手。

### 2.2 协议与主进程（MU-1 / M4 / M5 交付）

| 面 | 现状 | 对本片的影响 |
|---|---|---|
| 审批 | `approval.respond`（幂等）/ `pending.list` / 事件 `approval.request`（带 `chain`/`sessionId`/`approvalMode`/`expiresAt`）/ `pending.resolved` / `approval.delegated` 全部已实现 | S5 **零协议新增**；但 store 现在**没订阅** `approval.delegated` 与 `question.request` |
| 提问 | 只有 `question.respond` 命令（`ipc.ts:150`、`host.ts:2083`），`question.request` 事件声明存在但**无发射方** | P-6 的依据 |
| 预算 | `budget.get → BudgetSnapshot{state,spentUsd,softUsd,hardUsd,disabled,usage}`；事件 `budget.warning/frozen` 带 `scope`/`sessionId`/`limitedBy`（M4 修掉 G9.1） | S6 主数据源齐；缺「日」维度与协作开销切片（P-8 / G5.2） |
| 会话 | `session.list(SessionListQuery{status,limit}) → SessionSummary[]`，含 `counts` / `usage` / `budget`（`SessionBudgetView` 三层取严） | S6「按会话」与 S7 列表的数据源；**`SessionSummary` 不带 `rollup`** ⇒ S7 的「上次中断」拿不到（MU-2 台账 A-10） |
| 存储 | `storage.status → {root, sessionCount, loadedCount, issues}`（`ipc.ts:112-120`，实现 `host.ts:1143-1155`）；`SessionRollup.interruptedAt` 在落盘里有（`host.ts:1107-1119`） | S7 的存储实况与 issue 清单可直接用 |
| 配置 | `config.get → {config, envOverrides, paths, resolution}`；`config.patch` 15 条白名单；事件 `config.changed` | S8 主数据源齐；缺 UI 偏好字段（P-3）与 `config.reset`（P-7） |
| 窗口 | `apps/desktop/src/main/index.ts:378` 唯一 `BrowserWindow`；全仓无 `Menu` / `accelerator` / `globalShortcut` | S8 独立窗要新增窗口工厂 + 应用菜单（P-2） |

**一处必须澄清的「设计 vs 实现冲突」**：03 §7 的 D-4 拍板「允许改被 env 覆盖的字段 + 置灰」，而 `config-store.ts:259-270` 对被 env 锁定的路径是「报 `env-locked` issue 并**跳过**该字段」。两者其实**不冲突**：`config-store.ts:281` 明确把 `env-locked` 排除在 blocking 之外（其余字段照常落盘）。结论：**实现不改**，S8 按 D-4 把这类控件置灰 + 说明「被 `AXON_BASE_URL` 覆盖」，UI 根本不发该字段，`env-locked` 只作为兜底防线。这条写进 §6 风险表，别在实施时又翻一遍。

---

## 三、设计依据（逐条带出处）

1. **S5 只解决跨会话**：会话内审批就地出现在消息流里，S5 是「你在 A 会话干活时 B 会话有人卡住了」的出口 —— `docs/ux/02-团队与会话模型.md:120-122`、`s5-inbox.html:28`。现实现正好只覆盖会话内（`MessageStream.tsx:217` 按 `p.sessionId === current.record.id` 切片），S5 补的是另一半。
2. **S6 是全局口径的只读屏**，「花在谁身上」属会话内 S2-usage，上限配置属 S8 —— `docs/ux/00-信息架构与屏幕清单.md:210`、`docs/ux/03-设置界面设计.md:57`。
3. **S7 的协议面全部在 M5 定，MX 只占位** —— `00-...md:212-216`；数据面 M5 已就绪（`storage.status` + `rollup.interruptedAt`）。
4. **S8 独立窗的两条轴**（职责轴：设置是应用级；状态轴：顶栏 chip 随屏切作用域，设置窗无会话上下文）—— `03-设置界面设计.md:25-32`；入口在左下账号菜单；`⌘,` 与菜单项同一行为、语义是「聚焦已开的设置窗，没开则新开」**不是导航**，且原型用跳转模拟、「实现时注意别照抄」—— `03-...md:45`。
5. **每行设置必须有一句说明** —— `03-...md:111-113`；**无保存按钮、改完即生效、写失败行内报错并把控件回滚到真实值**（原文「而不是假装成功」）—— `03-...md:242`。
6. **同一个东西不设两个编辑入口**：团队与角色留在 S3，设置窗只放一个跳转 —— `03-...md:19`；「设置里只放上限与默认值，花了多少是仪表盘」—— `s8-settings.html:32` 的 `.st-navnote`。
7. **协议给不出就删掉界面元素，不填假数据** —— `03-...md:18`、`docs/ux/01-视觉设计语言与高保真原型.md:114`（原文「MU 必须把这些位置整块删掉，而不是填假数据」）。本片 §1.2 的每条「不做」都是这条纪律的直接结果。
8. **审批链的两个已知产品问题**（03 §7.1 A/B/C）：档位是按 Agent 而非按工具、链上任一 `auto`/`full_access` 祖先静默代批、生产路径叶子工具为空 ⇒ **S5 在本片验收时大概率是空屏**。因此 S5 的空态与 `approval.delegated` 留痕流水是必做项，而不是锦上添花。

---

## 四、总体设计

### 4.1 协议与主进程扩展（四处，全部最小化）

| # | 扩展 | 位置 | 为什么非改不可 | 被谁消费 |
|---|---|---|---|---|
| **E-1** | `SessionSummary.rollup?: SessionRollup` | `packages/protocol/src/session.ts`（`SessionSummary`）+ `session-store.ts` 的 `buildSessionSummary` 透传 | S7 的「上次中断」只能来自 `rollup.interruptedAt`；现在这个字段落了盘却到不了 UI（MU-2 台账 A-10） | S7 会话行、S6「历史合计」 |
| **E-2** | UI 偏好字段：`ui.theme` / `ui.density` / `ui.fontSize` / `ui.reduceMotion` / `ui.annotations` 进 `ConfigPatchPath` + `CONFIG_FIELD_SPECS` + `CONFIG_DEFAULTS` | `packages/protocol/src/config.ts` + `config-store.ts` 校验 | 外观 pane 的四项（P-3）；双窗同步靠 `config.changed` | S8 外观 pane、主窗根元素 `data-*` |
| **E-3** | 目录打开命令归一：**删除** `role.openDir` / `team.openDir`，新增单条 `shell.openPath`，payload `{kind: 'roles'｜'teams'｜'config'｜'sessions'}`（`config` 走 `shell.showItemInFolder` reveal 单文件） | `packages/protocol/src/ipc.ts` + `main/index.ts` 的 `OPEN_PATHS` 惰性求值表 | S8「关于」pane 的「在访达中显示」与账号菜单的「打开配置目录 `~/.axon`」都没有落点 | S8 关于 pane、Sidebar 账号菜单 |

> **E-3 实施偏离（阶段 0 实测）**：原计划「给 `role.openDir` 加 kind」，实际改成**删两条旧命令 + 建一条枚举命令**。理由：`role.openDir` 这个名字一旦能打开 sessions/config 就名不副实，而渲染层拿到的必须是**枚举**而不是路径 —— 枚举把可达集锁死在主进程（`OPEN_PATHS` 四个键），等于从协议层杜绝「渲染层递任意路径让主进程打开」这条越权通道。旧命令全仓仅 2 处调用（`S3Teams.tsx`、`Sidebar.tsx`），删除成本低于长期背一个错名字。
| **E-4** | `config.reset`：把 15 条白名单路径删回默认，**保留未知键**，返回新快照 + 发 `config.changed` | `ipc.ts` 新增命令 + `config-store.ts` 新增方法 | S8 危险区（P-7）；用 `config.patch` 逐个置 null 不等于恢复出厂 | S8 危险区 |

> 除此之外**不新增任何命令/事件/字段**。`pending.history`（S5 真历史）、`provider.test`、按日预算、`SessionCounts.turns`、G5.2 用量切片一律进 §十二 台账。

### 4.2 渲染层布局

```
renderer/
  main.tsx                 ← 改：按 location.hash 决定挂 <Shell/> 还是 <SettingsApp/>
  state/types.ts           ← 改：Screen 增 's5'|'s6'|'s7'
  state/store.tsx          ← 改：+2 订阅（question.request / approval.delegated）
                              +3 action（patchConfig / resetConfig / openPath）
                              +1 派生（resolvedFeed：本次运行期已处理流水）
  state/selectors.ts       ← 改：抽公共 money/时间格式化；新增 inbox/budget/sessions 三组口径函数
  components/
    Shell.tsx              ← 改：switch 加三个 case
    Sidebar.tsx            ← 改：NAV_LATER 上移、badge 取真值、账号菜单接线
    parts/ApprovalCard.tsx ← 新：从 MessageStream 抽出（S2 与 S5 共用；带 variant='stream'|'inbox'）
    S5Inbox.tsx            ← 新
    S6Budget.tsx           ← 新
    S7Sessions.tsx         ← 新
  settings/                ← 新（设置窗专属，独立 React 根，不进主窗 bundle 的渲染路径）
    SettingsApp.tsx        ← 窗壳：st-nav + pane 切换（hash 驱动）
    SettingsStore.tsx      ← 极简 store：config.get + config.changed + patch（不复用主窗 store）
    panes/{General,Appearance,Models,Orchestration,About}.tsx
    fields.tsx            ← .srow/.tgl/.sel/.inp/.path 五个受控件 + env 置灰三态 + 行内错误
  styles/settings.css      ← 新：原型 axon.css §11 搬运（**必须加进 build.mjs 的 cssFiles 数组**）
main/
  windows.ts               ← 新：createMainWindow / openSettingsWindow（单例聚焦）
  menu.ts                  ← 新：应用菜单（含「设置… ⌘,」），仅 macOS 形态
  index.ts                 ← 改：启动装菜单、openDir 分支扩展、config.reset 路由
```

**为什么设置窗不复用主窗 store**：主窗 store 启动就拉 `session.list`/`role.list`/`team.list` 并订阅 21 个事件，设置窗一个都不需要；复用等于让一个「不参与会话的窗口」订阅全部会话事件，正是 03 §2 想避免的语义污染。设置窗只需要 `config.get` + `config.changed` + `budget.get` + `storage.status` + `ledger.getAdoptionPolicy` 五条。

**为什么不拆第二个 html/bundle**：`apps/desktop/scripts/build.mjs:96` 的 CSS 拼接与 `index.html` 拷贝都是硬编码单文件；用 `loadFile(index.html, { hash: 'settings' })` + `main.tsx` 里读 `location.hash` 分叉，**构建脚本只需加一份 CSS**，不改产物结构。代价是设置窗会加载主窗 JS（同一 bundle），可接受（本地文件、无网络）。

### 4.3 三屏的数据装配

| 屏 | 拉取（启动已有） | 订阅 | 派生 |
|---|---|---|---|
| S5 | `pending.list` | `approval.request`（已订）/ `pending.resolved`（已订）/ **`question.request`（新）** / **`approval.delegated`（新）** | 按 `sessionId` 分组、按 `at` 升序；`state==='pending'` → 待处理，`'resolved'` → 本次已处理；阻塞影响 = 会话成员里 `status==='suspended'` 的子集 |
| S6 | `budget.get` + `session.list` | `budget.warning/frozen`（已订）/ `session.changed`（已订） | 三指标（累计已用 / 软硬线 / 最严会话档位）；按会话排行 = `sessions` 按 `usage.costUsd` 倒序；历史合计 = `status==='closed'` 的 `usage` 求和（走 rollup，不触发懒加载） |
| S7 | `session.list({status:'all'})` + `storage.status` | `session.created/changed/removed`（已订） | 分段：全部 / 可恢复（`rollup.interruptedAt` 存在）/ 已归档（`record.status==='closed'`）；issue 列表按 `kind` 分组 |

**懒加载纪律（M5 前提）不许破**：S6/S7 **只读 `session.list` 的 rollup 汇总，绝不为了算数字去 `session.get`**。MU-2 的 ui-smoke 已有「进 S1/S3 后 `loadedCount` 不变」的反向断言，本片给 S6/S7 各加一条同样的断言。

### 4.4 S8 的字段映射（15 条白名单去向）

| pane | 设置项 | 字段路径 | env 可覆盖 |
|---|---|---|---|
| 通用·权限 | 默认审批档 / 审批超时 | `defaultApproval` / `approvalTimeoutMs` | 否 |
| 通用·常规 | 默认执行方式 / 默认工作目录 | `defaultExecutor` / `defaultCwd` | 否 |
| 通用·常规 | 角色目录、配置文件位置 | 只读 `ConfigPaths.*` + 打开按钮（E-3） | — |
| 外观 | 主题 / 密度 / 字号 / 减弱动效 / 显示协议标注 | `ui.*`（E-2） | 否 |
| 模型与网关 | 网关名称 / Base URL / API Key / 默认模型 / 请求头 / 模型清单 | `provider.name` / `.baseUrl` / `.apiKey` / `.defaultModel` / `.headers` / `.models` | **`AXON_BASE_URL` / `AXON_API_KEY` / `AXON_MODEL` 三条** |
| 模型与网关·预算 | 全局硬线 / 软线 | `budgetUsd` / `budgetSoftUsd`（原型把软线画成只读 tag，**实现里它可写**，按 spec 改为输入框 +「留空 = 硬线 × 0.8」） | 否 |
| 编排与安全 | 并发上限 / 最大分身深度 / 空闲看门狗 | `maxConcurrent` / `maxDepth` / `idleTimeoutMs` | 否 |
| 编排与安全 | 裁决策略 / 仲裁者 | `ledger.getAdoptionPolicy` / `setAdoptionPolicy`（**不走 config**） | — |
| 编排与安全 | `agent_wait` 默认超时 | 只读常量展示 | — |
| 关于 | 版本 / 文件位置 / 会话与账本 | 静态 + `ConfigPaths` + `storage.status`（原型「全在内存」文案已过时，**必须重写**） | — |

**删掉的原型元素**（协议无落点，按 §三.7 纪律整块删而不是留死控件）：在菜单栏中显示、防止系统休眠、测试连接、每角色模型覆盖、检查更新、开源许可证、设置搜索框、配置文件位置的「更改」、默认工作目录的「更改」（改为可直接编辑的文本框，不开系统选择器）。

---

## 五、关键流程

### 5.1 `⌘,` → 设置窗（单例）

```
用户按 ⌘, / 点账号菜单「设置…」
  → [菜单] menu.ts 的 accelerator  或  [渲染] invoke('window.openSettings')  ※见下方注
  → main/windows.ts: openSettingsWindow()
      settingsWin 存在 ? settingsWin.focus()              // 03 §2「聚焦而非新开」
                       : new BrowserWindow({...}).loadFile(index.html, {hash:'settings'})
  → 设置窗 renderer: main.tsx 读 location.hash === '#settings' → 挂 <SettingsApp/>
  → SettingsApp: invoke('config.get') → 渲染五 pane；sub('config.changed') → 全量重绘
```

注：账号菜单那条路径需要一条渲染→主进程的意图。为不新增「窗口类命令」这一整类，**复用 E-3 的思路**：新增单条 `window.openSettings`（payload 空）比给 openDir 硬塞语义更干净 —— 这条算在 E-3 里一并实施（合计仍是 4 处扩展）。实测已按此实现：`window.openSettings` 返回 `{opened:true}`，重复调用只聚焦不新建（单例已冒烟验证）。

### 5.2 改一项设置（无保存按钮）

```
用户改控件（如并发上限 4 → 6）
  → 受控件本地乐观置值 + 标记 saving
  → invoke('config.patch', { patch: { maxConcurrent: 6 } })
  → config-store.patch()：逐字段校验 → 任一非 env-locked 错误 ⇒ 整批不落盘
      ├ accepted=true  → 原子写 0600 → host.applyConfig 热应用 → 事件 config.changed
      │     → 两个窗口同时收到 → SettingsApp 全量重绘（乐观值被真值覆盖，等价确认）
      └ accepted=false → errors[] 回到调用方
            → 控件回滚到 snapshot 里的旧值 + 行内红字显示 message（03 §5.1）
```

**env 覆盖三态**：`config.get` 的 `envOverrides[]` 里出现的 path ⇒ 控件 `disabled` + 值显示 env 的值 + 说明「被 `AXON_BASE_URL` 覆盖，改动不会生效」。UI 因此**不会**发出该字段，`env-locked` issue 只在极端并发（改完 env 又重启前）兜底。

### 5.3 S5 的一次批准

```
B 会话某成员触发需审批工具
  → 事件 approval.request（带 chain/sessionId/tool/args/approvalMode/expiresAt）
  → store 追加进 pending[]  → 左栏底部「待批 N」+1、S5 列表出现新卡
用户在 S5 点「批准」
  → respondApproval(requestId, true) → invoke('approval.respond')（幂等：重复/过期 requestId 安全）
  → 本地乐观把该项 state 置 'resolved'（卡片移入「本次已处理」）
  → 主进程结算 → 事件 pending.resolved{outcome} → 真值覆盖
若链上祖先代批（未到人）
  → 事件 approval.delegated{origin,tool,approver,mode,chain}
  → 直接进「本次已处理」流水，标注「由 <approver>（档位 auto）代批」
```

### 5.4 S7 的一次「继续」

S7 不发明新动作：**「继续」= `session.get` + 切到 S2**（等价于左栏点会话），M5 的 `ensureSessionLoaded` 会在 `session.get` 时懒加载整棵树。「只读打开」在本片**不做**（无只读模式协议），按钮删除。

---

## 六、边界情况与风险

| # | 情况 | 处理 |
|---|---|---|
| R-1 | **S5 验收时是空屏**（生产路径叶子工具为空，03 §7.1-C） | 空态必须写好（「没有等你拍板的事」+ 一句解释审批何时出现）；验收靠 `SMOKE` 注入的 echo 工具走一次真实审批（ui-smoke 已有审批幕） |
| R-2 | 链上 `auto` 祖先静默代批 ⇒ 收件箱永远空（03 §7.1-B） | 本片不改审批语义（内核事），但 S5 右栏「穿透规则」hint 原样保留那句「⚠️ 档位是按 Agent 而非按工具」，并靠 `approval.delegated` 流水让「谁替你批的」可见 |
| R-3 | 设置窗与主窗**双写 config** | 单一真相在主进程 `config-store`；两窗都只靠 `config.changed` 重绘，不本地缓存除乐观值以外的状态 |
| R-4 | `provider.headers` / `provider.models` 是 json 整体替换 ⇒ 并发覆盖 | 编辑时以最近一次 `config.get`/`config.changed` 的快照为基，提交后若 `config.changed` 带回不同内容则重绘（最后写入者胜，文档里说明） |
| R-5 | 设置窗关闭时机 / 主窗关了设置窗还开着 | `settingsWin` 在 `closed` 时置 null；`will-quit` 的 `host.dispose()` + `storage.flush()`（3s 上限）路径不受影响 —— **不许**因为多一个窗口就改退出流程 |
| R-6 | 新增 `styles/settings.css` 忘了加进 `apps/desktop/scripts/build.mjs:96` 的 `cssFiles` 数组 | 静默失效（dev 可能因另一条路径看似正常）⇒ 切片 3 的验证步骤里显式检查产物 `dist/renderer/axon.css` 含 `.st-nav` |
| R-7 | S6/S7 为算数字触发全量 `session.get`，打穿 M5 懒加载 | ui-smoke 加「进 S6/S7 后 `loadedCount` 不变」反向断言（同 MU-2 做法） |
| R-8 | `ui.*` 落 config 后，主窗需要在启动前拿到主题 ⇒ 首帧闪烁 | 本片只做浅色，`ui.theme` 实际不改变配色，闪烁风险为零；真做暗色时再议（台账） |
| R-9 | 菜单一上，macOS 默认菜单项（复制/粘贴/退出）若不补齐会丢失 | `menu.ts` 用 `Menu.buildFromTemplate` 带标准 `editMenu`/`windowMenu` 角色，只额外插「设置… ⌘,」 |
| R-10 | `ELECTRON_RUN_AS_NODE` 宿主注入 / ESM-only 两条老坑 | 新增 `windows.ts`/`menu.ts` 属主进程 `.mjs` 产物，esbuild external 规则不变；dev 脚本已带 `env -u`（AGENTS.md §5） |

---

## 七、实施计划（九片，每片可验证、可单独 commit）

> 顺序原则：**先协议后渲染**（E-1~E-4 一次到位，后续片只加行不动结构）；**先宿主后内容**（设置窗先能开，再填 pane）；**S5 → S6 → S7** 按数据依赖从简到繁；死链清零与冒烟放最后。

### 7.0 并行作业编排（用户 2026-09-16 要求「多会话窗口并行开发」）

> **与 AGENTS.md §4.4 的关系**：§4.4 原文是「同一工作树里同时只允许一个会话写代码、动 git」。用户本次明确要求并行，故本片按**受控豁免**执行，用三条替代纪律把 §4.4 想防的两件事（互相覆盖、git 打架）堵死：
> 1. **文件所有权唯一**：每个文件有且只有一个会话可写（下表），跨界即返工；
> 2. **git 单点**：只有主线会话执行 `git add/commit`，并行会话**一次 git 命令都不许跑**；
> 3. **共享文件全部前置**：所有需要多屏共同改动的文件，在阶段 0 由主线一次改完并 commit，并行会话开工时它们已是只读前提。
>
> 主线会话开工前应向用户确认是否把这三条写回 AGENTS.md §4.4（本片不擅自改根约定）。

**三阶段**：

```
阶段 0（主线，串行，切片 1 + 2 + 2.5）   ← 必须 commit 完成后才放并行
        协议与主进程扩展 / 设置窗宿主 / 所有共享渲染文件的坑位
                │
     ┌──────────┼──────────┬──────────┐
阶段 1  W-A S5   W-B S6    W-C S7    W-D S8      ← 四个会话窗口并行，只写各自新文件
     └──────────┴──────────┴──────────┘
                │
阶段 2（主线，串行）  死链核销 + ui-smoke 四幕 + 文档同步 + 质量门 + 收口 commit
```

**文件所有权表**（阶段 1 期间生效）：

| 会话 | 只写这些文件 | 只读（不许改） |
|---|---|---|
| **W-A**（S5 收件箱） | `renderer/components/S5Inbox.tsx`、`renderer/styles/screens.css` 的 `/* S5 */` 段 | 其余全部 |
| **W-B**（S6 预算用量） | `renderer/components/S6Budget.tsx`、`screens.css` 的 `/* S6 */` 段 | 其余全部 |
| **W-C**（S7 会话恢复） | `renderer/components/S7Sessions.tsx`、`screens.css` 的 `/* S7 */` 段 | 其余全部 |
| **W-D**（S8 设置窗） | `renderer/settings/**`（整目录）、`renderer/styles/settings.css` | 其余全部 |
| **主线** | 阶段 0 与阶段 2 的全部文件；并行期间**不写任何代码** | — |

> `screens.css` 是唯一被四家共用的文件。规避办法：阶段 0 先在文件里放好四段带注释的空占位（`/* ===== S5 ===== */` …），每家只在自己那段内追加，**不得调整他人段落、不得改文件头**。若仍冲突，以「屏内样式内联进各自组件」为兜底。

**并行会话的命令白名单**（抢资源的一律禁止）：

| 允许 | 禁止 | 为什么 |
|---|---|---|
| `bun run typecheck` | `bun run build:desktop` / `verify-lazy` | 都写同一个 `dist/`，并发会互相截断产物 |
| `bun run test`（只读跑，不改测试文件） | `bun run dev` / `bun run ui-smoke` | 抢 Electron 实例与 CDP 端口；ui-smoke 还会清场 |
| `read` / `grep` 任意文件 | **任何 `git` 命令** | git 索引是单点资源，并发 add 会互相吞改动 |

### 7.1 九片与阶段对应

| 片 | 阶段/归属 | 内容 | 怎么验证它对了 |
|---|---|---|---|
| **1** | 阶段 0 · 主线 | **协议与主进程扩展**：E-1 `SessionSummary.rollup` 透传、E-2 `ui.*` 五字段进白名单+默认值+校验、E-3 `shell.openPath` 归一 + `window.openSettings`、E-4 `config.reset` | 新增主进程单测：① `session.list` 返回的 summary 带 rollup 且 `interruptedAt` 与落盘一致；② `config.patch {ui.density:'compact'}` 落盘 + `config.changed`；③ 非法 `ui.theme` 值整批拒绝；④ `config.reset` 清 15 项、保留未知键；`bun run test` 518 → 约 530 全绿 |
| **2** | 阶段 0 · 主线 | **设置窗宿主**：`main/windows.ts`（单例 + focus）、`main/menu.ts`（标准角色 + 设置… ⌘,）、`main.tsx` 的 hash 分叉、`SettingsApp` 空壳 | `bun run dev` 按 `⌘,` 开窗；再按一次是**聚焦**不是开第二个；关掉主窗后 `⌘,` 仍可开；`build:desktop` + `verify-lazy` 全绿 |
| **2.5** | 阶段 0 · 主线（**并行的前提**） | **共享坑位一次做完**：`types.ts` 的 `Screen` 增三值；`Shell.tsx` switch 加三个 case；建三个屏组件空壳；`store.tsx` 补 2 订阅（`question.request`/`approval.delegated`）+ 3 action（`patchConfig`/`openSettings`/`openPath`；重置只在设置窗用，不进主窗 store）+ `resolvedFeed`；`selectors.ts` 抽公共 `money`/`fmtTime` 并补三组口径函数；`parts/ApprovalCard.tsx` 从 `MessageStream` 抽出；`screens.css` 放四段空占位；`build.mjs` 加 `settings.css` | `bun run typecheck` 绿；`bun run dev` 点三个新导航能进空屏不报错；S2 审批卡行为与外观**零变化**（抽件回归） |
| **3** | 阶段 1 · **W-D** | **设置窗样式与受控件**：`styles/settings.css`（原型 §11 搬运，逐值对齐）；`settings/fields.tsx` 五个受控件（env 置灰三态 + 行内错误 + 乐观值回滚） | 阶段 2 主线跑产物检查 `grep -c '\.st-nav' dist/renderer/axon.css` > 0；截图钩子（`AXON_SHOT_DIR`）对 `s8-settings.html` 逐值比对 |
| **4** | 阶段 1 · **W-D** | **S8 五个 pane 接线**：通用 / 外观 / 模型与网关 / 编排与安全 / 关于；`ledger.get/setAdoptionPolicy` 接裁决策略；危险区二次确认 | dev 手工（阶段 2 主线统一过）：改并发上限 → 主窗立刻生效；设 `AXON_MODEL=x` 重启 → 默认模型控件置灰且说明正确；点重置 → 二次确认 → 配置回默认、角色目录不受影响 |
| **5** | 阶段 1 · **W-A** | **S5 收件箱**：列表 + 分段 + 穿透链 + 阻塞影响 + 本次运行期已处理流水 + 空态（`ApprovalCard` 已由阶段 0 抽好，复用 `variant='inbox'`） | SMOKE 工具触发审批 → S5 出现同一张卡 → 在 S5 批准 → S2 的卡同步消失；空态截图 |
| **6** | 阶段 1 · **W-B** | **S6 预算与用量**：告警卡 + 三指标 + 按会话排行 + 成本构成（降级版）+ 右栏三块 + 「最近预算事件」（接管 `budgetAlert` 遗留口） | 造两个会话（一个超软线）→ 三指标与「最严会话档位」正确；`loadedCount` 反向断言；文案自查：全屏无「今日」、无「协作开销占比」、无轮数 |
| **7** | 阶段 1 · **W-C** | **S7 会话恢复**：分段 + 会话行（含「上次中断」）+ 存储实况 + issue 清单 + 「继续」跳 S2 | 真盘重启场景手工复现：跑到一半退出 → 重开 → S7 显示该会话「可恢复」并带中断时刻；点「继续」进 S2 且消息完整；`loadedCount` 反向断言 |
| **8** | 阶段 2 · 主线 | **死链核销 + CSS 去重**：`Sidebar.tsx` 的 `NAV_LATER` 上移、badge 取真值、账号菜单两项接线、底部「待批 N」可点、brand 区搜索/通知两枚装饰图标**删除**；清掉 `tokens.css` 与 `base.css` 重复归一段 | 全 renderer `grep -n 'MU-3'` 零命中（除历史说明注释）；视觉回归截图 |
| **9** | 阶段 2 · 主线 | **冒烟补幕 + 文档同步 + 收尾**：先修 `ui-smoke.mjs` 的 `getPageTarget()`（选窗条件加 `&& !url.includes('#settings')`，否则会选中设置窗，见 §十三 T-7）；再新增 S5/S6/S7 三幕 + 设置窗一幕（开窗→改一项→主窗读回→重开仍单例）+ 两条 `loadedCount` 反向断言；回填 §十一/§十二/§十三；同步 03 §1 与 01 §1 | 质量门七件套全绿（§九）；台账里 MU-2 的 A-10 / C-1 / C-2 / C-4 四行按实际结果核销 |

**主线在阶段 1 期间做什么**：不写代码，只做 review —— 每完成一屏，主线读一遍其文件、跑一次 `typecheck`、用 `git status --short` 确认没越界改他人文件，然后**由主线 commit**（一屏一个 `feat(renderer):` commit）。

---

## 八、测试策略

| 层 | 覆盖 | 位置 |
|---|---|---|
| 主进程单测 | E-2 `ui.*` 校验（合法/非法/删除）、E-4 `config.reset` 的「清白名单 + 留未知键」、E-3 `shell.openPath` 枚举分支 | `apps/desktop/src/main/config-store.test.ts`（扩） |
| 真盘集成 | E-1 rollup 透传：重启后 `session.list` 的 summary 带 `interruptedAt` | `apps/desktop/src/main/host.restart.test.ts`（扩） |
| 契约 | 不新增（本片不碰 pi 边界） | — |
| 渲染层 | 沿用 MU-2 口径：**无单测，靠 ui-smoke**（渲染层是薄壳，逻辑都在 selectors 纯函数里；若某个口径函数复杂到值得测，就单独给 `selectors` 补纯函数测试而不是测组件） | `scripts/ui-smoke.mjs` |
| UI 冒烟 | 新四幕：S5（触发审批→收件箱可见→批准→消失）、S6（三指标 + loadedCount 不变）、S7（重启后可恢复行）、S8（⌘, 开窗→patch 一项→读回一致） | `scripts/ui-smoke.mjs` |
| 人眼验收 | 截图钩子 `AXON_SHOT_DIR` 对 s5/s6/s7/s8 四张原型逐值比对（MU-2 同法） | `docs/ux/mockups/` |

**测试基线**：518 例 / 24 文件不许回退；本片预计 +10~15 例（全在主进程侧）。

**实测结果（收尾）**：**528 例 / 24 文件**（+10，全在 `config-store.test.ts` 与 `host.restart.test.ts`），渲染层零单测的口径守住。ui-smoke 从 24 条断言涨到 **41 条**（新增四幕 + 3 条 `loadedCount` 反向断言）。

---

## 九、验收标准（可勾选）

- [x] 左栏六项导航**全部可点**，无 `disabled`、无 `title="MU-3"` 残留；badge 取真实待批数
- [x] S5：跨会话审批可见可批；穿透链正确；代批有留痕流水；空态有解释；在 S5 批准后 S2 同步消失
- [x] S6：全局档位/软硬线/累计已用三指标正确；按会话排行可点进该会话用量视图；无「今日」「协作开销占比」「轮数」等无源数字（冒烟 7.6 幕有一条「全屏无『今日』」的文案断言）
- [x] S7：重启后能看出哪些会话被中断；点「继续」能回到完整会话（冒烟 8.5 幕）
- [x] S8：`⌘,` 与账号菜单都能开窗且是**单例聚焦**；五个 pane 齐；改任一项立刻生效且重启后保持；被 env 覆盖的三项置灰且说明正确；重置只动 config.json
- [x] 每行设置都有一句说明（03 §3 硬规矩），无保存按钮
- [x] 懒加载不破：进 S6/S7 后 `storage.status.loadedCount` 不变（冒烟三条反向断言）
- [x] 质量门七件套全绿：`guard` / `typecheck` / `test`（**528**） / `build:desktop` / `verify-lazy` / `ui-smoke` / `dev` 手工过一遍上述能力
- [x] MU-2 台账 A-10 / C-1 / C-2 / C-4 四行按实际结果核销，不留口头延期

---

## 十、文档同步

| 文档 | 改什么 |
|---|---|
| `docs/03-实施框架与里程碑.md` | §1 状态表 MU-3 行改 ✅（并把范围从「S5/S6/S8」改为拍板后的真实范围）；§3 MU-3 条目补交付摘要 |
| `docs/01-架构决策-方案B.md` | §1 进度表补 MU-3 |
| `docs/ux/03-设置界面设计.md` | §7 D-3 状态从「未定」改为「已由 MU-2 拍板：浅色胜出；暗色见 MU-3 台账」；G11 十四条逐条标「已兑现 / 本片兑现 / 转台账」 |
| `docs/ux/00-信息架构与屏幕清单.md` | S5/S6/S7 三节补「实现落点」行 |
| `docs/milestones/MU-2-renderer-core.md` | §十二 台账 A-10 / C-1 / C-2 / C-4 标注回收状态（**不删行**） |
| 本文件 | §〇 回填拍板结果；收尾补 §十一 拍板记录、§十二 遗留台账、§十三 设计 vs 实测 |

---

## 十一、拍板记录

> 用户 2026-09-16 逐条拍板，全部按「推荐方案」通过，无改动。

| # | 议题 | 结论 | 一句话理由 |
|---|---|---|---|
| P-1 | 本片做三屏还是四屏 | **四屏（含 S7 会话恢复）** | 不做 S7，M5 的落盘/恢复成果在 UI 上没有出口，「重启后哪些会话被中断」只能看日志 |
| P-2 | S8 是屏还是独立窗 | **独立 `BrowserWindow`** | 设置没有会话上下文，塞进主窗就得给它挂一个语义错误的会话 chip；⌘, 是系统级习惯 |
| P-3 | 外观偏好存哪 | **`config.json` 的 `ui.*`** | 两窗要同步，而 `file://` 下 localStorage 分区不可靠；配置的真相本来就在主进程 |
| P-4 | 暗色主题 | **本片不做**，`ui.theme` 保留 `dark`/`system` 枚举但控件置灰 | 全量换肤要复核 12 屏，够独立一片（台账 D-7） |
| P-5 | S5「已处理」的时间范围 | **降级为「本次运行期内」** | `ApprovalBroker` 结算即 delete，盘上没有历史（台账 D-1） |
| P-6 | 选项式提问 | **不做** | `question.request` 全仓无发射方，形状未定（台账 D-2） |
| P-7 | 协议扩展的边界 | 做 `shell.openPath` + `config.reset`，**不做** `provider.test` | 前两个是纯本地枚举操作；后者要主进程发真 HTTP，归 M6 |
| P-8 | S6 的时间口径 | **全部改「累计」文案** | `BudgetGuard` 只有进程内累计，没有日切；写「今日」就是假数据（台账 D-4） |
| R-8 | 外观四项要不要真生效 | **三项真生效，`annotations` 删行不删字段** | density/fontSize/reduceMotion 落 body `data-*` + CSS 变量；标注系统在渲染层根本不存在（原型里是 `assets/shell.js` 的 `⌘/` 调试工具），按「协议给不出就删界面元素」删行，白名单字段留给 G11.13（台账 D-11） |

## 十二、遗留工作台账（延期项登记处，实施中新增的当场补）

| # | 内容 | 为什么延 | 落点 |
|---|---|---|---|
| D-1 | `pending.history`：审批/提问的**持久**历史 | broker 结算即 delete，不留档；需新协议 + 落盘 | M6 后（与账本查询口径一起看） |
| D-2 | 选项式提问 + `question.request` 发射方 | 全仓无发射方，形状未定 | Axon5 人机交互专片 |
| D-3 | `provider.test`（测试连接） | 要主进程发真 HTTP | M6 真实模型接入 |
| D-4 | 按日预算重置（「今日已用 / 日硬线」） | `BudgetGuard` 只有进程内累计，日界与跨重启语义未定 | 内核片（M6 前后） |
| D-5 | G5.2 用量按协作动作切片（「协作开销占比」） | pi Usage details 未透传 | M6 前置·快照补全 |
| D-6 | `SessionCounts.turns`（轮数） | 快照无该计数 | 同 D-5 |
| D-7 | 暗色主题 + 主题切换器（承接 MU-2 台账 C-4） | 全量换肤 + 12 屏复核，独立一片 | 待排 |
| D-8 | 孤儿目录清理（S7「清理孤儿」） | 无扫描/删除命令；删用户目录不可逆 | 待排（需单独设计确认流程） |
| D-9 | Tray / 防休眠、检查更新、开源许可证、设置搜索框、目录选择器 | 无实现且非本片主线 | M7（打包与分发）一并考虑 |
| D-10 | 只读打开会话（S7 按钮） | 无只读模式协议 | 待排 |
| D-11 | 「显示协议数据标注」设置行 | 渲染层没有标注系统（原型里那是 `assets/shell.js` 的 `⌘/` 调试浮层，不是产品能力）；按「协议给不出就删掉界面元素，不填假数据」删行 —— 白名单字段 `ui.annotations` **保留**，`config.patch` 存得进、读得出，只是没人消费 | G11.13（做标注系统那一片）；届时按 `SegField` 形状重写一个 `ToggleField`（本片已把死控件与 `.tgl` CSS 一并删除，见 §十三 T-11） |
| D-12 | S8「关于」pane 的检查更新 / 开源许可证 | 无实现，属打包分发范畴 | 归入 D-9（M7） |

**MU-2 台账核销（本片承接的四行）**：

| MU-2 # | 内容 | 本片结果 |
|---|---|---|
| A-10 | 左栏 S5/S6/S8 三项导航置灰（`NAV_LATER`） | ✅ **核销**：六项全部可点，`NAV_LATER` 与 `title="MU-3"` 已从 `Sidebar.tsx` 删除；badge 取 `pending.length` 真值 |
| C-1 | 底部「待批 N」是死数字 | ✅ **核销**：`data-smoke="foot-pending"` 接 S5 落点，冒烟 7.6 幕验它可点并跳屏 |
| C-2 | 账号菜单两项无落点 | ✅ **核销**：「设置…」→ `window.openSettings`；「打开配置目录」→ `shell.openPath('config')` |
| C-4 | 暗色主题缺失 | ⏳ **转结**：本片确认不做（拍板 P-4），并入本表 D-7；`ui.theme` 字段与置灰控件已就位 |

## 十三、设计 vs 实测

> 实施期发现的原型/协议出入逐条记这里，以实测为准并回写对应 UX 文档。

### 阶段 0 实施记录（2026-09-16，切片 1 / 2 / 2.5）

| # | 设计原话 | 实际做法 | 为什么改 |
|---|---|---|---|
| T-1 | E-3「给 `role.openDir` 加 kind」 | 删 `role.openDir`/`team.openDir`，新建枚举命令 `shell.openPath` | 枚举把可达集锁在主进程；旧名字能开 sessions/config 名不副实（详见 §四.1 E-3 注） |
| T-2 | E-2 白名单「15 条」 | 白名单 15 → **20 条**，`ConfigFieldKind` 新增 `'boolean'` | `ui.reduceMotion`/`ui.annotations` 是布尔，原有 kind 只有 string/number/enum，不加就只能存字符串 `'true'` |
| T-3 | E-4 `config.reset` 可否用 `patch` 逐个置 null | **不复用**，写独立 `reset()`（与 `patch` 共用抽出的 `commit()`） | `patch` 路径会被 `env-locked` 拦住 ⇒ 「重置了但没重置干净」；重置是对**文件**的操作，env 覆盖是运行时的事，两件事 |
| T-4 | S8 窗的渲染入口 | 两窗**共用一份 `renderer.js` + `index.html`**，`location.hash === '#settings'` 分叉；设置窗**不复用** `AppProvider`，另写 `SettingsStore` | 再加一条 esbuild 入口 = 再维护一份 CSP；主窗 store 订了十余条会话事件并维护消息流，设置窗一条不需要，它的唯一真相是 `ConfigSnapshot` |
| T-5 | （未入设计） | `main.tsx` 在 `#settings` 下设 `document.title = '设置'` | 共用 `index.html` ⇒ `<title>` 也共用，`BrowserWindow.title` 选项会被页面 `<title>` 覆盖，实测两窗都叫「Axon」 |
| T-6 | 「S5 与 S2 的审批卡各自实现」 | 抽出 `components/parts/ApprovalCard.tsx`（`variant: 'stream'｜'inbox'`），S2 `MessageStream` 改为复用 | 同一条待办在两屏长得不一样，用户会当成两件事；四个 `data-smoke` 钩子原样保留，冒烟不破 |
| T-7 | — | `ui-smoke.mjs` 的 `getPageTarget()` 用 `url.includes('index.html')` 选窗 | 设置窗 URL 同样含 `index.html`（带 `#settings`）⇒ **切片 9 补冒烟幕时必须改成排除 `#settings`**，否则会随机选错窗 |

**阶段 0 真窗口实测（CDP 探针，临时脚本）**：① `window.openSettings` → `{opened:true}`，设置窗 1 个；② 再调一次仍为 1 个（单例成立）；③ 设置窗 5 个导航项、`body[data-window=settings]`、`settings.css` 已生效；④ 在设置窗 `config.patch {ui.density:'compact'}` 后，**主窗** `config.get` 读到 `{density:'compact'}`（双窗同步通）；⑤ `config.reset` 后 `ui` 清空；⑥ 左栏 s5/s6/s7 均可点达，标题分别为「收件箱 / 预算与用量 / 会话恢复」。

### 阶段 1 实施记录（2026-09-16，四窗并行 · 切片 3~7）

| # | 设计原话 | 实际做法 | 为什么改 |
|---|---|---|---|
| T-8 | `ApprovalCard` 的对外形状是 `{request, variant, sessionTitle?, onOpenSession?}` | 补两个可选扩展点 `headTag?` / `children?` | S5 要在卡头挂「代批」标记、在卡尾插「阻塞影响」说明，而这两处 S2 都不需要；两者都有默认值 ⇒ 不传时与抽件前**逐像素一致**，四个 `data-smoke` 钩子零变化 |
| T-9 | 「S3/S6 各写一个 `money()` 格式化」 | 四个局部 `money` + 一个局部 `relDay` 合并进 `selectors`，`S3Teams` 只留一层 `teamMoney` 包装 | 同一个金额在四屏里必须一模一样；`teamMoney` 留着是因为团队的 `undefined` 语义是「没设上限」而不是「$0.00」，这层判空不该塞进通用格式化 |
| T-10 | — | W-C（S7）**违规自行 commit `96f1aee`** | 违反 AGENTS.md §4.4 受控豁免第 3 条（git 单点）。已保留原样不做历史改写（rebase 一条已入库的 commit 收益远小于风险），只记在此处备查 |

**阶段 1 真窗口实测（CDP 探针）**：三屏正常渲染无 console 错误；`storage.status.loadedCount` 进 S6/S7 前后 1 → 1（R-7 守住）；设置窗五个 pane 的设置行数分别为 6/5/10/6/8。

### 阶段 2 实施记录（2026-09-16，切片 8 / 9）

| # | 设计原话 | 实际做法 | 为什么改 |
|---|---|---|---|
| T-11 | R-8「外观四项真生效」 | 三项真生效 + `ToggleField` **整个组件与 `.tgl` CSS 一族删除** | 删掉 `ui.annotations` 那一行后，全仓布尔配置项归零 ⇒ 控件零使用者。留着就是 40 行组件 + 25 行 CSS 的死代码；G11.13 要用时按 `SegField` 形状重写只需 20 行 |
| T-12 | 密度「按原型收紧行距与字号」 | **只改纵向节奏**（`--row-y` 13→8px / `--prow-y` 9→5px / `--sec-gap` 22→14px），字号与横向留白不动 | 缩字号是拿可读性换密度，而字号本来就有独立的滑杆；收横向留白会让长路径更早被截断 |
| T-13 | 字号「落 `data-font-size`」 | 落 CSS 变量 `--fs-msg`（`body.style.setProperty`），只影响会话正文 | 字号是连续量（12~20），枚举属性要为每个值写一条规则、改区间还得同步改 CSS；且全局缩放会顺带改掉侧栏/顶栏，那不是用户在「消息字号」滑杆上期待的 |
| T-14 | — | `reduceMotion === 'system'` 也必须落属性 | 浏览器只对自己的滚动/动画尊重 `prefers-reduced-motion`，不会替我们停掉自定义 `transition`；「缺省从没设过」与「显式选跟随系统」在 CSS 上是两条不同规则 |
| T-15 | — | `applyAppearance` 由 `useEffect` 盯 `config` 状态，而不是在三个 `setConfig` 调用点各写一遍 | 三条写入路径（开机拉取 / `config.changed` / 本窗 patch 回包）终值相同，盯状态就只有一处真相，也不会漏掉以后新增的写入路径 |
| T-16 | 冒烟「S5 幕：触发审批 → 收件箱可见 → 批准 → 消失」 | 改为**另起一个分身留一条不批的审批**，且必须排在烧钱幕**之前** | ① 预算 `frozen` 是终态，`assertCanStart` 会挡下之后所有 spawn/prompt（`packages/kernel/src/budget.ts:94`）；② 同一个分身被审批卡住时发不了新 prompt，而烧钱那两轮还得用它；③ 这条待批同时充当 S7「上次中断」的标的 —— 硬杀时得有人处于非终态，恢复扫描才有痕迹可留 |
| T-17 | 冒烟 S5 断言「空态 + 已处理流水并存」 | 改为「默认 tab 验待处理卡 → 切『全部』tab 验两段并存」 | 实测默认 tab 是「待处理」，它根本不渲染「本次已处理」段，原断言要求两个互斥的钩子同时在场，必红。顺带把分段切换这个交互也验了 |
| T-18 | （未入设计，切片 9 跑出来的真 bug） | `host.ts` 的 `scheduleRollup` **透传已有 `interruptedAt`** | 它是**历史事实**（上次退出时还有人在跑），不是当前状态。重启后任意一次落账/状态跃迁/`turn.end` 都会走到 `scheduleRollup`，不透传就等于把刚标上的中断痕迹无声抹掉 —— S7 的「可恢复」会在用户眼皮底下消失 |
| T-19 | （同上） | `markInterruptedAt` 之后 `emit('session.changed')` | 该方法在**懒加载当场**被调（用户刚点开这个会话），而渲染层的会话列表还是开机那一发 `session.list` 的快照；不播的话 S7 要等下一次全量刷新才看得见「上次中断」，而那时用户早已错过提示 |

**阶段 2 真窗口实测**：`ui-smoke` 41 条断言全绿（原 24 条 + 新四幕）。R-8 单独跑过 CDP 探针：设置窗 patch `{density:'compact', fontSize:18}` → 两窗 `body.dataset.density === 'compact'`、`--fs-msg` 计算值 `18px`、`--row-y` `8px`；`config.reset` → 两窗回缺省（`data-density` 消失、`--fs-msg` 回 `15px`）；两窗 console 零错误。

**切片 8 死链核销清单（`git show 0b6555a --stat`）**：侧栏 brand 区两枚装饰图标（搜索/通知）及其 CSS；`tokens.css` 与 `base.css` 的重复归一段（拼接顺序下 base 胜出，前者从未生效）；约 14 条无使用者的 CSS 规则（`.bubble-meta`/`.msg-actions`/`.topbar .act`/`.composer .act`/`.badge.quiet`/`.menu[hidden]`/`a.stat:hover`/`.seg-a`/`.field.ta`/`.field.dim`/`.view-head h2`/`.lnk`/`.st-back`/`.is-ext`）；重复定义的 `.side-scroll` 与 `.tree .lvN::before` 合并；`selectors.blockedCount`/`splitRecoverable` 两个无消费者的导出删除，`isTerminal`/`textOfBlocks`/`fmtInt`/`relDay`/`Prose`/`InlineSeg` 六个降为文件私有；store context 上 `removeSession`/`renameSession`/`patchConfig`/`loadLedger` 四个无消费者的导出收回。保留 `Icon` 的 18/20 两档尺寸并加注：它是令牌梯度，不是死链。

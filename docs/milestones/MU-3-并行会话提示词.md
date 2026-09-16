# MU-3 并行会话提示词（复制即用）

> 用法：**先在主线会话跑完阶段 0 并 commit**，再开四个新会话窗口，各自粘贴对应提示词。
> 编排规则见 `docs/milestones/MU-3-closing-screens.md` §7.0（文件所有权表 + 命令白名单）。
> 三条铁律：**只写自己名下的文件** / **一次 git 命令都不许跑** / **不许跑 dev、ui-smoke、build:desktop**。

> **阶段 0 已于 2026-09-16 完成并 commit（`32db327`）；四个并行窗口可以开了。**
>
> **主线已备好、直接用即可的 API**（别再造一份，也别改它们）：
> - `useApp()`（`state/store.tsx`）新增：`pending` / `resolvedFeed` / `openPath(kind)` / `openSettings()` / `patchConfig(patch)`
> - `state/selectors.ts` 新增：`money` `relDay` `fmtTime` `since`；S5 用 `splitPending` `blockedCount`；S6 用 `spendRanking` `strictestTier` `totalUsage`；S7 用 `interruptedAt` `splitRecoverable`
> - `components/parts/ApprovalCard.tsx`：`<ApprovalCard request variant="stream"|"inbox" sessionTitle? onOpenSession? />`（S2 已改为复用它，四个 data-smoke 钩子不得改名）
> - `settings/SettingsStore.tsx`：`useSettings()` → `{ config, issues, error, patch, reset, openPath, dismissError }`（不做乐观更新；真相只来自 `config.get` / `config.changed`）
> - 三个屏骨架文件（`S5Inbox.tsx` / `S6Budget.tsx` / `S7Sessions.tsx`）头部注释已列出各自的可用原料与约束，开工先读
> - 命令名变更：`role.openDir` / `team.openDir` 已删，统一为 `shell.openPath {kind:'roles'|'teams'|'config'|'sessions'}`；另有 `window.openSettings`、`config.reset`
> - 环境：`bun` 不在默认 PATH，先 `export PATH="/opt/homebrew/bin:$PATH"`；当前测试基线 **528 例 / 24 文件**，不得回退

---

## 0. 主线会话（阶段 0，串行，必须先跑完）

```
你在 /Users/lucaszhou/works/prjs/axon 工作。先读 AGENTS.md，再读 docs/milestones/MU-3-closing-screens.md 全文（方案已评审通过，§〇 八条拍板全部按推荐列执行）。

你的任务：执行 §7.1 的切片 1、2、2.5（阶段 0，主线串行），为后续四个并行会话铺好全部共享地基。做完这三片并提交后停下，等我开并行窗口。

切片 1 —— 协议与主进程扩展（§4.1 的 E-1~E-4，只做这四处，不许多加命令/事件/字段）：
- E-1：packages/protocol/src/session.ts 的 SessionSummary 增可选 rollup: SessionRollup；apps/desktop/src/main/session-store.ts 的 buildSessionSummary 透传（S7 的「上次中断」只能来自 rollup.interruptedAt）
- E-2：packages/protocol/src/config.ts 增 ui.theme / ui.density / ui.fontSize / ui.reduceMotion / ui.annotations 五条，进 ConfigPatchPath + CONFIG_FIELD_SPECS + CONFIG_DEFAULTS，并在 config-store.ts 的 validateValue 做 enum/boolean 校验
- E-3：ipc.ts 的 openDir kind 从 'roles'|'teams' 扩到含 'config'|'sessions'（用 shell.showItemInFolder reveal 单文件）；新增命令 window.openSettings（payload 空）
  【实际已实施为——删 role.openDir / team.openDir，新建单条枚举命令 shell.openPath {kind:'roles'|'teams'|'config'|'sessions'}；理由见 closing-screens.md §四.1 E-3 注】
- E-4：新增命令 config.reset —— 把 15 条白名单路径删回默认，保留未知键，返回新快照并发 config.changed

切片 2 —— 设置窗宿主：
- 新建 apps/desktop/src/main/windows.ts（createMainWindow + openSettingsWindow，settingsWin 单例：已存在则 focus，closed 时置 null）
- 新建 apps/desktop/src/main/menu.ts（Menu.buildFromTemplate，带标准 editMenu/windowMenu 角色，额外插「设置… ⌘,」）
- index.ts 接线：启动装菜单、window.openSettings 路由、shell.openPath 路由（OPEN_PATHS 惰性求值表）、config.reset 路由；**不许改 will-quit 的 dispose/flush 流程**
- renderer/main.tsx 按 location.hash === '#settings' 分叉挂 <SettingsApp/>；新建 renderer/settings/SettingsApp.tsx 空壳（st-nav + 五个空 pane）+ SettingsStore.tsx（只订 config.changed，只拉 config.get / budget.get / storage.status / ledger.getAdoptionPolicy）

切片 2.5 —— 共享坑位一次做完（这是并行的前提，缺一项并行会话就会互相改同一个文件）：
- renderer/state/types.ts：Screen 增 's5' | 's6' | 's7'
- renderer/components/Shell.tsx：switch 加三个 case（注意 's0' 占着 default）
- 建三个空壳文件：components/S5Inbox.tsx / S6Budget.tsx / S7Sessions.tsx（各自渲染一个 .empty 占位即可）
- renderer/state/store.tsx：补订阅 question.request、approval.delegated；补 action patchConfig / openSettings / openPath（重置只在设置窗用，不进主窗 store）；补派生 resolvedFeed（本次运行期内已处理的请求流水）
- renderer/state/selectors.ts：把 money（现在 S2Views.tsx / S1Workbench.tsx / Chips.tsx 各写一遍）与时间格式化抽成公共导出；补 inbox / budget / sessions 三组口径函数
- 新建 renderer/components/parts/ApprovalCard.tsx：从 MessageStream.tsx 抽出 ApprovalCard / QuestionFoot / Chain，带 variant: 'stream' | 'inbox'；MessageStream 改为引用它，**S2 的外观与行为必须零变化**
- renderer/styles/screens.css：放四段带注释的空占位 /* ===== S5 ===== */ /* ===== S6 ===== */ /* ===== S7 ===== */（S8 用独立文件）
- 新建空的 renderer/styles/settings.css，并加进 apps/desktop/scripts/build.mjs:96 的 cssFiles 数组（漏了会静默不生效）

纪律：
- 包管理器只有 bun；pi import 只许在三个白名单文件；渲染进程零 Node
- 每一处协议改动要带注释说明「为什么」，风格对齐现有文件
- 完成后跑 bun run guard / typecheck / test（518 → 约 530 全绿）/ build:desktop / verify-lazy，再做一次 bun run dev 手工验证（⌘, 能开窗且再按是聚焦；三个新导航能进空屏）
- 做完用一个 feat 语义化 commit 提交（代码 + 测试一起），然后向我汇报：改了哪些文件、测试数、并行会话现在可以开工了吗
```

---

## 1. W-A 会话：S5 收件箱

```
你在 /Users/lucaszhou/works/prjs/axon 工作，是 MU-3 里程碑四个并行会话中的 W-A，只负责 S5 收件箱这一屏。

先读：AGENTS.md → docs/milestones/MU-3-closing-screens.md（重点 §7.0 并行编排、§4.3 数据装配、§5.3 S5 流程、§六 风险 R-1/R-2）→ docs/ux/mockups/s5-inbox.html（视觉与结构逐值对齐的来源）→ docs/ux/02-团队与会话模型.md:120-122（S5 的唯一职责）。

【硬边界 —— 违反即返工】
- 你只许写这两处：apps/desktop/src/renderer/components/S5Inbox.tsx、renderer/styles/screens.css 里 /* ===== S5 ===== */ 那一段之内
- 其他任何文件一律只读。需要 store 的新字段/新 action？**不要自己加**，停下来告诉我，由主线统一加
- 禁止跑：任何 git 命令、bun run dev、bun run ui-smoke、bun run build:desktop、bun run verify-lazy
- 允许跑：bun run typecheck、bun run test（只读跑，不改测试文件）、read/grep

【要做的事】
按原型 s5-inbox.html 实现 S5，数据源全部来自 store（pending 数组已在启动时由 pending.list 拉好，approval.request / pending.resolved / question.request / approval.delegated 四个订阅已由主线接好）：
1. 工具条：seg①「待处理 N / 本次已处理 M / 全部」、seg②「全部会话 / 每会话一枚带计数」、右侧「全部拒绝」（实现为循环 N 次 approval.respond，要处理部分失败）
2. 审批卡：复用 components/parts/ApprovalCard.tsx 的 variant='inbox'（**不要重写一份**）；含穿透链、会话 tag（可点跳该会话）、等待时长/超时、折叠块「完整命令与工作目录」
3. 提问卡：只做纯文本提问（复用同一组件）；**不做选项式提问**——question.request 全仓无发射方
4. 「本次已处理」流水：从 pending 里筛 state==='resolved' + store 的 resolvedFeed（含 approval.delegated 的代批留痕，标注「由 X（档位 auto）代批」）；屏上必须明说「刷新后清空」——真历史需要新协议，本片不做
5. 右栏：穿透规则三行 def（always_ask / auto / full_access，档位名以 packages/protocol/src/agent.ts 的枚举为准）+ 那句「⚠️ 档位是按 Agent 而非按工具的」原样保留；阻塞影响列表 = 会话成员里 status==='suspended' 的子集
6. **空态是必做项**（不是锦上添花）：生产路径叶子工具为空，验收时大概率就是空屏。写清「没有等你拍板的事」+ 一句解释审批何时出现

【禁止】
- 不做「本会话内同类命令自动放行」checkbox（无规则放行协议）
- 不做「批准一次 / 批准并继续」两个按钮（协议只有一个布尔 approved），只做「批准 / 拒绝」
- 不填任何协议给不出的数字（原型的「今天已处理 7」是示意，不是真值）

【完成标准】
bun run typecheck 绿；自查全屏没有假数据、没有 disabled 死控件；然后向我汇报：做了什么、删了原型的哪些元素及原因（这些我会记进文档 §十二台账）。**不要 commit，由主线收口。**
```

---

## 2. W-B 会话：S6 预算与用量

```
你在 /Users/lucaszhou/works/prjs/axon 工作，是 MU-3 里程碑四个并行会话中的 W-B，只负责 S6 预算与用量这一屏。

先读：AGENTS.md → docs/milestones/MU-3-closing-screens.md（重点 §7.0 并行编排、§4.3 数据装配、§六 风险 R-7）→ docs/ux/mockups/s6-budget.html → docs/ux/00-信息架构与屏幕清单.md 的 S6 一节。

【硬边界 —— 违反即返工】
- 你只许写这两处：apps/desktop/src/renderer/components/S6Budget.tsx、renderer/styles/screens.css 里 /* ===== S6 ===== */ 那一段之内
- 其他任何文件一律只读。缺 store 字段就停下来告诉我，不要自己加
- 禁止跑：任何 git 命令、bun run dev、bun run ui-smoke、bun run build:desktop、bun run verify-lazy
- 允许跑：bun run typecheck、bun run test（只读跑）、read/grep

【要做的事】
按原型 s6-budget.html 实现 S6（全局口径的**只读**屏，改限额归 S8）：
1. 告警卡：有会话进入 warning/frozen 时出现，叙述句 + 进度条（.bar.warn 已在 components.css 定义好，直接用）
2. 三张指标卡：①累计已用 ②全局软线/硬线 ③最严重的会话档位（ok → warning → frozen 单向）
3. 「按会话」列表：从 store 的 sessions（session.list 结果）按 usage.costUsd 倒序；每行显示会话名 + 团队 tag + 档位 tag + 「N 成员」+「$已用 / $有效上限」（来自 SessionBudgetView 的 effectiveSoft/HardUsd）；点行跳该会话的「用量」视图
4. 末行「已结束的 N 个会话 / 历史合计 $X」：只从 session.list({status:'closed'}) 的 rollup 汇总求和
5. 右栏三块：档位语义、三层限额（全局/团队/会话，取更严者生效——**注意原型那句「当前内核只有全局一层」已过时，MU-1 三层预算已交付，必须改写**）、最近预算事件（接管 store 里目前无人消费的 budgetAlert 遗留口，屏上说明是本次运行期内的易失列表）

【禁止 —— 这些数字协议给不出，整块删掉而不是填假值】
- 不做「今日」维度（BudgetGuard 是进程内累计、无日切）⇒ **全屏不许出现「今日」「/日」字样，一律写「累计」**
- 不做「其中协作开销 $X（N%）」占比（用量未按协作动作切片）
- 不做「19 轮 / 12 轮」轮数（SessionCounts 无该字段）
- 不做 .ava-stack 头像叠层（SessionTeamRef 没有成员名单；MU-2 已按同样理由删过，沿用「团队名首字 + 成员数」）

【必须守住的不变量】
S6 只读 session.list 的 rollup 汇总，**绝不能为了算数字去调 session.get** —— 那会打穿 M5 的懒加载（storage.status.loadedCount 必须在进 S6 后保持不变，主线会加 ui-smoke 反向断言）。

【完成标准】
bun run typecheck 绿；自查全屏无「今日」、无占比、无轮数；然后向我汇报做了什么、删了哪些原型元素及原因。**不要 commit，由主线收口。**
```

---

## 3. W-C 会话：S7 会话恢复

```
你在 /Users/lucaszhou/works/prjs/axon 工作，是 MU-3 里程碑四个并行会话中的 W-C，只负责 S7 会话恢复这一屏。

先读：AGENTS.md → docs/milestones/MU-3-closing-screens.md（重点 §7.0 并行编排、§4.3、§5.4 S7 流程）→ docs/ux/mockups/s7-sessions.html → docs/milestones/M5-tree-persistence.md（落盘布局与恢复语义）。

【硬边界 —— 违反即返工】
- 你只许写这两处：apps/desktop/src/renderer/components/S7Sessions.tsx、renderer/styles/screens.css 里 /* ===== S7 ===== */ 那一段之内
- 其他任何文件一律只读。缺 store 字段就停下来告诉我，不要自己加（rollup 已由主线在切片 1 透传到 SessionSummary）
- 禁止跑：任何 git 命令、bun run dev、bun run ui-smoke、bun run build:desktop、bun run verify-lazy
- 允许跑：bun run typecheck、bun run test（只读跑）、read/grep

【要做的事】
按原型 s7-sessions.html 实现 S7：
1. 分段 seg：全部 / 可恢复（summary.rollup?.interruptedAt 存在）/ 已归档（record.status==='closed'）
2. 会话行：状态点 + 会话名 + mono sessionId + 状态 tag + 「N 个分身 · M 笔协作 · cwd」+ 时间；被中断的会话额外显示「上次中断于 …」
3. 「继续」按钮 = openSession(id) 并切到 S2（**不发明新动作**；M5 的 ensureSessionLoaded 会在 session.get 时懒加载整棵树）
4. 存储实况区：storage.status 的 root / sessionCount / loadedCount，以及 issues 清单按 kind 分组显示（坏文件不阻断启动，但要让用户看得见）

【禁止】
- 不做「清理孤儿」按钮：StorageIssueKind 里虽有 orphan-dir，但没有扫描与删除命令，删用户目录是不可逆动作，本片不做
- 不做「只读打开」按钮：无只读模式协议
- 不为了显示计数去调 session.get —— 只用 session.list 的 rollup/counts。进 S7 后 storage.status.loadedCount 必须不变（主线会加 ui-smoke 反向断言）

【完成标准】
bun run typecheck 绿；自查：所有数字都能指到 SessionSummary / StorageStatus 的具体字段，没有一处是编的；然后向我汇报做了什么、删了哪些原型元素及原因。**不要 commit，由主线收口。**
```

---

## 4. W-D 会话：S8 设置窗

```
你在 /Users/lucaszhou/works/prjs/axon 工作，是 MU-3 里程碑四个并行会话中的 W-D，只负责 S8 设置窗（工作量最大的一块，独立窗口）。

先读：AGENTS.md → docs/milestones/MU-3-closing-screens.md（重点 §7.0 并行编排、§4.4 字段映射表、§5.2 改一项设置的流程、§六 风险 R-3/R-4/R-6）→ docs/ux/03-设置界面设计.md **全文**（这是本屏的规格书）→ docs/ux/mockups/s8-settings.html 与 docs/ux/mockups/assets/axon.css 的 §11（设置窗组件样式的逐值来源）。

【硬边界 —— 违反即返工】
- 你只许写：apps/desktop/src/renderer/settings/**（整目录，主线已放好 SettingsApp.tsx 与 SettingsStore.tsx 空壳）、apps/desktop/src/renderer/styles/settings.css（主线已建空文件并接进 build.mjs）
- 其他任何文件一律只读，**尤其不许动 main/、protocol/、主窗的 components/ 与 state/**。缺协议就停下来告诉我
- 禁止跑：任何 git 命令、bun run dev、bun run ui-smoke、bun run build:desktop、bun run verify-lazy
- 允许跑：bun run typecheck、bun run test（只读跑）、read/grep

【要做的事】
1. styles/settings.css：把原型 assets/axon.css §11 的设置窗组件逐值搬过来（.window.is-settings / .st-sidebar / .st-back / .st-item / .st-navnote / .st-nav / .st-group / .st-main / .st-body / .st-h1 / .st-lede / .st-sec / .grp / .srow(.top/.col/.head) / .tgl / .sel / .seg.sm / .danger-zone）。注意：**原型 §11 的 .path 是独立类，和实现里已有的 .card-head .path 不是一回事，别覆盖**
2. settings/fields.tsx：五个受控件（.srow 行壳 / .tgl 开关 / .sel 下拉（外观是按钮，不是原生 select）/ .inp 输入 / .path 只读路径 + 动作按钮），统一实现：
   - 无保存按钮、改完即发 config.patch
   - 乐观置值 → accepted=false 时**回滚到快照真值 + 行内红字显示 errors[].message**（绝不假装成功）
   - env 三态：config.get 的 envOverrides 里出现的 path ⇒ 控件 disabled + 显示 env 的值 + 说明「被 AXON_BASE_URL 覆盖，改动不会生效」；UI 因此不会发出该字段
   - **每一行必须有一句灰字说明**（03 §2.3 硬规矩，因为 Axon 的设置项几乎全都改变安全边界）
3. 五个 pane（字段映射照 MU-3 文档 §4.4 的表，一条不多一条不少）：
   - 通用：默认审批档 defaultApproval / 审批超时 approvalTimeoutMs / 默认执行方式 defaultExecutor / 默认工作目录 defaultCwd（可直接编辑文本框，不开系统选择器）/ 角色目录与配置文件位置（只读 ConfigPaths + 打开按钮，走 openPath action）
   - 外观：主题 / 密度 / 字号 / 减弱动效 / 显示协议标注，落 ui.* 字段（主线已加白名单）。**主题 seg 只有「浅色」可选，「深色」「跟随系统」置灰标「未实现」**
   - 模型与网关：provider.name / baseUrl / apiKey（secret，只显示掩码 apiKeyMasked）/ defaultModel / headers（json 整体替换）/ models 清单（表头：模型 / 推理 / 上下文 / 最大输出 / 价格）；预算 budgetUsd + budgetSoftUsd（**原型把软线画成只读 tag 是错的，它可写**，做成输入框 + 「留空 = 硬线 × 0.8」）
   - 编排与安全：maxConcurrent / maxDepth / idleTimeoutMs / agent_wait 默认超时（只读常量）/ 裁决策略与仲裁者（走 ledger.getAdoptionPolicy + setAdoptionPolicy，**不走 config**）
   - 关于：版本信息 / 文件位置（reveal）/ 「会话与账本」区用 storage.status 的真实数据（**原型那句「全在内存，关掉应用就一起消失」已过时，M5 已落盘，必须重写**）/ 危险区「重置所有设置」（config.reset + 二次确认，说明「只重置 config.json，不动角色目录与团队」）
4. 左侧 st-nav 三组：个人（通用/外观/模型与网关/编排与安全）、在主窗里管（团队与角色 ↗ / 预算与用量 ↗，用 ↗ 外链图标而不是 chevR，点了走 window 通信回主窗）、其他（关于 Axon）

【禁止 —— 协议无落点，整块删掉不要留死控件】
在菜单栏中显示、运行任务时防止系统休眠、测试连接、每角色模型覆盖、检查更新、开源许可证、设置项搜索框、配置文件位置的「更改」按钮、默认工作目录的系统选择器。

【注意】
- 设置窗**不复用主窗 store**（它不该订阅会话事件），只用主线建好的 SettingsStore
- 设置窗**没有顶栏 chip**（它没有会话上下文）
- headers/models 是 json 整体替换字段：以最近一次 config.get / config.changed 的快照为基做「读整体→改→整体写回」，收到 config.changed 就重绘

【主线已放好的底座（以实文件为准，可改内部实现但不要换掉架构）】
- `settings/SettingsStore.tsx`：`useSettings()` → `{ config, issues, error, patch(patch), reset(), openPath(kind), dismissError() }`；`patch`/`reset` 返回 `boolean`，失败时把错误文案放进 `error`。**它不做乐观更新** —— 字段级的乐观值与回滚由你在 `fields.tsx` 里做（用快照真值作为回滚目标）
- `settings/SettingsApp.tsx`：已有 `.st-win` / `.st-nav` / `.st-navitem` / `.st-main` / `.st-pane[data-pane]` / `.st-sec` 骨架与五个 pane 占位（general / appearance / model / orchestration / about），错误条复用主窗的 `.card.err`（`data-smoke="settings-error"`）
- `styles/settings.css` 已建并接进 `build.mjs` 的 `cssFiles`，里面已用既有 token 写了上述骨架类；你从原型 §11 搬组件样式时与它合并，**别再新建 CSS 文件**（新文件必须改 build.mjs，而 build.mjs 不在你名下）
- 设置窗标题已由 `main.tsx` 置为「设置」；窗口单例、`config.changed` 双窗广播都已真窗口实测通过

【完成标准】
bun run typecheck 绿；自查：每行都有说明、无保存按钮、无死控件、被 env 覆盖的三项置灰且说明正确；然后向我汇报做了什么、删了哪些原型元素及原因。**不要 commit，由主线收口。**
```

---

## 5. 收尾（阶段 2，回到主线会话）

```
四个并行会话已完成 S5/S6/S7/S8。你是主线会话，执行 docs/milestones/MU-3-closing-screens.md §7.1 的切片 8 与 9：

1. 先 review：逐个读四屏的新文件，用 git status --short 确认没有人越界改了不属于自己的文件；跑 bun run typecheck
2. 切片 8 死链核销：Sidebar.tsx 的 NAV_LATER 三项上移为活链、badge 从写死的 '2' 换成 globalChips 的真值、账号菜单「设置…」与「打开配置目录」接线、底部「待批 N」可点进 S5、brand 区搜索/通知两枚装饰图标删除；清掉 tokens.css 与 base.css 的重复归一段
3. 切片 9：ui-smoke 新增 S5/S6/S7 三幕 + 设置窗一幕（⌘, 开窗 → patch 一项 → 读回一致）+ 两条 loadedCount 反向断言；回填 MU-3 文档的 §十一 拍板记录、§十二 台账（把四个会话汇报的删减项逐条登记）、§十三 设计 vs 实测；同步 docs/03 §1 状态列、docs/01 §1 进度表、docs/ux/03 §7 的 D-3 状态、MU-2 文档 §十二 的 A-10/C-1/C-2/C-4 四行核销（改状态不删行）
4. 质量门七件套全绿：guard / typecheck / test / build:desktop / verify-lazy / ui-smoke / dev 手工过一遍
5. 按屏分 commit（一屏一个 feat(renderer):），最后一个 commit 带文档同步
```

# M2 角色系统（6.3 RoleLoader）：方案设计与实施计划

> 状态：**已完成**（2026-09-13；全部验收项通过，见 §八）
> 对应架构：01 §6.3 ｜ 依赖里程碑：M1 ✅
> 文档模板遵循：03 §4

---

## 一、目标与范围

**用户可见能力（一句话）**：在 UI 里创建 / 编辑 / 删除自己的角色，重启后还在；新建分身时可以选择所有角色。

**本里程碑内做**：

- 角色落盘：`~/.axon/roles/<name>.json`（schema = 协议层 `RoleDefinition` + 少量元信息）
- 角色管理器：加载 → 校验 → 合并（内置 + 用户）→ `fs.watch` 热重载
- UI：角色列表分组（内置/自定义）+ 「新建角色」按钮 + 角色编辑器弹窗（表单 + 校验报错 + JSON 预览）+ 删除（需确认）+ 「打开角色目录」
- 协议扩展：`role.save` / `role.delete` 已有，补充校验错误通道 + `roles.changed` 事件 + 角色元信息（来源 / 覆盖内置）

**明确不做**：

- ❌ 角色间协作（M4）、自主派发（M3+，待定项 2）
- ❌ 角色运行时行为差异（model 字段之外的工具白名单已经由 M1 生效）
- ❌ 角色配置的图形化 JSON 编辑器（先表单，够用）

**⚠️ 拍板变更（2026-09-13）**：UI 框架决策用户选 **现在就上 React**（03 §6 #2，推翻本文档初稿的「先 DOM」）。M2 的渲染层**全部视图**（角色列表、树、日志流、编辑器弹窗）一次迁移为 React 组件，不留 plain DOM 混血；架构不变量不变：渲染层仍旧是**无状态薄壳**，状态真相只在主进程，事件流入 props。

---

## 二、现状盘点

| 组件 | 位置 | 已有能力 |
|---|---|---|
| 协议层角色类型 | `packages/protocol/src/agent.ts:170-200` | `RoleDefinition`（name/displayName/description/instructions/model/tools/shellAllow/defaultForkMode/approval） |
| 协议层命令 | `packages/protocol/src/ipc.ts:78-79` | `role.list`、`role.save`、`role.delete` 已预埋 |
| 内置角色 | `apps/desktop/src/main/roles.ts` | `BUILTIN_ROLES`(Axon1~5) + `BLANK_ROLE` + `CLONE_ROLE` = `ALL_ROLES` 7 个 |
| 宿主 | `apps/desktop/src/main/host.ts:44-46` | `roles: Map<string, RoleDefinition>` 构造时填充；`listRoles()` 返回；`spawn()` 按名取角色，缺省报「角色不存在」 |
| 渲染层 | `apps/desktop/src/renderer/renderer.ts:44-75` | `renderRoles()` 平铺所有角色，点击 = spawn；无编辑入口 |
| 主进程 | `apps/desktop/src/main/index.ts:38-55` | `createHost()` 注入 `ALL_ROLES`；IPC handler 分发 `host.execute` |

现状问题：

1. 角色是 TS 常量，无法在不改代码的情况下增删改
2. `role.save`/`role.delete` 在 `CommandMap` 里预埋但 host 未实现（`execute` 的 `default` 抛「未实现的命令」）
3. `role.list` 平铺返回，UI 无法区分「内置 / 自定义 / 是否有校验错误」

---

## 三、设计依据

| 依据 | 出处 |
|---|---|
| 角色是**声明式配置**，不是代码：`packages/agents/<name>/agent.json` | 02 §3.3 TabTin |
| 能力 = `tools 白名单 × 审批档` 双正交 | 01 §6.3；roles.ts 实现中已带注释引用 |
| 内置角色（Axon1~5 + blank + clone）保持 TS 常量 | M1 `roles.ts` |
| 角色只能减能，不能越权（子∩父） | 01 §6.3（codex `role.rs:91-106`），已在 host 落地 |
| 多会话纪律：主线写代码，commit 统一收口 | AGENTS.md §4 |

---

## 四、总体设计

### 4.1 用户角色文件 schema（v1）

`~/.axon/roles/<name>.json`：

```json
{
  "version": 1,
  "role": {
    "name": "devops",
    "displayName": "运维分身",
    "description": "部署、日志、环境诊断",
    "instructions": "你是运维分身。……",
    "tools": ["read", "grep", "bash"],
    "approval": "always_ask",
    "defaultForkMode": "none"
  }
}
```

字段即 `RoleDefinition`；`version` 为将来迁移预留（AGENTS.md §5：schema 带版本号是 M5 的先行纪律）。`name` 是**文件名也是身份**，禁止 `/` 与大小写混用（mac 大小写不敏感）。

### 4.2 合并规则（内置 + 用户文件）

```
加载顺序：BUILTIN_ROLES(TS) → ~/.axon/roles/*.json（文件名字典序）
  ├─ 名称不冲突     → 追加
  ├─ 名称 = 内置名  → 用户角色覆盖内置（内存层合并，不改内置源文件）
  │                  UI 标记「已覆盖内置」
  ├─ 名称 = 已加载用户角色 → 最后一个文件生效（按文件名序），标记告警
  └─ 校验失败       → 跳过该文件，错误进入 errors 列表，不炸运行中的树
```

**`role.list` 返回结构升级**（协议新增 `RoleEntry`）：

```ts
interface RoleEntry {
  role: RoleDefinition;
  source: 'builtin' | 'user';
  overridesBuiltin?: boolean;   // 用户角色覆盖内置时置为内置名
  filePath?: string;            // 用户角色才有
  errors: RoleIssue[];          // 加载校验错误（文件级），角色本体有效才返回
}
```

### 4.3 新增模块布局

```
apps/desktop/src/main/role-loader.ts    ← 新增（纯逻辑 + 可注入 IO）
  ├─ validateRole(payload) → RoleIssue[]      纯函数，可单测
  ├─ mergeRoleFiles(builtin, files) → { roles: RoleEntry[], } 纯函数，可单测
  └─ RoleLoader 类（构造注入 dir / readFile / writeFile / watchFn → 可 headless 测试）
      load() / save(role) → 原子写 / delete(name) / watch(debounce 300ms) → onChange
```

`apps/desktop/src/main/role-loader.test.ts` ← 单测。RoleLoader **不依赖 electron**（沿用 host.ts 的纪律）。

### 4.4 现有文件改动

| 文件 | 改动 |
|---|---|
| `packages/protocol/src/ipc.ts` | 新增 `RoleEntry`、`RoleIssue` 类型；`role.list` 结果改为 `RoleEntry[]`；`role.save` 结果改为 `{ role: RoleEntry; accepted: boolean; errors: RoleIssue[] }`；新增 `roles.changed` 事件；`role.save` payload 语义 = 创建或更新同名用户角色 |
| `packages/protocol/src/agent.ts` | `RoleDefinition` 增加 `version`（可选，只写用户角色）？否——`version` 放文件外层，不动 `RoleDefinition` |
| `apps/desktop/src/main/host.ts` | `roles: Map` 改为可更新：`updateRoles(entries: RoleEntry[])` + `listRoles(): RoleEntry[]`；`spawn()` 名解析不变（覆盖后自然取到新定义） |
| `apps/desktop/src/main/index.ts` | `createHost` 注入改为 `host.updateRoles(loader.roles)`；新增 IPC handler `role.save` / `role.delete` / `role.openDir`（shell.openPath 放主进程，只读操作不经过 host.execute）；watch 触发 `host.updateRoles` → 事件已由 `updateRoles` 发 `roles.changed` |
| `apps/desktop/src/renderer/renderer.ts` | 角色列表分组渲染 + 编辑器弹窗 + 新建/编辑/删除按钮 + 坏文件栏 + `roles.changed` 订阅 |
| `apps/desktop/src/renderer/index.html` | 弹窗 DOM 结构 |

### 4.5 关键流程

- **启动**：main `RoleLoader.load()` → `host.updateRoles()` → UI `renderRoles()`
- **保存**：UI `invoke('role.save', {role})` → main 校验 → 失败 `{accepted:false, errors}`；成功原子写 JSON → watch 触发重载（防抖）→ `roles.changed` 事件 → UI 重渲染
- **热改**：用户用编辑器改 `~/.axon/roles/*.json` → watch → 重载 → `roles.changed` → UI 刷新；**运行中的 Agent 不受影响**（spawn 时已快照）
- **删除**：`role.delete` → 删文件 → 同 save 的后半段。内置角色不可删（`source:'builtin'` 时拒绝）

### 4.6 审批档在 M2 的落地范围

`approval` 字段的**取值与验证**进 M2（schema 的一部分）；**审批流转**（`approval.respond`）不在本里程碑 —— 它属于 M3 Orchestrator 的闸门。

### 4.7 决策点（03 §6 #2）：UI 框架 —— 已拍板：现在上 React ✅

用户拍板现在就引入 React（2026-09-13）。落地边界：

- 渲染层全部视图一次迁移为 React 组件（`index.html` 只留 `<div id="root">`），不留 plain DOM 混血
- 依赖只加 `react` + `react-dom`（+ 类型），**不引入**路由/状态库——状态仍来自主进程事件流
- esbuild 开启 `jsx: 'automatic'`，入口改 `src/renderer/main.tsx`；`tsconfig.renderer.json` 补 `jsx` 与 react 类型
- 薄壳原则不变：组件只做「渲染 + 发意图」，编排逻辑一律留在主进程（host/loader），组件单文件 ≤ ~200 行
- 不引入 jsdom/Testing Library——薄壳可测逻辑都在主进程侧；M3 若多路流式视图复杂再评估
- 新增依赖须过质量门：bun 安装 + `verify-lazy` 确认 renderer 仍无 pi/node 引用

---

## 五、边界情况与风险

| 边界/风险 | 应对 |
|---|---|
| 坏 JSON / 校验失败 | 跳过文件 + errors 进 `role.list` + UI 红条提示，绝不炸树 |
| mac 大小写不敏感：`Tester.json` vs `tester.json` | name 统一 `^[a-z][a-z0-9_-]*$` 小写约束；冲突按文件名字典序后者胜 + 告警 |
| 用户角色与内置同名 | 覆盖（内存层）+ UI 标记；删用户文件 →内置复活 |
| 原子写被 watch 抓到半截 | 写临时文件 + rename；watch 回调防抖 + 读失败重试一次 |
| watch 在编辑器「重命名保存」（vim swap / JetBrains atomic-save）漏事件 | 回调不依赖事件参数：任何事件都全量重扫目录（目录小，成本可忽略） |
| `role.save` 与「角色不存在」竞态 | main handler 统一走 loader，loader 是唯一真相 |
| 权限逃逸 | 角色 tools 仍受 host `intersectTools` 父∩子约束，M2 不打开任何新口子 |

---

## 六、实施计划

按顺序切片，每步带验证方式：

1. **协议扩展**（§4.4 协议两行）+ host `updateRoles` / `role.list` 返回角色条目 + host.unit 更新 —— 验证：`bun run typecheck`（协议改动会炸所有消费点，是好事）
2. **role-loader.ts 纯部分**：`validateRole` + `mergeRoleFiles` —— 验证：单测（`role-loader.test.ts`）
3. **role-loader.ts IO 部分**：`RoleLoader` 类（load/save/delete/watch）—— 验证：用 `memfs` 还是注入 IO？**注入 IO**（dir/readFile/writeFile/watchFn 构造参数），单测用内存实现 —— 验证：单测
4. **index.ts 接线**：IPC `role.save`/`role.delete`/`role.openDir` + watch + `host.updateRoles` —— 验证：headless 集成测试（`role-loader.test.ts` 加一条 main 层流程）
5. **React 落地**：依赖（react/react-dom/@types）+ esbuild `jsx: automatic` + tsconfig.renderer + `main.tsx` 入口；先迁移既有三视图（角色/树/日志）为组件，验证渲染等价 —— 验证：`bun run build:desktop` + `verify-lazy` + `bun run dev` 目视无劣化
6. **角色编辑器 UI**：分组列表（内置/自定义/覆盖标记/错误栏）+ 编辑器弹窗（表单 + 校验报错 + JSON 预览）+ 删除确认 + 「打开角色目录」—— 验证：`bun run dev` 全流程手工
7. **质量门全过 + 文档同步 + commit**

---

## 七、测试策略

- `role-loader.test.ts`：validateRole（边界：空 name / 大写 / 非法 forkMode / 空 instructions / 非数组 tools）、mergeRoleFiles（内置+用户+覆盖+重复+错误隔离）
- `host.test.ts` 补：`updateRoles` + `role.list` 新返回 + 覆盖内置后 spawn 用到新指令
- E2E：`bun run ui-smoke`（`scripts/ui-smoke.mjs`：自己拉起窗口 + CDP 驱动全链路，M3+ 复用；根 `package.json` 已挂 `ui-smoke` 脚本）
- 手工体检：`bun run dev` 全 UI 流程

---

## 八、验收标准（退出条件）

> 收尾核对（2026-09-13，全部 ✅）：
> - 无重启新建角色：`bun run ui-smoke`（已提升为正式脚本，一键拉起+CDP 驱动：`invoke role.save` → 事件 → DOM 出现卡片 → 删除回落）✅
> - 重启存活：角色文件从磁盘加载（窗口冒烟 `roles: 8 个（用户 1）issues: 1`）✅
> - 覆盖内置 + 权限拦截：host 测试（updateRoles 覆盖 / 工具闸门拦截）✅
> - 坏 JSON 隔离：loader 测试 + 窗口冒烟 issues:1（其余角色照常）✅
> - React 全量迁移：五组件，无 plain DOM 残留；verify 保险丝仍过 ✅
> - `bun run check` 全绿，114 例 ✅

- [x] 渲染层迁移为 React 组件后，既有树视图/日志流无功能/表现劣化
- [x] 无重启新建角色 → 立即出现在列表 → spawn 使用（不进 git、不动宿主进程）
- [x] 重启应用 → 自定义角色加载回来
- [x] 「tester 只读」角色（用户手建同名覆盖 Axon4）spawn 后写工具被闸门拦截
- [x] 坏 JSON：启动 + 运行中，红条显示错误，其它角色照常工作，不影响正在跑的 Agent
- [x] `bun run check` 全绿，83 例以上
- [x] `docs/milestones/M2-role-loader.md` 状态收尾为已完成；03 §1 表更新；01 §1 进度表更新

---

## 九、文档同步

完工后更新：01 §1 进度表（6.3 → ✅）、03 §1（M2 ✅）、AGENTS.md（§5 补 React 不变量）、本文件（状态行 + 决策点结论）。
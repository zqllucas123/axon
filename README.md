# Axon

> 多子 Agent 协作的桌面客户端 —— 让一个目标由一支 AI 团队分工完成，而不是一个 Agent 硬扛。

Axon 把「多 Agent 协作」做成可见、可控、可追溯的桌面应用：你给出目标，主控 Agent 自己决定何时拆分任务、派生子 Agent、咨询同伴、移交工作；每一次协作动作都落账，每一笔 token 开销都归到具体的人头上。

**技术栈**：全栈 TypeScript · 内核 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 0.85.1 · 自建 L2 编排层 · Electron 33 + React 19

---

## 它解决什么问题

单个 Agent 处理复杂任务时会遇到三堵墙：上下文塞不下、能力边界模糊、出了问题无从追溯。

Axon 的答案是**一支有分工的团队**：

- **角色不是提示词换皮**，而是「工具白名单 × 审批档」的双正交约束。进度管理角色拿不到写文件的工具——不是因为提示词让它别写，而是它的 tools universe 里根本没有。
- **协作动作是枚举的**，只有 consult（咨询）/ fork（分叉）/ delegate（委派）/ handoff（移交）四种，每一次都落账。不做自由消息总线，因为那会让「谁让谁做了什么」变得不可查。
- **子 Agent 只能减权不能越权**：权限按「父 ∩ 子白名单」求交，派生链再深也不会凭空长出能力。

---

## 核心设计

### 分层架构

```
L3  渲染薄壳（React 19）      只做「渲染 + 发意图」，零 Node，零编排决策
 ↓
L2  编排层（自建，核心资产）   AgentRegistry / ContextForker / MessageBus / BudgetGuard / TreePersistence
 ↓
    适配器边界                AxonEngine（5 方法）+ ModelSource —— pi 的类型不得泄漏到上层
 ↓
L1  pi-agent-core            Agent 循环、工具调用、流式事件
 ↓
L0  pi-ai                    44 个 provider，动态 import 懒加载
```

适配器边界是硬保险丝：内核升级或更换时，编排层不需要重写。

### 分身三角

每个子 Agent 的能力由三个维度合成，顺序固定：

**角色**（它是谁）→ **权限**（它能碰什么，父 ∩ 子求交）→ **上下文**（它知道什么，由 ForkMode 决定）

`ForkMode` 默认 `none`（子 Agent 从干净上下文起步），`all` 是显式逃生门。这是三个独立产品线收敛出的结论——默认继承全部上下文会让子 Agent 被父辈的思维定式带偏。

### 并发闸门

闸门只数 `running` 状态的 Agent。等待中的分两类：`parked`（排队等额度）和 `suspended`（父等后代，主动退位让额）。`wait` 只允许等后代，`promote` 免检。

这套语义让**死锁在结构上不可能发生**：等待关系构成有向无环图（只能等后代），而等待方必定已释放自己的额度。

### 六个编排工具

`agent_spawn` · `agent_wait` · `agent_check` · `agent_message` · `agent_resume` · `agent_interrupt`

工具只能由 host/orchestrator 发放，且 per-spawn 双闭包绑定 `selfPath`——Agent 无法自由指定操作目标，只能操作自己派生的后代。

---

## 内置角色

| 角色 | 定位 | 工具 | 审批档 |
|---|---|---|---|
| **Axon1 · 进度管理** | 拆解目标、排期、跟踪阻塞 | 只读 | auto |
| **Axon2 · 架构设计** | 技术方案与结构决策 | 只读 + write | auto |
| **Axon3 · 开发执行** | 写实现 | 读写 + bash | always_ask |
| **Axon4 · 测试** | 验证与质量把关 | 只读 + write + bash | always_ask |
| **Axon5 · 人机对齐** | 追问与核对，不执行任务 | 只读（`ForkMode: all`） | always_ask |
| **轻量分身 / 内核分身 / 内置引擎 / 团队主控** | 通用与自定义基座 | 按需 | always_ask |

Axon5 是唯一用 `ForkMode: all` 的内置角色——它的职责就是核对「实际做的」与「当初说的」，没有上下文无从核对。这是逆者作为显式逃生门的正当用例。

七个内置角色全部拿到六件套编排工具（取最大自由度），token 风险由**预算熔断 + 树深上限 2**两条硬底线兜住，而不是靠削减工具。

自定义角色放在 `~/.axon/roles/`，tools 白名单里写了哪个工具名就授权哪个，不写即无。

---

## 界面

| 屏 | 内容 |
|---|---|
| S0 新建会话 | 选团队、定目标 |
| S1 工作台 | Agent 树 + 实时状态 |
| S2 会话 | 消息流（流式渲染）+ Inspector |
| S3 团队 | 团队与角色编排 |
| S5 收件箱 | 审批请求（父链穿透） |
| S6 预算 | 用量与成本，按会话/按 Agent 切片 |
| S7 会话列表 | 历史会话，支持从中断处继续 |
| S8 设置 | 独立窗：模型、外观、存储、关于 |

会话完整落盘（`~/.axon/sessions/`），重启后 Agent 树、消息、状态完整恢复；列表走懒加载，秒开。

---

## 快速开始

### 环境要求

- macOS（Apple Silicon）
- [Bun](https://bun.sh) —— **本项目唯一的包管理器**，禁用 npm/yarn/pnpm
- Node.js（仅打包环节需要，通过 nvm 即可）

### 安装与运行

```bash
bun install
bun run dev          # 构建并启动 Electron
```

首次启动前配置模型（`~/.axon/config.json`）：

```json
{
  "provider": {
    "id": "your-provider",
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-..."
  },
  "defaultModel": "your-model-id",
  "models": [
    {
      "id": "your-model-id",
      "cost": { "input": 0.14, "output": 0.28 },
      "compat": { "maxTokensField": "max_tokens" }
    }
  ]
}
```

也可以在应用内「设置 → 模型」里填写并点「测试连接」验证。API key 通过 Electron `safeStorage` 加密存储，读侧掩码。

> `cost` 字段缺省会导致成本恒为 0；`compat.maxTokensField` 影响截断控制。两者都有启动告警。

### 打包

```bash
bun run build:pack   # → dist-pack/Axon-0.1.0-arm64.dmg
```

产出未签名，首次打开需在「系统设置 → 隐私与安全性」放行，或：

```bash
xattr -cr /Applications/Axon.app
```

---

## 开发

### 常用命令

```bash
bun run dev            # 开发模式
bun run typecheck      # root + renderer 双 tsc
bun run test           # vitest（528 例 / 24 文件）
bun run guard          # 工程约定检查（6 项）
bun run ui-smoke       # UI 端到端冒烟（CDP）
bun run verify-lazy    # 验证 pi 懒加载未被打包器提升
bun run check          # guard + typecheck + test + build + verify-lazy
```

### 目录结构

```
packages/
  protocol/     类型与 IPC 契约（agent / config / ipc / ledger / session / team）
  kernel/       编排内核（registry / fork / ledger / budget / provider / engine）
apps/desktop/
  src/main/     主进程：host 装配、编排器、角色与团队加载、持久化、配置
  src/preload/  contextBridge 桥接
  src/renderer/ React 薄壳（组件 + store + selectors）
docs/           架构决策、里程碑设计、调研报告、UX 设计（见 docs/README.md）
examples/       内核尖峰脚本
```

### 硬性约束

这几条是 guard 脚本强制检查的，不是建议：

1. **只用 bun**，禁止任何 npm/yarn/pnpm 命令与锁文件
2. **pi import 只许出现在三个边界文件**（`kernel/src/engine.ts`、`engine.contract.test.ts`、`provider.ts`），其余一律 import `@axon/kernel`
3. **渲染进程零 Node**：`contextIsolation: true` + `nodeIntegration: false`，状态真相只存在于主进程
4. **pi 包 ESM-only**：主进程与 preload 必须输出 `.mjs`，esbuild 必须 external 掉 pi 相关包

第 4 条尤其要紧：pi-ai 的 44 个 provider 靠动态 import 懒加载，一旦被打包器静态提升，四套 SDK 会连同依赖一起进包体，体积从几 MB 膨胀到几十 MB。`verify-lazy` 就是为了让这条规则可验证而非口头约定。

### 文档

新加入者按 `docs/README.md` 的顺序读：`03-实施框架与里程碑` → `01-架构决策-方案B` → `02-调研补充与结论复核`。

每个里程碑的方案设计与实施记录在 `docs/milestones/`，跨里程碑的一次性验证在 `docs/spikes/`。

开发约定（含工作流、质量门、并行会话纪律）见仓库根的 `AGENTS.md`。

---

## 项目状态

M0 ~ M7 与 MU-1/MU-2/MU-3 全部完成，v0.1 功能闭环。

已知未做（有台账，非遗漏）：Apple 签名与公证、auto-update、x64/Windows 打包、CI 自动发布、暗色主题、Tray 图标。

---

## License

Apache License 2.0

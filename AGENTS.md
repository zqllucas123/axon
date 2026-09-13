# AGENTS.md —— Axon 项目开发约定

> 本文件是**人类与 AI 会话的共读入口**：新开的任何 agent 会话、任何新加入的协作者，
> 动工前先读本文件，再按 §1 的顺序读文档。规则即约束，不是建议。

**项目**：Axon —— 多子 Agent 协作的桌面客户端（内核 `pi-agent-core` 0.85.1 + 自建 L2 编排层，全栈 TypeScript，Electron 壳）。
**工作区**：`/Users/lucaszhou/works/prjs/axon`

---

## 1. 新会话的上下文加载顺序

新会话没有既往上下文，**不要凭常识开工**，按顺序读：

1. `docs/README.md` —— 文档索引（三分钟摸清全貌）
2. `docs/03-实施框架与里程碑.md` —— 里程碑总览、工作流约定、质量门、需用户拍板的决策清单
3. `docs/01-架构决策-方案B.md` —— 定稿架构与六组件设计
4. `docs/02-调研补充与结论复核.md` —— 风险登记（A/B/C）与三条拍板记录

需要细节证据时再进 `docs/research/`。

## 2. 工作流（用户拍板，2026-09-13）

- **按里程碑推进**：总览见 03 §1，当前只有 M0/M1 完成，下一个是 M2 角色系统
- **每个里程碑开工前**，先在 `docs/milestones/M<id>-<短名>.md` 写「方案设计 + 实施计划」（模板在 03 §4），经用户过目后才许写实现代码
- **每个里程碑收尾**过质量门（§3）后才算完成，且文档同步（03 §1 状态列、01 §1 进度表）

## 3. 质量门（收尾必查，全绿才算完）

```bash
bun run guard        # 6 项：包管理约束 / pi import 白名单 / electron 落地等
bun run typecheck    # root + renderer 双 tsc
bun run test         # 现有 83 例不能回退
bun run build:desktop && bun run verify-lazy   # 打包保险丝（pi 懒加载不能被提升）
bun run dev          # 手工过一遍本里程碑的用户可见能力
```

## 4. 硬性禁令（违反 = 回退重做）

1. **包管理器只有 bun**（`scripts/check-bun-only.mjs` guard）；禁止任何 npm/yarn/pnpm 命令与锁文件
2. **pi import 只许在三个边界文件**：`packages/kernel/src/engine.ts`、`engine.contract.test.ts`、`provider.ts`；其余文件一律 import `@axon/kernel`。要放宽先改 guard 白名单
3. **渲染进程零 Node**：`contextIsolation: true` + `nodeIntegration: false` 不许松；renderer 保持无状态薄壳（kalo `chat-store.ts` 1405 行的教训），状态真相只存在于主进程
4. **多会话纪律**：同一工作树里**同时只允许一个会话写代码、动 git**；其他并行会话只能做只读调研，且只许写自己产出的新文档（产出路径见任务指派）。commit 由主线会话统一收口
5. **不推翻已拍板决策**：三条拍板（ForkMode 默认 `none` / Electron / 直接开发 Electron）见 02 §5，要推翻需用户重新拍板

## 5. 架构不变量（改动前先对照）

- 分层：L3 渲染薄壳 → L2 编排（自建，核心资产）→ 适配器边界（`AxonEngine`/`ModelSource`）→ L1 pi-agent-core → L0 pi-ai。**pi 的 `Agent` 类型不得泄漏到编排层**（风险 A 保险丝）
- 分身三角合成顺序固定在 `AxonHost`：**角色 → 权限（父∩子白名单）→ 上下文（ForkMode）**
- ForkMode 默认 `none`（三产品独立收敛的结论）；`all` 是显式逃生门，内置角色仅 Axon5 用
- 能力 = **工具白名单 × 审批档**双正交；角色只能减能不能越权
- 协作动作**枚举化 + 落账**（consult/fork/delegate/handoff），不做自由消息总线；不设特权 planning/review 角色
- pi 包 **ESM-only**：主进程/preload 必须输出 `.mjs`；esbuild 必须 external pi 相关包（风险 B 保险丝）
- `ELECTRON_RUN_AS_NODE` 可能被宿主（kalo）注入，electron 启动一律 `env -u ELECTRON_RUN_AS_NODE`（dev 脚本已含）
- 版本锁定：pi 0.85.1 / electron 33.2.1 / esbuild 0.24.2；升级 = 先跑 contract test + 对照 02 §4 风险

## 6. 文档与证据纪律

- 所有技术论断必须带 **文件路径:行号** 代码摘录，不接受 README 转述
- 调研/设计文档是交付物，不是随笔；写完要进 git
- 外部参考仓库（只读）：`/Users/lucaszhou/works/prjs/agents/{kalo,tutti,TabTin,codex}`，引证方式照 docs/02

## 7. 提交规范

- 语义化 commit：`feat:` / `docs:` / `test:` / `chore:`，代码 + 测试 + 文档一起提交
- commit 由主线会话统一执行；调研会话产出文档后交主线 review + 收口
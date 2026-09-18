# M7 打包与分发：方案设计与实施计划

> 状态：**已完成（2026-09-18）**
> 对应架构：01 §6.7（隐含，构建产物层）｜ 依赖里程碑：M6

---

## 〇、拍板记录（开工前填）

| # | 问题 | 结论 | 日期 |
|---|------|------|------|
| P-1 | 签名/公证 | **本里程碑不做**：需 Apple Developer 证书（\$99/年），见 §六.1；产出无签名 DMG，用户需手动绕过 Gatekeeper | — |
| P-2 | auto-update | **不做**：v0.1 人工分发（03 §M7 明确）；`autoUpdater` 不引入 | — |
| P-3 | 目标平台 | **仅 macOS arm64**：开发机 Apple Silicon；x64 / Windows 延期 | — |
| P-4 | 发布渠道 | **本地产出 DMG 文件**，不推 GitHub Releases / S3；CI 集成延期 | — |

---

## 一、目标与范围

**用户可见能力**：`bun run build:pack` 产出 `dist-pack/Axon-0.1.0-arm64.dmg`，用户双击挂载后拖拽安装即可运行 Axon.app。

**本里程碑内做什么**：
- 安装 electron-builder 并写配置
- 新增 `scripts/pack.mjs`：负责 node_modules 拼装后调 electron-builder
- 生成占位图标 `apps/desktop/assets/icon.icns`
- `package.json` 新增 `build:pack` 脚本
- 新增 `bun run ui-smoke` 的冒烟幕：验证打包后应用能启动（`open` DMG + check pid）
- 文档同步 + commit

**明确不做**：
- Apple 签名/公证（P-1）
- auto-update（P-2）
- x64 / Windows / Linux 打包（P-3）
- GitHub Releases / CI 自动发布（P-4）
- Tray 图标、「检查更新」菜单项（MU-3 台账 D-7/D-9，仍延期）
- 开源许可证 pane（MU-3 台账 G11.10，仍延期）

---

## 二、现状盘点

### 2.1 构建产物

`bun run build:desktop`（`apps/desktop/scripts/build.mjs`）把三段产物输出到 `apps/desktop/dist/`：

```
apps/desktop/dist/
  main.mjs          # 主进程（ESM）
  main.mjs.map
  preload.mjs       # preload（ESM）
  preload.mjs.map
  renderer/
    renderer.js     # 渲染进程（浏览器 ESM bundle）
    renderer.js.map
    axon.css        # 五份 CSS 合并
    index.html
```

esbuild 将 `@axon/protocol` / `@axon/kernel` 两个 workspace 包**源码直接打包**进 `main.mjs`，只有 `electron`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/chord` 四个包保持 external，由运行时从 `node_modules` 解析。

### 2.2 electron-builder 现状

- `package.json` 的 `trustedDependencies` 里有 `electron-builder`，但未实际安装（`node_modules` 里找不到）。
- 无任何 `electron-builder.yml` / `build` 配置存在。

### 2.3 图标现状

`apps/desktop/src/renderer/icons.tsx` 只有 SVG inline 图标（React 组件），无 `.icns` 平台图标文件。需要 `.icns` 才能让 macOS Dock/Finder 显示正确图标。

### 2.4 monorepo 与 node_modules 拓扑

bun workspace 把所有依赖**提升到 repo 根** `node_modules/`，`apps/desktop/node_modules/` 只有 workspace 链接（symlink）。electron-builder 打包时需要能解析 external 包，所以必须让 pi 包出现在最终 app bundle 的 `node_modules/` 里。

---

## 三、设计依据

| 结论 | 出处 |
|------|------|
| pi 包 ESM-only，动态 import 不能被 esbuild 静态提升；external 是保险丝 | `apps/desktop/scripts/build.mjs:8-18`（注释）；`scripts/verify-lazy-loading.mjs` |
| `ELECTRON_RUN_AS_NODE` 需 unset | `AGENTS.md §5`；`package.json` dev 脚本 |
| Tauri 无签名公证的代价是教训，Electron 有成熟签名工具链 | `docs/02-调研补充与结论复核.md §2.5:244` |
| 签名/公证依赖 Apple Developer 证书，届时再议 | `docs/03-实施框架与里程碑.md §6` 决策清单 #5 |
| electron-builder 已在 trustedDependencies | `package.json:13` |

---

## 四、总体设计

### 4.1 打包流水线

```
bun run build:pack
  │
  ├─ 1. bun run build:desktop          # esbuild 三段产物 → apps/desktop/dist/
  │
  ├─ 2. scripts/pack.mjs（新增）
  │     ├─ 检查 dist/ 存在
  │     ├─ 将 external 包从 repo 根 node_modules/ 复制到
  │     │   apps/desktop/dist/node_modules/
  │     │   （仅 pi-ai、pi-agent-core、chord 三个包，electron 由系统提供）
  │     └─ 调用 electron-builder --config electron-builder.yml
  │
  └─ → dist-pack/Axon-0.1.0-arm64.dmg
```

**为什么在 dist/ 下放 node_modules 而不是 apps/desktop/node_modules/**

electron-builder 的 `files` 配置从 `directories.app`（`apps/desktop/`）出发，`asarUnpack` 里列出的路径也是相对于 app root。把 pi 包放进 `apps/desktop/dist/node_modules/` 意味着主进程 ESM `import '@earendil-works/pi-agent-core'` 能按 Node 的 upward search 找到它；同时打包脚本只需复制三个包，不影响 bun workspace 的 `node_modules/` 结构。

**为什么不在 electron-builder 的 extraResources 里放**

extraResources 走文件系统路径但不进 asar、不在 `require` 解析链里；要用还需手写 `process.resourcesPath` 解析。直接放进 `node_modules/` 路径更简单且与开发态一致。

### 4.2 新增文件清单

| 文件 | 说明 |
|------|------|
| `electron-builder.yml`（repo 根） | electron-builder 配置 |
| `scripts/pack.mjs` | 打包编排脚本（node_modules 拼装 → electron-builder） |
| `apps/desktop/assets/icon.icns` | 占位图标（1024×1024 纯色 + 文字） |
| （修改）`package.json` | 新增 `build:pack` 脚本 |

### 4.3 electron-builder.yml 设计

```yaml
appId: com.axon.desktop
productName: Axon
copyright: Copyright © 2026

# 构建产物的 app 根目录：apps/desktop/
directories:
  app: apps/desktop
  output: dist-pack

# 从 app 根（apps/desktop/）打包哪些文件进 asar
# dist/ 含主进程/preload/renderer，package.json 含 main 入口
# dist/node_modules/ 含 pi external 包（由 pack.mjs 复制进来）
files:
  - dist/**
  - package.json

# pi 包用动态 import 懒加载：不能进 asar（asar 里的文件路径
# 在运行时是虚拟路径，动态 require/import 对 .node 文件失效；
# pi-ai 的 44 个 provider 里有 native addon）。
# asarUnpack 里列的 glob 会在 asar 旁边保留为真实文件。
asarUnpack:
  - dist/node_modules/@earendil-works/**

mac:
  target:
    - target: dmg
      arch: arm64
  icon: assets/icon.icns
  # 无签名：hardenedRuntime 和 entitlements 均不设，
  # 用户安装时需在「系统设置 → 安全性」放行，或 xattr -cr /Applications/Axon.app
  identity: null

dmg:
  title: Axon ${version}
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications
```

### 4.4 pack.mjs 设计

```
1. 确认 apps/desktop/dist/ 存在（build:desktop 已跑）
2. 读 repo 根 node_modules/ 中 @earendil-works/* 和 @earendil-works/chord
3. mkdirp apps/desktop/dist/node_modules/@earendil-works/
4. cp -R 每个包到目标目录（覆盖式，幂等）
5. execa electron-builder --config electron-builder.yml
```

脚本不运行 build:desktop，由 build:pack 脚本串联（`bun run build:desktop && bun run scripts/pack.mjs`）。

### 4.5 图标

占位图标：用 `sips` 将一张 SVG/PNG 转为多分辨率 `.icns`。M7 阶段只需能运行，图标质量不是验收标准。

具体做法：生成一个 1024×1024 的 PNG（纯色背景 + "A" 文字），用 macOS 内置 `iconutil` 生成 `.icns`。

### 4.6 guard 白名单无需修改

`scripts/check-bun-only.mjs` guard 检查 pi import 白名单；`pack.mjs` 不引入 pi 包，无需改白名单。

---

## 五、关键流程

**完整打包路径（开发者本机）：**

```
bun run build:pack
  ↓
build.mjs: esbuild 三段构建 → apps/desktop/dist/{main.mjs, preload.mjs, renderer/}
  ↓
pack.mjs: cp @earendil-works/* → apps/desktop/dist/node_modules/@earendil-works/
  ↓
electron-builder: 读 apps/desktop/package.json（main: ./dist/main.mjs）
  → 收集 files glob → 打 asar（dist/** 除 asarUnpack）
  → asarUnpack: dist/node_modules/@earendil-works/** 解包到 app.asar.unpacked/
  → 生成 Axon.app bundle
  → 包进 Axon-0.1.0-arm64.dmg → dist-pack/
  ↓
dist-pack/Axon-0.1.0-arm64.dmg
```

**用户安装路径（无签名）：**

```
双击 DMG → 挂载 → 拖 Axon.app 到 /Applications/
→ 首次打开：系统拦截（未知开发者）
→ 用户：系统设置 → 安全性 → 仍要打开（或：xattr -cr /Applications/Axon.app）
→ Axon.app 启动
→ 读取 ~/.axon/config.json（已有配置即可直接用）
```

---

## 六、边界情况与风险

### 6.1 无签名 Gatekeeper 拦截

macOS 14+ 对未签名应用拦截更严。用户需要主动放行（「仍要打开」或 xattr 命令）。**这是 v0.1 人工分发的已知代价**，文档里写清楚操作步骤即可。签名/公证在获得 Apple Developer 证书后加进 M7-patch 或后续里程碑。

### 6.2 pi 包 asarUnpack 与动态 import

`@earendil-works/pi-ai` 在运行时用 `api/lazy.js:46-49` 动态 import 44 个 provider 之一。asar 内部的动态路径解析依赖 Electron 的 asar 协议拦截，但 `.node` native addon 和一些 ESM 动态 import 场景无法走 asar 虚拟路径。`asarUnpack` 把整个 `@earendil-works/**` 解包为真实文件，彻底规避此问题。

### 6.3 verify-lazy 在打包后的验证范围

现有 `verify-lazy` 检查 esbuild 输出的 `main.mjs`，不检查 asar 包。打包后的懒加载正确性靠 6.2 的 asarUnpack 保证，无需新增 asar 级 verify。

### 6.4 monorepo node_modules 拓扑

`apps/desktop/node_modules/` 里有 bun 的 workspace symlink（`@axon/kernel` → `../../packages/kernel`），这些在打包时不应被带入（它们的源码已被 esbuild 内联进 main.mjs）。`files` 配置只收 `dist/**` + `package.json`，不含 `apps/desktop/node_modules/`，symlink 不会进包。

### 6.5 dist-pack/ 进 .gitignore

打包产物（.dmg / .zip）体积大，必须加入 `.gitignore`。

---

## 七、实施计划

| 步骤 | 内容 | 验收标准 |
|------|------|----------|
| 1 | 安装 electron-builder：`bun add -D electron-builder@25.1.8` | `node_modules/.bin/electron-builder --version` 输出版本 |
| 2 | 写 `electron-builder.yml` | 文件存在，内容对齐 §4.3 |
| 3 | 生成占位 `apps/desktop/assets/icon.icns` | 文件存在，`file icon.icns` 输出 ICNS |
| 4 | 写 `scripts/pack.mjs` | 对齐 §4.4 |
| 5 | `package.json` 新增 `build:pack` 脚本 | `bun run build:pack` 能调起 |
| 6 | `.gitignore` 加 `dist-pack/` | grep 确认 |
| 7 | 跑 `bun run build:pack`，验收 DMG | `dist-pack/Axon-0.1.0-arm64.dmg` 存在；`open dist-pack/*.dmg` 能挂载；`cp -R /Volumes/Axon*/Axon.app /tmp/` + `open /tmp/Axon.app` 能启动主窗口 |
| 8 | 质量门全绿 | 见 §八 |
| 9 | 文档同步 + commit | 03 §1 M7 行改 ✅；01 §1 M7 标注完成；本文状态改「已完成」 |

---

## 八、质量门

```bash
bun run guard          # 白名单不变，全绿
bun run typecheck      # 零 TS 错误
bun run test           # 528 例不回退
bun run build:desktop  # esbuild 三段成功
bun run verify-lazy    # pi 懒加载不被提升
bun run build:pack     # DMG 产出成功
# 手工：
open dist-pack/Axon-*.dmg
# 挂载后拖 Axon.app 到 /tmp，执行：
open /tmp/Axon.app     # 主窗口出现
```

注：`ui-smoke`（CDP 自动）不验收打包后的 Axon.app（CDP 端口、cdpDisabled 标志在打包产物里需额外配置，超出 v0.1 范围）。打包验收走手工启动。

---

## 九、拍板记录

见 §〇，实施前需用户确认 P-1~P-4 四条。

---

## 十、实施记录

| 步骤 | 文件 | 说明 |
|------|------|------|
| 1 | `package.json` root | 增 `electron-builder@25.1.8` devDependency；增 `build:pack` 脚本 |
| 2 | `electron-builder.yml` | `directories.app = dist-staging`（staging 策略，规避 bun workspace symlink 逃逸） |
| 3 | `apps/desktop/assets/icon.icns` | 占位图标（sips + iconutil 生成，516KB，11 分辨率） |
| 4 | `scripts/pack.mjs` | staging 拼装脚本：esbuild 产物 + pi 包（realpath 解引用 bun symlink）→ dist-staging/；Node v22（nvm）跑 electron-builder |
| 5 | `.gitignore` | 新增 `dist-pack/` 和 `dist-staging/` |

**关键实施偏差（§十三 同步）**：
- electron-builder 不能直接以 `apps/desktop/` 为 appDir——bun workspace symlink（`@axon/kernel → ../../packages/kernel`）会逃逸出 appDir，asar 打包阶段直接报错。改用 staging 策略：pack.mjs 先把干净产物装配到 `dist-staging/`，再让 builder 打那个目录。
- 本机无全局 node，用 nvm 的 `/Users/lucaszhou/.nvm/versions/node/v22.20.0/bin/node` 跑 electron-builder CLI（bun 下 bluebird/source-map-support column=-1 崩溃，两次确认）。

---

## 十一、拍板记录（实施期）

| # | 问题 | 结论 | 日期 |
|---|------|------|------|
| I-1 | appDir 选 `apps/desktop/` 还是 staging 目录 | **staging 目录**：bun symlink 逃逸问题结构性无解，staging 是最干净的方案 | 2026-09-18 |
| I-2 | 如何跑 electron-builder（本机无全局 node） | **nvm Node v22**：bun 在 bluebird/source-map-support 下崩溃（两次），Electron ELECTRON_RUN_AS_NODE 方式 argv 被 builder CLI 消费，最终用 nvm node 跑 cli.js | 2026-09-18 |

---

## 十二、遗留台账

| ID | 事项 | 来源 | 后续 |
|----|------|------|------|
| D-1 | Apple 签名/公证 | §六.1；03 §6 决策 #5 | 获得证书后加进后续版本 |
| D-2 | auto-update（electron-updater） | 03 §M7 明确不做 | v0.2+ 按需 |
| D-3 | x64 / Windows / Linux 打包 | P-3 | 按需 |
| D-4 | CI 自动发布（GitHub Actions + Releases） | P-4 | v0.2+ |
| D-5 | Tray 图标 | MU-3 台账 D-7/D-9 | 独立里程碑 |
| D-6 | 开源许可证 pane | MU-3 台账 G11.10 | 独立里程碑 |

---

## 十三、设计 vs 实测

> 实施完成后回填：设计与实现的偏差、新发现的约束。

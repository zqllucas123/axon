# M15 多模型提供商：方案设计与实施计划

> 状态：**已完成（2026-10-10）** —— 设计（2026-10-08）到落地跨了两天，实测数据见 §九；拍板见 §5.2 / §5.3
> 对应架构：01 §6（适配器边界 / L0 provider 层）｜ 依赖里程碑：M6（真实模型接入）、MU-3（设置窗）

---

## 一、目标与范围

**用户可见能力**：可以配置多个模型提供商（网关），并在**新建会话**与**运行中会话**的输入框里
跨提供商挑模型。

### 本里程碑做什么

1. 配置从「一个网关」变成「一组网关」：`AxonConfig.providers[]`，设置页渲染多张卡、可增可删
2. 模型寻址从裸 id 变成**复合键** `providerId:modelId`（用户拍板），解决两个网关同名模型的歧义
3. S0 新建会话屏新增模型选择器（会话级初始模型，落盘）
4. S2 会话内 `ModelPicker` 改造为按提供商分组（它现在只能看见第一个网关）
5. **团队成员可逐个指定模型**（S3 成员编辑器加「模型覆写」行）；不指定就跟会话窗选的那个
6. 单 provider 配置的**自动迁移**（含 keychain 密钥搬迁），老用户升级无感

### 明确不做什么（防蔓延）

- **不做非 OpenAI 兼容协议**。`api` 字段仍恒为 `openai-completions`，设置页的「API 协议」
  仍是只读徽章。pi 的 44 个内置 provider 目录不接（M6 已有结论：企业网关是
  「自定义 baseUrl + 自定义模型名」的组合，内置目录里不会有这些模型 id）
- **不做「角色类型」级的模型 UI**。做的是**团队成员覆写**（`TeamMemberOverride.model`，
  S3 成员编辑器）；`RoleDefinition.model`（角色类型库那一层）字段照旧、值域变成 ref，
  但**角色编辑器里不加模型下拉** —— 角色是跨团队复用的模板，把模型钉死在模板上
  会让同一个角色在不同团队没法用不同模型，而成员覆写正是为此存在的
- **不做模型清单的自动同步**。「拉取模型列表」仍是用户手动点的动作
- **不改预算/用量的口径**。成本仍按 `ModelSpec.cost` 逐模型算，与 provider 数量无关

---

## 二、现状盘点

| 文件 | 当前形态 | 障碍 |
|---|---|---|
| `packages/protocol/src/config.ts:85-93` | `ProviderConfig` 单对象，`AxonConfig.provider?` | 结构上只装得下一个网关 |
| `packages/protocol/src/config.ts:231-253` | `ConfigPatchPath` 是**静态字面量联合**，含 `provider.*` 六条 | 表达不了 `providers[2].baseUrl` 这类动态路径 |
| `apps/desktop/src/main/keychain.ts:91-105` | key 名硬编码 `provider.apiKey` | 只能存一把 key |
| `apps/desktop/src/main/model-config.ts:66-117` | `resolveModelChoice` 返回单 provider 规格 | — |
| `packages/kernel/src/provider.ts:161-216` | `createOpenAICompatSource` 建**一个** pi provider + 独占 registry | — |
| `apps/desktop/src/renderer/settings/panes/Models.tsx:344-595` | `ProviderCard` 无 props，直读 `config.config.provider` | 单例写死 |
| `apps/desktop/src/renderer/components/ModelPicker.tsx:43-44` | 只读 `config.provider.models` | 多 provider 后只看得见第一个 |
| `apps/desktop/src/renderer/components/S0NewSession.tsx:342-444` | 工具栏有附件/引擎/模式三枚按钮 | **没有模型入口** |
| `packages/protocol/src/session.ts:342-381` | `CreateSessionPayload` 无 model 字段 | 会话级模型无处落 |
| `packages/protocol/src/team.ts:37` | `TeamMemberOverride.model` **字段已存在** | 只缺 UI 与优先级语义 |
| `apps/desktop/src/main/session-instantiate.ts:58` | `effectiveMemberRole` **已把 `ov.model` 接进生效角色** | 管线已通，不用改 |
| `apps/desktop/src/renderer/components/S3Teams.tsx:286-303` | 成员编辑器有「审批覆写」「执行引擎」等覆写行 | **没有「模型覆写」行** |
| `packages/protocol/src/session.ts:156-166` | `AdhocMemberSpec` 无 model 字段 | adhoc 成员无法指定模型（本次补齐） |

---

## 三、设计依据

### 1. pi 内核**本来就是**多 provider 容器 —— 这是本里程碑成本低的根本原因

`node_modules/@earendil-works/pi-ai/dist/models.js:35-37`：
```js
setProvider(provider) {
    this.providers.set(provider.id, provider);   // 按 id upsert，天然多实例
}
```
`models.js:352`（stream 路径）：
```js
const provider = this.providers.get(model.provider);  // 按 model.provider 路由
```

即 `MutableModels` 是一张 `providerId → Provider` 的表，`stream()` 自己按
`model.provider` 分派。我们现在只是**往里塞了一个**（`provider.ts:196-197`
每次 `createRegistry()` 建新表、只 `setProvider` 一次）。

结论：**不需要 N 个 ModelSource，只需要一个共享 registry 装 N 个 provider**，
一个 `streamFn` 吃全部。这与 `ModelSource` 的既有契约（`provider.ts:49-52`
「model 与 streamFn 必须配套」）不冲突 —— 配套关系由 `model.provider` 保证。

### 2. 复合键寻址与 pi 的模型身份一致

`models.d.ts` 的 `getModel(provider, id)` 与 `modelsAreEqual`（比 id **和** provider）
都说明：pi 眼里模型身份是 `(provider, id)` 二元组。我们的 `providerId:modelId`
只是把这个二元组压成一个字符串，便于落盘与 IPC 传输。

### 3. 写侧用专用命令而非扩展 patch 白名单（用户拍板）

`config.ts:220-229` 的注释写明白名单存在的理由是「不认识的键不能被写进来」。
把它改成带模板串的类型（`providers.${string}.baseUrl`）会丢掉「静态可枚举」这个性质，
而这正是白名单的价值。改走 `provider.save`/`provider.delete`，与
`role.save`（`ipc.ts:158-163`）/`team.save`（`ipc.ts:227-230`）同构 ——
**整体提交 + 校验失败不落盘 + 回 issues**。

### 4. keychain 按 id 而非数组下标存

`keychain.ts:46-76` 的 `getAt`/`setAt`/`ctPath` 吃任意点号路径，所以
`providerKeys.<id>.apiKey` 零改造即可用。**不能**用 `providers.2.apiKey`：
下标会随设置页重排失效，而 id 是稳定身份。

---

## 四、总体设计

### 4.1 数据模型（schema 先行）

```jsonc
// ~/.axon/config.json
{
  "providers": [
    {
      "id": "kt",                                  // 身份，稳定、唯一、不含点号
      "name": "kt",
      "baseUrl": "https://gateway.kotei.com.cn/yanjiuyuan/v1",
      "models": [{ "id": "deepseek-v4.1-flash", "cost": { "input": 0.14 } }],
      "defaultModel": "deepseek-v4.1-flash",       // provider 内默认
      "headers": {}
    },
    { "id": "dashscope", "name": "阿里云百炼", "baseUrl": "...", "models": [...] }
  ],
  "defaultModelRef": "kt:deepseek-v4.1-flash",     // 跨 provider 的「主对话」
  "providerKeys": {                                 // keychain 密文，按 id 分键
    "kt":        { "apiKeyCiphertext": "base64…" },
    "dashscope": { "apiKeyCiphertext": "base64…" }
  }
}
```

`provider`（单数、旧形状）与 `provider.apiKeyCiphertext` 读到即迁移、迁完即删。

### 4.2 模型寻址：复合键 `providerId:modelId`

| 场景 | 值 |
|---|---|
| `AxonConfig.defaultModelRef` | `kt:deepseek-v4.1-flash` |
| `SessionRecord.modelRef` | 同上 |
| `AgentSnapshot.model` | 同上 |
| `RoleDefinition.model` | 同上，**裸 id 向后兼容** |
| `agent.setModel` 的 payload | 同上 |

三个纯函数住在 `packages/protocol/src/config.ts`（该文件既有纪律：只放纯类型/常量/纯函数）：

```ts
formatModelRef(providerId, modelId): string               // `${p}:${m}`
parseModelRef(ref): { providerId?: string; modelId: string }
resolveModelRef(providers, ref): { provider; model } | undefined
```

`resolveModelRef` 的兼容规则：ref 无冒号 ⇒ 按 `providers` 顺序找首个含该 modelId 的 provider。
这样既有角色文件（`model: "deepseek-v3"`）与 M5 落盘的 `AgentSnapshot.model` 都不用迁移。
**只在第一个冒号处切分**，模型 id 本身含冒号（如 `qwen:7b`）也能正确解析出 providerId。

### 4.3 协议扩展

新增两条命令（`packages/protocol/src/ipc.ts`）：

| 命令 | payload | result |
|---|---|---|
| `provider.save` | `{ provider: ProviderConfig }` | `{ accepted; errors: ConfigIssue[]; config: ConfigSnapshot }` |
| `provider.delete` | `{ id: string }` | `{ deleted; errors: ConfigIssue[]; config: ConfigSnapshot }` |

`provider.test` 的 payload 加 `providerId?`（缺省 = 默认 provider），result 形状不变。
事件无新增 —— 两条命令都回 `ConfigSnapshot`，且仍走既有的 `config.changed` 广播（两窗同步）。

`ConfigPatchPath` 删掉 `provider.*` 六条、加 `defaultModelRef`。
`CreateSessionPayload` / `SessionRecord` 各加 `modelRef?: string`；`SESSION_SCHEMA_VERSION` 3 → 4。
`AdhocMemberSpec` 加 `model?: string`（`TeamMemberOverride.model` 已存在，不用动）。
`AgentSnapshot` 加 `modelOrigin?: ModelOrigin`（见 §4.6）；`TranscriptHeader` 加 `model?` / `modelOrigin?`。

### 4.4 接线图

```
~/.axon/config.json
   │  providers[] + defaultModelRef + providerKeys{}
   ▼
ConfigStore.load()  ──migrateProviders()──►  raw.providers[]
   │                    （单→多 + key 搬迁，幂等）
   ├─ snapshot()   ──► AxonConfigView.providers[]（逐个脱敏）──► 两个窗口
   └─ rawConfig()  ──► resolveModelChoice()
                           │  { kind:'openai-compat', providers:[…], defaultRef }
                           ▼
                    createMultiProviderSource(specs, defaultRef)
                           │  一个 registry ← setProvider × N
                           │  一个 streamFn  （pi 按 model.provider 自路由）
                           ▼
                    withDsmlParsing(…)  ──► AxonHost.setModelSource()
                                                 │
                        ┌────────────────────────┴───────────────────┐
                        ▼                                            ▼
              pickModelSource(ref)                           setModel(path, ref)
              （建根/spawn 时解析）                           （S2 运行时切换）
```

### 4.5 文件布局

| 文件 | 动作 |
|---|---|
| `packages/protocol/src/config.ts` | 改：`providers[]`、`defaultModelRef`、三个 ref 纯函数、白名单增删 |
| `packages/protocol/src/ipc.ts` | 改：两条新命令 + `provider.test` payload |
| `packages/protocol/src/session.ts` | 改：`modelRef` ×2 + schema 版本 |
| `packages/kernel/src/provider.ts` | 改：抽 `buildProvider`，加 `createMultiProviderSource` |
| `apps/desktop/src/main/keychain.ts` | 改：key 名 → `providerKeys.<id>.apiKey` |
| `apps/desktop/src/main/config-store.ts` | 改：迁移 + 多 provider 脱敏 + `saveProvider`/`deleteProvider` |
| `apps/desktop/src/main/model-config.ts` | 改：`ModelChoice` 多 provider |
| `apps/desktop/src/main/provider-probe.ts` | 改：按 providerId 取网关 |
| `apps/desktop/src/main/index.ts` | 改：装配走 `createMultiProviderSource` |
| `apps/desktop/src/main/host.ts` | 改：两条命令分派 + ref 语义 + 会话 modelRef 解析 |
| `apps/desktop/src/renderer/components/ModelPicker.tsx` | 改：多 provider 分组 + 双模式 |
| `apps/desktop/src/renderer/components/S0NewSession.tsx` | 改：工具栏加选择器 |
| `apps/desktop/src/renderer/settings/panes/Models.tsx` | 改：多卡 + 增删 + draft 提交 |
| `apps/desktop/src/renderer/settings/SettingsStore.tsx` | 改：两个新方法 |
| `apps/desktop/src/main/session-instantiate.ts` | 改：`ov.model` 不再并入生效角色，改挂 `MemberPlan.modelOverride`（见 §5.2） |
| `apps/desktop/src/renderer/components/S3Teams.tsx` | 改：成员编辑器加「模型覆写」行（`ModelPicker` 的第三种模式） |
| `packages/protocol/src/agent.ts` | 改：`AgentSnapshot.modelOrigin` + `ModelOrigin` 联合类型（见 §4.6） |
| `apps/desktop/src/main/session-files.ts` | 改：`TranscriptHeader` 加 `model?` / `modelOrigin?`（现在模型压根没落盘，见 §4.6） |
| `packages/kernel/src/provider.multi.test.ts` | 新增 |

### 4.6 模型来源标记 `modelOrigin`（用户要求 2026-10-08）

**为什么需要**：`AgentSnapshot.model` 现在是**单字段无来源**（`agent.ts:325`），
`setModel` 直接覆写它（`host.ts:523`）。拿到一个 `model: "kt:deepseek-v4.1-flash"`
无法回答「这是用户给这个成员单独指定的，还是跟着会话继承下来的」。
这个区分不是元数据洁癖，它直接决定一个行为：**改会话模型时谁跟着变**。

```ts
/** 生效模型的来源档位，与 §5.2 的五级链一一对应。 */
export type ModelOrigin =
  | 'member'    // ① 团队成员覆写（S3 成员编辑器点名指定）
  | 'session'   // ② 会话窗选择（S0 选择器）
  | 'role'      // ③ 角色类型声明
  | 'default'   // ④ 全局 defaultModelRef
  | 'fallback'  // ⑤ 首个可用 provider 的默认模型
  | 'runtime';  // S2 运行时手动切换（`agent.setModel`）
```

`AgentSnapshot` 加 `modelOrigin?: ModelOrigin`，与 `model` **同写同改**：
`pickModelSource` 改为返回 `{ source, ref, origin }`，spawn 时一次写入两个字段；
`setModel` 成功后写 `modelOrigin = 'runtime'`。

**`'member'` / `'runtime'` 是「钉住」语义，其余是「继承」语义** —— 这是本字段唯一的行为含义：

```
用户在 S0/S2 改会话模型（session.modelRef 变更）
  └─ 遍历该会话的活成员：
       modelOrigin ∈ {member, runtime}  ⇒ 不动（用户显式指定过）
       modelOrigin ∈ {session, role, default, fallback} ⇒ 跟随新值，origin 置 'session'
```

没有这个字段就只有两种错法：要么无脑全改（踩掉用户给成员的点名指定），
要么一个不改（会话选择器形同虚设）。

**顺带修一个既有 bug**：模型压根没落盘 —— `TranscriptHeader`
（`session-files.ts:305-314`）没有 model 字段，`headerOf`（`host.ts:1583-1593`）也不写。
所以现在重启会话，用户在 S2 里切过的模型**静默丢失**，全部回落到角色声明。
本里程碑给 header 加 `model?` / `modelOrigin?`，恢复时：
`origin ∈ {member, runtime}` ⇒ 用盘上的值；否则按 §5.2 重解析（配置可能已变）。

渲染层顺带受益：`ModelPicker` 可以把继承来的值显示为灰字占位（「跟随会话 · xxx」），
用户真选了才变实色 —— 这是 §4.6 唯一的 UI 影响，不额外加组件。

---

## 五、关键流程

### 5.1 启动装配（多 provider）

```
app.whenReady
  └─ ConfigStore.load()
       ├─ migrateProviders(raw)            // 幂等：已是 providers[] 则空转
       │    ├─ provider{} → providers[{id: provider.id ?? 'default', …}]
       │    └─ provider.apiKey{,Ciphertext} → providerKeys.<id>.*
       └─ commit() 落盘（仅当发生迁移）
  └─ resolveModelChoice(rawConfig)
       ├─ providers 为空 / 全部缺 baseUrl|apiKey  ⇒ faux + 原因
       ├─ 逐个解析，跳过不完整的 provider（**部分可用即可用**）
       └─ defaultRef 解析不到 ⇒ 回落到首个可用 provider 的默认模型
  └─ createMultiProviderSource(specs, defaultRef)
  └─ withDsmlParsing → host.setModelSource
```

**「部分可用即可用」**是刻意的：用户配了三个网关、其中一个 key 填错，不该让另外两个一起降级到 faux。
被跳过的 provider 进 `console.warn`，并在 `ConfigResolution.reason` 里附一句。

### 5.2 模型解析优先级（用户拍板 2026-10-08）

```
spawn 一个 Agent（建根 or 团队成员）
  └─ modelRef =
       member.overrides.model          // ① 团队成员覆写（S3 成员编辑器，最具体）
    ?? session.record.modelRef         // ② 会话窗选的那个（S0 选择器）
    ?? role.model                      // ③ 角色类型声明（M6 的 per-role 映射）
    ?? config.defaultModelRef          // ④ 全局默认
    ?? providers[0].defaultModel       // ⑤ 兜底
  └─ pickModelSource(modelRef) → selectModel(ref)
       └─ 解析失败 ⇒ warn + 回落下一级（不抛，沿用 host.ts:492-499 既有纪律）
  └─ 命中第几级就把档位写进 snapshot.modelOrigin（§4.6）
```

五级链与 `ModelOrigin` 是**一一对应**的：命中 ① 写 `'member'`、② 写 `'session'`、
③ 写 `'role'`、④ 写 `'default'`、⑤ 写 `'fallback'`。所以 `pickModelSource`
的返回值从「一个 ModelSource」变成 `{ source, ref, origin }` —— 解析和记账一次完成，
不留「先解析再猜来源」的二次推断（那是 bug 的温床）。

**定序理由**：模型是 `team.ts:33` 明说的「中性」字段 —— 换模型不改变权限，
所以它不受「角色只能减能」那条约束管辖，排序原则变成**越具体越优先**。
成员覆写是对某个团队里某个成员的点名指定，比会话窗的「这次任务整体用什么」更具体；
而会话窗的选择是用户当下的明确意志，比角色模板里写的默认值更具体。

**这条定序有一个实现后果（§二 要改）**：`effectiveMemberRole`
（`session-instantiate.ts:53-62`）现在把 `ov.model` **合并进** `role.model`
（`...(ov.model !== undefined ? { model: ov.model } : {})`），合并后就分不出
「这个 model 是成员覆写来的还是角色文件来的」—— 而新顺序里这两者分别排 ① 和 ③，
中间隔着会话选择。所以必须让它们**分头走**：`ov.model` 不再并入生效角色，
改为挂到 `MemberPlan.modelOverride`，由 host 在 spawn 时按上面五级链解析。
这是本里程碑**唯一一处**对既有编排逻辑的语义改动，单测要钉住它。

### 5.3 S2 运行时切换

与现状一致，只是 payload 从裸 id 变 ref：
`ModelPicker` → `agent.setModel{path, model: ref}` → `host.setModel` →
`selectModel(ref)` → `engine.setModel(model)`（pi 语义：下一轮起生效）→
`agent.model.changed` 事件 → 渲染层更新 snapshot。

成功后写 `snapshot.modelOrigin = 'runtime'`，并补一行 agent header 落盘（§4.6 修的那个 bug：
现在这个切换重启就丢）。`agent.model.changed` 的 payload 加 `modelOrigin`，渲染层据此决定
显示实色还是「跟随会话」灰字。

### 5.4 改会话模型时的级联（§4.6 的行为出口）

```
S0/S2 改会话模型 → session.record.modelRef = 新值
  └─ 遍历该会话所有活成员 snapshot：
       origin ∈ {member, runtime} ⇒ 跳过（用户显式钉过，不许冲掉）
       origin ∈ {session, role, default, fallback} ⇒ setModel(新值) + origin = 'session'
  └─ 每个被改的成员各发一次 `agent.model.changed`
```

这是 `modelOrigin` 存在的**唯一理由**：没有它只有两种错法 —— 无脑全改（踩掉成员点名指定）
或一个不改（会话选择器形同虚设）。lead 自己走同一套逻辑，不特殊对待。

---

## 六、边界情况与风险

| # | 情况 | 应对 |
|---|---|---|
| 1 | **旧配置迁移**（单 provider + 已加密 key） | `migrateProviders` 幂等；key 从 `provider.apiKeyCiphertext` 搬到 `providerKeys.<id>.apiKeyCiphertext`。**迁移前不删旧字段**，落盘成功后才删 —— 中途崩溃不丢 key |
| 2 | 两个 provider 同名模型 | 复合键天然区分；裸 id 按顺序取首个并 warn |
| 3 | 模型 id 自身含冒号（`qwen:7b`） | `parseModelRef` 只在**第一个**冒号切分 |
| 4 | provider id 重复 / 含点号 | `validateProvider` 拒掉（点号会劈开 keychain 路径） |
| 5 | 删掉 `defaultModelRef` 指向的 provider | `deleteProvider` 自动改指剩余首个的默认模型 |
| 6 | 删掉全部 provider | 合法，回落 faux（与「没配就降级」既有纪律一致） |
| 7 | 某个 provider key 填错 | **部分可用即可用**，不拖累其他 provider（§5.1） |
| 8 | 活引擎的模型来自已删 provider | `selectModel` 抛错 → host warn + 保持原引擎（`host.ts:517-526` 已是这个行为） |
| 9 | 会话落盘的 modelRef 指向已删 provider | 重启按 5.2 回落全局默认，不阻塞恢复 |
| 10 | env 覆盖（`AXON_*`） | 只锁**默认 provider**，CI 与 ui-smoke 的既有路径不变 |
| 11 | 外部引擎会话（M9） | S0/S2 都不显示模型选择器；`setModel` 对 `externalEngineId` 直接 return（`host.ts:513` 已有） |
| 12 | 成员带 `overrides.engineId`（走外部引擎）又设了模型覆写 | 模型覆写对外部引擎无意义：S3 里该成员选了引擎后，模型行置灰并提示（与 lead 的引擎行同一手法） |
| 13 | 成员模型覆写指向已删 provider | 按 §5.2 逐级回落到会话选择，不阻塞实例化；S3 里该值标黄提示「提供商已不存在」 |
| 14 | 团队模板跨机器共享（`~/.axon/teams/*.json` 里存了 `kt:xxx`） | ref 里的 providerId 在对方机器可能不存在 ⇒ 同 13 条回落。**不做** provider 身份的全局化（超出本里程碑） |

**上游坑**：pi 的 `registry.setProvider` 按 id upsert —— 两个 spec 用同一个 id 会**静默覆盖**。
`createMultiProviderSource` 在装入前先查重并抛错（配置层已校验，这里是第二道）。

---

## 七、实施计划

每片结束时 `bun run typecheck` + 相关单测必须绿。

| 片 | 内容 | 怎么验证它对了 |
|---|---|---|
| 1 | 协议层：`providers[]`/`defaultModelRef`/三个 ref 纯函数/白名单增删/`modelRef` ×2/schema 版本 | 新增 ref 纯函数单测（含含冒号 id、裸 id fallback）；`bun run typecheck` 暴露出全部调用点 |
| 2 | `keychain.ts` key 名改造 | 既有 keychain 测试改造后绿 |
| 3 | `config-store.ts`：迁移 + 多 provider 脱敏 + `saveProvider`/`deleteProvider` | `config-store.test.ts` 新增迁移用例（单→多、key 搬迁、幂等重跑）、save 校验用例、delete 改指用例 |
| 4 | `model-config.ts`：`ModelChoice` 多 provider + 部分可用 | `model-config.test.ts` 新增多 provider、部分可用、defaultRef 回落用例 |
| 5 | 内核 `createMultiProviderSource` | 新增 `provider.multi.test.ts`：两 provider 同名模型各自路由到正确 baseUrl（断言 `model.baseUrl`）+ id 重复抛错 |
| 6 | 主进程接线：`index.ts` 装配 / `host.ts` 两命令分派 + ref 语义 + 会话 modelRef 解析 / `provider-probe.ts` | `bun run dev` 启动日志显示多 provider label；既有 host 测试不回退 |
| 7 | 渲染层设置页：多卡 + 增删 + draft 提交 + `SettingsStore` 两方法 | 手工：加第二个 provider、拉模型、测连通、删 provider |
| 8 | 渲染层会话侧：`ModelPicker` 三模式 + 分组；S0 工具栏接入 | 手工：S0 与 S2 都能跨 provider 选模型；ui-smoke 的 `model-picker`/`model-option` 钩子仍命中 |
| 9 | **成员级模型**：`session-instantiate.ts` 拆 `modelOverride` + host 五级链 + S3 成员编辑器「模型覆写」行 + `AdhocMemberSpec.model` | 单测钉住五级优先链；手工：两成员分设不同 provider 的模型，跑一轮看各自走对网关 |
| 10 | 质量门全绿 + 文档同步 | §九 清单 |

**切片 1 之后 typecheck 必然大面积报错**（删了 `provider.*` 白名单、改了 `provider?` 形状），
这是**有意的**：让编译器把所有调用点点出来，而不是靠 grep 找。

---

## 八、测试策略

- **纯函数单测**（protocol）：`formatModelRef` / `parseModelRef` / `resolveModelRef` ——
  含冒号 id、裸 id、空 providers、重名取首个
- **配置层单测**（`config-store.test.ts`）：迁移幂等性、`saveProvider` 校验矩阵
  （id 非法/重复、models[i] 缺 id、env-locked 跳过）、`deleteProvider` 的 defaultModelRef 改指、
  原子落盘保留未知字段（既有纪律）
- **解析层单测**（`model-config.test.ts`）：多 provider、部分可用、四种降级原因、env 只锁默认
- **内核契约测**（`provider.multi.test.ts`）：**同名模型路由正确**是本里程碑的核心断言 ——
  两个 provider 各有 `deepseek-v3`，`selectModel('a:deepseek-v3')` 与 `selectModel('b:deepseek-v3')`
  必须返回不同 `baseUrl` 的 model
- **优先链单测**（`session-instantiate.test.ts` + host 侧）：**本里程碑最该钉住的断言** ——
  构造「成员覆写 = A / 会话选择 = B / 角色声明 = C / 全局默认 = D」的全矩阵，
  逐级拿掉上层，验证解析结果依次落到 A→B→C→D。特别要有一例
  「角色声明了 C 但会话选了 B」⇒ 结果必须是 B（这是本次拍板反转的那一条，
  也是 `effectiveMemberRole` 拆 `modelOverride` 的理由）
- **集成**：既有 528 例全部不回退（尤其 `host.*.test.ts` 与 `provider.dsml.test.ts`）
- **ui-smoke**：既有钩子 `model-picker` / `model-option` 保持可命中；S0 新选择器加
  `data-smoke="s0-model-picker"`，暂不新增幕次（本里程碑不扩 ui-smoke 断言数）

---

## 九、验收标准

**自动化门（2026-10-10 实测）**

- [x] `bun run guard` 绿（pi import 白名单未放宽）
- [x] `bun run typecheck` 绿（root + renderer）
- [x] `bun run test` 绿 —— **681 例**全绿（M15 起点 528 例；差额含 M10~M14 与 M15 的累积新增）
- [x] `bun run build:desktop && bun run verify-lazy` 绿（main.mjs 404 KB / renderer.js 1518 KB）
- [x] `bun run ui-smoke` 绿（全幕通过，`s0-model-picker` 等钩子可命中；按计划未新增幕次）

### 9.1 实测回填

| 项 | 值 | 证据 |
|---|---|---|
| 落地 commit | `772d1ff`（M15 主体：多提供商 + 会话窗模型选择）｜`8119cb6`（同会话收尾：左栏列出无项目归属会话 + 恢复会话屏 chips） | `git log --oneline` |
| 节奏 | 2026-10-08 设计评审 → 2026-10-10 提交（跨两个工作日，中途插入了成员级模型覆写与选择器位置统一两条用户追加要求） | — |
| 测试数 | 681 例全绿 | `bun run test` |
| 打包体积 | main.mjs 404 KB / renderer.js 1518 KB，懒加载未被破坏 | `bun run verify-lazy` |

> 逐条的「设计 vs 实测偏离」没有在落地当时记入本文档（当时的会话直接进了 M16），
> 故此处只回填可复核的客观项，不复述无法取证的过程细节。

**手工门（待用户验收 —— 点过之后再置 ✅）**

- [ ] 手工：设置页能加/改/删第二个提供商，各自拉模型列表、各自测连通性
- [ ] 手工：S0 工具栏选择器按提供商分组，选 B 的模型建会话 → 实际走 B 的 baseUrl
- [ ] 手工：S2 运行中会话跨 provider 切模型 → 下一轮生效
- [ ] 手工：**团队里两个成员分设不同 provider 的模型**，跑一轮各自走对网关
- [ ] 手工：成员不设模型 ⇒ 跟随会话窗所选；会话窗也不选 ⇒ 跟随角色/全局默认
- [ ] 手工：给成员选了外部引擎后，模型行置灰并给出提示
- [ ] 手工：删掉默认模型所属 provider → 自动改指，顶栏不降级 faux
- [ ] 手工：**旧 config.json 首次启动自动迁移**，key 不丢、会话可用
- [ ] 手工：三个 provider 其中一个 key 故意填错 → 另外两个照常可用

---

## 十、文档同步（2026-10-10 收口）

- [x] `docs/03-实施框架与里程碑.md` §1 状态表 —— 加 M15 行
- [x] `docs/01-架构决策-方案B.md` §1 进度表 —— 适配器边界那行补「多 provider 共享 registry」
- [x] `docs/milestones/M6-real-model.md` —— 加一句指向本文档（M6 的「一个网关」结论已被本里程碑取代）
- [x] 本文档状态改为「已完成」并回填实测数据
- [~] `docs/milestones/MU-1-session-team.md` —— **文件名写错了**（现存文件是 `MU-1-session-container.md`），
      且该文档没有「成员覆写」一节；五级优先链本文档 §5.2 已写全，MU-1 侧只在
      §4.7 加了「三层预算已下线」的注记，不再另补一节



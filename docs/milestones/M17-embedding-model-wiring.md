# M17 向量模型接线：方案设计、实施计划与实测

> 状态：**已完成（2026-10-10）**
> 决策来源：用户口述 —— 2026-10-10 贴出「模型配置里给 `text-embedding-v3` 测试连接显示失败」
> 并问「是因为目前还不兼容配置向量模型么」；确认诊断后回「可以」授权动手
> 依赖里程碑：M12~M14（知识库管道与 S4 屏）、M15（多提供商 `providers[]`）、M6（`provider-probe`）
> 纪律：本片**动了协议 / 主进程 / 渲染三层**，但没有新增协议命令、没有改落盘形状，
> 唯一的倒退风险是「向量模型从对话侧消失」—— 已在 §三.1 逐条钉住

---

## 一、目标与范围

**用户可见能力（一句话）**：在「设置 → 模型配置」给某个模型点一下「向量」，它就能被正确测通
（走 `/embeddings`）、并从知识库的「向量模型」下拉里选到；知识库不再是一个装着配置却打不开的功能。

### 1.1 做什么

1. **探测端点按模型类型分派**：`provider.test` 新增 `kind`，`embedding` 打 `/embeddings`，
   其余打 `/chat/completions`（`provider-probe.ts:160`、`ipc.ts:432`）
2. **`ModelSpec.kind?: 'chat' | 'embedding'`**：向量模型是**模型属性**，不再靠猜名字
   （`protocol/config.ts:53`）；全局默认向量模型 = `providers` 顺序里首个标了 `embedding` 的
   （`resolveEmbeddingModels`，`protocol/config.ts:195`）
3. **知识库端点改从 `providers[]` 取**：`index.ts:590` 起按向量模型挑端点+key，
   换掉读 legacy `config.provider` 的那段（§二.1）
4. **每 KB 的向量模型真的能换**：`makeKnowledgeManager` 传 `embedderFactory`
   （`knowledge-bridge.ts:59`），S4 下拉改读配置里的向量模型（`S4Knowledge.tsx:30`）
5. **探测失败详情可见**：HTTP 码 + 响应体片段从 tooltip 挪到行下
   （`Models.tsx:280`、`Models.tsx:612`）

### 1.2 明确不做（防蔓延）

- **不新增顶层 `embeddingModelRef` 配置字段**：用户的心智是「这个模型是向量模型」，
  不是「另有一处设置指向它」。少一个要进白名单、要校验、要迁移的顶层键
- **不做向量维度校验**：LanceDB 的表 schema 由首次摄入的向量决定（`store.ts:57`），
  换模型后旧块维度不匹配是既有事实（`manager.ts:83` 已写明「让上层收错误提示」），
  本片只把 S4 的提示留在原位（`S4Knowledge.tsx` 的 `s4-model-warn`）
- **不动 M16 之后的下线范围**：用量、并发闸门、审批链路一行不碰

---

## 二、现状盘点：三个各自独立的断点

用户报的是「测试连接失败」，但沿链路走下去是**三件不相干的事**同时坏着：

| # | 断点 | 取证 |
|---|---|---|
| 1 | 单模型「测试」写死打 chat 端点，向量模型恒 400 | 原 `provider-probe.ts:203` `const path = model ? 'chat/completions' : 'models'` |
| 2 | 知识库端点读 legacy `config.provider`，M15 迁移已把该键删掉 ⇒ `kbManager` 恒为 null | 原 `index.ts:584-596`；`config-store.ts:367` 的 `delete next['provider']`；实测本机 `~/.axon/config.json` 无 `provider` 键 |
| 3 | 每 KB 的向量模型下拉只改元数据，embedder 恒回落默认 | 原 `knowledge-bridge.ts:27-34` 未传 `embedderFactory` ⇒ `manager.ts:73-85` 的 `_embedderFor` 永远走 `defaultEmbedder`；下拉里是硬编码的 4 个预设（原 `S4Knowledge.tsx:22-27`） |

第 2 条是 M15 的漏改：`rawConfig.provider ?? {}` 由 6b973dd（M13）写入，M15（772d1ff）把
配置形状换成 `providers[]` 时没跟着改。它之所以一直没被发现 —— `scripts/kb-e2e.mjs:80-82`
用 `AXON_KB_EMBED_*` 注入本地桩服务，走不到这条真实路径。

**顺带修掉的一个既有坎**：原 `resolveEffective` 经 `resolveModelChoice` 解析网关，
而后者会跳过「模型清单为空」的 provider —— 于是**刚加好的新网关测不了**
（而「先填 baseUrl/key → 测试连接 → 再拉模型列表」正是自然顺序）。
现在探测只关心「网关通不通」，与「这次会话用哪个模型」解耦（`provider-probe.ts:171-176`）。

---

## 三、实施中发现并修掉的问题（设计 vs 实测偏离）

### 3.1 过滤向量模型会把探测一起打死（本片差点引入）

「向量模型不进对话侧注册表」这一刀落在 `resolveModelChoice`（`model-config.ts:121`），
而原 `resolveEffective` 正是拿它的结论找网关 —— 两者一叠加，
**只挂向量模型的网关（= 用户截图里那个 Ali）会连探测都点不动**，
报「提供商不可用（…或模型清单为空）」，正好把用户要修的场景修坏。

所以 `resolveEffective` 改成直接读 `providers[]` 的 `baseUrl`/`apiKey`
（`provider-probe.ts:176`），只保留两件与探测有关的事：legacy 形状兜底、keychain 注入、
第一个 provider 的 `AXON_BASE_URL`/`AXON_API_KEY` 覆盖。用例见
`provider-probe.test.ts`「只挂向量模型的网关仍能探测」。

### 3.2 「只挂向量模型」不能报成「模型清单为空」

过滤后 provider 会走进既有的 `skipped` 分支，而原文案是「模型清单为空」——
用户看到这句会去删一个**其实配对**的模型。两种空现在分开报
（`model-config.ts:130`），且这句话会一路显示到顶栏降级原因里。

### 3.3 「主对话」胶囊得跟着一起消失，否则留下悬空的 `defaultModelRef`

标了 `embedding` 的模型不该有「主对话」按钮（选了会话一发就 400）；
但如果它**已经**是主对话，光藏按钮不够 —— `defaultModelRef` 会指到一个再也不能用的模型，
下次启动静默回落到别的模型而设置页看不出来。所以标记动作在同一笔 `saveProvider` 里
把 `defaultModel` + `defaultModelRef` 一起清掉（`Models.tsx` 的 `commitModels` 第二参）。
不能拆两次提交：provider 写侧是「整体覆盖」，而 `providerBase()` 读的是上一次渲染的 props。

### 3.4 顺手修掉：删掉「当前主对话」的模型是个静默失败

同一条写路径上的既有 bug。`handleDelete` 提交时带着 `defaultModel: p.defaultModel`，
删的若正是它，`validateProvider` 会判「defaultModel 不在该提供商的模型清单里」
（`config-store.ts:243-254`）→ 整批不落盘，而渲染层不看 `saveProvider` 的返回值，
用户点了垃圾桶什么都不会发生。现在同一个 `clearDefault` 参数一并清掉
（`Models.tsx` 的 `handleDelete`）。

M17 之前它测不出来是因为**没人删过默认模型**；本片把「悬空的默认指向」当成一类问题
统一处理（标记向量、删除模型两条路），所以一并收掉。

---

## 四、质量门结果

```
bun run guard        ✓ 6 项全过
bun run typecheck    ✓ root + renderer 双 tsc
bun run test         ✓ 本片触及的 3 个测试文件全绿（新增 provider-probe.test.ts 9 例）
                        环境性失败与本片无关，见下
bun run build:desktop ✓
bun run verify-lazy  ✓ provider 懒加载完好，内核未泄漏到渲染层
```

**测试数**：新增 `provider-probe.test.ts` 9 例；`model-config.test.ts` +3；
`config-store.test.ts` +2。

**本机 28 例环境性失败（非本片引入）**：`RoleLoader`/`TeamLoader`/`RoleBridge`
（断言里出现 `'\mem\roles\ops.json'`，Windows 路径分隔符）、`detectAgentTools`
（本机未装 `claude`）、agent 工具的 `read/edit/write/ls/glob/grep`、
`ConfigStore` 的 0600 权限位（Windows 的 chmod 不落地）。取证方式：逐条读失败断言，
全部落在本片未触碰的文件上，且失败原因均为 Windows/环境差异。

**未跑**：`bun run ui-smoke`（需抢 Electron/CDP）、`bun run dev` 手工验收 —— 留给用户过目。

---

## 五、残留与台账

- **`ui-smoke` 无关**：本片没动 `scripts/ui-smoke.mjs` 的挂点，M17 不新增幕。
  但**建议下次跑冒烟时顺手看一眼 S8 模型配置屏**：新增的「向量」胶囊是唯一的新控件
- **旧 KB 的向量模型名是历史值**：换模型前建的知识库，`embeddingModel` 里可能是
  `qwen3.7-text-embedding`（旧硬编码默认）这类不在配置里的名字。S4 现在**显示回落后的真相**
  并在 tooltip 说明（`S4Knowledge.tsx:50`），但不做数据迁移 —— 用户点一下下拉即可写正
- **每 KB 换模型不会重算旧块**：维度不匹配要到查询时才暴露（既有行为，S4 已有文案提示）
- **`providers[].apiKeyCiphertext` 重复落盘**：实测本机 config.json 里密文同时存在于
  `providerKeys.<id>.apiKeyCiphertext` 与 `providers[].apiKeyCiphertext`。是 `saveProvider`
  把读侧视图整体回写导致的，**功能无影响**（读侧只认前者），本片不动，留作台账
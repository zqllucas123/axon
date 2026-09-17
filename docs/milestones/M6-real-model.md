# M6 真实模型接入：方案设计与实施计划

> 状态：**设计评审中**（2026-09-17）
> 对应架构：01 §6.6（模型适配层）｜ 依赖里程碑：M5（落盘）、MU-3（收尾屏）
> 并行结构拍板：2026-09-17，1+3+1 三段式，详见 §七

---

## 〇、前置尖峰结论（必读）

S2（`docs/spikes/S2-真模型方言与可靠性报告.md`，2026-09-17）完成了五个决策闸口的取证：

| 闸口 | 结论 | 对本里程碑的约束编号 |
|---|---|---|
| B-1 流式文本 | `text_delta` 存活（29 条），**M6 必须接** | C-1 |
| B-3 工具增量 | `toolcall_delta` 存活（4 条），**M6 必须接** | C-1 |
| 成本归零 | 配置缺 `cost` 字段所致，网关正常返回 token 数 | C-3 |
| 看门狗阈值 | 最长静默 1676ms（工具回合间隙），阈值 ≥ 8000ms | C-5、C-6 |
| length 续写 | 网关未按 `maxTokens` 截断（`compat.maxTokensField` 未透传所致），结论挂起 | C-4 |
| thinking-only | 未出现，kalo 补丁 1 暂不需要移植 | C-7 |

**协议声明 `agent.message.delta` / `agent.tool.update` 确认存活，保留。**

---

## 一、目标与范围

### 用户可见能力

用户在设置窗（⌘,）填入自己的 API key 和模型后，所有 Agent 对话实时流式显示（字 by 字出现），工具调用有进度指示，成本数字真实可信（S6 预算屏与气泡内联账单有真数据），预算熔断在真实花费下触发。

### 本里程碑内做什么

- **流式接入（S）**：`wire()` 响应 `message_update.assistantMessageEvent`，把 `text_delta` / `thinking_delta` / `toolcall_delta` 三类翻译成 Axon 协议事件；渲染层消费它们实时更新消息气泡
- **可靠性补丁（R）**：流式看门狗（kalo 补丁 3 的 Axon 实现版）；`compat.maxTokensField` 透传让截断能真正触发；length 续写待看门狗落地后补测
- **per-role 模型映射（M）**：`RoleDefinition.model` 真正生效；`AxonHost` 三个 `createAxonEngine` 调用点各自按角色选 model
- **API key 进 keychain（K）**：新建 `main/keychain.ts`，存取用 Electron 的 `safeStorage`；`config-store.ts` 的写侧存密文，读侧返回掩码；渲染层 `Models.tsx` 的 `SecretField` 透传到 keychain
- **provider.test 测试连接（T）**：新建 `main/provider-probe.ts`；`Models.tsx` 的「测试连接」按钮有真实反馈
- **配置与接线补全（G）**：`ModelSpec` 增 `compat.maxTokensField`；配置校验对 `cost` 全零出 `console.warn`；`provider.test` 命令加进 `ipc.ts`
- **真模型编排压测（P）**：多子 Agent 并发下 gate 争用、真实成本与预算熔断的联调

### 明确不做

- 暗色主题（台账 D-7，归 M7）
- `pending.history` 持久历史（台账 D-1）
- 按日预算重置（台账 D-4，`BudgetGuard` 无日切）
- 用量按协作动作切片（台账 D-5）
- 轮数计数（台账 D-6）
- kalo 补丁 2a/2b（length 续写）：先实现 `compat.maxTokensField` 透传，补测后再定

---

## 二、现状盘点

### 已有的

| 组件 | 现状 | 关键文件路径 |
|---|---|---|
| `createOpenAICompatSource` | 完整实现；`selectModel(id)` 已有但零调用方 | `packages/kernel/src/provider.ts:155` |
| `AxonHost.modelSource` | 单一 `ModelSource`，全局唯一模型 | `host.ts:237` |
| `RoleDefinition.model` | 字段已在协议里，但 host 忽略它 | `packages/protocol/src/agent.ts:230` |
| `wire()` | 只响应顶层事件（`message_end` / `turn_end` 等），无流式分支 | `host.ts:1990` |
| `MessageStream.tsx` | 192 行，纯 `agent.message.end` 一次性渲染，无增量更新 | `renderer/components/MessageStream.tsx` |
| `Models.tsx` | 534 行，有 `SecretField`；apiKey 明文写 `config.json` | `settings/panes/Models.tsx` |
| `config.json` key 存储 | 明文，`~/.axon/config.json`（0600）；`maskConfig` 保证 apiKey 不出主进程 | `config-store.ts:36` |
| `ModelSpec` | `cost` / `maxTokens` 已有；**无 `compat` 字段** | `packages/protocol/src/config.ts:39` |
| `BudgetGuard` | 吃 `usage.cost.total`，`cost` 为 0 时永远不触发 | `packages/kernel/src/budget.ts:94` |

### 缺口

- `wire()` 无 `message_update` 分支：流式增量完全丢弃
- `HostOptions.modelSource` 是 `ModelSource`（单 model），没有 `selectModel` 入口
- `ModelSpec` 无 `compat.maxTokensField`，造成 `maxTokens` 无法正确下发
- 无 keychain：safeStorage / keytar 全仓零调用
- 无 `provider.test`：`ipc.ts` 里没有此命令
- `createAxonEngine` 三处调用点（`host.ts:697/1081/1548`）硬用 `this.modelSource.model`

---

## 三、设计依据

- **S2 §三.闸口 1**：`assistantMessageEvent` 载荷形状 + 事件类型分布（wire 接线规格）
- **S2 §三.闸口 2**：cost=0 根因（`MODEL_DEFAULTS.cost` 全零），告警修法
- **S2 §三.闸口 3**：最长静默 1676ms（看门狗阈值下限）
- **S2 §三.闸口 4**：`compat.maxTokensField` 未透传导致网关不截断；修法见 `openai-completions.js:601-605`
- **S1 §四.1**：工具签名 `(toolCallId, args, signal, ctx)`（第一参不是 args）
- `packages/kernel/src/provider.ts:155`：`selectModel(id)` 已实现，返回 `ModelSource`
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1325-1337`：compat 合并逻辑
- MU-3 §〇 P-7：`provider.test` 和 keychain 归 M6

---

## 四、总体设计

### 4.1 数据模型变更（schema 先行）

**`packages/protocol/src/config.ts`**（共享文件，阶段 0 改完）：

```ts
// 增加 compat 字段。maxTokensField 决定 pi 把 maxTokens 发成哪个请求字段。
// 自定义网关不识别 max_completion_tokens（OpenAI 新字段）时需显式声明 max_tokens。
// 参考 pi openai-completions.js:601-605 的分支逻辑。
export interface ModelSpec {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  compat?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  };
}
```

**`packages/protocol/src/ipc.ts`**（共享文件，阶段 0 改完）：

```ts
// 新增 provider.test 命令：测试当前配置的网关连通性，返回延迟与可用模型列表。
'provider.test': {
  params: Record<string, never>;
  result: { ok: boolean; latencyMs: number; models: string[]; error?: string };
};
```

### 4.2 模块布局

新增文件（各属主窗口只写自己的文件）：

| 文件 | 属主 | 职责 |
|---|---|---|
| `apps/desktop/src/main/keychain.ts` | W-A | `safeStorage` 包装；`set(key, plain)` / `get(key) → plain \| null` / `has(key)` |
| `apps/desktop/src/main/provider-probe.ts` | W-B | 发一个最小 completion 请求，返回延迟与模型验证结果 |

改动文件：

| 文件 | 属主 | 改动内容 |
|---|---|---|
| `packages/protocol/src/config.ts` | 阶段 0 主线 | `ModelSpec` 加 `compat.maxTokensField` |
| `packages/protocol/src/ipc.ts` | 阶段 0 主线 | `provider.test` 命令声明 |
| `apps/desktop/src/main/config-store.ts` | W-A | 写侧用 keychain 加密 apiKey；读侧返回掩码 |
| `apps/desktop/src/renderer/settings/panes/Models.tsx` | W-B | 「测试连接」按钮；keychain 的 key 交互（placeholder 显掩码） |
| `apps/desktop/src/main/host.ts` | W-C | `wire()` 增流式分支；`createAxonEngine` 三处接 per-role model；看门狗 |
| `apps/desktop/src/main/index.ts` | W-C | `HostOptions.modelSource` 改为 `OpenAICompatSource`（携带 `selectModel`）；`createModelSource` 补 `compat` 透传 |
| `packages/kernel/src/provider.ts` | W-C | model 对象构造透传 `compat`；`ModelSource & { selectModel }` 类型已有，确认 index.ts 用起来 |
| `packages/protocol/src/agent.ts` | W-C | `AgentSnapshot` 加 `model?: string` 消费点（已有字段，补 registry 赋值） |
| `apps/desktop/src/renderer/components/MessageStream.tsx` | 阶段 C | 增量渲染（`agent.message.delta` 事件消费） |
| `apps/desktop/src/renderer/state/store.tsx` | 阶段 C | `agent.message.delta` action handler |
| `apps/desktop/src/main/model-config.ts` | 阶段 0 主线 | `compat` 字段透传 + `cost` 全零告警 |

### 4.3 流式接入接线图

```
模型网关（SSE）
  └─ pi openai-completions.js（流式解析）
       └─ AgentEvent: message_update { assistantMessageEvent: { type, delta, ... } }
            └─ host.ts wire()          ← 阶段 C 新增 message_update 分支
                 ├─ text_delta       → emit('agent.message.delta', { text: delta })
                 ├─ thinking_delta   → emit('agent.message.delta', { thinking: delta })
                 └─ toolcall_delta   → emit('agent.tool.progress', { callId, delta })
                      └─ ipc.ts（已声明）
                           └─ renderer store.tsx → MessageStream.tsx（增量 append）
```

### 4.4 per-role 模型映射

`HostOptions` 中 `modelSource` 改为 `OpenAICompatSource`（已有 `selectModel` 方法）。
`AxonHost` 在三个 `createAxonEngine` 调用点：

```ts
// host.ts:697（spawn 普通 agent）、1081（恢复 agent）、1548（根 agent）
const roleModel = this.registry.get(path)?.snapshot.role;
const def = roleModel ? loadRoleDefinition(roleModel) : undefined;
const modelSource = def?.model
  ? this.modelSource.selectModel(def.model)  // 角色声明了 model 就切换
  : this.modelSource;                          // 否则用全局默认

const engine = createAxonEngine({
  model: modelSource.model,
  streamFn: modelSource.streamFn,
  ...
});
```

`RoleDefinition.model` 字段值是 `ModelSpec.id`，须存在于 `provider.models` 列表里；
不存在时 fallback 全局默认并 `console.warn`，不报错（S1 §五 的「缺配置降级而非报错」原则）。

### 4.5 keychain

`Electron.safeStorage`（内置，无需额外依赖）：

- `safeStorage.isEncryptionAvailable()` 为 false 时（CI、非 macOS）降级明文，打 warn
- 写：`safeStorage.encryptString(plain)` → Buffer → base64 存进 `config.json` 的 `provider.apiKeyCiphertext`；删掉明文 `provider.apiKey`
- 读：`config-store.ts:maskConfig` 侧：`apiKeyCiphertext` 有值时解密后返回掩码（`sk-***xxxx`），**解密结果不出 config-store**
- 渲染层 `Models.tsx` 的 `SecretField`：显示掩码；用户输入新值时 IPC 到主进程加密存储
- 首次迁移：`config.json` 里如果还有明文 `apiKey`，启动时自动加密迁移并删明文

### 4.6 流式看门狗

在 `wire()` 里对每个 `AgentPath` 维护一个 `lastActivityAt` 时间戳，`message_update` 或 `turn_start` 到来时刷新。
一个 `setInterval`（500ms）扫描所有 `running` 状态的 agent，超过阈值（`WATCHDOG_MS = 10_000`，比实测最大静默 1676ms 多 6 倍余量）则对 engine 执行 abort。

S2 §三.闸口 3 证明「工具回合间隙」会有 1676ms 静默，因此看门狗必须接受正常间隙，不能只盯相邻帧。

---

## 五、关键流程

### 5.1 流式消息到界面的完整路径

```
1. 用户发消息 → host.ts agent.prompt()
2. pi engine 发起 SSE 请求 → 逐 token 收流
3. 每个 token → AgentEvent: message_update { assistantMessageEvent: {type:'text_delta', delta:'...'} }
4. wire() 捕获 → emit('agent.message.delta', { messageId, text: delta }, path)
5. preload.ts ipcRenderer.on('agent.message.delta', ...) → store dispatch
6. store.tsx: messages 里找 messageId（用 message_start 已创建的占位）→ 追加 delta
7. MessageStream.tsx: 订阅 store → 增量 re-render（React 批量合并）
8. message_end 到达 → 最终内容替换（防流式与落盘不一致）
```

### 5.2 per-role model 映射路径

```
agent.spawn({role:'researcher'}) 调用
  → AxonHost.spawnAgent()
  → 读 RoleDefinition.model（如 'deepseek-r1'）
  → this.modelSource.selectModel('deepseek-r1') → 返回该 model 的 ModelSource
  → createAxonEngine({ model: selected.model, streamFn: selected.streamFn })
```

---

## 六、边界情况与风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 网关忽略 `compat.maxTokensField` | maxTokens 失效，无法测 length 截断 | 透传字段；先做好、再补测 |
| safeStorage 在 CI/非 macOS 下不可用 | keychain 存取失败 | `isEncryptionAvailable()` 判断，降级明文并 warn |
| 流式与 message_end 内容不一致 | 渲染闪烁 | message_end 到达时用最终内容整体替换，而非追加 |
| per-role model 不存在于 models 列表 | createAxonEngine 收到 undefined model | fallback 全局默认 + warn；不 throw |
| 看门狗误杀正常工具等待 | agent 被强制中断 | 阈值 10s（实测最大静默 1676ms 的 ~6 倍）；turn_start 也刷新时间戳 |
| cost=0 时 BudgetGuard 永不触发 | 预算熔断失效且无感知 | 配置校验 warn；S6 屏显示「单价未配置」提示 |
| 阶段 B 三窗碰同一 tsconfig | typecheck 互相干扰 | 三窗只跑 typecheck，不跑 build/dev/smoke |

---

## 七、实施计划（1+3+1 三段式）

拍板（2026-09-17）：一份 key，阶段 B 并行三窗，阶段 A 和 C 串行。

### 阶段 0 · 主线（前置共享文件，必须 commit 后才开阶段 B）

主线改完下列文件并出一个 `chore: M6 阶段0 共享文件前置` commit：

| 文件 | 改动 |
|---|---|
| `packages/protocol/src/config.ts` | `ModelSpec.compat.maxTokensField` |
| `packages/protocol/src/ipc.ts` | `provider.test` 命令声明 |
| `apps/desktop/src/main/model-config.ts` | `compat` 透传到 `createOpenAICompatSource`；`cost` 全零告警 |

验收：`bun run guard && bun run typecheck && bun run test`（528 例不回退）。

---

### 阶段 B · 并行三窗（阶段 0 commit 后同时开）

#### W-A keychain（属主文件）

- 新建 `apps/desktop/src/main/keychain.ts`
- 改 `apps/desktop/src/main/config-store.ts`（写侧加密，读侧掩码，启动迁移）

验收（只许跑 typecheck）：`bun run typecheck`。代码完成后交主线 review + commit。

**零改动**：`host.ts` / `Models.tsx` / `ipc.ts` / `provider.ts`。

---

#### W-B provider.test（属主文件）

- 新建 `apps/desktop/src/main/provider-probe.ts`
- 改 `apps/desktop/src/renderer/settings/panes/Models.tsx`（「测试连接」按钮 + keychain 掩码显示）

验收（只许跑 typecheck）：`bun run typecheck`。

**零改动**：`host.ts` / `config-store.ts` / `ipc.ts` / `provider.ts`。

注：`provider.test` 在 `ipc.ts` 的命令声明已由阶段 0 加好，W-B 只需在 `index.ts` 里注册 handler、在 `Models.tsx` 里调用。

---

#### W-C 接线 + per-role（属主文件）

- 改 `apps/desktop/src/main/host.ts`：
  - `wire()` 增 `message_update` 分支（text_delta / thinking_delta / toolcall_delta）
  - 三个 `createAxonEngine` 调用点接 per-role model 映射
  - 流式看门狗
- 改 `apps/desktop/src/main/index.ts`：`HostOptions.modelSource` 改为带 `selectModel` 的类型
- 改 `packages/kernel/src/provider.ts`：model 对象透传 `compat`

验收（只许跑 typecheck + test）：`bun run typecheck && bun run test`。

**零改动**：`config-store.ts` / `Models.tsx` / `provider.ts:config.ts`。

---

### 阶段 C · 主线（串行，等阶段 B 三窗全部 review + commit 后开）

1. **流式渲染**：`store.tsx` 增 `agent.message.delta` action；`MessageStream.tsx` 增量 append
2. **thinking 折叠区**：消息气泡支持 thinking block 折叠（协议已有 thinking content type）
3. **工具进度**：`agent.tool.progress` 事件对应 `MessageStream.tsx` 里的进度条更新
4. **联调验收**：`bun run dev` 手工过流式 + per-role + keychain + provider.test + 预算熔断五项能力
5. **真模型编排压测（P）**：`bun run example:orchestration` 并发两子 Agent，观察 gate 争用与成本汇总
6. **质量门全绿**：guard + typecheck + test(528) + build:desktop + verify-lazy + ui-smoke(41)

---

## 八、测试策略

### 单测 / 契约测试

- `packages/kernel/src/engine.contract.test.ts`：补一个 `message_update` 事件的 delta 序列用例（faux 模式，不需要真 key）
- `packages/kernel/src/provider.ts`：`createOpenAICompatSource` 透传 `compat` 的单测

### 集成测试

- `bun run example:dialect`（S2 探针）：阶段 C 联调时再跑一次，校验 text_delta / thinking_delta / toolcall_delta 三类事件在 wire 层都有对应处理
- `bun run example:orchestration`：多子 Agent 真实编排，gate=2，观察成本沿父链汇总

### ui-smoke

当前 41 条断言不回退。阶段 C 完成后视情况补两条：

- 流式消息：发一条 prompt，检查消息气泡在 `agent.message.end` 前就出现了内容（`textContent.length > 0`）
- 成本数字：`data-cost` 属性为非零值（需配置 `cost` 字段）

---

## 九、验收标准

- [ ] `bun run guard` 6 项全绿
- [ ] `bun run typecheck`（root + renderer 双 tsc）零错误
- [ ] `bun run test` 528 例不回退（可新增）
- [ ] `bun run build:desktop && bun run verify-lazy` 通过
- [ ] `bun run ui-smoke` 41 条（+新增）全绿
- [ ] 手工演示五项能力：
  - [ ] 流式消息：字 by 字出现，不等 message_end
  - [ ] thinking 折叠：deepseek-r1 风格的 thinking block 可折叠
  - [ ] per-role 模型：`~/.axon/config.json` 里一个角色指定不同模型，Spawn 后该 agent 走该模型（启动日志可见）
  - [ ] keychain：设置窗填入 apiKey 后重启，apiKey 以掩码显示，且不明文出现在 `config.json`
  - [ ] provider.test：设置窗点「测试连接」，显示延迟与可用模型
- [ ] S6 预算屏：成本数字非零（config 里配 `cost` 单价后）
- [ ] 预算熔断：手动把 `budgetUsd.hard` 设低于当前累计，触发 `budget.frozen` banner

---

## 十、文档同步

完工后更新：

- `docs/03-实施框架与里程碑.md` §1 M6 行状态改「已完成」，§3 M6 节补完工摘要
- `docs/01-架构决策-方案B.md` §1 进度表 M6 行打勾
- 本文档状态行改「已完成（YYYY-MM-DD）」
- AGENTS.md 进度行改「M0~M6 与 MU-1/MU-2/MU-3 均已完成」，测试基线更新

---

## 十一、文件所有权表（阶段 B 并行纪律）

> 根据 AGENTS.md §4.4 受控豁免条款，阶段 B 三窗并行时此表为硬约束。
> 每个文件只能有一个属主会话写，非属主文件一律只读。

| 文件 | 属主 | 备注 |
|---|---|---|
| `apps/desktop/src/main/keychain.ts`（新建） | **W-A** | |
| `apps/desktop/src/main/config-store.ts` | **W-A** | |
| `apps/desktop/src/main/provider-probe.ts`（新建） | **W-B** | |
| `apps/desktop/src/renderer/settings/panes/Models.tsx` | **W-B** | |
| `apps/desktop/src/main/host.ts` | **W-C** | |
| `apps/desktop/src/main/index.ts` | **W-C** | |
| `packages/kernel/src/provider.ts` | **W-C** | |
| `packages/protocol/src/config.ts` | **阶段 0 主线** | 阶段 B 开始前已 commit，三窗只读 |
| `packages/protocol/src/ipc.ts` | **阶段 0 主线** | 同上 |
| `apps/desktop/src/main/model-config.ts` | **阶段 0 主线** | 同上 |
| `apps/desktop/src/renderer/components/MessageStream.tsx` | **阶段 C 主线** | 阶段 B 期间三窗不碰 |
| `apps/desktop/src/renderer/state/store.tsx` | **阶段 C 主线** | 同上 |

---

## 十二、台账（M6 遗留 / 延期项）

> 完工时填写延期项，写明原因。开工时此表为空。

| 编号 | 描述 | 原因 | 去向 |
|---|---|---|---|
| D-M6-1 | length 续写（kalo 补丁 2a/2b） | `compat.maxTokensField` 透传后未补测 | M6 收尾时补测，若有必要写进去；否则归 M7 |

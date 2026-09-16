# M5 会话持久化（6.6 TreePersistence）：方案设计与实施计划

> 状态：**已完成**（2026-09-16 收口；2026-09-15 评审通过，四条拍板见 §〇）
> 对应架构：01 §6.6（TreePersistence）/§6.1（Registry 多根）；UX `00` S7 会话恢复、UX `02` §7（M5 接口建议）
> 依赖里程碑：M4（账本，已完成）+ MU-1（会话容器，已完成，commit `4212546`）
> 上游拍板：MU-1 §4.3 已把落盘布局写进架构（`docs/milestones/MU-1-session-container.md:218-232`），本里程碑**实现它**，只补细节
> 纪律：所有论断带 `文件路径:行号`；行号以 2026-09-15 工作树（commit `4212546`）为准

---

## 〇、待用户拍板（✅ 2026-09-15 已拍板）

**拍板记录（2026-09-15，用户逐条确认）：四条全部按推荐落地** —— ① 重启后挂起审批/提问 → 全部结算为 `rejected` + 留痕；② 账本 `status:'open'` → 结算 + 注明「应用重启，未及结算」；③ 加载策略 → 懒加载 + 汇总缓存；④ 删除语义 → 物理删除整个会话目录。

下表是拍板时的选项与理由（不再变更，实现以它为准）：

| # | 决策 | 选项 | 推荐与理由 |
|---|---|---|---|
| 1 | **重启后挂起的审批/提问怎么办** | A. 全部结算为 `rejected` + 留痕「应用重启，审批未决」；B. 重新弹出等人批；C. 原样挂着（UI 标灰、不可批） | **A**。重启后没有进程在等，B 的「重新弹」等于把一条旧请求伪装成新的（用户批了也只是对旧 turn 徒劳表态——那个 turn 已经死了）；C 会留下一条永远无法处理的挂起，污染收件箱。A 最诚实，且账本/事件都有迹可循 |
| 2 | **账本里 `status:'open'` 的记录怎么办** | A. 启动时结算为 `settled`，`summary` 注明「应用重启，未及结算」；B. 保持 open | **A**。open 的语义是「目标还在跑，终态时会结算」（`packages/protocol/src/ledger.ts:41`），重启后目标不再跑，这条永远不会自己结；一直 open 会让 S4/右栏账本永远显示「进行中」 |
| 3 | **恢复的加载策略** | A. 懒加载：启动只读 `session.json`（列表可用），选中/投喂某个会话时才读它的树与消息；B. 全量预加载：启动就把所有会话的树+消息读进内存 | **A**。B 在「几十个会话 × 每个几十个成员 × 每个几百条消息」时启动明显变慢、内存放大；而列表所需的 `usage/counts` 由 `session.json` 里的**汇总缓存**（§4.2）提供，不读树也能显示 |
| 4 | **删除会话时磁盘目录怎么处理** | A. 物理删除整个会话目录（含成员 transcript 与账本）；B. 软删（移到 `~/.axon/trash/`，可恢复） | **A**。会话目录自包含（§4.1），一次 `rm -rf` 就是完整语义；B 会引入「回收站」这个需要 UI/清理策略的新面。代价：误删不可恢复 —— 这是 M5 的已知取舍（kalo 的删除同样是物理删，且它**连子会话都不删**，`sessions_store.rs:106-121`，我们至少在这一点上比它干净） |

---

## 一、目标与范围

### 目标（一句话）

关掉应用再打开，**会话列表、每棵成员树、每份 transcript、账本、用量与状态全部回来了**，并且恢复过程本身是可解释的（被降级/被结算的东西都有留痕）。

### 做什么

- 落盘：会话元数据（`session.json`）、每个成员的 transcript（每人一个 JSONL）、会话账本切片（`ledger.jsonl`）
- 启动恢复：扫描 → 装载记录 → 懒加载会话（重建 registry 树 + 重灌引擎 + 重算用量/预算）
- 恢复语义：运行期状态（running/waiting/审批/排队/等待边）的**显式降级规则**（§4.6）
- 崩溃安全：尾部半行容忍、坏行隔离、原子写 `session.json`
- 删除/改名/升级等既有命令的落盘闭环
- 存储问题上报：坏文件不阻断启动，进 `StorageIssue` 清单（§4.8）

### 明确不做

- **不改多根注册表与会话语义**（MU-1 已定形）；M5 只做「内存 ↔ 磁盘」的映射
- **不做 compaction / 历史分页**（transcript 全量读；分页留给有真实数据之后的里程碑，S2 的「加载更早」是 MU-2 之后的事）
- **不做 fork 快照落盘**（`session.escalate` 的 `carryMessages` 只在内存语义里；不生成新文件）
- **不做会话目录的迁移/导入导出**（跨机器搬会话不在本次范围）
- **不落盘排队中的任务与等待边**（§4.6，理由：重放会重复扣费或造成假状态）
- **不动渲染层**（MU-2 的活）；只保证 IPC 数据在重启后仍然为真

---

## 二、现状盘点（「重启即失」的清单）

M5 的全部工作面就是下面这张表。左列是今天活在哪里的内存状态，右列是恢复的难点。

| 状态 | 当前位置 | 恢复难点 |
|---|---|---|
| 会话记录表 | `apps/desktop/src/main/session-store.ts:45`（Map，上限 200 `:51`，淘汰 `:107-120`） | 上限与淘汰规则是**内存时代**的产物：落盘后不该再丢用户会话（§4.5） |
| 会话记录的写点 | `host.ts` 的 create/rename/remove/escalate（`docs/milestones/MU-1-session-container.md:105`） | 写盘要收在 store 层，否则「哪些命令需要落盘」会散在 host 里 |
| 成员树（快照） | `packages/kernel/src/registry.ts:103`（`nodes: Map<AgentPath, AgentNode>`） | 可序列化（`AgentSnapshot` 是纯数据）；但 `status=running/waiting` 重启后没有真答案 |
| 派生索引：path 序号 / 会话并发上限 | `registry.ts:105,107` | **必须从落盘树重建**，否则重启后新成员会与旧路径重名 |
| 引擎实例 + transcript | `registry.ts:60-64`（`nodes[].engine`）；读取口 `host.ts:329-331` | engine 不可序列化；pi-agent-core 的 `Agent` 自身**不落盘**（见 §3.2），Axon 必须自定消息落盘格式；恢复只能靠 `EngineSpec.messages` 重灌（`packages/kernel/src/engine.ts:69,88-95`） |
| 账本 | `packages/kernel/src/ledger.ts:80-89`（含 `byToolCall`/`arbitrationSent`/`usageBaselines` 索引） | 记录形状可直落（`LedgerRecord` 已带 `version`，`packages/protocol/src/ledger.ts:64`）；索引可重建 |
| 挂起审批 | `apps/desktop/src/main/approval.ts:71`；协议 `packages/protocol/src/ipc.ts:206-228` | 重启后无人能 resolve（决策 1） |
| 排队队列 / 等待边 / idle 计时器 | `host.ts:197-207` | 运行期图，见 §4.6 的降级表 |
| 全局预算已花 | `packages/kernel/src/budget.ts:29,73`（由 root usage 灌入） | **不要单独落盘**，否则用量会有两套真相；从各会话 usage 之和重建 |
| 运行期配置 / 角色 / 团队 | `config-store.ts` / `role-loader` / `team-loader` | 已落盘，M5 不管 |

---

## 三、设计依据

### 3.1 外参 kalo：抄什么、不抄什么

kalo 的落盘**不在 Rust 层**，写侧全在内嵌的 pi fork（`kalo-harness/packages/coding-agent/src/core/session-manager.ts`，版本 0.84.1）；Rust 只做「列/改名/删/分页读」。事实与取舍：

**抄**（每条都经本轮调研核过）：

- **单文件 append-only JSONL + 首行 header 带版本**：`session-manager.ts:30-40` 的首行 `{type:'session',version:3,id,timestamp,cwd,parentSession}`，v1→v3 的读侧迁移在 `:230-296`。Axon 对应：每个文件首行 header + 自管 `storageVersion`。
- **每行基座 `{type,id,parentId,timestamp}`，append 即「挂到当前 leaf 再前移 leaf」**（`:45-50`、`:1044-1056`）：这是它的分支/回溯机制。Axon 不需要分支（会话树由 registry 表达），**但保留 `type + at` 的行基座**，用于容错与调试。
- **子会话不污染主列表**：`<桶>/subagent/<parentSessionId>/<childId>.jsonl`（`extensions/subagent/children.ts:85-88`），两个扫描器都非递归（`sessions_store.rs:44-70`、`session-manager.ts:823`）。Axon 用「一会话一目录、成员都在目录内」达成同一效果（更强：删除一次到位）。
- **子文件名不可由 id 推全名**（`children.ts:99-115`，只能按 `_<childId>.jsonl` 后缀识别）：教训 → **文件的权威身份写在 header 里，不靠文件名反推**（§4.2）。
- **恢复 = 全量重放 → 重建 messages → 作为初始 state 灌进引擎**（`agent-session-runtime.ts:256`、`agent-session.ts:1926`）。Axon 的缝正好是 `EngineSpec.messages`（`engine.ts:69`）。
- **坏行容错**：读侧 parse 失败一律 skip（`session-manager.ts:504-510`、`sessions_store.rs:97`）；Rust 改名前若文件不以 `\n` 结尾先补一行防粘行（`sessions_store.rs:190-195`）。

**不抄**：

- 「首条 assistant 才落盘」的乐观门闩（`session-manager.ts:1015-1041`）：那是给 kalo 桌面乐观行服务的；Axon 必须**发 prompt 即落盘**（用户已付 token、审批态要活过重启）。
- sidecar 进程注册表 / readiness / `switch_session`（`session.rs`）：Axon 主进程直接持有 `Agent`，不需要。
- `<enc(cwd)>` 分桶带来「跨 cwd 靠 `parentSession` 绝对路径自救」的麻烦：Axon 的会话目录自包含，cwd 只影响**桶的位置**，不影响会话内寻址（§4.1）。
- 无孤儿清理（`sessions_store.rs:106-121` 只删单个 jsonl、不删子目录）：Axon 的删除必须**整目录**。

### 3.2 pi 0.85.1 自带的落盘设施：评估结论是「不用」

pi-agent-core 0.85.1 的 harness 里有 `JsonlSessionRepo` / `StorageBackedSession`（`node_modules/@earendil-works/pi-agent-core/dist/harness/session/`）。逐条评估后**不采用**：

1. **层次错位**：pi 的 session 是 harness 工作区（多 lane/branch 的文档），Axon 的会话是多 Agent 树 + 元数据 + 账本；树的挂载点/角色/权限/状态在 pi 里无位置，只能塞 `custom` entry 或通用 value —— 等于把 Axon schema 塞进别人的容器，没省建模。
2. **元数据太薄**：`JsonlSessionMetadata` 只有 `{id, createdAt, storageVersion, cwd, path, modifiedAt, parentSessionId}`，Axon 的 title/status/团队/预算全要另存。
3. **不复用其内层存储**：真正干活的 `JsonlStorage` **不在公开导出面**（`dist/harness/session/index.d.ts:5` 的具名清单未含），深路径 import 实测 `ERR_MODULE_NOT_FOUND`。要复用就得自己实现它的公开 `Storage` 接口（11 个方法）——工作量 ≥ 自写 JSONL。
4. **版本绑定**：它的 `storageVersion` 严格相等校验（`jsonl/storage.js:128-130`），而 pi 未到 1.0（Axon 的核心风险策略就是「上游会动」，见 `engine.ts:12-22`）。把用户数据的格式押在 0.85.1 的内部格式上，是把风险 A 从代码层引到**数据层**。
5. **不用它也不损失什么**：Axon 需要的 seq/usage 记账/分支导航都不缺（账本与 registry 已有自己的实现），缺的只是「写入 + 容错」，那正是本里程碑要写的部分。
6. 官方恢复入口照用：`AgentOptions.initialState.messages`（`dist/agent.d.ts:6`，实现把 `initialState.messages` 拷进 state），Axon 侧已有 `fromMessageLike`（`engine.ts:118-120`）这把桥。

### 3.3 顺手修正两处既有引证（本轮调研实证）

| 处 | 旧写法 | 实况（0.85.1 已安装产物） |
|---|---|---|
| 「harness 22 个方法全是 `HarnessNotImplemented`」 | `docs/01:121`、`docs/02:76`、`docs/research/pi.md:17`、`packages/kernel/src/engine.ts:13` | **dist 里 `HarnessNotImplemented` 零命中**；harness runtime 已是实现（`dist/harness/runtime/lane.js` 1574 行等），唯一未实现的是 `watchSession` → `SliceNotImplemented`（`dist/harness/runtime/harness.js:229`）。风险 A 的**结论不变**（pi 未 1.0、适配器边界必须留），但论据要更新：不是「harness 空着」，而是「上游已经提供了另一条 lane-based 路径，Axon 的自建层将来要与它对照评估」 |
| 「pi 有 session store（harness/session）」 | 本轮调研的初始假设 | 对 Axon 用的**非 harness `Agent`**，pi 不提供任何会话存储（`Agent` 只透传 `sessionId`）；harness 的那套是另一条路线（§3.2 已评估）。M5 必须自建，这一条要在文档里说清 |

> 这两条只改引证与描述，**不改任何拍板结论**；建议在 M5 收尾的文档同步里一并落地（§十）。

### 3.4 MU-1 已定的布局（本里程碑的输入）

`docs/milestones/MU-1-session-container.md:218-232` 已把布局写死：

```
~/.axon/
  sessions/<enc(cwd)>/<sessionId>/
    session.json           # SessionRecord + schemaVersion
    agents/<childId>.jsonl # 每人一个 transcript（childId = path 末段）
    ledger.jsonl           # 本会话账本切片
```

`SESSION_SCHEMA_VERSION = 1`（`packages/protocol/src/session.ts:64`）与 `LEDGER_SCHEMA_VERSION = 1`（`packages/protocol/src/ledger.ts:42`）各自独立。M5 的职责是补**文件格式、写入模型、恢复语义**三件事，不是重新选址。

---
## 四、总体设计

### 4.1 落盘布局（最终版）

```
~/.axon/
  sessions/                                  # 根；AXON_SESSIONS_DIR 可覆盖（测试/冒烟/多实例）
    --Users-lucaszhou-works-prjs-axon--/     # 桶 = enc(cwd)（抄 kalo session-manager.ts:476-481）
      s7k2x-9f3a/                            # 会话目录 = 会话 id
        session.json                         # 元数据 + 汇总缓存（原子写）
        session.json.tmp-<ts>                # 原子写临时文件（写完 rename；失败则清）
        agents/
          s7k2x-9f3a.jsonl                   # 会话根的 transcript（文件名 = path 末段）
          dev-1.jsonl
          dev-2.jsonl
        .corrupt/                            # 坏文件隔离区（不自动修复、不删）
          dev-3.jsonl.2026-09-15T23-59-00
        ledger.jsonl                         # 本会话账本切片
```

规则：

- `enc(cwd)` = `'--' + cwd 去前导 / \ + 把 / \ : 换成 - + '--'`（同 kalo `session-manager.ts:476-481`）。cwd 只决定桶的位置，不参与会话内寻址。
- 文件名 = path 末段（`/s7k2x-9f3a` → `s7k2x-9f3a`；`/s7k2x-9f3a/dev-1` → `dev-1`）。**权威身份在 header 里**（§4.2 B），文件名只是索引；两者不一致时以 header 为准并记 `path-mismatch` issue。
- 删除 = 删整个 `<sessionId>/` 目录（决策 4A）。
- `.corrupt/` 存被隔离的坏文件（移动改名，不删除原文）。

### 4.2 三种文件格式

#### A. session.json（原子写；小文件）

```json
{
  "storageVersion": 1,
  "savedAt": 1758033600000,
  "record": { "id": "s7k2x-9f3a", "title": "…", "schemaVersion": 1 },
  "rollup": {
    "at": 1758033600000,
    "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 },
    "counts": { "members": 4, "running": 0, "parked": 0, "suspended": 0, "ledger": 12, "pending": 0 },
    "status": "idle",
    "interruptedAt": 1758033600000
  }
}
```

- `record` 直接复用协议类型 `SessionRecord`（含它自己的 `schemaVersion`，`packages/protocol/src/session.ts:64`），不新造影子类型。
- `rollup` 是**上次观测的汇总缓存**，供列表在懒加载下显示（决策 3A）；它不是真相——真相在 transcript 与 registry。
- `interruptedAt`：上次退出时仍有 running/waiting 成员 → 记时间戳；恢复后 UI 用它显示「本会话恢复自上次运行」（MU-2 消费）。

#### B. agents/<leaf>.jsonl（append-only，每行一个 JSON 对象）

```jsonl
{"type":"agent","storageVersion":1,"schemaVersion":1,"sessionId":"s7k2x-9f3a","path":"/s7k2x-9f3a/dev-1","parent":"/s7k2x-9f3a","role":"developer","displayName":"后端","forkMode":"none","createdAt":1758033000000}
{"type":"message","at":1758033001000,"message":{"role":"user","content":[{"type":"text","text":"…"}]}}
{"type":"state","at":1758033009000,"status":"done","usage":{"inputTokens":120,"outputTokens":340,"costUsd":0.0031},"lastError":null}
{"type":"note","at":1758033600000,"text":"应用重启：运行中被中断，已降为空闲"}
```

- 首行必须是 `agent` header；恢复时按 header 建节点（**不靠文件名反推**——kalo 的教训，`children.ts:99-115`）。
- `message` 行：每条 user / assistant / toolResult 一条，append-only。
- `state` 行：状态跃迁与用量快照（进 `done`/`failed`/`interrupted` 时必写；读侧取最后一条恢复 `usage`/`lastError`）。
- `note` 行：系统注记，**不进入模型上下文**，只在 S2 时间线显示（重启降级、孤儿修复等）。
- 容错：坏行 skip 并累计 issue；**末尾缺换行的半行整条丢弃**（进程被杀时正在写的那一行）。

#### C. ledger.jsonl（append-only，每次变更追加一条完整记录）

```jsonl
{"type":"ledger-header","storageVersion":1,"schemaVersion":1,"sessionId":"s7k2x-9f3a"}
{"type":"record","record":{"id":"l-000001-9f","version":1,"status":"open","…":"…"}}
```

- `LedgerRecord` 是可变的（settle/adopt 会改 `status`/`adoption`/`usage`/`summary`），采用**追加新版本、读侧按 id 后者覆盖前者**（last-wins）。好处：崩溃安全、不必 O(n) 重写、历史可追溯（将来想做「账本时间旅行」也有料）。
- 读侧：`Map<id, record>` 覆盖合并 → 交给 `Ledger.load(records)`（新增方法）。

### 4.3 模块布局（新增/改动）

| 文件 | 类型 | 职责 |
|---|---|---|
| `apps/desktop/src/main/session-files.ts` | 新增，纯函数（零 IO） | `enc(cwd)` 与目录/文件路径计算；三组编解码（session / transcript / ledger）；容错解析返回 `{ data, issues }` |
| `apps/desktop/src/main/session-persistence.ts` | 新增，IO 类 | `SessionPersistence`：`listRecords()` / `loadSession(id)` / `saveRecord()` / `appendTranscript()` / `appendLedger()` / `removeSession()` / `quarantine()` / `status()`；per-file 串行写队列；原子写；目录扫描 |
| `apps/desktop/src/main/session-store.ts` | 改动 | 支持注入初始记录（启动装载）；去掉 200 条淘汰（改由 `list` 的 `limit` 控制）；`create/update/remove` 触发落盘回调 |
| `apps/desktop/src/main/host.ts` | 改动 | 写点接线（create/rename/escalate/remove/消息/状态/账本）+ `ensureSessionLoaded()` + 恢复语义 + `storageStatus()` |
| `packages/kernel/src/ledger.ts` | 改动 | `load(records)` + `onChange` 回调（落盘挂点）；内存上限语义不变 |
| `packages/kernel/src/registry.ts` | 改动 | 新增 `restoreNodes(...)`：按 depth 建节点 + 重建 `counters`/`sessionLimits`；`updateIdentity` 已存在（MU-1） |
| `packages/kernel/src/engine.ts` | 改动 | 已有 `EngineSpec.messages` 与 `fromMessageLike`；若 host 侧装配重复则加一个 `createEngineFrom(messages, spec)` 便捷函数 |
| `packages/protocol/src/session.ts` | 改动 | 新增 `SESSION_STORAGE_VERSION`、`SessionRollup`、`StorageIssue`（纯类型） |
| `packages/protocol/src/ipc.ts` | 改动 | 新增 `storage.status` 命令（§4.9） |
| `apps/desktop/src/main/index.ts` | 改动 | sessions root（`AXON_SESSIONS_DIR` 覆盖）+ 启动装载 + `will-quit` 收尾 |

### 4.4 写入模型

三条原则：

1. **写入点 = 状态变更点**：不轮询；也不复用 index.ts 的 ≤4Hz 事件节流（那是给 UI 的，不是给磁盘的）。
2. **transcript 与账本走 append**（一行一次，per-file 串行队列保证不交错）；**session.json 走原子写**（tmp + rename，抄 `config-store.ts:288-293` 的既有实现）。
3. **不做 fsync**（与 kalo 一致，`session-manager.ts:1015-1041` 也无）。理由：进程崩溃由「尾部半行容忍」兜住；掉电丢尾部是可接受的损失；macOS 上每次 append 都 fsync 代价明显。**这是显式取舍，写进文档而不是默默选择**。

节流与合并：

- `session.json`：元数据变化立刻写；`rollup`（用量/计数）合并到 ≥500ms 一次（否则每轮 turn 都在写小文件）。
- transcript：每条消息写一行（一行一次 `appendFile`，已经足够便宜，不做批处理）。
- ledger：每次变更一行。

退出：`will-quit`（`apps/desktop/src/main/index.ts:467`）flush 待写的 `session.json`；transcript 与 ledger 无待写内容（每次变更已落）。

### 4.5 启动与恢复

```
启动
 ├─ 扫 ~/.axon/sessions/<桶>/<sessionId>/session.json
 │   （两层扫描；缺 session.json 的目录跳过并记 orphan-dir issue）
 ├─ SessionStore 装入全部 SessionRecord（列表立刻可用；不读树、不建引擎）
 ├─ 全局预算重建：BudgetGuard.setLimits(全局档)；已花 = 各会话 rollup.usage 之和
 └─ 完毕（此时 loadedCount = 0）

用户动作（session.get / prompt / spawn / escalate / ledger.query 带 sessionId）
 └─ ensureSessionLoaded(sessionId)
      ├─ 读 agents/*.jsonl → 解析 header + 行 → 建 registry 节点（根在前，按 depth 排序）
      ├─ 每个成员：messages = repairMessages(读到的消息) → 实例化引擎（EngineSpec.messages）
      ├─ registry 重建 counters（从 path 末段数字）与 sessionLimits（record.maxConcurrent）
      ├─ usage/状态恢复：取最后的 state 行；缺则按消息内 usage 求和
      ├─ 账本：读 ledger.jsonl → Ledger.load() → 结算 open 记录（决策 2A）→ 挂 onChange 落盘
      ├─ 运行期状态降级（§4.6）+ 写 note 行
      └─ 标记 loaded：此后该会话读写都走内存 + 落盘
```

懒加载的边界条件：

- `session.list` 永不触发加载（只用 store + rollup）。
- `session.get` 触发加载（用户点开会话）。
- `removeSession`/`renameSession` 对未加载会话直接操作磁盘（不需要加载）。
- `ledger.query({sessionId})` 触发加载（账本在内存里）。

### 4.6 恢复语义（降级表）

| 重启前 | 重启后 | 留痕 |
|---|---|---|
| agent `running` / `waiting` | `idle` | transcript 追加 `note` 行「应用重启：运行中被中断，已降为空闲」；`rollup.interruptedAt` 记录 |
| agent `suspended`（父在等后代） | `idle`，等待边全部丢弃 | 同上 |
| parked 队列 + 待投喂文本 | 丢弃 | **不落盘**：写盘会导致重启后重复投喂 = 重复扣费（kalo 的「重启不自动复活」同款取舍，docs/02 §2.3） |
| 挂起审批/提问 | 结算为 `rejected`，理由「应用重启，审批未决」 | 恢复时发一条 `pending.resolved`（与手动拒绝同形，UI 不用新代码） |
| 账本 `status:'open'` 记录 | `settle`（`summary` = 「应用重启，未及结算」） | 账本追加新版本行 |
| `failed` agent | 保持 `failed` + `lastError` | 无需 |
| `sessionTiers`（预算档位观测） | 从 usage 重算 | 无 |
| idle 计时器 / lastActivity | 重置 | 无 |

> 推论：**pending 请求本身不落盘**（重启即结算），所以磁盘上不存在「半条 pending」的持久状态。这是决策 1A 的推论，也是 §4.7 写点表里「审批 resolve 不落盘」的原因。

### 4.7 与既有模块的接线（写点清单）

| 变化点 | 现有位置 | 落盘动作 |
|---|---|---|
| 建会话 | `host.createSession` | 建目录 + 写 session.json + 各成员 transcript header |
| 改名 | `host.renameSession` | 写 session.json |
| 升级（escalate） | `host.escalateSession` | 写 session.json + 新成员 header + 原根 transcript 追加 note |
| 删会话 | `host.removeSession` | 删整目录（决策 4A） |
| 会话级预算/并发变化 | host 内（create/escalate） | 写 session.json |
| spawn | `host.spawn` | 新 transcript 文件（header 一行） |
| prompt / 消息事件 | host 的引擎事件订阅与 `emit` 分发处 | append message 行 |
| 状态跃迁 | registry 状态变更处（host 包装） | append state 行（done/failed/interrupted/waiting） |
| 账本 record/settle/adopt | host 调 `ledger.*` 的三处 | append ledger 行 |
| 审批 resolve | `host.respondApproval` | 不落盘（见 §4.6 推论） |

### 4.8 存储问题上报

```ts
export interface StorageIssue {
  kind:
    | 'corrupt-line'      // 单行解析失败（已跳过）
    | 'partial-line'      // 末尾半行（已丢弃）
    | 'missing-header'    // transcript 缺首行 agent header
    | 'version-too-new'   // storageVersion 高于本版本（拒载该文件）
    | 'path-mismatch'     // 文件名与 header.path 不一致（以 header 为准）
    | 'unreadable-dir'    // 目录/文件读失败
    | 'orphan-dir';       // 会话目录缺 session.json
  sessionId?: string;
  /** 相对 sessions root 的路径（不暴露用户绝对路径）。 */
  path: string;
  detail: string;
  at: number;
}
```

- 收集：启动扫描与懒加载都往 `SessionPersistence.issues` 追加（上限 100 条，超出丢最旧）。
- 上报：`storage.status` 命令返回（§4.9）；**不发事件**（避免渲染层对启动顺序做假设）。
- 隔离：坏文件移动到 `<sessionId>/.corrupt/<name>.<ts>`（不删原文）。

### 4.9 协议扩展（最小）

```ts
'storage.status': {
  payload: Record<string, never>;
  result: {
    root: string;             // 会话根目录（S7 与设置页「会话与账本」显示）
    sessionCount: number;
    loadedCount: number;      // 已懒加载的会话数
    issues: StorageIssue[];
  };
};
```

- 为什么需要：S7（会话恢复屏）与 S8 的「会话与账本」行（UX 03 G11.11）必须能说清「东西在哪、有没有坏文件」；也让 M7 打包期诊断有据可查。
- 不加「分页/更早消息」命令：M5 不做分页（§一 明确不做）。

---

## 五、关键流程

### 5.1 建会话（createSession）

```
host.createSession(payload)
 ├─ sessionId = newSessionId()；组装 record（含 schemaVersion）
 ├─ registry.createRoot({ sessionId, ... })（现有逻辑：三角合成 + 引擎实例化）
 ├─ persistence.createSession(record)
 │    mkdir <root>/<enc(cwd)>/<id>/agents
 │    写 session.json（原子） → 各成员写 transcript header 行
 └─ emit session.created
```

### 5.2 投喂与落盘（prompt）

```
host.prompt(path, text)
 ├─ ensureSessionLoaded(sessionId)        // 冷会话首次用到
 ├─ 用户消息进引擎 → append message 行（user）
 ├─ 引擎事件流：assistant / toolResult 每条 append 一行
 ├─ turn 结束：append state 行（status + usage）
 └─ session.changed（≤4Hz，仅 UI）
```

### 5.3 重启

见 §4.5 的图。用户可见口径：**列表秒开（只读小文件），点开哪个会话才读哪个会话的树**。

### 5.4 崩溃点分析

| 崩溃时机 | 磁盘状态 | 恢复行为 |
|---|---|---|
| 写 transcript 行中途 | 末尾缺换行的半行 | 丢弃半行，其余完好（issue: partial-line） |
| 写 session.json 中途 | 旧文件完好 + `.tmp-*` 残留 | 用旧文件；残留 tmp 在下次写入时覆盖（不读它） |
| rename 前后任一时刻 | 目录里要么旧要么新 | 两种都合法（原子写保证不出现半个） |
| 建会话目录中途 | 有目录、无 session.json | 跳过 + orphan-dir issue（**不自动删**，避免误删用户数据） |
| 删目录中途 | 部分删除 | 下次启动报 orphan-dir；用户可在 Finder 里自己清 |

---


## 六、边界情况与风险

| # | 风险 | 应对 |
|---|---|---|
| R1 | **崩溃时丢尾部**（无 fsync） | 尾部半行丢弃（§4.2 B/§5.4）；已 ack 的尾部在掉电时可丢 —— 显式接受（§4.4 第 3 条） |
| R2 | **文件损坏**（磁盘错误、外部编辑器改坏） | 逐行容错 + 隔离到 `.corrupt/` + `StorageIssue` 上报；**绝不阻断启动** |
| R3 | **cwd 桶名与目录改名**：用户重命名/移动工作目录后，桶名与实际 cwd 不再一致 | 桶名只是**分组**，会话内寻址用 header/record 里的绝对 cwd；`session.json` 的 `record.cwd` 是真相。桶不一致不报错（记 informational issue 可选）。**不做自动迁移**（§一 不做导入导出） |
| R4 | **大 transcript**：单文件几万行、启动懒加载时同步读会卡 | M5 全量读（不做分页）；但读的是**选中的那一个会话**，不是全库。若单会话超阈值（如 5MB）记 issue 但照读；分页留给后续里程碑 |
| R5 | **多进程同时开同一会话**（dev + 打包版同时跑） | 单进程假设 + 不做锁（与 pi 的 `JsonlSessionRepo` 同款：「无 lockfile，跨进程同时打开会在 commit 校验失败」是它的已知行为）。M5 记录该假设；将来要做多实例再加 lockfile |
| R6 | **磁盘满/写失败** | 写失败**不静默**：`StorageIssue` + 渲染层红条（复用 roles/teams 的 issues 通道形态）；内存状态不回滚（用户操作继续有效，只是没落盘） |
| R7 | **重启后 `running → idle` 让用户以为任务完成了** | `note` 行 + `rollup.interruptedAt` + MU-2 的「恢复自上次运行」提示三者同时给；不用 `failed`（那不是失败，是被中断） |
| R8 | **重启结算 open 账目造成「假结算」** | `summary` 明确写「应用重启，未及结算」，不与正常结算混淆（决策 2A） |
| R9 | **200 条上限与淘汰**（`session-store.ts:51,107-120`） | 落盘后**删掉淘汰**：磁盘是全量，`list` 的 `limit` 控制返回条数（缺省 50）。淘汰是内存时代的产物，留着会让用户会话「自己消失」（不可接受） |
| R10 | **版本演进**：将来改 schema | `storageVersion`（外箱：布局/文件集）与 `SESSION_SCHEMA_VERSION`（会话记录）/`LEDGER_SCHEMA_VERSION`（账本）三层各自独立；读侧遇 `version-too-new` **拒载并保留原文件**（不降级写），遇旧版本预留迁移分支（M5 只有 v1，不写假迁移代码） |
| R11 | **`.tmp-*` 残留堆积** | 写 session.json 前先清理同目录的旧 tmp（O(1) 次 `readdir` 过滤），不做全局巡检 |
| R12 | **引擎重灌后行为不一致**：repairMessages 会剥掉悬空 toolCall | 这是**有意的**：悬空 toolCall 灌回去会让模型重新调用（或 provider 报错）；`repairMessages`（`packages/kernel/src/fork.ts:74`）与 fork 路径共用同一修复，行为一致 |

---

## 七、实施计划（6 片，每片可独立验证）

| 片 | 内容 | 验证方式 |
|---|---|---|
| 1 | 协议与纯格式层：`session-files.ts`（enc/路径/三组编解码/容错解析）+ `protocol/src/session.ts` 的 `StorageIssue`/`SessionRollup`/`SESSION_STORAGE_VERSION` | `session-files.test.ts`（**零 IO**，字符串喂进喂出）：往返编码、坏行 skip、半行丢弃、缺 header、版本过新、文件名与 header 不一致 |
| 2 | IO 层：`session-persistence.ts`（扫描/装载/原子写/append 队列/隔离/status）+ 单测 | `session-persistence.test.ts`（`mkdtemp` 真盘，抄 `config-store.test.ts:14-23` 范式）：建会话落盘、载入往返、半行、坏行隔离、写失败不谎报（抄 `config-store.test.ts:255-274`）、并发 append 不交错 |
| 3 | store 接线：SessionStore 支持注入 + 去淘汰 + 落盘回调；`ledger.load()` + `onChange` | `session-store.test.ts` 增量用例；`ledger.test.ts` 的 load/onChange |
| 4 | host 写点：create/rename/escalate/remove/spawn/消息/状态/账本全部接落盘 | `host.session.test.ts` 增量：落盘断言（真盘）+ 删会话后目录消失 |
| 5 | host 恢复：`ensureSessionLoaded` + registry/引擎重建 + 恢复语义 + 结算 + `storage.status` | **重启集成测试**：真盘建会话 → `host.dispose()` → 新 host 同根 → 断言列表/树/消息/账本/用量/预算全部恢复、running→idle、审批结算、open 账目结算 |
| 6 | index.ts 接线（`AXON_SESSIONS_DIR` + 启动装载 + will-quit）+ ui-smoke 重启幕 + 文档同步 + 质量门 + commit | `bun run ui-smoke`（加一幕：删会话→目录消失；或第二次启动断言会话仍在）；`bun run dev` 手工：建会话→跑一轮→退出→重开→树/消息/账本都在 |

依赖顺序：1 → 2 → 3 → 4 → 5 → 6（每片结束时全量测试保持绿）。

---

## 八、测试策略

- **纯解析测试（零 IO）**：片 1 的全部用例都喂字符串 —— 抄 kalo 的 `session_paging.rs:224-300` 范式（纯解析器穷举：compaction/未知节点/坏行/分页边界）。
- **真盘测试**：片 2/4/5 用 `mkdtemp(join(tmpdir(),'axon-sessions-'))` + `afterEach` 清理（`config-store.test.ts:14-23` 同款）。
- **崩溃点注入**：用可注入的 IO（`team-loader.test.ts:411-436` 的 `memIO()` 形态）在第 N 次 write/rename 抛错，断言：`accepted=false` 或 issue 上报、**不产生半截 session.json**。
- **重启集成（最重要的一例）**：不 mock 文件系统，直接 dispose + 重建 host，覆盖「用户真实路径」。
- **不新建测试类型**：沿用 vitest 2.1.8；不引入 fs 模拟框架（可注入 IO 已够用）。
- **量级预估**：片 1 约 25 例，片 2 约 20 例，片 3 约 8 例，片 4 约 10 例，片 5 约 12 例 → 总测试数 429 → ~500。

---

## 九、验收标准

- [ ] 建会话（engine/team/adhoc）→ 退出应用 → 重开：会话在列表里，且树/消息/账本/用量/预算全部恢复（半自动：重启集成测试 + `bun run dev` 手工一遍）
- [ ] 重启后 `running/waiting` 成员降为 `idle` 且有 `note` 留痕；`rollup.interruptedAt` 有值
- [ ] 重启后挂起审批结算为 `rejected`（理由「应用重启，审批未决」）；账本 open 记录结算并注明
- [ ] 半行/坏行不阻断启动，隔离到 `.corrupt/`，`storage.status` 能列出
- [ ] `session.list` 不触发任何 transcript 读取（懒加载成立：可用一个只读计数断言或测试证明）
- [ ] `AXON_SESSIONS_DIR` 可覆盖根目录（测试与冒烟用临时目录，不污染用户 `~/.axon`）
- [ ] 测试总数从 429 增长（不回退），全绿
- [ ] `bun run guard / typecheck / build:desktop / verify-lazy / ui-smoke` 全绿
- [ ] 无渲染层改动（MU-2 的活）；无 pi import 扩散（仍只有三个边界文件）
- [ ] 文档同步（§十）逐条落地

---

## 十、文档同步

| 文档 | 更新内容 |
|---|---|
| `docs/01-架构决策-方案B.md` §1 进度表 | 6.6 TreePersistence 行 ⬜ → ✅（落点：`session-files.ts`/`session-persistence.ts`） |
| `docs/01` §5/§6.6 | 补「落盘布局最终版」与「不复用 pi 的 JsonlSessionRepo」的结论 |
| `docs/02` §2.4、§4 风险 A | 补 kalo 事实的两处细修（写侧在 pi fork 而非 Rust）+ **修正 `HarnessNotImplemented` 引证**（§3.3） |
| `docs/03-实施框架与里程碑.md` §1/§3 | M5 状态列 ✅ + M5 完成记录（拍板、交付、测试数、设计 vs 实测出入） |
| `docs/ux/00` §3 S7 行 + §7 | S7 从「M5 预占位」变为「数据面就绪」；注 `storage.status` 是 S7/S8 的数据源 |
| `docs/ux/02` §7 M5 行 | 「恢复单位 = Session」的建议已落地，补最终文件名与格式 |
| `docs/ux/03` §5 G11.11 | 从「全在内存」改为「落盘于 `~/.axon/sessions/`」+ `storage.status` 命令已交付 |
| `docs/milestones/MU-1-session-container.md` §十一 | M5 行从「待办」改为「已完成（M5 文档链接）」 |
| 本文件 | 状态行 + 设计 vs 实测出入小节（沿用 M3/M4/MU-1 惯例） |

---

## 十一、遗留与后续

- **分页与 compaction**：S2 的「加载更早」与长会话的上下文压缩都不在 M5；`ledger.jsonl` 的 last-wins 追加也终将需要 compaction（阈值与策略留待有真实数据后定）。
- **多实例锁**：R5 的单进程假设在多开场景会破；需要时加 lockfile。
- **会话导入/导出、跨机器迁移**：不做；`session.json` 自包含 + transcript 相对路径的设计为将来留了门。
- **S7 会话恢复屏的交互形态**（哪些会话显示「可恢复」、是否自动恢复）属 MU-2/MU-3 的 UI 决策；M5 只保证数据面（列表 + `storage.status` + `rollup.interruptedAt`）。
- **G11.11 的 UI 落地**（设置页「会话与账本」行）属 MU-3。

---

## 十二、设计 vs 实测（收口记录，2026-09-16）

设计阶段没料到、真盘上抓出来的东西（每条都有测试或冒烟检查钉住）：

1. **escalate 不重写 header ⇒ 恢复要按 record 校正根身份**。写点表（§4.4）规定升级只追加 note，磁盘上根的身份仍是 `engine`，而 `record.executor` 已是 `team/adhoc`；不校正则重启后「主控」拿着单兵工具表，编排工具全丢（`host.restart.test.ts`「重启后主控仍拿得到编排工具」钉住）。
2. **`budgetSnapshot().spentUsd` 冷启动显示 $0**。它只取 `registry.totalUsage()`，而懒加载下启动时 registry 里一个节点都没有，钱却记在种子化后的闸门里；改成 `max(registry 总用量, 种子化已花)`。
3. **`registry.sessionIdOf(path)` 在节点被摘掉后返回 `undefined`**：删成员时算不出会话 id ⇒ transcript 不删、重启后成员「复活」。落盘入口改走纯路径解析 `sessionIdOfPath`。
4. **`createSession` 要同步入队每一笔写 + rollup 粘性**：否则「建完立刻 flush」漏 `session.json`，那笔迟到的 `saveRecord`（不带 rollup）还会把汇总缓存冲掉（列表上的成员数/用量瞬间变 0）。
5. **删除/隔离也要进 `flush()` 的等待集合**（`track()` + `inflight`），否则退出时最后一笔删除会丢。
6. **退出路径不能被 flush 挂住**：`will-quit` 里 `flush()` 一旦不返回，应用就关不掉；加 3s 上限（可用性优先于最后一笔写）。
7. **冒烟基建两坑**（不是产品代码，但会让验收假红）：`node_modules/.bin/electron` 只是 cli.js 壳，只给它 SIGTERM 会留下孤儿占着调试端口 ⇒ 下一次冒烟「等不到 CDP 页面目标」；被信号杀掉的子进程 `exitCode` 恒为 `null`（信号记在 `signalCode`）⇒ 等待循环永远等不到「已退出」。
8. **懒加载判据要精确到位**：`session.list` 不触发加载只能在内核级断言（`host.restart.test.ts` 的 `loadedCount === 0`）；应用级冒烟里渲染壳冷启动会自己选中一个会话（那次 `session.get` 是「用户动作」的替身），故判据写成「已加载 ≤ 1 且列表带回落盘摘要」。

**测试规模**：M5 交付后 **515 例 / 24 文件**全绿（M4 收口 429 例 → +86）；`guard`/`typecheck`/`build:desktop`/`verify-lazy`/`ui-smoke` 全绿，冒烟新增「重启恢复」幕 6 项检查。

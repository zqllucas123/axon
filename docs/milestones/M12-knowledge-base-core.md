# M12 知识库核心：方案设计与实施计划

> 状态：**设计评审中**
> 日期：2026-10-03
> 对应架构：新增 L2 知识层（`packages/knowledge`）
> 依赖里程碑：M6（真实模型接入，OpenAI-compat 网关已通）、MU-3（UI 框架就绪）

---

## 〇、待用户拍板的决策

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| D1 | 向量数据库 | **LanceDB**（纯本地文件，零服务进程，anything-llm 实测可用） | Chroma（需服务进程）、sqlite-vss（功能较弱） |
| D2 | Embedding 端点 | **复用现有 OpenAI-compat 网关**（`~/.axon/config.json` 已有 endpoint + key），默认模型 `text-embedding-3-small` | 单独配 embedding 端点（设置里加一栏，M13 再做） |
| D3 | 知识库与会话关系 | **全局共享**：知识库不属于某个会话，会话挂载时按 ID 引用 | 每会话独立（孤立，无法复用） |
| D4 | 代码仓库摄入策略 | **逐文件扫描文本文件**（`.ts/.py/.go/.md` 等），按路径分 chunk，忽略 `node_modules`/`.git` | 依赖 tree-sitter 做语义切割（复杂度高，M12 不做） |
| D5 | M12/M13 拆分 | **M12 只做核心管道**（摄入 + 存储 + IPC 协议），**不含 Agent 工具和 UI**；M13 做 Agent 工具 `kb_search` + 知识库管理屏 | 一次全做（风险高，单里程碑太大） |

---

## 一、目标与范围

**用户可见能力**：用户可在 Axon 中新建本地知识库，将网页（HTML）、文档（DOCX、Markdown）或代码仓库导入，完成向量化索引，并通过 IPC 查询——为 M13 的 Agent 问答工具和 UI 屏铺好底层。

**M12 内做**：
- 新 `packages/knowledge` 包：摄入器（HTML/DOCX/MD/代码仓库）、文本切块器、Embedding 调用、LanceDB 向量存储、知识库 CRUD
- `packages/protocol` 扩展：`KnowledgeBase` / `KnowledgeDoc` 类型 + IPC 命令/事件
- 主进程 `knowledge-bridge.ts`：把 IPC 请求路由到 `packages/knowledge`
- 单测 + 集成测试（faux embedder，不依赖真实 API）

**M12 明确不做**：
- Agent 工具 `kb_search`（M13）
- 知识库管理 UI 屏（M13）
- 全文检索（只做向量检索）
- PDF 支持（anything-llm 的 `asPDF` 依赖较重，后续里程碑加）
- 增量更新 / 重新索引（首版全量重建）

---

## 二、现状盘点

| 组件 | 当前状态 | M12 所需 |
|---|---|---|
| `packages/kernel` | AxonEngine / Registry / Budget | 只读依赖，不改动 |
| `packages/protocol` | `ipc.ts` / `session.ts` 等 | 新增 `knowledge.ts` + 扩展 `ipc.ts` |
| `apps/desktop/src/main/config-store.ts` | 存 endpoint / apiKey，已脱敏读取 | 读 embedding 端点配置 |
| `apps/desktop/src/main/index.ts` | 装配所有 bridge | 新增 `knowledge-bridge` 装配 |
| anything-llm（只读参考） | `collector/`（摄入）+ `server/utils/TextSplitter/`（切块）+ `server/utils/vectorDbProviders/lance/`（LanceDB） | 移植 TextSplitter 逻辑（TS）、摄入器结构、LanceDB 连接模式 |

---

## 三、设计依据

**LanceDB 选型依据**：anything-llm `server/utils/vectorDbProviders/lance/index.js:1-10` 展示了完整的连接-建表-向量搜索模式；`@lancedb/lancedb` 是纯 Node.js 包（`.node` native addon），在 Electron 主进程中与 pi-agent-core 一样走 ESM external 模式，不会被 esbuild 打包（保险丝 B 继续有效）。数据目录放 `~/.axon/knowledge/lancedb/`，与会话目录并列。

**TextSplitter 移植依据**：anything-llm `server/utils/TextSplitter/index.js:1-60` 是框架无关的纯函数，输入 `pageContent: string`，输出 `{pageContent, metadata}[]`。依赖 `@langchain/textsplitters`（Apache-2.0），M12 引入此包。

**Embedding 端点复用依据**：`apps/desktop/src/main/config-store.ts` 已有 `endpoint`、`apiKey`、`defaultModel` 三字段，`config.get` 通过 IPC 可读取脱敏版本，主进程侧可直接拿明文用于 HTTP 调用。OpenAI `/v1/embeddings` 接口是行业标准，Kotei 网关已兼容。

**文件解析依据**：anything-llm `collector/processSingleFile/convert/asDocx.js` 用 `mammoth`（MIT）将 DOCX 转纯文本，无副依赖；`asTxt.js` 直接读 UTF-8；HTML 页面用 `cheerio` 提取 `body` 文本，过滤 `<script>`/`<style>`。这三个解析器是轻量独立函数，可直接移植为 TypeScript。

**知识库全局共享依据**：设计隐喻是「AI 时代的笔记本」——用户期望同一份知识库可被不同会话的 Agent 调用，与会话生命周期解耦。类比 Axon 的 Team 档案：团队也是全局定义、按会话实例化。

---

## 四、总体设计

### 4.1 包结构

```
packages/knowledge/
  src/
    chunker.ts          # TextSplitter 移植（@langchain/textsplitters）
    embedder.ts         # Embedder 接口 + OpenAICompatEmbedder 实现
    store.ts            # LanceDB 封装（KnowledgeStore）
    kb.ts               # KnowledgeBase 元数据 CRUD（JSON 文件）
    ingest/
      html.ts           # HTML → 纯文本（cheerio）
      docx.ts           # DOCX → 纯文本（mammoth）
      md.ts             # Markdown → 纯文本（strip-markdown）
      repo.ts           # 代码仓库 → 逐文件文本
      index.ts          # ingest(source) 分发器
    index.ts            # 公开 API：KnowledgeManager
  package.json          # esm, type:module, bun workspace
```

### 4.2 数据模型

```typescript
// packages/protocol/src/knowledge.ts

/** 知识库元数据，存 ~/.axon/knowledge/<kbId>/meta.json */
interface KnowledgeBase {
  id: string;           // uuid
  name: string;
  description: string;
  createdAt: string;    // ISO 8601
  updatedAt: string;
  docCount: number;
  chunkCount: number;
  embeddingModel: string;  // 摄入时记录，查询时需一致
}

/** 已摄入的来源文档（不存原始内容，只存元数据） */
interface KnowledgeDoc {
  id: string;           // uuid
  kbId: string;
  sourceType: 'html' | 'docx' | 'md' | 'repo';
  sourceRef: string;    // URL 或绝对路径
  title: string;
  chunkCount: number;
  indexedAt: string;
}

/** 向量检索结果 */
interface KnowledgeChunk {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;        // cosine similarity [0,1]
  sourceRef: string;
  title: string;
}
```

LanceDB 表 schema（每个 kb 一张表，表名 = `kb_<kbId>`）：
```
chunkId: string, docId: string, kbId: string,
content: string, sourceRef: string, title: string,
vector: Float32Array(1536)   // text-embedding-3-small 维度
```

### 4.3 IPC 协议扩展

新增命令（加入 `packages/protocol/src/ipc.ts` 的 `CommandMap`）：

| 命令 | 参数 | 返回 |
|---|---|---|
| `kb.list` | — | `KnowledgeBase[]` |
| `kb.create` | `{name, description}` | `KnowledgeBase` |
| `kb.delete` | `{kbId}` | `void` |
| `kb.getStats` | `{kbId}` | `{docCount, chunkCount, embeddingModel}` |
| `kb.addSource` | `{kbId, sourceType, sourceRef}` | `{jobId}` |
| `kb.removeDoc` | `{kbId, docId}` | `void` |
| `kb.query` | `{kbId, query, topK?}` | `KnowledgeChunk[]` |
| `kb.listDocs` | `{kbId}` | `KnowledgeDoc[]` |

新增事件（主进程 → 渲染）：

| 事件 | payload |
|---|---|
| `kb.indexing.progress` | `{kbId, jobId, sourceRef, processed, total}` |
| `kb.indexing.done` | `{kbId, jobId, docId, chunkCount}` |
| `kb.indexing.error` | `{kbId, jobId, sourceRef, error}` |

### 4.4 装配关系

```
Renderer → IPC → knowledge-bridge.ts → KnowledgeManager
                                          ├── KnowledgeBase CRUD (JSON 文件)
                                          ├── Ingest pipeline
                                          │     ├── ingest/html|docx|md|repo.ts
                                          │     ├── chunker.ts
                                          │     ├── embedder.ts → OpenAI-compat HTTP
                                          │     └── store.ts → LanceDB
                                          └── kb.query → store.ts → LanceDB
```

esbuild external 白名单需追加：`@lancedb/lancedb`、`mammoth`、`cheerio`（与 pi 包同理，走 ESM external）。`scripts/check-bun-only.mjs` 的 pi-import 白名单不需改动（knowledge 包不 import pi）。

---

## 五、关键流程

### 5.1 摄入流程（`kb.addSource`）

```
bridge.addSource(kbId, sourceType, sourceRef)
  → ingest(sourceType, sourceRef)     # 返回 {title, pageContent}[]（每页/每文件一项）
  → for each page:
      chunks = chunker.split(pageContent, {chunkSize:800, chunkOverlap:100})
      vectors = await embedder.embed(chunks.map(c => c.text))   # 批量，最多 512/批
      store.upsert(kbId, chunks, vectors, {docId, title, sourceRef})
  → kb.updateDocMeta(kbId, docId, {chunkCount, indexedAt})
  → emit kb.indexing.done
```

索引任务在主进程异步跑，不阻塞 IPC 响应。`jobId` 用于进度事件关联。

### 5.2 查询流程（`kb.query`）

```
bridge.query(kbId, query, topK=5)
  → queryVector = await embedder.embed([query])
  → chunks = store.search(kbId, queryVector, topK)   # LanceDB cosine search
  → return chunks.map(c => ({...c, score: distanceToSimilarity(c._distance)}))
```

---

## 六、边界情况与风险

| 风险 | 应对 |
|---|---|
| Embedding 网关不支持 `/v1/embeddings` | `kb.addSource` 返回明确错误；UI（M13）提示用户检查配置 |
| DOCX/HTML 解析失败 | ingest 层 try/catch，emit `kb.indexing.error`，不中断其他文档 |
| LanceDB native addon 与 Electron 版本不兼容 | M12 第一步即验证（`bun add @lancedb/lancedb` + 主进程 import 测试），不通则换 sqlite-vss 方案 |
| 大仓库摄入时间过长（内存） | 每 50 文件 flush 一次，流式处理，不在内存堆积全部 chunk |
| `esbuild external` 遗漏导致 lancedb 被打包 | `bun run verify-lazy` 的负向测试会捕获（如 M1 风险 B 那样） |
| 知识库被删除但 LanceDB 表未清理 | `kb.delete` 先删 LanceDB 表再删元数据文件，保证原子性（用临时 `.deleting` 标记） |

---

## 七、实施计划

每步末尾标注「验证方式」。

**切片 1 — LanceDB 可行性验证（1 天）**
- `bun add @lancedb/lancedb` 加入 `packages/knowledge`
- 写一个最小 smoke test：在主进程（`bun --conditions electron` 或直接 `bun test`）中连接 LanceDB、插入 3 条向量、搜索取回
- 同时验证 esbuild external 生效：`bun run build:desktop && bun run verify-lazy`
- **验证**：smoke test 通过且 verify-lazy 不报错

**切片 2 — 协议定义（半天）**
- 新建 `packages/protocol/src/knowledge.ts`（类型定义）
- 扩展 `packages/protocol/src/ipc.ts`（8 命令 + 3 事件）
- `bun run typecheck` 绿
- **验证**：typecheck 通过，协议模块可被 `@axon/protocol` import

**切片 3 — chunker + embedder（1 天）**
- `bun add @langchain/textsplitters` 加入 `packages/knowledge`
- 移植 TextSplitter 为 `chunker.ts`（TS，接口：`split(text, config): Chunk[]`）
- `embedder.ts`：`Embedder` 接口 + `OpenAICompatEmbedder`（读 config-store 的 endpoint/apiKey）
- faux embedder：`FauxEmbedder` 返回随机 Float32Array，用于测试
- 单测：分块边界、overlap、批次切分
- **验证**：`bun run test` 新增 ≥15 例

**切片 4 — KnowledgeStore（LanceDB 封装）（1 天）**
- `store.ts`：`createTable` / `upsertChunks` / `search` / `deleteTable` / `tableExists`
- `distanceToSimilarity` 与 anything-llm lance/index.js:45-53 同逻辑
- 集成测试：用 FauxEmbedder + 本地临时目录，insert→search→delete 全链路
- **验证**：集成测试通过，临时目录清理干净

**切片 5 — 摄入器（2 天）**
- `bun add cheerio mammoth strip-markdown`
- `ingest/md.ts`：strip-markdown 去掉 markdown 语法，保留纯文本
- `ingest/html.ts`：cheerio 提取 `body`，去 `<script>/<style>/<nav>/<footer>`
- `ingest/docx.ts`：mammoth.extractRawText，返回 `{title, pageContent}`
- `ingest/repo.ts`：递归扫指定目录，白名单扩展名（`.ts/.tsx/.js/.py/.go/.rs/.java/.md/.txt`），每文件一个 `pageContent`，忽略 `node_modules/.git/dist/build`
- `ingest/index.ts`：按 sourceType 分发
- 单测：各格式 fixture 文件（放 `packages/knowledge/__tests__/fixtures/`）
- **验证**：各摄入器单测通过，repo 摄入器正确忽略 node_modules

**切片 6 — KnowledgeBase CRUD + KnowledgeManager（1 天）**
- `kb.ts`：JSON 元数据 CRUD（`~/.axon/knowledge/<kbId>/meta.json` + `docs.json`）
- `KnowledgeManager`：`create/list/delete/addSource/removeDoc/query`
- `addSource` 内异步摄入管道，emit 进度事件
- `kb.delete` 的原子清理逻辑（先 lancedb 表，再文件）
- **验证**：`bun run test` 新增 ≥20 例（含 addSource 全链路，用 FauxEmbedder）

**切片 7 — 主进程装配（半天）**
- 新建 `apps/desktop/src/main/knowledge-bridge.ts`
- 在 `index.ts` 中注册 8 条 IPC 命令 handler
- esbuild config 追加 `@lancedb/lancedb`、`mammoth`、`cheerio` 到 external 白名单
- **验证**：`bun run build:desktop && bun run verify-lazy` 全绿

**切片 8 — 测试补全与质量门（1 天）**
- 补齐 guard / typecheck / test / build / verify-lazy
- 手工演示：`bun run dev`，打开 DevTools 控制台，执行 `ipcRenderer.invoke('kb.create', {name:'test'})` 等几条命令确认端到端通
- 此里程碑无 ui-smoke 新幕（UI 在 M13），但现有 41 条断言不能回退
- **验证**：质量门全绿

---

## 八、测试策略

- **单测**（`packages/knowledge/__tests__/`）：chunker 分块逻辑、各摄入器解析输出、KnowledgeBase 元数据 CRUD、store distanceToSimilarity
- **集成测试**：FauxEmbedder + 临时 LanceDB 目录，覆盖 addSource→query 全链路（HTML/DOCX/MD/repo 各一个 fixture）
- **契约测试**：`knowledge-bridge` 的 IPC handler 与 protocol 类型对齐（类型层保证，不额外写）
- **不在 M12 测试**：真实 embedding API 调用（网络依赖，留手工验收）

---

## 九、验收标准

- [ ] `bun run guard` 绿（pi-import 白名单未被破坏）
- [ ] `bun run typecheck` 绿（root + renderer 双 tsc）
- [ ] `bun run test` 全绿，新增 ≥40 例，总数 ≥568（当前 528）
- [ ] `bun run build:desktop && bun run verify-lazy` 绿（lancedb/mammoth/cheerio 均 external）
- [ ] `bun run ui-smoke` 全绿，现有 41 条断言不回退
- [ ] 手工演示：DevTools 中 `kb.create → kb.addSource(md文件) → kb.query` 返回有意义结果
- [ ] `~/.axon/knowledge/` 目录布局符合设计（`<kbId>/meta.json`，`lancedb/` 同级）
- [ ] `kb.delete` 后 LanceDB 表和元数据文件均被清除

---

## 十、文档同步

完工后更新：
- `docs/03-实施框架与里程碑.md` §1 表格：M12 加行，状态 ✅
- `docs/01-架构决策-方案B.md` §1 进度表：新增 `packages/knowledge` 行
- 本文件状态行改为「已完成」

---

## 附：anything-llm 可复用清单

| anything-llm 源文件 | 复用方式 | 许可 |
|---|---|---|
| `server/utils/TextSplitter/index.js` | 移植为 `chunker.ts`，保留配置接口，改 TS | MIT |
| `server/utils/vectorDbProviders/lance/index.js` | `distanceToSimilarity` 逻辑原样移植；`connect/search/upsert` 模式参考，重写为 TS | MIT |
| `collector/processSingleFile/convert/asDocx.js` | 用 mammoth 的方式（`mammoth.extractRawText`）参考 | MIT |
| `collector/processLink/index.js` | HTML scrape 策略参考（cheerio 提取 body 文本） | MIT |

**不复用**：Express server 架构、Prisma 模型、auth 层、collector hotdir 机制——这些都是服务端概念，Axon 在 Electron 主进程中直接调用。

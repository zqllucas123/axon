# M14 kb_search Agent 工具：方案设计与实施计划

> 状态：**已完成（2026-10-04）**
> 依赖里程碑：M12（知识库核心管道）、M13（S4 管理屏 + KnowledgeBridge）

---

## 一、目标

让 Agent 在对话执行任务时，能够主动调用 `kb_search` / `kb_list` 工具检索本地知识库，
把相关内容片段作为上下文喂给自己。

---

## 二、架构决策

**工具注入时机**：`AxonHost.tools` 是 `readonly`，只能在 `new AxonHost(options)` 时传入。
因此需要在 `createHost` 之前创建 `KnowledgeManager`，把工具生成后随 `tools` 选项一起传进去。

这要求把 `KnowledgeManager` 的创建从 `KnowledgeBridge` 构造函数里提出来，
改为由 `index.ts` 提前创建后分别传给 `createHost` 和 `KnowledgeBridge`。

---

## 三、交付清单

| 文件 | 变更内容 |
|---|---|
| `packages/knowledge/src/manager.ts` | 新增 `setCallbacks()` 方法，让进度回调可在构造后绑定 |
| `apps/desktop/src/main/kb-tools.ts` | 新文件：`createKbSearchTool`、`createKbListTool`、`KB_TOOL_NAMES` |
| `apps/desktop/src/main/knowledge-bridge.ts` | 重构：`KnowledgeManager` 改为外部传入；新增 `makeKnowledgeManager` 工厂函数 |
| `apps/desktop/src/main/roles.ts` | `withOrchestration` 追加 `KB_TOOL_NAMES`，所有内置角色都获得 kb 工具 |
| `apps/desktop/src/main/index.ts` | `createHost` 接受可选 `kbManager`；在调 `createHost` 前创建 manager；kb 工具随 `tools` 选项注入 |

---

## 四、质量门结果

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | ✅（M14 新增代码零错误） |
| `bun run test` | ✅ 671 例全绿 |
| `bun run build:desktop` | ✅ |
| `bun run verify-lazy` | ✅ |

---

## 五、Agent 使用方式

Agent 在角色白名单里有 `kb_list` / `kb_search` 时，可以这样使用：

```
1. 调用 kb_list 获取可用知识库列表和 ID
2. 调用 kb_search(kb_id=<id>, query=<问题>, top_k=5) 获取相关内容
3. 把返回的内容片段作为背景知识，结合任务输出结论
```

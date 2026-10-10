# M13 S4 知识库管理屏 + 主进程 KnowledgeBridge：方案设计与实施计划

> 状态：**已完成（2026-10-04）**
> 依赖里程碑：M12（本地知识库核心管道）
> 标题修订（2026-10-10）：原标题写作「知识库 Agent 工具 + S4 管理屏」，但 §一「明确不做」里
> 把 `kb_search` Agent 工具明确推给了下一个里程碑，实际由 **M14** 交付 —— 标题随之改正。

---

## 一、目标与范围

**用户可见能力**：
1. 侧边栏新增「知识库」入口（S4 屏），用户可在此新建知识库、添加网页/文档/代码仓库来源、查看摄入进度、测试搜索、删除文档或整个知识库。
2. 主进程注册 `KnowledgeBridge`，完成 kb.* IPC 命令的主进程侧装配；配置有 `provider.baseUrl` 和 `provider.apiKey` 时自动启用，否则降级为返回空结果的 stub（冒烟安全）。

**本里程碑内做：**
- `Screen` 类型加 `'s4'`；侧边栏 NAV 加「知识库」入口（`book` 图标）
- `S4Knowledge.tsx`：知识库列表、详情、添加来源、搜索测试完整 UI
- `store.tsx`：`kbs`/`kbJobs` state + kb.* 事件订阅 + kb 意图（createKb/deleteKb/addKbSource/removeKbDoc/queryKb/listKbDocs）
- `Shell.tsx`：加 `'s4'` 路由
- `main/index.ts`：导入并注册 `KnowledgeBridge`，未配置时注册空 stub
- `screens.css`：S4 样式（知识库卡片网格、摄入进度条、文档列表、搜索区）

**明确不做：**
- Agent 工具 `kb_search`（IPC 层已通，Agent 工具扩展留下一个里程碑）
- 知识库与会话的显式关联入口（M14+）
- 重新索引 / 增量更新（全量重建，M12 定策）

---

## 二、交付清单

| 文件 | 变更内容 |
|---|---|
| `packages/protocol/src/ipc.ts` | CommandMap 8 条 kb.* + EventMap 3 条 kb.indexing.* |
| `apps/desktop/src/renderer/state/types.ts` | Screen 加 `'s4'` |
| `apps/desktop/src/renderer/state/store.tsx` | kbs/kbJobs state + 事件订阅 + 意图 + value 返回 |
| `apps/desktop/src/renderer/components/Sidebar.tsx` | NAV 加知识库入口 |
| `apps/desktop/src/renderer/components/Shell.tsx` | 导入 S4Knowledge + 路由 |
| `apps/desktop/src/renderer/components/S4Knowledge.tsx` | 新建知识库管理屏 |
| `apps/desktop/src/renderer/styles/screens.css` | S4 样式 |
| `apps/desktop/src/main/index.ts` | 导入 KnowledgeBridge + 注册 |

---

## 三、质量门结果

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | ✅（M13 新增代码零错误） |
| `bun run test` | ✅ 671 例全绿 |
| `bun run build:desktop` | ✅ |
| `bun run verify-lazy` | ✅ |
| pre-existing 问题 | `config-store.ts:128`、`index.ts:274` 两处 pre-existing 类型错误，与本次无关 |

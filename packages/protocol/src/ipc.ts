/**
 * 渲染进程 ↔ 内核 的通信契约。
 *
 * 设计原则：渲染进程只发**意图**，不持有 Agent 实例，也不做任何编排决策。
 * 所有状态的唯一真相在 kernel 侧，UI 通过事件流被动同步。
 * 这样 kernel 换宿主（CLI / 测试 / 未来的 server）时，UI 契约不用动。
 */

import type {
  AgentPath,
  AgentSnapshot,
  AgentStatus,
  ApprovalMode,
  AxonThinkingLevel,
  ForkModeSpec,
  MessageLike,
  RoleDefinition,
  RoleEntry,
  RoleIssue,
  UsageTotals,
} from './agent.ts';
import type { AgentToolsSnapshot } from './agent-tools.ts';
import type { ConfigIssue, ConfigPatch, ConfigSnapshot } from './config.ts';
import type {
  AddSourcePayload,
  IndexingDonePayload,
  IndexingErrorPayload,
  IndexingProgressPayload,
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeDoc,
} from './knowledge.ts';
import type { ProjectIssue, ProjectKind, ProjectRecord } from './project.ts';
import type {
  Adoption,
  AdoptionPolicy,
  LedgerQuery,
  LedgerQueryResult,
  LedgerRecord,
} from './ledger.ts';
import type {
  CreateSessionPayload,
  EscalateSessionPayload,
  SessionDetail,
  SessionListQuery,
  SessionSummary,
  StorageIssue,
} from './session.ts';
import type { TeamDefinition, TeamEntry, TeamIssue } from './team.ts';

// ─────────────────────────────────────────────────────────────
// 信封
// ─────────────────────────────────────────────────────────────

export interface RequestEnvelope<C extends keyof CommandMap = keyof CommandMap> {
  id: string;
  command: C;
  payload: CommandMap[C]['payload'];
}

export interface ProtocolError {
  code: string;
  message: string;
  detail?: unknown;
}

export type ResponseEnvelope<C extends keyof CommandMap = keyof CommandMap> =
  | { id: string; ok: true; result: CommandMap[C]['result'] }
  | { id: string; ok: false; error: ProtocolError };

export interface NotificationEnvelope<E extends keyof EventMap = keyof EventMap> {
  event: E;
  payload: EventMap[E];
  /**
   * 事件来自哪个 agent；UI 据此把事件路由到树上的节点。
   *
   * MU-1 起改为**可选**：会话/团队/配置级事件（`session.created`、`teams.changed`、
   * `config.changed`）没有单一 agent 源，硬塞一个只会逼实现编个假路径出来。
   */
  source?: AgentPath;
  /** 事件所属会话；会话内的事件必有，全局事件没有。 */
  sessionId?: string;
  at: number;
}

// ─────────────────────────────────────────────────────────────
// 命令（渲染 → 内核，有应答）
// ─────────────────────────────────────────────────────────────

export interface SpawnAgentPayload {
  role: string;
  /** 父 Agent 路径。MU-1 起父子树以会话为根，缺省值交给宿主按会话选。 */
  parent?: AgentPath;
  /**
   * 归属会话。只缺 parent 时用它定位会话根（`/<sessionId>`）。
   *
   * 两个都给也可以，但两者必须同属一个会话（宿主体检查），否则会造出
   * 跨树的孤儿节点 —— 那会让「按会话切片」全部失真。
   */
  sessionId?: string;
  /** 覆盖角色默认的分身模式。 */
  forkMode?: ForkModeSpec;
  /**
   * 一次性覆写，不落盘。
   *
   * MU-1 起带上 `tools`/`approval`：团队成员计划（session-instantiate）把
   * 「引用角色 + 本队覆写」预合成后再交到这里。**覆写只减不增** 的守门人
   * 在宿主（host.spawn），不在调用方 —— 这里只是传声筒。
   */
  overrides?: Partial<
    Pick<RoleDefinition, 'displayName' | 'instructions' | 'model' | 'tools' | 'approval'>
  >;
  /** 创建后立即投喂的首条任务。 */
  initialPrompt?: string;
}

export interface CommandMap {
  /**
   * 存储实况（M5 §4.9）：根目录 / 会话数 / 已懒加载数 / issue 清单。
   *
   * 为什么单独一条命令：S7 恢复屏与 S8「会话与账本」要能说清「东西在哪、
   * 有没有坏文件」；**不发事件**（渲染层不该对启动顺序做假设）。
   */
  'storage.status': {
    payload: Record<string, never>;
    result: {
      root: string;
      sessionCount: number;
      loadedCount: number;
      issues: StorageIssue[];
    };
  };
  'agent.spawn': { payload: SpawnAgentPayload; result: AgentSnapshot };
  'agent.list': { payload: Record<string, never>; result: AgentSnapshot[] };
  'agent.get': { payload: { path: AgentPath }; result: AgentSnapshot | null };
  'agent.messages': { payload: { path: AgentPath }; result: MessageLike[] };
  'agent.prompt': { payload: { path: AgentPath; text: string }; result: { accepted: true } };
  'agent.interrupt': { payload: { path: AgentPath }; result: { accepted: true } };
  /**
   * 运行时切换该 Agent 后续轮次的模型 / 推理深度（会话输入区选择器）。
   *
   * 两个字段都可选：只换模型、只换档位、或都换。作用于内存中的活引擎
   * （pi 的 `state.model` / `state.thinkingLevel` 皆「for future turns」），
   * 不改角色档、不持久化 —— 重启后引擎按角色/默认模型重建。
   */
  'agent.setModel': {
    payload: { path: AgentPath; model?: string; thinkingLevel?: AxonThinkingLevel };
    result: { accepted: true };
  };
  /** 级联删除整棵子树。 */
  'agent.remove': { payload: { path: AgentPath }; result: { removed: AgentPath[] } };

  'role.list': {
    payload: Record<string, never>;
    result: { entries: RoleEntry[]; issues: RoleIssue[] };
  };
  /** 创建或覆盖同名用户角色；校验失败时 accepted=false 且带 errors。 */
  'role.save': {
    payload: { role: RoleDefinition };
    result: { accepted: boolean; errors: RoleIssue[] };
  };
  /** 删除用户角色文件；不存在视为已删除（幂等）。 */
  'role.delete': { payload: { name: string }; result: { deleted: boolean; errors: RoleIssue[] } };

  /** 回应内核发起的审批请求。 */
  'approval.respond': {
    payload: { requestId: string; approved: boolean; note?: string };
    result: { accepted: true };
  };
  /** 回应内核发起的提问（Axon5 人机交互用）。 */
  'question.respond': {
    payload: { requestId: string; answer: string };
    result: { accepted: true };
  };
  /** 重连后拉取尚未回应的挂起请求，避免 UI 刷新丢失待办。 */
  'pending.list': { payload: Record<string, never>; result: PendingRequest[] };

  /** 查询协作账本；过滤条件见 LedgerQuery。 */
  'ledger.query': { payload: LedgerQuery; result: LedgerQueryResult };
  'ledger.get': { payload: { id: string }; result: LedgerRecord | null };
  /** 人工裁决一笔协作产出。 */
  'ledger.adopt': {
    payload: { id: string; adoption: Adoption; note?: string };
    result: { record: LedgerRecord };
  };
  'ledger.getAdoptionPolicy': { payload: Record<string, never>; result: AdoptionPolicy };
  /** 切换裁决策略（人工 / 委派给指定 Agent）。 */
  'ledger.setAdoptionPolicy': {
    payload: { policy: AdoptionPolicy };
    result: { policy: AdoptionPolicy };
  };

  /** 拉当前预算档位；frozen 是终态，没有查询通道 UI 刷新后就瞎了。 */
  'budget.get': { payload: Record<string, never>; result: BudgetSnapshot };

  // ─ MU-1：会话（一等公民，UX 02 §2.2）──

  /** 建会话并按执行方式实例化（engine 只建根 / team 按编队 / adhoc 现挑）。 */
  'session.create': { payload: CreateSessionPayload; result: SessionSummary };
  /** 会话详情：摘要 + 本会话成员树（S2 右栏顶部面板、S5 deep link 的数据源）。 */
  'session.get': { payload: { sessionId: string }; result: SessionDetail | null };
  'session.list': { payload: SessionListQuery; result: SessionSummary[] };
  /** 单兵 → 团队的升级（「叫人」）；已产生的消息不丢。 */
  'session.escalate': { payload: EscalateSessionPayload; result: SessionDetail };
  'session.rename': { payload: { sessionId: string; title: string }; result: SessionSummary };
  /** 删会话 = 级联删整棵树 + 清理账本切片/挂起/队列。 */
  'session.remove': { payload: { sessionId: string }; result: { removedPaths: AgentPath[] } };

  // ── M10：子任务 session 查询 ──

  /**
   * 列出某主管 session 派生的全部子 session。
   * 用于 S2 透明化面板（主管视角）。
   */
  'subsession.list': {
    payload: { parentSessionId: string };
    result: SessionSummary[];
  };

  // ── MU-1：团队（S3 团队管理）──

  'team.list': {
    payload: Record<string, never>;
    result: { entries: TeamEntry[]; issues: TeamIssue[] };
  };
  /** 创建或覆盖同名用户团队；校验失败时 accepted=false 且带 errors。 */
  'team.save': {
    payload: { team: TeamDefinition };
    result: { accepted: boolean; errors: TeamIssue[] };
  };
  'team.delete': { payload: { name: string }; result: { deleted: boolean; errors: TeamIssue[] } };

  // ── 项目（左栏「项目」模块）──

  /** 项目列表（零会话项目也在内）+ 加载期问题（坏文件等）。 */
  'project.list': {
    payload: Record<string, never>;
    result: { entries: ProjectRecord[]; issues: ProjectIssue[] };
  };
  /**
   * 创建项目（仅项目元数据，不隐式建会话）；校验失败 accepted=false 带 errors。
   *
   * `kind` 缺省 `'local'`。选 `'git'` 时主进程会校验目录内已有 `.git`，
   * 否则拒绝创建（不替用户跑 `git init` —— 不在别人目录里静默产生副作用）。
   */
  'project.create': {
    payload: { name: string; cwd: string; kind?: ProjectKind };
    result: { accepted: boolean; errors: ProjectIssue[]; project?: ProjectRecord };
  };
  /**
   * 打开原生目录选择器选工作空间。渲染进程零 Node，不能自己弹 dialog；
   * cancelled=true 表示用户取消（此时 path 缺省，UI 不应改写输入）。
   *
   * 两个入口共用：新建项目挑目录，以及**新建会话时挑这次的工作目录**。
   * 主进程会把返回的路径记进「可信路径集合」，之后才能被 `workspace.inspect` 查。
   */
  'project.pickWorkspace': {
    payload: Record<string, never>;
    result: { cancelled: boolean; path?: string };
  };

  /**
   * 打开原生文件选择器，供用户挑选要放入会话工作目录的附件。
   *
   * 与 `project.pickWorkspace` 同一原则：渲染进程零 Node，系统对话框只能在主进程弹。
   * 返回用户选中的文件绝对路径列表（取消时为空数组）。
   * 主进程把路径原样回传给渲染层；复制动作在 `session.create` 时集中处理，
   * 不在这一步做 —— 选文件与建会话是两个独立意图。
   */
  'shell.pickFiles': {
    payload: Record<string, never>;
    result: { paths: string[] };
  };

  // ── 工作区元信息（新建会话页的工作区 chip）──

  /**
   * 分配一个**本次运行期专属**的临时工作目录，作普通会话（不归属项目）的默认工作区。
   *
   * 为什么是主进程分配而不是渲染层拼路径：渲染进程零 Node，没有 tmpdir 概念；
   * 而且这个目录要登进「可信路径集合」并被退出清理，必须由主进程持有。
   * 目录名形如 `axon-a1b2c3`，会话之间的产物互不干扰。
   */
  'workspace.newTemp': {
    payload: Record<string, never>;
    result: { path: string; folderName: string };
  };
  /**
   * 取一个工作区的展示元信息：文件夹名 + git 分支。
   *
   * **path 不是任意路径**：渲染层零 Node，这条命令若接受任意路径就等于把文件系统
   * 探测能力交给界面层。主进程只认「可信路径集合」里的四类：项目 cwd、
   * `config.defaultCwd`、`pickWorkspace` 返回过的、本运行期分配的临时目录；
   * 不在集合内直接抛错。
   *
   * 不在 git 仓库时 `branch` 为 null、`isGit` 为 false，调用方自行决定是否展示。
   */
  'workspace.inspect': {
    payload: { path: string };
    result: { path: string; folderName: string; branch: string | null; isGit: boolean };
  };

  // ── MU-1：配置（S8 设置窗）──

  'config.get': { payload: Record<string, never>; result: ConfigSnapshot };
  /**
   * 改配置。与 role.save / team.save 同构：**校验失败不落盘**，
   * 返回 issues 让 UI 逐字段标红，而不是抛错让人去猜哪个字段坏了。
   */
  'config.patch': {
    payload: { patch: ConfigPatch };
    result: { accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot };
  };
  /**
   * 恢复出厂（S8 危险区）：把白名单内的字段删回缺省，**未知键原样保留**。
   * 不等价于「逐个 `config.patch` 置 null」：那条路会被 env-locked 挡住（见 config-store.reset）。
   */
  'config.reset': {
    payload: Record<string, never>;
    result: { accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot };
  };

  // ── MU-3：外壳类（系统文件管理器 / 窗口）──

  /**
   * 用系统文件管理器打开一个「已知位置」。
   *
   * 为什么是枚举而不是路径字符串：渲染进程零 Node，它**不应该能指定任意路径让
   * 主进程去 open** —— 那等于把 `shell.openPath` 整个暴露给界面层。枚举把可达集
   * 锁在主进程内（MU-3 E-3；前身是 MU-1/M2 的 `role.openDir`/`team.openDir`）。
   * `config` 是单文件，用 `showItemInFolder` reveal；其余三个是目录。
   */
  'shell.openPath': {
    payload: { kind: OpenPathKind };
    result: { path: string };
  };
  // ── 应用菜单（Windows 自绘标题栏里的那排菜单名）──

  /**
   * 顶层菜单清单（`[{id, label}]`），供 Windows 自绘标题栏渲染那排菜单名。
   *
   * 为什么渲染层不自己写死这排名字：菜单的真实定义在主进程的 `menu.ts`
   * （`Menu.buildFromTemplate`）。渲染层复制一份就是两份真相 —— 以后加一项菜单，
   * 标题栏会少一个按钮且**不报错**。这里读的是 `Menu.getApplicationMenu()`，
   * 渲染出来的按钮数就等于主进程真装了几项。
   */
  'menu.list': {
    payload: Record<string, never>;
    result: { items: Array<{ id: AxonMenuId; label: string }> };
  };

  /**
   * 在光标处弹出某个顶层菜单的原生子菜单。
   *
   * 点的是标题栏里自绘的菜单名，弹出的仍是**系统原生下拉**（行为、快捷键提示、
   * 勾选态全部由 Electron 的 role 提供），所以这里只做「弹哪一个」，
   * 不存在第二套菜单实现。
   */
  'menu.popup': { payload: { menuId: AxonMenuId }; result: { opened: true } };

  // ── 工作区文件浏览（S2 顶部「打开文件」）──

  /**
   * 会话工作区元信息：文件夹名 + git 分支。
   * 主进程用 sessionId 解出 record.cwd，再同步跑 `git rev-parse` 拿分支；
   * 不在 git 仓库时 branch 为 null，调用方自行决定是否展示。
   */
  'session.cwdInfo': {
    payload: { sessionId: string };
    result: { folderName: string; branch: string | null };
  };

  /**
   * 列出会话工作区（`record.cwd`）下某目录的条目。
   *
   * 为什么带 sessionId 而不是任意路径：渲染进程零 Node，绝不能让它指定任意路径
   * 让主进程去 readdir —— 那等于把整个文件系统暴露给界面层。sessionId 在主进程
   * 解成 `record.cwd` 作为**沙箱根**，`relPath` 经 resolveInCwd 校验后必须仍落在根内，
   * 否则拒绝（防 `../` 目录穿越）。与 `shell.openPath` 的枚举同一条安全原则。
   */
  'fs.listDir': {
    payload: { sessionId: string; relPath: string };
    result: { root: string; relPath: string; entries: FsEntry[] };
  };
  /**
   * 读取会话工作区内某文件用于预览。沙箱校验同 `fs.listDir`。
   *
   * 大文件（> 1MB）只回 `tooLarge` 占位、不读内容，避免把几十 MB 的日志/二进制
   * 塞进 IPC 把渲染层打爆。文本按 utf8，图片按 base64（配 mime）供 <img> 直接渲染，
   * 其余二进制回 tooLarge=false 且 encoding='base64' 由 UI 决定是否下载。
   */
  'fs.readFile': {
    payload: { sessionId: string; relPath: string };
    result: {
      content: string;
      encoding: 'utf8' | 'base64';
      tooLarge?: boolean;
      mime?: string;
      size: number;
    };
  };

  // ── 本机外部 Agent 工具（新建会话的「执行引擎」popover）──

  /**
   * 读当前探测结果。**不触发探测**：首次启动的探测由主进程在后台自己发起，
   * 这条只读快照；`status: 'detecting'` 时等 `agentTools.changed`。
   */
  'agentTools.get': { payload: Record<string, never>; result: AgentToolsSnapshot };
  /**
   * 重新探测（用户装了新工具后手动点）。等探测完才回包，回的是新快照；
   * 同时照常广播 `agentTools.changed`。并发调用共享同一次探测。
   */
  'agentTools.redetect': { payload: Record<string, never>; result: AgentToolsSnapshot };

  // ── M6：Provider 连接测试 ──

  /**
   * 测试当前配置的网关连通性。
   *
   * 为什么独立一条命令而不复用 config.get：config.get 只是读配置快照，
   * 不实际发 HTTP 请求；设置窗「测试连接」按钮需要真实的延迟数字和
   * 可用模型列表，必须对网关发请求才能拿到。
   *
   * 两种模式：
   * - `payload = {}`：GET /models 拉取网关可用模型清单（result.models）。
   * - `payload = { model }`：对该模型发一次极小的 chat/completions 探测。
   *   /models 探测不可靠——不少 OpenAI 兼容网关根本没实现 /v1/models，
   *   但 /chat/completions 完全可用；单模型可用性只有真跑一次才作数。
   */
  'provider.test': {
    payload: { model?: string };
    result: { ok: boolean; latencyMs: number; models: string[]; error?: string };
  };

  // ── M12：知识库 ──

  /** 列出全部知识库。 */
  'kb.list': { payload: Record<string, never>; result: KnowledgeBase[] };
  /** 新建知识库。 */
  'kb.create': { payload: { name: string; description: string }; result: KnowledgeBase };
  /** 删除知识库（级联删 LanceDB 表和元数据目录）。 */
  'kb.delete': { payload: { kbId: string }; result: { deleted: boolean } };
  /** 获取知识库统计（docCount / chunkCount / embeddingModel）。 */
  'kb.getStats': {
    payload: { kbId: string };
    result: { docCount: number; chunkCount: number; embeddingModel: string } | null;
  };
  /** 异步摄入一个来源；立即返回 jobId，进度通过事件通知。 */
  'kb.addSource': { payload: AddSourcePayload; result: { jobId: string } };
  /** 删除一个已摄入的文档及其 chunk。 */
  'kb.removeDoc': { payload: { kbId: string; docId: string }; result: { removed: boolean } };
  /** 向量检索。 */
  'kb.query': {
    payload: { kbId: string; query: string; topK?: number };
    result: KnowledgeChunk[];
  };
  /** 列出知识库下的全部文档元数据。 */
  'kb.listDocs': { payload: { kbId: string }; result: KnowledgeDoc[] };
}

/** `shell.openPath` 的可达集（主进程解成真路径）。 */
export type OpenPathKind = 'roles' | 'teams' | 'config' | 'sessions';

/** 工作区目录树的一个条目（`fs.listDir` 返回）。 */
export interface FsEntry {
  name: string;
  kind: 'dir' | 'file';
  /** 仅文件有；目录省略。 */
  size?: number;
}

/**
 * 挂起中的待办（审批 / 提问）。
 *
 * `chain` 是审批穿透路径（origin → … → root，抄 TabTin subagent-hitl）：
 * UI 要能说清「这个请求是替谁问的、经过了谁」，否则深层子 Agent 的请求
 * 冒到人面前时完全没有来源感。
 */
export interface PendingRequest {
  requestId: string;
  kind: 'approval' | 'question';
  /**
   * 请求属于哪个会话。
   *
   * 它是 S5 收件箱「跨会话聚合」的分组键（UX 02 §3.4 的「双重主键」：
   * 请求属于某会话，但「有人卡住等你」是跨会话的）。
   */
  sessionId: string;
  /**
   * 父会话 id（M10）。子 session 的审批请求带此字段，指向主管 session。
   * 渲染层据此把子 session 的审批也显示在主管 session 的收件箱里。
   */
  parentSessionId?: string;
  /** 谁要动手。 */
  origin: AgentPath;
  chain: AgentPath[];
  tool?: string;
  args?: unknown;
  /** 该 agent 生效的审批档。 */
  approvalMode?: ApprovalMode;
  message: string;
  detail?: unknown;
  at: number;
  /** 超时时刻；超时按拒绝处理并把原因回灌给模型。 */
  expiresAt?: number;
  state: 'pending' | 'resolved';
}

/** 预算档位快照。 */
export interface BudgetSnapshot {
  state: 'ok' | 'warning' | 'frozen';
  /** 已累计花费。 */
  spentUsd: number;
  /** 软线；disabled 时无意义。 */
  softUsd: number;
  /** 硬线；<= 0 表示熔断关闭。 */
  hardUsd: number;
  disabled: boolean;
  usage: UsageTotals;
}

// ─────────────────────────────────────────────────────────────
// 事件（内核 → 渲染，单向推送）
// ─────────────────────────────────────────────────────────────

export interface EventMap {
  'agent.created': { snapshot: AgentSnapshot };
  'agent.status': { path: AgentPath; status: AgentStatus; error?: string };
  'agent.removed': { paths: AgentPath[] };
  /** 该 Agent 的当前模型 / 推理深度已切换（`agent.setModel` 后下发，渲染层据此更新 snapshot）。 */
  'agent.model.changed': { path: AgentPath; model?: string; thinkingLevel?: AxonThinkingLevel };

  /** 流式输出三段式：start → delta* → end。 */
  'agent.message.start': { messageId: string };
  /**
   * 流式消息增量（M6 wire() 分支）。
   * text / thinking 二选一，每条事件只带一个字段。
   * thinking 来自 deepseek-r1 风格的 reasoning 通道（S2 闸口1取证）。
   */
  'agent.message.delta': { messageId: string; text?: string; thinking?: string };
  'agent.message.end': { messageId: string; message: MessageLike };

  'agent.tool.start': { callId: string; tool: string; args: unknown };
  'agent.tool.update': { callId: string; chunk: string };
  'agent.tool.end': { callId: string; ok: boolean; result?: unknown; error?: string };

  'agent.turn.end': { usage: UsageTotals };

  /**
   * 角色集合变化（保存/删除/编辑器外部改文件后热重载）。UI 直接拿 entries 重绘。
   *
   * 注意这里**没有** `agent.message.received`：Agent 间通信的唯一口径是账本
   * （`ledger.recorded`）。留一个平行的轻通知事件会让 UI 出现两份互相矛盾的
   * 协作记录（M4 决策 D3）。
   */
  'roles.changed': { entries: RoleEntry[]; issues: RoleIssue[] };

  /** 工具执行前的 HITL 门；沿父链穿透后仍无人代批时才发到人面前。 */
  'approval.request': {
    requestId: string;
    /** 属于哪个会话（MU-1：收件箱按会话切片；渲染层要能直接把事件拼进待办表）。 */
    sessionId: string;
    /** M10：子 session 的审批请求带此字段，指向主管 session。 */
    parentSessionId?: string;
    /** 谁要动手。 */
    origin: AgentPath;
    /** 穿透路径 origin → … → root。 */
    chain: AgentPath[];
    tool: string;
    args: unknown;
    approvalMode: ApprovalMode;
    message: string;
    expiresAt?: number;
  };
  'question.request': { requestId: string; message: string };
  /** 请求已有结果（被回应 / 超时 / agent 消失），UI 据此摘掉待办。 */
  'pending.resolved': {
    requestId: string;
    outcome: 'approved' | 'denied' | 'answered' | 'expired' | 'cancelled';
  };

  /** 账本落了一笔新协作。 */
  'ledger.recorded': { record: LedgerRecord };
  /**
   * 已有记录发生变化（settle 或 adoption 表态）。
   *
   * 刻意合成一个事件而不是拆 settled/adopted 两个：两者对 UI 都是
   * 「同一笔记录变了，按 id upsert」，拆开只会让渲染层写两遍相同逻辑。
   */
  'ledger.updated': { record: LedgerRecord };
  'ledger.policyChanged': { policy: AdoptionPolicy };

  /**
   * 预算软/硬熔断。
   *
   * `spentUsd` 与 `limits` 必须是两个不同来源的数 —— 之前的 `limitUsd` 字段
   * 实际塞的是 spent，导致 UI 上「已用 / 上限」永远相等（M4 修订 G9.1）。
   *
   * MU-1 加 `scope`：三层限额（全局/团队/会话）取更严者后，UI 必须知道
   * 是哪一层触发的——否则会话被团队预算卡住时，用户看全局额度还富余，会以为程序坏了。
   */
  'budget.warning': BudgetEventPayload;
  'budget.frozen': BudgetEventPayload;

  // ─ MU-1：会话 / 团队 / 配置 ──

  /** 会话建立成功。 */
  'session.created': { summary: SessionSummary };
  /**
   * 会话 rollup 变化（成员状态 / 账本 / 待批 / 用量）。
   *
   * 发送侧要节流（≤ 4Hz/会话，实现放 index.ts 转发层）：一个忙碌会话的
   * turn.end + status 事件会以每秒几十条的频率出现，不节流会把 IPC 打满。
   */
  'session.changed': { summary: SessionSummary };
  /** 会话被删。`paths` 是级联删掉的全部路径（子先父后），UI 逐个摘节点。 */
  'session.removed': { sessionId: string; paths: AgentPath[] };

  // ── M10：子任务 session 事件 ──

  /**
   * 主管 session 派生了一个子 session（`task_spawn` 成功）。
   * 渲染层监听这个事件来刷新「子任务」面板。
   */
  'subsession.created': { parentSessionId: string; summary: SessionSummary };
  /**
   * 子 session 状态/用量变化（复用 session.changed 的节流约束）。
   * 渲染层用它来更新子任务行的状态点和摘要文本。
   */
  'subsession.changed': { parentSessionId: string; summary: SessionSummary };

  /** 团队集合变化（保存/删除/外部改文件后热重载）。UI 直接拿 entries 重绘。 */
  'teams.changed': { entries: TeamEntry[]; issues: TeamIssue[] };
  /** 项目集合变化（创建/外部改文件后热重载）。UI 直接拿 entries 重绘。 */
  'projects.changed': { entries: ProjectRecord[]; issues: ProjectIssue[] };
  /** 配置落盘成功（含来自其他途径的变更）；UI 全量重绘而不是局部打补丁。 */
  'config.changed': { config: ConfigSnapshot };
  /** 外部 Agent 工具探测状态变化（开始探测 / 探测完成）。 */
  'agentTools.changed': { snapshot: AgentToolsSnapshot };

  // ── M12：知识库摄入进度事件 ──

  /** 摄入任务分批处理进度（主进程 → 渲染）。 */
  'kb.indexing.progress': IndexingProgressPayload;
  /** 摄入任务完成（主进程 → 渲染）。 */
  'kb.indexing.done': IndexingDonePayload;
  /** 摄入任务失败（主进程 → 渲染）。 */
  'kb.indexing.error': IndexingErrorPayload;

  /**
   * 「打开设置」从**菜单**发起（`文件 → 设置…` / `Ctrl+,`）。
   *
   * 为什么菜单不能像渲染层那样自己切屏：菜单在主进程，而 `screen` 是渲染层的
   * UI 状态（`state/types.ts`）。走这条事件把意图传回去，与侧栏那个「设置」
   * 落到同一屏 —— 在此之前菜单走的是另一条路（开独立设置窗），
   * 结果是同一个入口点出两种设置界面。
   *
   * 不带 payload：只表达「去设置」这一个意图，不在协议里复制一份 Screen 联合。
   */
  'ui.openSettings': Record<string, never>;

  /**
   * 代批留痕（MU-1 审批修②）。
   *
   * 背景：`resolveDelegation` 只要链上有 auto/full_access 祖先就直接放行，
   * **不发事件、无记录**；而内置 planner/architect/aligner 都是 auto，
   * aligner 又常当 lead ⇒ 默认配置下 HITL 形同虚设。留痕之后，S5 的
   * 「已处理流水」与调试台都能回答「这次是谁替你批的」。
   */
  'approval.delegated': {
    /** 真正要动手的那个 agent。 */
    origin: AgentPath;
    tool: string;
    /** 替它批的祖先。 */
    approver: AgentPath;
    /** 代批者生效的审批档（auto 或 full_access）。 */
    mode: ApprovalMode;
    /** 穿透路径 origin → … → approver。 */
    chain: AgentPath[];
    at: number;
  };
}

/** 预算跃迁事件的载荷（warning / frozen 共用）。 */
export interface BudgetEventPayload {
  usage: UsageTotals;
  spentUsd: number;
  softUsd: number;
  hardUsd: number;
  /** 触发口径：全局档还是某会话档。 */
  scope: 'global' | 'session';
  /** scope='session' 时必有。 */
  sessionId?: string;
  /** 生效上限来自哪一层（会话口径时有意义，UI 显示「受团队预算限制」）。 */
  limitedBy?: 'global' | 'team' | 'session';
}

// ─────────────────────────────────────────────────────────────
// 桥接接口
// ─────────────────────────────────────────────────────────────

/**
 * 运行平台 —— **只用这三个值**，不是 `NodeJS.Platform`。
 *
 * 两个理由：① 渲染层的类型图里出现 `NodeJS.*` 与「渲染进程零 Node」（AGENTS.md §4.3）
 * 是自相矛盾的信号，哪怕 `@types/node` 恰好能编过；② 联合类型收窄到我们真的分支过的
 * 三种，`freebsd` 之流在 preload 归一（`toAxonPlatform`）时就被挡在门外，
 * 渲染层永远不会遇到一个「既要按 Linux 走又不知道该按谁走」的值。
 */
export type AxonPlatform = 'darwin' | 'win32' | 'linux';

/** 顶层菜单的稳定标识（顺序会变、id 不会），两侧唯一的对齐口径。 */
export type AxonMenuId = 'file' | 'edit' | 'view' | 'window';

/** preload 通过 contextBridge 暴露给渲染进程的对象形状。 */
export interface AxonBridge {
  /**
   * 运行平台。**同步字段，不是命令**：Windows 要不要画那条自绘标题栏，
   * 这个决定必须在首帧就有答案 —— 走 `invoke` 会先渲染出一帧没有标题栏的布局
   * 再跳一下。它是不可变的环境常量（与 `process.platform` 同源），
   * 不属于「状态真相在主进程」那条纪律要管的状态。
   */
  readonly platform: AxonPlatform;

  invoke<C extends keyof CommandMap>(
    command: C,
    payload: CommandMap[C]['payload'],
  ): Promise<CommandMap[C]['result']>;

  subscribe<E extends keyof EventMap>(
    event: E,
    handler: (
      payload: EventMap[E],
      meta: { source?: AgentPath; sessionId?: string; at: number },
    ) => void,
  ): () => void;
}

export const IPC_COMMAND_CHANNEL = 'axon:command';

export function ipcEventChannel(event: keyof EventMap): string {
  return `axon:event:${event}`;
}

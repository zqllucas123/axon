/**
 * 本机已安装的外部 Agent 工具（Claude Code / Codex / …）—— 新建会话「执行引擎」
 * popover 的数据源。
 *
 * 描述「装没装、在哪、什么版本、能不能用来跑会话」。选中一个 `runnable` 的工具后，
 * 新建会话带上 `CreateSessionPayload.engineId`，会话就由它执行（M9）。
 * 引擎与 `SessionExecutor`（单兵/团队的模式维度）正交。
 *
 * 探测在主进程做（渲染进程零 Node，查不了 PATH），且**只做一次**：结果落盘缓存，
 * 之后启动直接读缓存；装了新工具由用户点「重新检测」（`agentTools.redetect`）。
 */

/** 认得的外部 Agent 工具。增一项 = 主进程 `KNOWN_AGENT_TOOLS` 加一行 + 这里加一个字面量。 */
export type AgentToolId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'hermes';

/**
 * 一个已知工具的探测结果。**没装的也有条目**（`installed: false`）：
 * 列表只列已装的话，用户分不清「没探到」和「探到了但不能用」（抄 tutti：
 * 目录是静态全量的，状态逐项写明）。
 */
export interface DetectedAgentTool {
  id: AgentToolId;
  /** 展示名（Claude Code / Codex …）。 */
  label: string;
  installed: boolean;
  /** 可执行文件的绝对路径；未安装为 null。 */
  path: string | null;
  /** `--version` 的输出里抠出来的版本号；未安装或跑不出来为 null（不影响「已安装」判定）。 */
  version: string | null;
  /**
   * 能不能选它来执行会话 = 已安装 **且** Axon 已接入它的运行时（M9 起：Claude Code）。
   * 由主进程给出：「接入了哪些」是主进程的事实，渲染层不该自己维护一份名单。
   */
  runnable: boolean;
}

export interface AgentToolsSnapshot {
  /**
   * `detecting`：首次启动（或重新检测）的后台探测还没回来，`tools` 是旧值或空；
   * `ready`：`tools` 就是探测结果。
   */
  status: 'detecting' | 'ready';
  /** 最近一次完成探测的时刻；从未探测过为 null。 */
  detectedAt: number | null;
  /** 探测完成后恒为全量已知工具（含未安装的）；从未探测过时为空。 */
  tools: DetectedAgentTool[];
}

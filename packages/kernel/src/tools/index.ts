/**
 * 叶子工具层（M8）—— read / ls / glob / grep / edit / write / bash。
 *
 * 与编排工具（agent/ledger…）的关键区别：叶子工具**按会话 cwd 绑定**，
 * 因此不是构造期注入的静态 universe，而是在 host.toolsFor(cwd) 里按会话
 * 现造（cwd 收敛 + 审批门都挂在这一层）。ops 可注入，默认走本地实现。
 */

import type { AgentTool } from '../index.ts';
import { createBashTool } from './bash.ts';
import { createEditTool } from './edit.ts';
import { createGlobTool } from './glob.ts';
import { createGrepTool } from './grep.ts';
import { createLsTool } from './ls.ts';
import { createLocalOps, type LeafOperations } from './ops.ts';
import { createReadTool } from './read.ts';
import { createWriteTool } from './write.ts';

/** 叶子工具名清单 —— 角色白名单用它来声明可用能力。 */
export const LEAF_TOOL_NAMES = ['read', 'ls', 'glob', 'grep', 'edit', 'write', 'bash'] as const;
export type LeafToolName = (typeof LEAF_TOOL_NAMES)[number];

/** 只读子集（供 READ_ONLY 角色引用）。 */
export const READ_ONLY_LEAF_TOOLS = ['read', 'ls', 'glob', 'grep'] as const;
/** 写子集（叠加在只读之上）。 */
export const WRITE_LEAF_TOOLS = ['edit', 'write', 'bash'] as const;

/**
 * 为给定会话 cwd 造一整套叶子工具。ops 不传则用本地文件系统 + 子进程。
 */
export function createLeafTools(cwd: string, ops: LeafOperations = createLocalOps()): AgentTool[] {
  return [
    createReadTool(cwd, ops),
    createLsTool(cwd, ops),
    createGlobTool(cwd, ops),
    createGrepTool(cwd, ops),
    createEditTool(cwd, ops),
    createWriteTool(cwd, ops),
    createBashTool(cwd, ops),
  ];
}

export { createLocalOps } from './ops.ts';
export type { LeafOperations, BashResult, BashExecOptions } from './ops.ts';
export { PathEscapeError, resolveWithinCwd } from './path-utils.ts';
export { truncateHead, formatSize } from './truncate.ts';

/**
 * bash —— 在会话 cwd 内跑 shell 命令（M8）。
 *
 * cwd 固定为会话工作目录（模型不能 cd 出去改变持久 cwd —— 每次调用都在
 * 会话根重新起）。超时/abort 杀整个进程组。输出截断防撑爆。
 * 写副作用交给上层审批门（M4 D5）把关。
 */

import { Type, type AgentTool, type AgentToolResult } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { formatSize, truncateHead } from './truncate.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const schema = Type.Object({
  command: Type.String({ description: '要执行的 shell 命令' }),
  timeout: Type.Optional(Type.Number({ description: '超时毫秒（默认 120000，上限 600000）' })),
});

interface BashDetails {
  exitCode?: number | null;
  killed?: boolean;
}

export function createBashTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'bash',
    label: '执行命令',
    description: '在会话工作目录内执行 shell 命令。cwd 固定，无法持久切换目录。',
    parameters: schema,
    execute: async (_id, params: { command: string; timeout?: number }, signal) => {
      const timeoutMs = Math.min(params.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const result = await ops.exec(params.command, {
        cwd,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });

      const stdout = truncateHead(result.stdout);
      const stderr = truncateHead(result.stderr);
      const parts: string[] = [];
      if (stdout.content) parts.push(stdout.content);
      if (stderr.content) parts.push(`[stderr]\n${stderr.content}`);
      if (stdout.truncated || stderr.truncated) {
        parts.push(`[输出已截断，原始 ${formatSize(result.stdout.length + result.stderr.length)}]`);
      }
      if (result.killed) {
        parts.push(`[命令被终止：超时（${timeoutMs}ms）或被取消]`);
      }
      if (result.exitCode !== 0 && result.exitCode !== null) {
        parts.push(`[退出码 ${result.exitCode}]`);
      }
      const text = parts.join('\n') || '（无输出）';
      const details: BashDetails = { exitCode: result.exitCode, killed: result.killed };
      return {
        content: [{ type: 'text', text }],
        details,
      } as AgentToolResult<BashDetails>;
    },
  } as AgentTool;
}

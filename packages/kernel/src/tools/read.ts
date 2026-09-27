/**
 * read —— 读文件内容（M8）。相对路径相对会话 cwd 解析，越权拒绝，
 * 大文件按行/字节截断。支持 offset/limit 读取行区间。
 */

import { Type, type AgentTool, type AgentToolResult } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { resolveWithinCwd } from './path-utils.ts';
import { truncateHead, type TruncationResult } from './truncate.ts';

const schema = Type.Object({
  path: Type.String({ description: '要读取的文件路径（相对会话工作目录或绝对路径）' }),
  offset: Type.Optional(Type.Number({ description: '起始行号（1 起）' })),
  limit: Type.Optional(Type.Number({ description: '最多读取的行数' })),
});

export interface ReadDetails {
  truncation?: TruncationResult;
  path?: string;
}

function ok(text: string, details: ReadDetails): AgentToolResult<ReadDetails> {
  return { content: [{ type: 'text', text }], details };
}

export function createReadTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'read',
    label: '读取文件',
    description: '读取文件内容。用它替代 cat/head/sed。',
    parameters: schema,
    execute: async (_id, params: { path: string; offset?: number; limit?: number }) => {
      const abs = resolveWithinCwd(params.path, cwd);
      try {
        await ops.access(abs);
      } catch {
        throw new Error(`文件不存在或不可读：${params.path}`);
      }
      const buf = await ops.readFile(abs);
      let content = buf.toString('utf-8');

      if (params.offset !== undefined || params.limit !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (params.offset ?? 1) - 1);
        const end = params.limit !== undefined ? start + params.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      const truncation = truncateHead(content);
      const note = truncation.truncated
        ? `\n\n[已截断：显示 ${truncation.outputLines}/${truncation.totalLines} 行，命中${truncation.truncatedBy === 'lines' ? '行数' : '字节'}上限]`
        : '';
      return ok(truncation.content + note, { truncation, path: abs });
    },
  } as AgentTool;
}

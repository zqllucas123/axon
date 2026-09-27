/**
 * ls —— 列出目录内容（M8）。相对会话 cwd 解析，越权拒绝。
 */

import { Type, type AgentTool, type AgentToolResult } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { resolveWithinCwd } from './path-utils.ts';

const schema = Type.Object({
  path: Type.Optional(Type.String({ description: '要列出的目录（相对会话工作目录，默认当前）' })),
});

interface LsDetails {
  count?: number;
}

function res(text: string, details: LsDetails): AgentToolResult<LsDetails> {
  return { content: [{ type: 'text', text }], details };
}

export function createLsTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'ls',
    label: '列出目录',
    description: '列出目录下的文件与子目录。',
    parameters: schema,
    execute: async (_id, params: { path?: string }) => {
      const abs = resolveWithinCwd(params.path ?? '.', cwd);
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        entries = await ops.readdir(abs);
      } catch {
        throw new Error(`目录不存在或不可读：${params.path ?? '.'}`);
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const listed = entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
      const body = listed.length > 0 ? listed.join('\n') : '（空目录）';
      return res(body, { count: listed.length });
    },
  } as AgentTool;
}

/**
 * glob —— 按通配模式列出文件（M8）。模式相对会话 cwd 匹配，越权拒绝。
 */

import { Type, type AgentTool, type AgentToolResult } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { resolveWithinCwd } from './path-utils.ts';
import { globToRegExp, walkFiles } from './walk.ts';

const schema = Type.Object({
  pattern: Type.String({ description: '通配模式，如 src/**/*.ts' }),
  path: Type.Optional(Type.String({ description: '搜索根目录（相对会话工作目录，默认当前）' })),
});

interface GlobDetails {
  count?: number;
  truncated?: boolean;
}

function res(text: string, details: GlobDetails): AgentToolResult<GlobDetails> {
  return { content: [{ type: 'text', text }], details };
}

export function createGlobTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'glob',
    label: '匹配文件',
    description: '按通配模式列出匹配的文件路径。用它替代 find。',
    parameters: schema,
    execute: async (_id, params: { pattern: string; path?: string }) => {
      const root = resolveWithinCwd(params.path ?? '.', cwd);
      const { files, truncated } = await walkFiles(root, ops);
      const re = globToRegExp(params.pattern);
      const matched = files.filter((f) => re.test(f.rel)).map((f) => f.rel);
      matched.sort();
      const note = truncated ? '\n[遍历达到上限，结果可能不完整]' : '';
      const body = matched.length > 0 ? matched.join('\n') : '（无匹配）';
      return res(body + note, { count: matched.length, truncated });
    },
  } as AgentTool;
}

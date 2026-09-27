/**
 * write —— 写文件（M8）。整文件覆盖写，自动建父目录。越权拒绝。
 * 写操作受审批门管辖（M4 D5：非编排工具默认过 HITL）。
 */

import { Type, type AgentTool } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { resolveWithinCwd } from './path-utils.ts';

const schema = Type.Object({
  path: Type.String({ description: '要写入的文件路径（相对会话工作目录或绝对路径）' }),
  content: Type.String({ description: '写入的完整内容（覆盖原文件）' }),
});

export function createWriteTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'write',
    label: '写入文件',
    description: '写入文件（整文件覆盖）。父目录不存在会自动创建。',
    parameters: schema,
    execute: async (_id, params: { path: string; content: string }) => {
      const abs = resolveWithinCwd(params.path, cwd);
      await ops.writeFile(abs, params.content);
      const bytes = Buffer.byteLength(params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `已写入 ${params.path}（${bytes} 字节）` }],
        details: { path: abs },
      };
    },
  } as AgentTool;
}

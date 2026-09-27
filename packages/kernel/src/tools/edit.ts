/**
 * edit —— 精确串替换（M8 §六 B4，对齐 pi edit 语义）。
 *
 * old_string 必须在文件中唯一出现：零匹配或多匹配都报错、不改盘，
 * 杜绝模糊替换误伤。replace_all 显式放开多匹配。越权拒绝。
 */

import { Type, type AgentTool } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { resolveWithinCwd } from './path-utils.ts';

const schema = Type.Object({
  path: Type.String({ description: '要编辑的文件路径（相对会话工作目录或绝对路径）' }),
  old_string: Type.String({ description: '要替换的原文（须在文件中唯一出现，除非 replace_all）' }),
  new_string: Type.String({ description: '替换后的新文本' }),
  replace_all: Type.Optional(Type.Boolean({ description: '替换全部出现（默认 false，只允许唯一匹配）' })),
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function createEditTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'edit',
    label: '编辑文件',
    description: '对文件做精确字符串替换。old_string 须唯一出现，除非设 replace_all。',
    parameters: schema,
    execute: async (
      _id,
      params: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    ) => {
      const abs = resolveWithinCwd(params.path, cwd);
      if (params.old_string === params.new_string) {
        throw new Error('old_string 与 new_string 相同，无需编辑');
      }
      try {
        await ops.access(abs);
      } catch {
        throw new Error(`文件不存在或不可读：${params.path}`);
      }
      const original = (await ops.readFile(abs)).toString('utf-8');
      const count = countOccurrences(original, params.old_string);
      if (count === 0) {
        throw new Error(`未找到匹配的 old_string：${params.path}`);
      }
      if (count > 1 && !params.replace_all) {
        throw new Error(
          `old_string 在文件中出现 ${count} 次，非唯一。请扩大上下文使其唯一，或设 replace_all`,
        );
      }
      const updated = params.replace_all
        ? original.split(params.old_string).join(params.new_string)
        : original.replace(params.old_string, params.new_string);
      await ops.writeFile(abs, updated);
      return {
        content: [{ type: 'text', text: `已编辑 ${params.path}（替换 ${count} 处）` }],
        details: { path: abs, replaced: count },
      };
    },
  } as AgentTool;
}

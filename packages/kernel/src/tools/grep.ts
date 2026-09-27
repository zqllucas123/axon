/**
 * grep —— 在 cwd 子树内按正则搜文件内容（M8）。
 *
 * 纯 JS 实现（走 ops.readFile 逐文件匹配），可被假 ops 单测。
 * 命中数设上限，避免超大结果撑爆 transcript。越权拒绝。
 */

import { Type, type AgentTool, type AgentToolResult } from '../index.ts';
import type { LeafOperations } from './ops.ts';
import { resolveWithinCwd } from './path-utils.ts';
import { globToRegExp, walkFiles } from './walk.ts';

const MAX_MATCHES = 500;

const schema = Type.Object({
  pattern: Type.String({ description: '要搜索的正则表达式' }),
  path: Type.Optional(Type.String({ description: '搜索根目录（相对会话工作目录，默认当前）' })),
  include: Type.Optional(Type.String({ description: '文件名通配过滤，如 *.ts' })),
  ignore_case: Type.Optional(Type.Boolean({ description: '忽略大小写' })),
});

interface GrepDetails {
  matches?: number;
  truncated?: boolean;
}

function res(text: string, details: GrepDetails): AgentToolResult<GrepDetails> {
  return { content: [{ type: 'text', text }], details };
}

export function createGrepTool(cwd: string, ops: LeafOperations): AgentTool {
  return {
    name: 'grep',
    label: '搜索内容',
    description: '在文件内容中按正则搜索，返回匹配的 文件:行号:内容。用它替代 grep 命令。',
    parameters: schema,
    execute: async (
      _id,
      params: { pattern: string; path?: string; include?: string; ignore_case?: boolean },
    ) => {
      const root = resolveWithinCwd(params.path ?? '.', cwd);
      let re: RegExp;
      try {
        re = new RegExp(params.pattern, params.ignore_case ? 'i' : '');
      } catch (e) {
        throw new Error(`无效的正则：${(e as Error).message}`);
      }
      const includeRe = params.include ? globToRegExp(params.include) : null;
      const { files, truncated: walkTruncated } = await walkFiles(root, ops);

      const lines: string[] = [];
      let matches = 0;
      let capped = false;
      for (const file of files) {
        if (includeRe && !includeRe.test(file.rel) && !includeRe.test(basename(file.rel))) continue;
        let content: string;
        try {
          content = (await ops.readFile(file.abs)).toString('utf-8');
        } catch {
          continue;
        }
        const fileLines = content.split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          if (re.test(fileLines[i] as string)) {
            lines.push(`${file.rel}:${i + 1}:${fileLines[i]}`);
            if (++matches >= MAX_MATCHES) {
              capped = true;
              break;
            }
          }
        }
        if (capped) break;
      }

      const truncated = walkTruncated || capped;
      const note = truncated ? '\n[结果达到上限，可能不完整]' : '';
      const body = lines.length > 0 ? lines.join('\n') : '（无匹配）';
      return res(body + note, { matches, truncated });
    },
  } as AgentTool;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

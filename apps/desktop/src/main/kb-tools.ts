/**
 * M14：知识库 Agent 工具——kb_search。
 *
 * 让 Agent 在任务执行过程中主动检索本地知识库，把相关内容作为上下文使用。
 *
 * 设计要点（仿 read.ts / orchestrator.ts 风格）：
 * - 工具是无状态闭包，`kbManager` 在创建时绑进来。
 * - 参数 schema 用 TypeBox，与其他工具保持一致。
 * - 失败一律 throw：pi 约定 throw 转 error toolResult 回灌给模型。
 * - 搜索结果格式化成易读的纯文本，让模型直接消费。
 */

import { Type, type AgentTool, type AgentToolResult } from '@axon/kernel';
import type { KnowledgeManager } from '@axon/knowledge';
import type { KnowledgeChunk } from '@axon/protocol';

const schema = Type.Object({
  kb_id: Type.String({
    description: '知识库 ID（可从 kb_list 工具获取）',
  }),
  query: Type.String({
    description: '搜索问题或关键词',
  }),
  top_k: Type.Optional(
    Type.Number({
      description: '返回结果数量，默认 5，最大 10',
      minimum: 1,
      maximum: 10,
    }),
  ),
});

const LIST_SCHEMA = Type.Object({});

/** 格式化搜索结果为模型可读文本 */
function formatResults(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '未找到相关内容。';
  return chunks
    .map((c, i) => {
      const score = (c.score * 100).toFixed(0);
      return [
        `[${i + 1}] 来源：${c.title}（相似度 ${score}%）`,
        `内容：${c.content.slice(0, 600)}${c.content.length > 600 ? '…' : ''}`,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * 创建 kb_search 工具。
 * kbManager 在主进程初始化后传入（不依赖 cwd，属于全局 universe 工具）。
 */
export function createKbSearchTool(kbManager: KnowledgeManager): AgentTool {
  return {
    name: 'kb_search',
    label: '知识库搜索',
    description:
      '在本地知识库中进行向量语义搜索，返回与问题最相关的内容片段。' +
      '用于从已摄入的网页、文档或代码仓库中查找相关知识。' +
      '需要先用 kb_list 获取可用知识库的 ID。',
    parameters: schema,
    execute: async (
      _id,
      params: { kb_id: string; query: string; top_k?: number },
    ): Promise<AgentToolResult<{ chunks: KnowledgeChunk[] }>> => {
      const topK = Math.min(params.top_k ?? 5, 10);

      // 校验知识库存在
      const kb = await kbManager.getKb(params.kb_id);
      if (!kb) {
        throw new Error(
          `知识库 "${params.kb_id}" 不存在。请用 kb_list 工具查看可用的知识库列表。`,
        );
      }

      const chunks = await kbManager.query(params.kb_id, params.query, topK);
      const text = [
        `知识库「${kb.name}」的搜索结果（查询：${params.query}，共 ${chunks.length} 条）：`,
        '',
        formatResults(chunks),
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        details: { chunks },
      };
    },
  } as AgentTool;
}

/**
 * 创建 kb_list 工具：列出所有可用知识库（ID、名称、文档数、chunk 数）。
 * Agent 在调用 kb_search 前应先用此工具确认知识库 ID。
 */
export function createKbListTool(kbManager: KnowledgeManager): AgentTool {
  return {
    name: 'kb_list',
    label: '列出知识库',
    description: '列出所有本地知识库，返回每个库的 ID、名称、文档数和向量块数量。在使用 kb_search 之前，先调用此工具获取知识库 ID。',
    parameters: LIST_SCHEMA,
    execute: async (): Promise<AgentToolResult<unknown>> => {
      const kbs = await kbManager.listKbs();
      if (kbs.length === 0) {
        return {
          content: [{ type: 'text', text: '当前没有可用的知识库。请先在 S4 知识库管理屏中创建并摄入内容。' }],
          details: { kbs: [] },
        };
      }
      const lines = kbs.map(
        (kb) =>
          `- ID: ${kb.id}\n  名称: ${kb.name}\n  文档: ${kb.docCount} 篇 / 向量块: ${kb.chunkCount}\n  模型: ${kb.embeddingModel}`,
      );
      return {
        content: [{ type: 'text', text: `可用知识库（共 ${kbs.length} 个）：\n\n${lines.join('\n\n')}` }],
        details: { kbs },
      };
    },
  } as AgentTool;
}

/** 知识库工具名清单，供角色白名单引用 */
export const KB_TOOL_NAMES = ['kb_search', 'kb_list'] as const;
export type KbToolName = (typeof KB_TOOL_NAMES)[number];

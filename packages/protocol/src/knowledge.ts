/**
 * 知识库协议类型。
 *
 * 知识库是全局共享的——它不属于某个会话，会话挂载时按 kbId 引用。
 * 这与 Team 档案的设计一致：全局定义，按需实例化。
 */

/** 知识库元数据；存 ~/.axon/knowledge/<kbId>/meta.json */
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  docCount: number;
  chunkCount: number;
  /** 建库时记录的 embedding 模型标识；查询时须一致。 */
  embeddingModel: string;
}

/** 来源类型 */
export type KnowledgeSourceType = 'html' | 'docx' | 'md' | 'repo';

/** 已摄入的来源文档（不存原始内容，只存元数据）。 */
export interface KnowledgeDoc {
  id: string;
  kbId: string;
  sourceType: KnowledgeSourceType;
  /** URL 或绝对路径 */
  sourceRef: string;
  title: string;
  chunkCount: number;
  indexedAt: string;
}

/** 向量检索结果 */
export interface KnowledgeChunk {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  /** cosine similarity [0, 1]，越大越相关 */
  score: number;
  sourceRef: string;
  title: string;
}

/** kb.addSource 的参数 */
export interface AddSourcePayload {
  kbId: string;
  sourceType: KnowledgeSourceType;
  /** URL 或绝对路径 */
  sourceRef: string;
}

/** kb.indexing.progress 事件载荷 */
export interface IndexingProgressPayload {
  kbId: string;
  jobId: string;
  sourceRef: string;
  processed: number;
  total: number;
}

/** kb.indexing.done 事件载荷 */
export interface IndexingDonePayload {
  kbId: string;
  jobId: string;
  docId: string;
  chunkCount: number;
}

/** kb.indexing.error 事件载荷 */
export interface IndexingErrorPayload {
  kbId: string;
  jobId: string;
  sourceRef: string;
  error: string;
}

/**
 * KnowledgeManager：知识库功能的核心入口。
 *
 * 职责：
 *  - kb CRUD（委托给 KbMetaStore）
 *  - 摄入管道（ingest → chunk → embed → store），异步跑，通过 onProgress/onDone/onError 回调
 *  - 向量查询（委托给 KnowledgeStore）
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeDoc,
  KnowledgeSourceType,
  IndexingProgressPayload,
  IndexingDonePayload,
  IndexingErrorPayload,
} from '@axon/protocol';
import { KbMetaStore } from './kb.ts';
import { KnowledgeStore } from './store.ts';
import { split } from './chunker.ts';
import type { Embedder } from './embedder.ts';
import { ingest } from './ingest/index.ts';

export type ProgressCallback = (p: IndexingProgressPayload) => void;
export type DoneCallback = (p: IndexingDonePayload) => void;
export type ErrorCallback = (p: IndexingErrorPayload) => void;
/** 按模型名构造 Embedder；用于运行时切换 per-KB 向量模型。 */
export type EmbedderFactory = (model: string) => Embedder;

export interface KnowledgeManagerOptions {
  /** ~/.axon/knowledge or equivalent */
  baseDir: string;
  embedder: Embedder;
  /**
   * 可选工厂：当 KB 配置了与默认 embedder 不同的模型时，
   * 用此工厂按需创建对应的 Embedder 实例（会被缓存）。
   */
  embedderFactory?: EmbedderFactory;
  onProgress?: ProgressCallback;
  onDone?: DoneCallback;
  onError?: ErrorCallback;
}

/** 每批 chunk 的向量化大小 */
const EMBED_BATCH = 64;

export class KnowledgeManager {
  private readonly meta: KbMetaStore;
  private readonly store: KnowledgeStore;
  private readonly defaultEmbedder: Embedder;
  private readonly embedderFactory?: EmbedderFactory;
  /** 按模型名缓存 Embedder，避免重复构造。 */
  private readonly embedderCache = new Map<string, Embedder>();
  private onProgress?: ProgressCallback;
  private onDone?: DoneCallback;
  private onError?: ErrorCallback;

  constructor(opts: KnowledgeManagerOptions) {
    this.meta = new KbMetaStore(opts.baseDir);
    this.store = new KnowledgeStore(opts.baseDir);
    this.defaultEmbedder = opts.embedder;
    this.embedderFactory = opts.embedderFactory;
    this.onProgress = opts.onProgress;
    this.onDone = opts.onDone;
    this.onError = opts.onError;
  }

  /** 取得指定 KB 应使用的 Embedder（优先匹配 KB 配置的模型）。 */
  private _embedderFor(kb: KnowledgeBase): Embedder {
    const model = kb.embeddingModel;
    if (model === this.defaultEmbedder.model) return this.defaultEmbedder;
    const cached = this.embedderCache.get(model);
    if (cached) return cached;
    if (this.embedderFactory) {
      const e = this.embedderFactory(model);
      this.embedderCache.set(model, e);
      return e;
    }
    // 没有工厂时降级用默认（查询时向量维度可能不匹配，让上层收错误提示）
    return this.defaultEmbedder;
  }

  /** 运行时绑定进度回调（主进程 KnowledgeBridge 在 getSender 就绪后调用）。 */
  setCallbacks(cbs: { onProgress?: ProgressCallback; onDone?: DoneCallback; onError?: ErrorCallback }): void {
    if (cbs.onProgress) this.onProgress = cbs.onProgress;
    if (cbs.onDone) this.onDone = cbs.onDone;
    if (cbs.onError) this.onError = cbs.onError;
  }

  // ── KB CRUD ───────────────────────────────────────────────────

  async listKbs(): Promise<KnowledgeBase[]> {
    return this.meta.list();
  }

  async getKb(kbId: string): Promise<KnowledgeBase | null> {
    return this.meta.get(kbId);
  }

  async createKb(name: string, description: string): Promise<KnowledgeBase> {
    await mkdir(join(this.meta['baseDir'], '..'), { recursive: true }).catch(() => {});
    return this.meta.create(name, description, this.defaultEmbedder.model);
  }

  /**
   * 更新知识库记录的向量模型标识。
   * 只更新元数据，不重新摄入现有文档；后续新增文档会用新模型编码。
   */
  async updateEmbeddingModel(kbId: string, model: string): Promise<void> {
    const kb = await this.meta.get(kbId);
    if (!kb) throw new Error(`知识库 ${kbId} 不存在`);
    await this.meta.update({ ...kb, embeddingModel: model });
  }

  /**
   * 删除知识库：先删 LanceDB 表，再删元数据目录。
   * 用 .deleting 标记保证原子性（崩溃后重启可识别残留并清理）。
   */
  async deleteKb(kbId: string): Promise<void> {
    await this.store.deleteTable(kbId);
    await this.meta.delete(kbId);
  }

  async listDocs(kbId: string): Promise<KnowledgeDoc[]> {
    return this.meta.listDocs(kbId);
  }

  async removeDoc(kbId: string, docId: string): Promise<void> {
    await this.store.deleteByDocId(kbId, docId);
    await this.meta.removeDoc(kbId, docId);
    await this.meta.updateDocCount(kbId);
  }

  // ── 摄入管道 ──────────────────────────────────────────────────

  /**
   * 异步摄入一个来源；立即返回 jobId，进度通过回调通知。
   * 不阻塞 IPC 响应。
   */
  addSource(kbId: string, sourceType: KnowledgeSourceType, sourceRef: string): string {
    const jobId = randomUUID();
    // 异步跑，不 await
    this._runIngest(kbId, sourceType, sourceRef, jobId).catch(() => {});
    return jobId;
  }

  private async _runIngest(
    kbId: string,
    sourceType: KnowledgeSourceType,
    sourceRef: string,
    jobId: string,
  ): Promise<void> {
    try {
      const pages = await ingest(sourceType, sourceRef);
      if (pages.length === 0) {
        this.onError?.({ kbId, jobId, sourceRef, error: '没有可摄入的内容' });
        return;
      }

      const kb = await this.meta.get(kbId);
      const embedder = kb ? this._embedderFor(kb) : this.defaultEmbedder;

      const docId = randomUUID();
      let totalChunks = 0;

      // 分页处理，每次 flush 一批 chunks（控制内存）
      const allChunks: Array<{ text: string; pageIdx: number; title: string }> = [];
      for (const page of pages) {
        const chunks = split(page.pageContent, { chunkSize: 800, chunkOverlap: 100 });
        for (const c of chunks) {
          allChunks.push({ text: c.text, pageIdx: allChunks.length, title: page.title });
        }
      }

      const total = allChunks.length;

      // 分批 embed + 存储
      for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
        const batch = allChunks.slice(i, i + EMBED_BATCH);
        const texts = batch.map((c) => c.text);
        const vectors = await embedder.embed(texts);

        const records = batch.map((c, j) => ({
          chunkId: randomUUID(),
          docId,
          kbId,
          content: c.text,
          sourceRef,
          title: c.title,
          vector: vectors[j] ?? [],
        }));

        await this.store.upsertChunks(records);
        totalChunks += batch.length;

        this.onProgress?.({
          kbId, jobId, sourceRef,
          processed: Math.min(i + EMBED_BATCH, total),
          total,
        });
      }

      // 保存文档元数据
      const doc: KnowledgeDoc = {
        id: docId,
        kbId,
        sourceType,
        sourceRef,
        title: pages[0]?.title ?? sourceRef,
        chunkCount: totalChunks,
        indexedAt: new Date().toISOString(),
      };
      await this.meta.addDoc(doc);
      await this.meta.updateDocCount(kbId);

      this.onDone?.({ kbId, jobId, docId, chunkCount: totalChunks });
    } catch (err) {
      this.onError?.({
        kbId, jobId, sourceRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 查询 ──────────────────────────────────────────────────────

  async query(kbId: string, queryText: string, topK = 5): Promise<KnowledgeChunk[]> {
    const kb = await this.meta.get(kbId);
    const embedder = kb ? this._embedderFor(kb) : this.defaultEmbedder;
    const [queryVec] = await embedder.embed([queryText]);
    if (!queryVec) return [];
    return this.store.search(kbId, queryVec, topK);
  }
}

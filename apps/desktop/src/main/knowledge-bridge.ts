/**
 * 主进程 IPC bridge：把 kb.* 命令路由到 KnowledgeManager。
 *
 * 命名约定与 role-bridge / team-bridge 保持一致：
 * 只负责 IPC 适配，业务逻辑全在 KnowledgeManager 里。
 */

import type { IpcMain, WebContents } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ipcEventChannel,
  type AddSourcePayload,
  type IndexingProgressPayload,
  type IndexingDonePayload,
  type IndexingErrorPayload,
} from '@axon/protocol';
import { KnowledgeManager, OpenAICompatEmbedder } from '@axon/knowledge';

/** 知识库根目录；AXON_KNOWLEDGE_DIR 供冒烟/测试隔离。 */
const KNOWLEDGE_DIR =
  process.env.AXON_KNOWLEDGE_DIR || join(homedir(), '.axon', 'knowledge');

export class KnowledgeBridge {
  private readonly mgr: KnowledgeManager;

  constructor(
    private readonly ipcMain: IpcMain,
    private readonly getSender: () => WebContents | null,
    endpointUrl: string,
    apiKey: string,
    embeddingModel = 'text-embedding-3-small',
  ) {
    const embedder = new OpenAICompatEmbedder({
      endpoint: endpointUrl,
      apiKey,
      model: embeddingModel,
    });

    this.mgr = new KnowledgeManager({
      baseDir: KNOWLEDGE_DIR,
      embedder,
      onProgress: (p: IndexingProgressPayload) => this._emit('kb.indexing.progress', p),
      onDone: (p: IndexingDonePayload) => this._emit('kb.indexing.done', p),
      onError: (p: IndexingErrorPayload) => this._emit('kb.indexing.error', p),
    });
  }

  /** 注册全部 kb.* IPC 命令 handler。 */
  register(): void {
    const { ipcMain, mgr } = this;

    ipcMain.handle('axon:kb.list', async () => {
      return mgr.listKbs();
    });

    ipcMain.handle('axon:kb.create', async (_e, payload: { name: string; description: string }) => {
      return mgr.createKb(payload.name, payload.description);
    });

    ipcMain.handle('axon:kb.delete', async (_e, payload: { kbId: string }) => {
      await mgr.deleteKb(payload.kbId);
      return { deleted: true };
    });

    ipcMain.handle('axon:kb.getStats', async (_e, payload: { kbId: string }) => {
      const kb = await mgr.getKb(payload.kbId);
      if (!kb) return null;
      return {
        docCount: kb.docCount,
        chunkCount: kb.chunkCount,
        embeddingModel: kb.embeddingModel,
      };
    });

    ipcMain.handle('axon:kb.addSource', async (_e, payload: AddSourcePayload) => {
      const jobId = mgr.addSource(payload.kbId, payload.sourceType, payload.sourceRef);
      return { jobId };
    });

    ipcMain.handle('axon:kb.removeDoc', async (_e, payload: { kbId: string; docId: string }) => {
      await mgr.removeDoc(payload.kbId, payload.docId);
      return { removed: true };
    });

    ipcMain.handle(
      'axon:kb.query',
      async (_e, payload: { kbId: string; query: string; topK?: number }) => {
        return mgr.query(payload.kbId, payload.query, payload.topK ?? 5);
      },
    );

    ipcMain.handle('axon:kb.listDocs', async (_e, payload: { kbId: string }) => {
      return mgr.listDocs(payload.kbId);
    });
  }

  /** 注销 handler（测试 / 热重载用）。 */
  unregister(): void {
    const channels = [
      'axon:kb.list', 'axon:kb.create', 'axon:kb.delete', 'axon:kb.getStats',
      'axon:kb.addSource', 'axon:kb.removeDoc', 'axon:kb.query', 'axon:kb.listDocs',
    ];
    for (const ch of channels) {
      this.ipcMain.removeHandler(ch);
    }
  }

  private _emit(event: string, payload: unknown): void {
    const sender = this.getSender();
    if (!sender || sender.isDestroyed()) return;
    sender.send(ipcEventChannel(event as Parameters<typeof ipcEventChannel>[0]), payload);
  }
}

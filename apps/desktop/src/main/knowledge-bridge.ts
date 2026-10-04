/**
 * 主进程 IPC bridge：把 kb.* 命令路由到 KnowledgeManager。
 *
 * M14 重构：KnowledgeManager 从外部传入，让 index.ts 可以在 createHost
 * 之前创建它，并把 kb_search / kb_list 工具注入 host universe。
 */

import type { IpcMain, WebContents } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ipcEventChannel,
  type AddSourcePayload,
} from '@axon/protocol';
import { KnowledgeManager, OpenAICompatEmbedder } from '@axon/knowledge';

export { KnowledgeManager };

/** 知识库根目录；AXON_KNOWLEDGE_DIR 供冒烟/测试隔离。 */
export const KNOWLEDGE_DIR =
  process.env.AXON_KNOWLEDGE_DIR || join(homedir(), '.axon', 'knowledge');

/**
 * 创建 KnowledgeManager（不含进度回调）。
 * 进度回调在 KnowledgeBridge 构造时绑定（那时 getSender 才有 WebContents）。
 */
export function makeKnowledgeManager(
  endpointUrl: string,
  apiKey: string,
  model = 'text-embedding-3-small',
): KnowledgeManager {
  const embedder = new OpenAICompatEmbedder({ endpoint: endpointUrl, apiKey, model });
  return new KnowledgeManager({ baseDir: KNOWLEDGE_DIR, embedder });
}

export class KnowledgeBridge {
  constructor(
    private readonly ipcMain: IpcMain,
    private readonly getSender: () => WebContents | null,
    private readonly mgr: KnowledgeManager,
  ) {
    // 绑定进度回调（需要 getSender，在此时才能拿到 WebContents）
    mgr.setCallbacks({
      onProgress: (p) => this._emit('kb.indexing.progress', p),
      onDone: (p) => this._emit('kb.indexing.done', p),
      onError: (p) => this._emit('kb.indexing.error', p),
    });
  }

  register(): void {
    const { ipcMain, mgr } = this;

    ipcMain.handle('axon:kb.list', async () => mgr.listKbs());

    ipcMain.handle('axon:kb.create', async (_e, payload: { name: string; description: string }) =>
      mgr.createKb(payload.name, payload.description),
    );

    ipcMain.handle('axon:kb.delete', async (_e, payload: { kbId: string }) => {
      await mgr.deleteKb(payload.kbId);
      return { deleted: true };
    });

    ipcMain.handle('axon:kb.getStats', async (_e, payload: { kbId: string }) => {
      const kb = await mgr.getKb(payload.kbId);
      if (!kb) return null;
      return { docCount: kb.docCount, chunkCount: kb.chunkCount, embeddingModel: kb.embeddingModel };
    });

    ipcMain.handle('axon:kb.addSource', async (_e, payload: AddSourcePayload) => ({
      jobId: mgr.addSource(payload.kbId, payload.sourceType, payload.sourceRef),
    }));

    ipcMain.handle('axon:kb.removeDoc', async (_e, payload: { kbId: string; docId: string }) => {
      await mgr.removeDoc(payload.kbId, payload.docId);
      return { removed: true };
    });

    ipcMain.handle(
      'axon:kb.query',
      async (_e, payload: { kbId: string; query: string; topK?: number }) =>
        mgr.query(payload.kbId, payload.query, payload.topK ?? 5),
    );

    ipcMain.handle('axon:kb.listDocs', async (_e, payload: { kbId: string }) =>
      mgr.listDocs(payload.kbId),
    );
  }

  unregister(): void {
    for (const ch of [
      'axon:kb.list', 'axon:kb.create', 'axon:kb.delete', 'axon:kb.getStats',
      'axon:kb.addSource', 'axon:kb.removeDoc', 'axon:kb.query', 'axon:kb.listDocs',
    ]) {
      this.ipcMain.removeHandler(ch);
    }
  }

  private _emit(event: string, payload: unknown): void {
    const sender = this.getSender();
    if (!sender || sender.isDestroyed()) return;
    sender.send(ipcEventChannel(event as Parameters<typeof ipcEventChannel>[0]), payload);
  }
}

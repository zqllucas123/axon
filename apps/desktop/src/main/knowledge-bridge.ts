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

  /**
   * 信封通道分发（M14 修复）。
   *
   * 渲染层所有命令都走 IPC_COMMAND_CHANNEL 单一信封通道，不存在
   * `axon:kb.*` 这种独立通道 —— 之前按独立通道注册等于没接线，
   * 命令会一路落到 host dispatch 的 default 分支报「未实现的命令」。
   *
   * 返回 undefined 表示「不是 kb 命令」，由调用方继续往下路由。
   */
  async handle(command: string, payload: unknown): Promise<unknown> {
    const mgr = this.mgr;
    switch (command) {
      case 'kb.list':
        return mgr.listKbs();
      case 'kb.create': {
        const p = payload as { name: string; description?: string };
        return mgr.createKb(p.name, p.description ?? '');
      }
      case 'kb.delete': {
        const p = payload as { kbId: string };
        await mgr.deleteKb(p.kbId);
        return { deleted: true };
      }
      case 'kb.getStats': {
        const p = payload as { kbId: string };
        const kb = await mgr.getKb(p.kbId);
        if (!kb) return null;
        return {
          docCount: kb.docCount,
          chunkCount: kb.chunkCount,
          embeddingModel: kb.embeddingModel,
        };
      }
      case 'kb.addSource': {
        const p = payload as AddSourcePayload;
        return { jobId: mgr.addSource(p.kbId, p.sourceType, p.sourceRef) };
      }
      case 'kb.removeDoc': {
        const p = payload as { kbId: string; docId: string };
        await mgr.removeDoc(p.kbId, p.docId);
        return { removed: true };
      }
      case 'kb.query': {
        const p = payload as { kbId: string; query: string; topK?: number };
        return mgr.query(p.kbId, p.query, p.topK);
      }
      case 'kb.listDocs': {
        const p = payload as { kbId: string };
        return mgr.listDocs(p.kbId);
      }
      default:
        return undefined;
    }
  }

  /**
   * 把摄入管道的三个回调接到渲染层事件通道上。
   *
   * 命令走 `handle()`（信封通道），这里只管事件方向：
   * 摄入是异步长任务，进度得主动推给 S4 屏的进度条。
   */
  bindEvents(): void {
    this.mgr.setCallbacks({
      onProgress: (job) => this._emit('kb.indexing.progress', job),
      onDone: (job) => this._emit('kb.indexing.done', job),
      onError: (job) => this._emit('kb.indexing.error', job),
    });
  }

  /**
   * 发事件 —— 必须套 NotificationEnvelope。
   *
   * preload 的 `subscribe` 读的是 `envelope.payload`（见 preload/index.ts），
   * 裸发 payload 会让渲染层每个 handler 都收到 `undefined`：表现为进度条
   * 不动 + 控制台 `Cannot read properties of undefined (reading 'jobId')`，
   * 而主进程一切正常，极难定位。
   */
  private _emit(event: string, payload: unknown): void {
    const sender = this.getSender();
    if (!sender || sender.isDestroyed()) return;
    sender.send(ipcEventChannel(event as Parameters<typeof ipcEventChannel>[0]), {
      payload,
      at: Date.now(),
    });
  }
}

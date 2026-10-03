/**
 * KnowledgeBase 元数据 CRUD。
 *
 * 布局：
 *   <baseDir>/
 *     <kbId>/
 *       meta.json   —— KnowledgeBase
 *       docs.json   —— KnowledgeDoc[]
 */

import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KnowledgeBase, KnowledgeDoc } from '@axon/protocol';

export class KbMetaStore {
  constructor(private readonly baseDir: string) {}

  async list(): Promise<KnowledgeBase[]> {
    const { readdir } = await import('node:fs/promises');
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return [];
    }

    const results: KnowledgeBase[] = [];
    for (const entry of entries) {
      const meta = await this._readMeta(entry).catch(() => null);
      if (meta) results.push(meta);
    }
    return results;
  }

  async get(kbId: string): Promise<KnowledgeBase | null> {
    return this._readMeta(kbId).catch(() => null);
  }

  async create(name: string, description: string, embeddingModel: string): Promise<KnowledgeBase> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const kb: KnowledgeBase = {
      id,
      name,
      description,
      createdAt: now,
      updatedAt: now,
      docCount: 0,
      chunkCount: 0,
      embeddingModel,
    };
    await mkdir(join(this.baseDir, id), { recursive: true });
    await writeFile(this._metaPath(id), JSON.stringify(kb, null, 2), 'utf8');
    await writeFile(this._docsPath(id), '[]', 'utf8');
    return kb;
  }

  async update(kb: KnowledgeBase): Promise<void> {
    const updated = { ...kb, updatedAt: new Date().toISOString() };
    await writeFile(this._metaPath(kb.id), JSON.stringify(updated, null, 2), 'utf8');
  }

  /** 删除元数据目录（LanceDB 表由 KnowledgeStore 负责清理）。 */
  async delete(kbId: string): Promise<void> {
    await rm(join(this.baseDir, kbId), { recursive: true, force: true });
  }

  async exists(kbId: string): Promise<boolean> {
    return access(this._metaPath(kbId)).then(() => true, () => false);
  }

  // ── 文档元数据 ────────────────────────────────────────────────

  async listDocs(kbId: string): Promise<KnowledgeDoc[]> {
    return this._readDocs(kbId).catch(() => []);
  }

  async getDoc(kbId: string, docId: string): Promise<KnowledgeDoc | null> {
    const docs = await this.listDocs(kbId);
    return docs.find((d) => d.id === docId) ?? null;
  }

  async addDoc(doc: KnowledgeDoc): Promise<void> {
    const docs = await this.listDocs(doc.kbId);
    docs.push(doc);
    await writeFile(this._docsPath(doc.kbId), JSON.stringify(docs, null, 2), 'utf8');
  }

  async removeDoc(kbId: string, docId: string): Promise<void> {
    const docs = await this.listDocs(kbId);
    const next = docs.filter((d) => d.id !== docId);
    await writeFile(this._docsPath(kbId), JSON.stringify(next, null, 2), 'utf8');
  }

  async updateDocCount(kbId: string): Promise<void> {
    const [kb, docs] = await Promise.all([this._readMeta(kbId), this._readDocs(kbId)]);
    if (!kb) return;
    kb.docCount = docs.length;
    kb.chunkCount = docs.reduce((s, d) => s + d.chunkCount, 0);
    await this.update(kb);
  }

  // ── 私有工具 ──────────────────────────────────────────────────

  private async _readMeta(kbId: string): Promise<KnowledgeBase> {
    const raw = await readFile(this._metaPath(kbId), 'utf8');
    return JSON.parse(raw) as KnowledgeBase;
  }

  private async _readDocs(kbId: string): Promise<KnowledgeDoc[]> {
    const raw = await readFile(this._docsPath(kbId), 'utf8');
    return JSON.parse(raw) as KnowledgeDoc[];
  }

  private _metaPath(kbId: string): string {
    return join(this.baseDir, kbId, 'meta.json');
  }

  private _docsPath(kbId: string): string {
    return join(this.baseDir, kbId, 'docs.json');
  }
}

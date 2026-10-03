/**
 * LanceDB 向量存储封装。
 *
 * 每个知识库对应一张表，表名为 kb_<kbId>。
 * 参考 anything-llm server/utils/vectorDbProviders/lance/index.js 的连接模式。
 */

import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { join } from 'node:path';
import type { KnowledgeChunk } from '@axon/protocol';

export interface ChunkRecord {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  sourceRef: string;
  title: string;
  vector: number[];
}

export class KnowledgeStore {
  private static _conn: Connection | null = null;
  private readonly dbPath: string;

  constructor(baseDir: string) {
    this.dbPath = join(baseDir, 'lancedb');
  }

  private async connect(): Promise<Connection> {
    if (!KnowledgeStore._conn) {
      KnowledgeStore._conn = await connect(this.dbPath);
    }
    return KnowledgeStore._conn;
  }

  async tableExists(kbId: string): Promise<boolean> {
    const client = await this.connect();
    const names = await client.tableNames();
    return names.includes(this._tableName(kbId));
  }

  async upsertChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;
    const client = await this.connect();
    const kbId = chunks[0]!.kbId;
    const name = this._tableName(kbId);
    const existing = await client.tableNames();

    // LanceDB expects plain objects; cast through unknown to satisfy strict index sig check.
    const rows = chunks as unknown as Record<string, unknown>[];

    if (existing.includes(name)) {
      const table = await client.openTable(name);
      await table.add(rows);
    } else {
      await client.createTable(name, rows);
    }
  }

  /**
   * 向量相似度搜索；返回结果按 score 降序排列。
   *
   * distanceToSimilarity：余弦距离 [0,2] → 相似度 [0,1]。
   * 距离 0 完全相同，距离 ≥ 1（正交或更远）归零，不让无关 chunk 蒙混过关。
   * 参考 anything-llm lance/index.js:45-53。
   */
  async search(kbId: string, vector: number[], topK = 5): Promise<KnowledgeChunk[]> {
    if (!(await this.tableExists(kbId))) return [];

    const client = await this.connect();
    const table: Table = await client.openTable(this._tableName(kbId));

    const rows = await table.vectorSearch(vector).limit(topK).toArray();

    return rows.map((row) => ({
      chunkId: row.chunkId as string,
      docId: row.docId as string,
      kbId: row.kbId as string,
      content: row.content as string,
      sourceRef: row.sourceRef as string,
      title: row.title as string,
      score: this._distanceToSimilarity((row as Record<string, unknown>)._distance as number | null),
    }));
  }

  /** 删除整张表（kb.delete 时调用）。 */
  async deleteTable(kbId: string): Promise<void> {
    if (!(await this.tableExists(kbId))) return;
    const client = await this.connect();
    await client.dropTable(this._tableName(kbId));
  }

  /** 删除指定 docId 的所有 chunk（kb.removeDoc 时调用）。 */
  async deleteByDocId(kbId: string, docId: string): Promise<void> {
    if (!(await this.tableExists(kbId))) return;
    const client = await this.connect();
    const table = await client.openTable(this._tableName(kbId));
    // LanceDB SQL filter：大驼峰字段名需要双引号，否则 parser 会做 case fold
    const safeId = docId.replace(/'/g, "''");
    await table.delete(`"docId" = '${safeId}'`);
  }

  async countChunks(kbId: string): Promise<number> {
    if (!(await this.tableExists(kbId))) return 0;
    const client = await this.connect();
    const table = await client.openTable(this._tableName(kbId));
    return await table.countRows();
  }

  private _tableName(kbId: string): string {
    return `kb_${kbId}`;
  }

  private _distanceToSimilarity(distance: number | null): number {
    if (distance === null || typeof distance !== 'number') return 0;
    if (distance >= 1.0) return 0;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  }
}

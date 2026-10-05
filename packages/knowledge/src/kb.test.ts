/**
 * KbMetaStore 单测（元数据 CRUD）
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KbMetaStore } from '../src/kb.ts';

let tmpDir: string;
let store: KbMetaStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'axon-kb-test-'));
  store = new KbMetaStore(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('KbMetaStore', () => {
  it('list 空目录返回空数组', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('create 写入元数据并可 get 取回', async () => {
    const kb = await store.create('测试库', '描述', 'text-embedding-3-small');
    expect(kb.name).toBe('测试库');
    expect(kb.docCount).toBe(0);

    const got = await store.get(kb.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(kb.id);
  });

  it('list 返回已建库', async () => {
    await store.create('A', '', 'model');
    await store.create('B', '', 'model');
    const list = await store.list();
    expect(list).toHaveLength(2);
  });

  it('delete 后 list 不再包含该库', async () => {
    const kb = await store.create('待删', '', 'model');
    await store.delete(kb.id);
    const list = await store.list();
    expect(list.find((k) => k.id === kb.id)).toBeUndefined();
  });

  it('addDoc / listDocs / removeDoc', async () => {
    const kb = await store.create('lib', '', 'model');
    await store.addDoc({
      id: 'doc-1',
      kbId: kb.id,
      sourceType: 'md',
      sourceRef: '/path/to/file.md',
      title: '文档一',
      chunkCount: 5,
      indexedAt: new Date().toISOString(),
    });

    const docs = await store.listDocs(kb.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe('doc-1');

    await store.removeDoc(kb.id, 'doc-1');
    expect(await store.listDocs(kb.id)).toHaveLength(0);
  });

  it('updateDocCount 更新 kb 的 docCount 和 chunkCount', async () => {
    const kb = await store.create('lib', '', 'model');
    await store.addDoc({
      id: 'doc-2',
      kbId: kb.id,
      sourceType: 'web',
      sourceRef: 'http://example.com',
      title: '页面',
      chunkCount: 10,
      indexedAt: new Date().toISOString(),
    });
    await store.updateDocCount(kb.id);

    const updated = await store.get(kb.id);
    expect(updated!.docCount).toBe(1);
    expect(updated!.chunkCount).toBe(10);
  });
});

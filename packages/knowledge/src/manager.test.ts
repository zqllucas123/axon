/**
 * KnowledgeManager 集成测试
 * 用 FauxEmbedder + 本地临时目录，不发真实 HTTP。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeManager } from '../src/manager.ts';
import { FauxEmbedder } from '../src/embedder.ts';

let tmpDir: string;
let mgr: KnowledgeManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'axon-mgr-test-'));
  mgr = new KnowledgeManager({
    baseDir: tmpDir,
    embedder: new FauxEmbedder(16),
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('KnowledgeManager — KB CRUD', () => {
  it('createKb / listKbs', async () => {
    const kb = await mgr.createKb('测试库', '描述');
    expect(kb.name).toBe('测试库');

    const list = await mgr.listKbs();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(kb.id);
  });

  it('deleteKb 后 listKbs 不含该库', async () => {
    const kb = await mgr.createKb('待删库', '');
    await mgr.deleteKb(kb.id);
    const list = await mgr.listKbs();
    expect(list.find((k) => k.id === kb.id)).toBeUndefined();
  });
});

describe('KnowledgeManager — addSource + query', () => {
  it('摄入 MD 文件后可查询', async () => {
    const kb = await mgr.createKb('md-test', '');

    // 写一个临时 MD 文件
    const mdFile = join(tmpDir, 'test.md');
    await writeFile(
      mdFile,
      '# 人工智能简介\n\n人工智能是计算机科学的一个分支，致力于创建能够模拟人类智能行为的系统。\n\n机器学习是人工智能的核心技术之一。',
      'utf8',
    );

    // 异步摄入——等待 done 回调
    const jobId = await new Promise<string>((resolve, reject) => {
      const m = new KnowledgeManager({
        baseDir: tmpDir,
        embedder: new FauxEmbedder(16),
        onDone: () => resolve('done'),
        onError: (e) => reject(new Error(e.error)),
      });
      resolve(m.addSource(kb.id, 'md', mdFile));
    });
    expect(typeof jobId).toBe('string');

    // 等 indexing 完成（最多 5s）
    await waitForDocCount(mgr, kb.id, 1);

    // 查询
    const results = await mgr.query(kb.id, '机器学习', 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.kbId).toBe(kb.id);
    }
  });

  it('removeDoc 后 listDocs 不含该文档', async () => {
    const kb = await mgr.createKb('rm-test', '');
    const mdFile = join(tmpDir, 'rm.md');
    await writeFile(mdFile, '# 删除测试\n\n这个文档会被删除。', 'utf8');

    await waitForIngest(mgr, kb.id, 'md', mdFile);

    const docs = await mgr.listDocs(kb.id);
    expect(docs).toHaveLength(1);

    await mgr.removeDoc(kb.id, docs[0]!.id);
    expect(await mgr.listDocs(kb.id)).toHaveLength(0);
  });
});

describe('KnowledgeManager — repo 摄入', () => {
  it('摄入代码仓库目录', async () => {
    const kb = await mgr.createKb('repo-test', '');

    // 建一个假仓库
    const repoDir = join(tmpDir, 'fake-repo');
    await mkdir(repoDir);
    await writeFile(join(repoDir, 'main.ts'), 'console.log("hello world");', 'utf8');
    await writeFile(join(repoDir, 'README.md'), '# Fake Repo\n\nA test repo.', 'utf8');
    // 应被忽略的目录
    await mkdir(join(repoDir, 'node_modules'));
    await writeFile(join(repoDir, 'node_modules', 'lib.js'), 'should not be ingested', 'utf8');

    await waitForIngest(mgr, kb.id, 'repo', repoDir);

    const docs = await mgr.listDocs(kb.id);
    // 只有 main.ts 和 README.md 应被摄入，node_modules 里的不算
    expect(docs.length).toBeGreaterThanOrEqual(1);
    const titles = docs.map((d) => d.title);
    expect(titles.some((t) => t.includes('node_modules'))).toBe(false);
  });
});

// ── 工具函数 ──────────────────────────────────────────────────

async function waitForDocCount(
  manager: KnowledgeManager,
  kbId: string,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const docs = await manager.listDocs(kbId);
    if (docs.length >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout: expected ${count} docs in kb ${kbId}`);
}

async function waitForIngest(
  manager: KnowledgeManager,
  kbId: string,
  sourceType: 'md' | 'html' | 'docx' | 'repo',
  sourceRef: string,
  timeoutMs = 5000,
): Promise<void> {
  // 用带回调的新实例来保证能收到完成信号
  const baseDir = (manager as unknown as { meta: { baseDir: string } }).meta?.['baseDir'] ??
    (manager as unknown as Record<string, unknown>)['baseDir'];

  await new Promise<void>((resolve, reject) => {
    const m = new KnowledgeManager({
      baseDir: baseDir as string,
      embedder: new FauxEmbedder(16),
      onDone: () => resolve(),
      onError: (e) => reject(new Error(e.error)),
    });
    m.addSource(kbId, sourceType, sourceRef);
    setTimeout(() => reject(new Error('ingest timeout')), timeoutMs);
  });
}

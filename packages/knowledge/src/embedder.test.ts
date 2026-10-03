/**
 * FauxEmbedder 单测
 */

import { describe, expect, it } from 'vitest';
import { FauxEmbedder } from '../src/embedder.ts';

describe('FauxEmbedder', () => {
  it('返回与输入条数相等的向量', async () => {
    const emb = new FauxEmbedder(16);
    const vecs = await emb.embed(['hello', 'world', 'foo']);
    expect(vecs).toHaveLength(3);
    for (const v of vecs) {
      expect(v).toHaveLength(16);
    }
  });

  it('空输入返回空数组', async () => {
    const emb = new FauxEmbedder();
    expect(await emb.embed([])).toEqual([]);
  });

  it('相同文本每次产生相同向量（确定性）', async () => {
    const emb = new FauxEmbedder(32);
    const a = await emb.embed(['deterministic test']);
    const b = await emb.embed(['deterministic test']);
    expect(a[0]).toEqual(b[0]);
  });

  it('不同文本产生不同向量', async () => {
    const emb = new FauxEmbedder(32);
    const [a, b] = await emb.embed(['foo', 'bar']);
    expect(a).not.toEqual(b);
  });

  it('向量已归一化（L2 norm ≈ 1）', async () => {
    const emb = new FauxEmbedder(64);
    const vecs = await emb.embed(['normalize test']);
    const v = vecs[0]!;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

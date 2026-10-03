/**
 * chunker 单测
 */

import { describe, expect, it } from 'vitest';
import { split } from '../src/chunker.ts';

describe('split — 基本分块', () => {
  it('空字符串返回空数组', () => {
    expect(split('')).toEqual([]);
    expect(split('   ')).toEqual([]);
  });

  it('短文本不超过 chunkSize 时返回单块', () => {
    const text = 'Hello world';
    const chunks = split(text, { chunkSize: 800 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Hello world');
  });

  it('长文本被切成多块，每块不超过 chunkSize', () => {
    const text = 'A'.repeat(3000);
    const chunks = split(text, { chunkSize: 800, chunkOverlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(800);
    }
  });

  it('段落边界优先分割', () => {
    const text = ['段落一内容内容内容', '段落二内容内容内容', '段落三内容内容内容'].join('\n\n');
    const chunks = split(text, { chunkSize: 20, chunkOverlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('overlap 使相邻块有重叠内容', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = split(text, { chunkSize: 100, chunkOverlap: 30 });
    if (chunks.length >= 2) {
      const first = chunks[0]!.text;
      const second = chunks[1]!.text;
      // 找至少一个 word 同时出现在两块里（overlap 保证）
      const firstWords = new Set(first.split(/\s+/));
      const secondWords = second.split(/\s+/);
      const shared = secondWords.filter((w) => firstWords.has(w));
      expect(shared.length).toBeGreaterThan(0);
    }
  });

  it('index 字段是非负整数', () => {
    const text = 'Hello\n\nWorld\n\nFoo';
    const chunks = split(text, { chunkSize: 800 });
    for (const c of chunks) {
      expect(c.index).toBeGreaterThanOrEqual(0);
    }
  });
});

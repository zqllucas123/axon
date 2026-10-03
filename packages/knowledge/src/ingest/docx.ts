/**
 * DOCX → 纯文本。
 * 用 mammoth.extractRawText 提取正文，不保留格式。
 * 参考 anything-llm collector/processSingleFile/convert/asDocx.js。
 */

import mammoth from 'mammoth';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export async function ingestDocx(filePath: string): Promise<{ title: string; pageContent: string }[]> {
  const buffer = await readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });

  const text = result.value.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return [];

  const title = basename(filePath, '.docx');
  return [{ title, pageContent: text }];
}

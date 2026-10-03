/**
 * 摄入分发器：根据 sourceType 调用对应的摄入器。
 * HTML 可以是 URL（需下载）或本地文件路径。
 */

import { readFile } from 'node:fs/promises';
import type { KnowledgeSourceType } from '@axon/protocol';
import { ingestMd } from './md.ts';
import { ingestHtml } from './html.ts';
import { ingestDocx } from './docx.ts';
import { ingestRepo } from './repo.ts';

export interface IngestedPage {
  title: string;
  pageContent: string;
}

export async function ingest(
  sourceType: KnowledgeSourceType,
  sourceRef: string,
): Promise<IngestedPage[]> {
  switch (sourceType) {
    case 'md': {
      const content = await readFile(sourceRef, 'utf8');
      return ingestMd(content, sourceRef);
    }
    case 'html': {
      let html: string;
      if (sourceRef.startsWith('http://') || sourceRef.startsWith('https://')) {
        const resp = await fetch(sourceRef, {
          headers: { 'User-Agent': 'Axon-Knowledge-Bot/1.0' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${sourceRef}`);
        html = await resp.text();
      } else {
        html = await readFile(sourceRef, 'utf8');
      }
      return ingestHtml(html, sourceRef);
    }
    case 'docx': {
      return ingestDocx(sourceRef);
    }
    case 'repo': {
      return ingestRepo(sourceRef);
    }
    default: {
      const _: never = sourceType;
      throw new Error(`Unknown sourceType: ${_}`);
    }
  }
}

/**
 * 摄入分发器：根据 sourceType 调用对应的摄入器。
 * `web` 既接 URL（抓取）也接本地 .html 文件路径。
 */

import { readFile } from 'node:fs/promises';
import type { KnowledgeSourceType } from '@axon/protocol';
import { ingestMd } from './md.ts';
import { ingestHtml } from './html.ts';
import { ingestDocx } from './docx.ts';
import { ingestRepo } from './repo.ts';
import { fetchWebPage, isHttpUrl } from './fetch-web.ts';

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
    case 'web': {
      // URL 走网络抓取，其余按本地 .html 文件读。两边最终都交给同一个
      // cheerio 解析器 —— 区别只在内容从哪来。
      if (isHttpUrl(sourceRef)) {
        const { html, finalUrl } = await fetchWebPage(sourceRef);
        const pages = await ingestHtml(html, finalUrl);
        if (pages.length === 0) {
          // 抓到了但正文是空的，几乎总是 SPA：HTML 只有一个挂载点，
          // 内容靠 JS 填。静默存一篇空文档会让用户以为收录成功了。
          throw new Error(
            `这个页面没有可提取的正文，可能需要 JavaScript 渲染：${sourceRef}`,
          );
        }
        return pages;
      }
      const html = await readFile(sourceRef, 'utf8');
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

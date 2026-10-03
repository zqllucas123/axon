/**
 * HTML → 纯文本。
 * 用 cheerio 提取 body 正文，过滤掉 script/style/nav/footer 等非内容标签。
 * 参考 anything-llm collector/processLink 的 scrape 策略。
 */

import * as cheerio from 'cheerio';

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'nav', 'footer', 'header',
  'aside', 'form', '[aria-hidden="true"]', '.ad', '.advertisement',
];

export async function ingestHtml(html: string, sourceRef: string): Promise<{ title: string; pageContent: string }[]> {
  const $ = cheerio.load(html);

  // 提取 title
  const title = $('title').first().text().trim()
    || $('h1').first().text().trim()
    || sourceRef;

  // 移除噪声节点
  NOISE_SELECTORS.forEach((sel) => $(sel).remove());

  // 取 body 文本；若无 body 则取整个文档
  const bodyEl = $('body');
  const text = (bodyEl.length ? bodyEl : $('html')).text()
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return [];
  return [{ title, pageContent: text }];
}

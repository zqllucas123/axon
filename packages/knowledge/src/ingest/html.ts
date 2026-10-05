/**
 * HTML → 纯文本。
 *
 * 两件事决定了存进知识库的是正文还是噪音：
 *
 * 1. **选对容器**。整页 body 里导航、侧栏、页脚、评论区的字数经常超过正文，
 *    它们被嵌进向量后会反复命中无关检索。优先取 `<main>`/`<article>`，
 *    没有才退回 body。
 * 2. **保住块边界**。cheerio 的 `.text()` 直接拼接文本节点，
 *    `<p>第一段</p><p>第二段</p>` 会变成「第一段第二段」—— 句子粘连会让
 *    切块切在句子中间。所以块级标签后补换行。
 *
 * 不引 Turndown 转 Markdown（anything-llm 的做法）：那套表格规则是为了让
 * 人读的渲染保真，而这里的下游只有 embedding，纯文本就够，少一个依赖。
 */

import * as cheerio from 'cheerio';

/** 整段删除：这些节点的文本永远不是正文。 */
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'nav', 'footer', 'header', 'aside', 'form', 'button',
  '[aria-hidden="true"]', '[hidden]', '[role="navigation"]',
  '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '.ad', '.advertisement', '.sidebar', '.comments', '.cookie-banner',
  // 微信公众号：页面自带一堆常驻隐藏弹层（扫码关注、"预览时标签不可点"、
  // 小程序跳转的"取消/允许"），它们不在 nav/footer 里，退回 body 时会被
  // 当成正文嵌入。公众号是本地知识库的高频来源，值得单独列。
  '.weui-dialog', '.weui-mask', '.weui-toast', '.weui-actionsheet',
  '#js_pc_qr_code', '.qr_code_pc', '.reward_area', '.js_tags',
  '.rich_media_area_extra', '.discuss_container', '.media_tool_meta',
  '.weui-half-screen-dialog', '.js_dialog_bg',
];

/**
 * 正文容器候选，从最可信排到最宽松。
 * 带站点专属选择器是必要的妥协：公众号页面没有 `<main>`/`<article>`，
 * 正文只在 `#js_content` 里，靠通用规则会退回 body 并吃进整页弹层。
 */
const CONTENT_SELECTORS = [
  'main', 'article', '[role="main"]',
  '#js_content', '.rich_media_content',  // 微信公众号
  '#content', '.content',
  '.markdown-body', '.post-content', '.article-content',
];

/** 这些标签结束处要有换行，否则相邻块的文字会粘连。 */
const BLOCK_TAGS = 'p,div,section,br,li,tr,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,dt,dd,figcaption';

export async function ingestHtml(
  html: string,
  sourceRef: string,
): Promise<{ title: string; pageContent: string }[]> {
  const $ = cheerio.load(html);

  // 标题在删噪声之前取 —— og:title 常在 <head>，h1 也可能落在被删的 header 里。
  const title = $('meta[property="og:title"]').attr('content')?.trim()
    || $('title').first().text().trim()
    || $('h1').first().text().trim()
    || sourceRef;

  NOISE_SELECTORS.forEach((sel) => $(sel).remove());

  // 块级标签后插入换行标记。用 \n 文本节点而非改 HTML，避免二次解析。
  $(BLOCK_TAGS).each((_, el) => { $(el).append('\n'); });

  // 找正文容器：取第一个有实质内容的候选。空的或只有壳的（SPA 的
  // <main> 常常是空挂载点）跳过，继续往下试。
  let scope = $();
  for (const sel of CONTENT_SELECTORS) {
    const found = $(sel).first();
    if (found.length && found.text().trim().length > 200) { scope = found; break; }
  }
  if (!scope.length) scope = $('body').length ? $('body') : $('html');

  const text = normalize(scope.text());
  if (!text) return [];

  // 摘要信息对检索有用（很多页面的 description 是最精炼的一句总结），
  // 放在正文前，这样首个 chunk 一定带着页面主旨。
  const desc = (
    $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content')
    || ''
  ).trim();

  const pageContent = desc && !text.startsWith(desc)
    ? `${title}\n\n${desc}\n\n${text}`
    : `${title}\n\n${text}`;

  return [{ title, pageContent }];
}

/**
 * 压掉抓取产生的空白噪音。
 * HTML 源码里的缩进会变成成片空格和空行，直接嵌入会浪费 token 预算。
 */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

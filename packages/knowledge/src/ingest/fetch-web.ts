/**
 * 远程网页抓取。
 *
 * 只用内置 fetch，不引 Puppeteer —— anything-llm 的 processLink 走
 * PuppeteerWebBaseLoader 以便渲染 JS，代价是额外下载一整个 Chromium。
 * Axon 是 Electron 应用，真要渲染 JS 应该复用壳里已有的 Chromium
 * （开隐藏 BrowserWindow），没必要再塞一个。静态 HTML 是绝大多数文档站、
 * 博客、维基的形态，fetch 足够；SPA 抓到空正文时我们明确报错而不是静默
 * 存一篇空文档。
 */

/** 单页抓取上限 8MB —— 正文类页面远低于此，超了基本是下载链接走错了路。 */
const MAX_BYTES = 8 * 1024 * 1024;
/** 整体超时 30s，含重定向与读 body。 */
const TIMEOUT_MS = 30_000;

export interface FetchedPage {
  html: string;
  /** 走完重定向后的真实 URL，用于相对链接解析与来源展示。 */
  finalUrl: string;
}

export function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/**
 * 抓一个网页，返回 HTML 文本。
 *
 * 失败一律抛错，消息面向用户（会直接显示在添加来源对话框里），所以带上
 * 具体状态码或原因，而不是笼统的「抓取失败」。
 */
export async function fetchWebPage(url: string): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`不是合法的网址：${url}`);
  }
  // 只放行 http/https。file: 和 data: 走到这里意味着调用方分流出错了，
  // 而且在主进程里 file: 等于任意文件读取。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http/https 网址，收到 ${parsed.protocol}`);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(parsed.href, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        // 有些站点对无 UA 或非浏览器 UA 直接 403，给一个真实浏览器 UA。
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`抓取超时（${TIMEOUT_MS / 1000}s）：${url}`);
    }
    throw new Error(`无法连接到 ${parsed.host}：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`网页返回 HTTP ${resp.status} ${resp.statusText}：${url}`);
  }

  // content-type 只拦明确的二进制。缺失或 text/* 一律放行 —— 不少站点
  // 根本不发这个头，以此为硬门槛会误杀。
  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  if (ctype && !/text\/|application\/(xhtml|xml|json)/.test(ctype)) {
    throw new Error(`这个地址返回的不是网页（${ctype.split(';')[0]}）：${url}`);
  }

  const declared = Number(resp.headers.get('content-length') || '0');
  if (declared > MAX_BYTES) {
    throw new Error(`网页体积 ${(declared / 1048576).toFixed(1)}MB 超过 8MB 上限`);
  }

  // content-length 可能缺失或撒谎，按实际字节再卡一次。
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`网页体积 ${(buf.byteLength / 1048576).toFixed(1)}MB 超过 8MB 上限`);
  }

  return { html: decodeHtml(buf, ctype), finalUrl: resp.url || parsed.href };
}

/**
 * 按声明的字符集解码。
 *
 * 中文站点仍有不少 GBK/GB2312，当 UTF-8 读会整页乱码，而乱码进了向量库
 * 是检索不回来的死数据。优先用 HTTP 头的 charset，没有就从 meta 标签里找
 * （先按 latin1 窥探前 2KB，这个范围内标签是 ASCII，够读出 charset）。
 */
function decodeHtml(buf: ArrayBuffer, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  let charset = fromHeader?.toLowerCase();

  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
    charset = (
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
      || /charset=([\w-]+)/i.exec(head)?.[1]
    )?.toLowerCase();
  }

  if (!charset || charset === 'utf-8' || charset === 'utf8') {
    return new TextDecoder('utf-8').decode(buf);
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    // 认不出的字符集退回 UTF-8，总比抛错丢掉整页好。
    return new TextDecoder('utf-8').decode(buf);
  }
}

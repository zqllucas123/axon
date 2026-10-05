/**
 * 网页抓取单测。
 * 全程 mock 全局 fetch —— 测试不许真打网络，否则会因离线或站点改版而假红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWebPage, isHttpUrl } from '../src/ingest/fetch-web.ts';

const realFetch = globalThis.fetch;

/** 造一个最小可用的 Response 替身。 */
function mockResponse(opts: {
  body?: string | ArrayBuffer;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  contentLength?: string;
  url?: string;
}): Response {
  const {
    body = '', status = 200, statusText = 'OK',
    contentType = 'text/html; charset=utf-8', contentLength, url = 'https://example.com/',
  } = opts;
  const buf = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
  const headers = new Map<string, string>();
  if (contentType) headers.set('content-type', contentType);
  if (contentLength) headers.set('content-length', contentLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    url,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => buf,
  } as unknown as Response;
}

beforeEach(() => { globalThis.fetch = vi.fn(); });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('isHttpUrl', () => {
  it('识别 http 与 https', () => {
    expect(isHttpUrl('http://a.com')).toBe(true);
    expect(isHttpUrl('https://a.com')).toBe(true);
    expect(isHttpUrl('HTTPS://A.COM')).toBe(true);
  });

  it('本地路径与其他协议不算', () => {
    expect(isHttpUrl('/path/to/file.html')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('./rel.html')).toBe(false);
  });
});

describe('fetchWebPage', () => {
  it('正常返回 HTML 与最终 URL', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: '<html><body><p>你好</p></body></html>' }),
    );
    const { html, finalUrl } = await fetchWebPage('https://example.com/');
    expect(html).toContain('你好');
    expect(finalUrl).toBe('https://example.com/');
  });

  it('跟随重定向后返回真实 URL', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: '<p>x</p>', url: 'https://example.com/final' }),
    );
    const { finalUrl } = await fetchWebPage('https://example.com/start');
    expect(finalUrl).toBe('https://example.com/final');
  });

  it('带真实浏览器 UA（无 UA 的请求常被 403）', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse({ body: '<p>x</p>' }));
    await fetchWebPage('https://example.com/');
    const init = vi.mocked(globalThis.fetch).mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('Mozilla/5.0');
  });

  it('非法网址直接报错', async () => {
    await expect(fetchWebPage('不是网址')).rejects.toThrow('不是合法的网址');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('拒绝 file: 协议（在主进程里等于任意文件读取）', async () => {
    await expect(fetchWebPage('file:///etc/passwd')).rejects.toThrow('只支持 http/https');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('HTTP 错误状态带上状态码', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ status: 404, statusText: 'Not Found' }),
    );
    await expect(fetchWebPage('https://example.com/x')).rejects.toThrow('HTTP 404');
  });

  it('二进制 content-type 被拦下', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ contentType: 'application/zip' }),
    );
    await expect(fetchWebPage('https://example.com/a.zip')).rejects.toThrow('不是网页');
  });

  it('缺失 content-type 仍放行（不少站点不发这个头）', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: '<p>内容</p>', contentType: null }),
    );
    await expect(fetchWebPage('https://example.com/')).resolves.toMatchObject({
      html: expect.stringContaining('内容'),
    });
  });

  it('content-length 超限时不读 body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ contentLength: String(20 * 1024 * 1024) }),
    );
    await expect(fetchWebPage('https://example.com/')).rejects.toThrow('超过 8MB');
  });

  it('content-length 撒谎时按实际字节兜住', async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: big.buffer, contentLength: '100' }),
    );
    await expect(fetchWebPage('https://example.com/')).rejects.toThrow('超过 8MB');
  });

  it('网络故障报出主机名', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchWebPage('https://down.example.com/')).rejects.toThrow('down.example.com');
  });

  it('超时报超时而不是泛化失败', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    vi.mocked(globalThis.fetch).mockRejectedValue(abort);
    await expect(fetchWebPage('https://slow.example.com/')).rejects.toThrow('抓取超时');
  });

  it('按 HTTP 头的 charset 解码 GBK', async () => {
    // GBK 的「中文」= D6 D0 CE C4，当 UTF-8 读会整页乱码。
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: gbk.buffer, contentType: 'text/html; charset=gbk' }),
    );
    const { html } = await fetchWebPage('https://example.cn/');
    expect(html).toBe('中文');
  });

  it('HTTP 头没 charset 时从 meta 标签找', async () => {
    const head = new TextEncoder().encode('<meta charset="gbk">');
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const merged = new Uint8Array(head.length + gbk.length);
    merged.set(head, 0);
    merged.set(gbk, head.length);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: merged.buffer, contentType: 'text/html' }),
    );
    const { html } = await fetchWebPage('https://example.cn/');
    expect(html).toContain('中文');
  });

  it('认不出的字符集退回 UTF-8 而不是抛错', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: '正文', contentType: 'text/html; charset=x-unknown-9000' }),
    );
    const { html } = await fetchWebPage('https://example.com/');
    expect(html).toBe('正文');
  });
});

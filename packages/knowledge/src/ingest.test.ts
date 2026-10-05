/**
 * ingest 摄入器单测
 */

import { describe, expect, it } from 'vitest';
import { ingestMd } from '../src/ingest/md.ts';
import { ingestHtml } from '../src/ingest/html.ts';

describe('ingestMd', () => {
  it('从 h1 标题提取 title', async () => {
    const md = '# 我的文档\n\n这是一段内容。';
    const pages = await ingestMd(md, '/path/to/doc.md');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe('我的文档');
  });

  it('无标题时用 sourceRef 的文件名', async () => {
    const md = '这是没有标题的内容。';
    const pages = await ingestMd(md, '/some/path/readme.md');
    expect(pages[0]!.title).toBe('readme.md');
  });

  it('去除 Markdown 语法符号', async () => {
    const md = '# 标题\n\n**粗体** 和 _斜体_ 以及 [链接](http://example.com)';
    const pages = await ingestMd(md, 'test.md');
    expect(pages[0]!.pageContent).not.toContain('**');
    expect(pages[0]!.pageContent).not.toContain('_');
    expect(pages[0]!.pageContent).not.toContain('[链接]');
    expect(pages[0]!.pageContent).toContain('粗体');
    expect(pages[0]!.pageContent).toContain('链接');
  });

  it('保留代码块内容但移除围栏', async () => {
    const md = '# 示例\n\n```js\nconsole.log("hello")\n```';
    const pages = await ingestMd(md, 'test.md');
    expect(pages[0]!.pageContent).toContain('console.log');
    expect(pages[0]!.pageContent).not.toContain('```');
  });
});

describe('ingestHtml', () => {
  it('提取 <title> 标签内容', async () => {
    const html = '<html><head><title>测试页面</title></head><body><p>内容</p></body></html>';
    const pages = await ingestHtml(html, 'http://example.com');
    expect(pages[0]!.title).toBe('测试页面');
  });

  it('过滤掉 <script> 和 <style> 内容', async () => {
    const html = `<html><body>
      <script>var x = 1;</script>
      <style>.foo { color: red; }</style>
      <p>正文内容</p>
    </body></html>`;
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.pageContent).not.toContain('var x');
    expect(pages[0]!.pageContent).not.toContain('.foo');
    expect(pages[0]!.pageContent).toContain('正文内容');
  });

  it('空 body 时返回空数组', async () => {
    const html = '<html><body></body></html>';
    const pages = await ingestHtml(html, 'test');
    expect(pages).toHaveLength(0);
  });

  it('无 title 时用 h1', async () => {
    const html = '<html><body><h1>主标题</h1><p>内容</p></body></html>';
    const pages = await ingestHtml(html, 'http://example.com/page');
    expect(pages[0]!.title).toBe('主标题');
  });

  it('相邻块级元素之间不粘连', async () => {
    // cheerio 的 .text() 会把这两段拼成「第一段第二段」，
    // 句子粘连会让 chunker 切在句子中间。
    const html = '<html><body><p>第一段。</p><p>第二段。</p></body></html>';
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.pageContent).not.toContain('第一段。第二段。');
    expect(pages[0]!.pageContent).toContain('第一段。');
    expect(pages[0]!.pageContent).toContain('第二段。');
  });

  it('有 <main> 时只取 main 内容，丢掉导航与页脚', async () => {
    const body = '这是文章的正文部分，需要足够长才会被认定为有实质内容的容器。'.repeat(8);
    const html = `<html><body>
      <nav>首页 关于 联系我们</nav>
      <div class="sidebar">相关推荐 热门文章</div>
      <main><p>${body}</p></main>
      <footer>版权所有 2026</footer>
    </body></html>`;
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.pageContent).toContain('这是文章的正文部分');
    expect(pages[0]!.pageContent).not.toContain('关于');
    expect(pages[0]!.pageContent).not.toContain('版权所有');
    expect(pages[0]!.pageContent).not.toContain('热门文章');
  });

  it('<main> 是空壳时退回 body', async () => {
    // SPA 的典型形态：<main> 只是挂载点，内容在别处。
    const html = '<html><body><main id="root"></main><p>服务端渲染的正文</p></body></html>';
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.pageContent).toContain('服务端渲染的正文');
  });

  it('title 优先用 og:title', async () => {
    const html = `<html><head>
      <title>站点名 - 文章标题</title>
      <meta property="og:title" content="文章标题">
    </head><body><p>内容</p></body></html>`;
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.title).toBe('文章标题');
  });

  it('meta description 并入正文开头', async () => {
    const html = `<html><head>
      <title>页面</title>
      <meta name="description" content="这是页面摘要">
    </head><body><p>正文</p></body></html>`;
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.pageContent).toContain('这是页面摘要');
  });

  it('压掉源码缩进产生的空白', async () => {
    const html = '<html><body>\n    <p>内容    带    空格</p>\n\n\n\n    <p>第二段</p>\n</body></html>';
    const pages = await ingestHtml(html, 'test');
    expect(pages[0]!.pageContent).not.toMatch(/ {2,}/);
    expect(pages[0]!.pageContent).not.toMatch(/\n{3,}/);
  });
});

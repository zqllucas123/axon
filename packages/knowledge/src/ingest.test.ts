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
});

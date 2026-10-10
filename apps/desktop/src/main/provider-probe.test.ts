/**
 * provider-probe 单测 —— 「测试连接」到底打了哪个端点。
 *
 * 这一层为什么值得测：探测端点选错时，网关给的是一个 400 + 一句「model not
 * supported」，界面把它原样报成「连接失败」。用户看到的是 baseUrl/key 像错的，
 * 于是去改一个本来没错的配置 —— 2026-10-10 实测 `text-embedding-v3` 就是栽在这里。
 * 所以「向量模型必须打 /embeddings」要钉死在测试里，而不是靠注释提醒。
 *
 * 用真 fetch 替身而不是网络：断言的是 URL 与 body，不是网关的行为。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
let calls: { url: string; body: Record<string, unknown> | null }[] = [];
let respond: () => Response;

/** 每次新建临时配置：CONFIG_PATH 是模块级常量，所以必须先设 env 再 import。 */
async function withConfig(config: unknown): Promise<typeof import('./provider-probe.ts')> {
  const dir = await mkdtemp(join(tmpdir(), 'axon-probe-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
  process.env.AXON_CONFIG = path;
  vi.resetModules(); // 让 model-config.ts 重新读一次 AXON_CONFIG
  return await import('./provider-probe.ts');
}

const embeddingGateway = {
  providers: [
    {
      id: 'ali',
      name: 'Ali',
      baseUrl: 'https://ws.example.com/compatible-mode/v1',
      apiKey: 'sk-plain-test',
      models: [{ id: 'text-embedding-v3', kind: 'embedding' }],
    },
  ],
};

const chatGateway = {
  providers: [
    {
      id: 'kotei',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-plain-test',
      models: [{ id: 'qwen3-max' }],
    },
  ],
};

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url: String(url), body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
    return respond();
  }) as typeof fetch;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.AXON_CONFIG;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('probeProvider · 按模型类型选端点', () => {
  it('向量模型打 /embeddings（body 用 input）—— 打 chat/completions 会恒 400', async () => {
    const { probeProvider } = await withConfig(embeddingGateway);
    const res = await probeProvider('text-embedding-v3', 'ali', 'embedding');

    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://ws.example.com/compatible-mode/v1/embeddings');
    expect(calls[0]?.body).toMatchObject({ model: 'text-embedding-v3', input: 'ping' });
    // 不能带上 chat 专有字段：网关会以「未知参数」为由 400
    expect(calls[0]?.body).not.toHaveProperty('messages');
  });

  it('对话模型仍打 /chat/completions，且不带 kind 时默认按对话处理', async () => {
    const { probeProvider } = await withConfig(chatGateway);
    await probeProvider('qwen3-max', 'kotei');

    expect(calls[0]?.url).toBe('https://gw.example.com/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({ model: 'qwen3-max', max_tokens: 1 });
  });

  it('只挂向量模型的网关仍能探测 —— 不因「对话侧被跳过」而报提供商不可用', async () => {
    const { probeProvider } = await withConfig(embeddingGateway);
    const res = await probeProvider('text-embedding-v3', 'ali', 'embedding');
    expect(res.error).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('baseUrl 不含版本段时补 /v1 再退一步试 /（网关两种写法都有）', async () => {
    const { probeProvider } = await withConfig({
      providers: [{ id: 'k', baseUrl: 'https://gw.example.com/compatible-mode', apiKey: 'sk-plain-test', models: [{ id: 'm' }] }],
    });
    await probeProvider('m', 'k');
    expect(calls.map((c) => c.url)).toEqual([
      'https://gw.example.com/compatible-mode/v1/chat/completions',
    ]);
  });
});

describe('probeProvider · 拉取模型列表', () => {
  it('不传 model 时 GET /models（无 body）', async () => {
    respond = () =>
      new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 });
    const { probeProvider } = await withConfig(chatGateway);
    const res = await probeProvider(undefined, 'kotei');

    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['a', 'b']);
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/models');
    expect(calls[0]?.body).toBeNull();
  });

  it('刚加好的空网关也能拉列表 —— 「先测通再拉模型」是最自然的顺序', async () => {
    const { probeProvider } = await withConfig({
      providers: [{ id: 'fresh', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-plain-test' }],
    });
    const res = await probeProvider(undefined, 'fresh');
    expect(res.error).toBeUndefined();
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/models');
  });

  it('非 2xx 带上响应体片段 —— 「模型名错」和「鉴权失败」只能靠它区分', async () => {
    respond = () => new Response('{"error":{"message":"model not found"}}', { status: 404 });
    const { probeProvider } = await withConfig(embeddingGateway);
    const res = await probeProvider('nope', 'ali', 'embedding');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('HTTP 404');
    expect(res.error).toContain('model not found');
  });
});

describe('probeProvider · 找不到网关', () => {
  it('providerId 打错就说清楚，不静默打到别的网关', async () => {
    const { probeProvider } = await withConfig(chatGateway);
    const res = await probeProvider('qwen3-max', 'typo');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('typo');
    expect(calls).toHaveLength(0);
  });

  it('缺 apiKey 时直接报，不发一个注定 401 的请求', async () => {
    const { probeProvider } = await withConfig({
      providers: [{ id: 'k', baseUrl: 'https://gw.example.com/v1', models: [{ id: 'm' }] }],
    });
    const res = await probeProvider('m', 'k');
    expect(res.error).toContain('apiKey');
    expect(calls).toHaveLength(0);
  });
});
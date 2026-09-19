/**
 * Provider 连接探测 —— M6「测试连接」的主进程实现。
 *
 * 为什么独立一个文件而不放 model-config.ts：
 * 探测逻辑需要发 HTTP，而 model-config.ts 是纯函数（无 I/O 除了读文件），
 * 两者混在一起会让 contract 测试也依赖网络。
 *
 * ── W-C 需要在 index.ts 里注册 ──────────────────────────────────
 *
 * import { probeProvider } from './provider-probe.ts';
 *
 * 在 ipcMain.handle(IPC_COMMAND_CHANNEL, ...) 的 try 块里，
 * 加在 `const result = await host!.execute(...)` 之前：
 *
 *   if (request.command === 'provider.test') {
 *     const result = await probeProvider();
 *     return { id: request.id, ok: true, result };
 *   }
 *
 * ────────────────────────────────────────────────────────────────
 */

import { loadConfig, resolveModelChoice } from './model-config.ts';
import { getKey } from './keychain.ts';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  error?: string;
}

/**
 * 向单个 URL 发 GET，解析 models 列表。
 *
 * 只负责一次请求；URL 轮换策略在调用方。
 * 2xx 才算成功；非 2xx 返回 ok=false 但不抛（HTTP 错误是正常结果）。
 * 网络层错误（ECONNREFUSED / abort）会向上抛，由调用方处理 fallback / 超时。
 */
async function tryUrl(
  url: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    return {
      ok: false,
      latencyMs,
      models: [],
      error: `HTTP ${res.status} ${res.statusText}`,
    };
  }

  let models: string[] = [];
  try {
    const json = (await res.json()) as Record<string, unknown>;
    // OpenAI 格式：{ data: [{ id, ... }] }
    // 部分网关格式：{ models: [{ id, ... }] }
    const arr: unknown[] = Array.isArray(json['data'])
      ? (json['data'] as unknown[])
      : Array.isArray(json['models'])
        ? (json['models'] as unknown[])
        : [];
    models = arr
      .map((m) =>
        typeof m === 'object' && m !== null && 'id' in m
          ? String((m as { id: unknown }).id)
          : '',
      )
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    // JSON 解析失败也算连通（2xx 已收到），models 留空即可
  }

  return { ok: true, latencyMs, models };
}

/**
 * 对单个模型发一次极小的 chat/completions 探测。
 *
 * 为什么不用 /models 判可用性：不少 OpenAI 兼容网关没实现 /v1/models（或权限
 * 不同），但 /chat/completions 完全可用；模型能不能用只有真跑一次才作数。
 * body 用 max_tokens=1 + 一个字的 prompt，把开销压到最低。
 * 2xx 视为可用；非 2xx（401/403/404 等）视为「可达但该模型不可用」。
 */
async function tryChat(
  url: string,
  apiKey: string,
  model: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
    signal,
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    // 带上响应体片段，方便判断是「模型名错」还是「鉴权失败」等
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* 忽略读体失败 */
    }
    return {
      ok: false,
      latencyMs,
      models: [],
      error: `HTTP ${res.status} ${res.statusText}${detail ? ` · ${detail}` : ''}`,
    };
  }

  return { ok: true, latencyMs, models: [model] };
}

/** 解析出可用的网关配置（含 keychain 注入的 apiKey）；faux 时返回 error。 */
async function resolveEffective(): Promise<
  | { ok: true; baseUrl: string; apiKey: string }
  | { ok: false; error: string }
> {
  const { config } = await loadConfig();
  // keychain 迁移后 config.json 里已无明文 apiKey，从 keychain 解密后注入，
  // 否则 resolveModelChoice 会误判「未配置 apiKey」而降级到 faux（测试连接永远失败）。
  const plainKey = getKey('provider.apiKey');
  const effective = plainKey
    ? { ...config, provider: { ...(config.provider ?? {}), apiKey: plainKey } }
    : config;
  const choice = resolveModelChoice(effective);
  if (choice.kind === 'faux') return { ok: false, error: choice.reason };
  return { ok: true, baseUrl: choice.baseUrl, apiKey: choice.apiKey };
}

/**
 * 测试当前配置的网关连通性。
 *
 * - 传 `model` → 对该模型发一次 chat/completions 真探测（单模型「测试」按钮用）。
 * - 不传 → GET /models 拉取网关模型清单（「拉取模型列表」用）。
 *
 * 流程：
 * 1. resolveEffective() 读配置 + 从 keychain 注入 apiKey
 * 2. faux → 直接返回失败原因，不发网络请求
 * 3. 根据 baseUrl 是否已含 /v1 决定探测 URL（缺 /v1 时 fallback 补一次）
 * 4. 超时 15000ms（chat 探测可能比列表慢；AbortController + setTimeout）
 * 5. HTTP 非 2xx（如 403）视为「连通但有问题」，不再 fallback
 */
export async function probeProvider(model?: string): Promise<ProbeResult> {
  const resolved = await resolveEffective();
  if (!resolved.ok) return { ok: false, latencyMs: 0, models: [], error: resolved.error };

  const { baseUrl, apiKey } = resolved;
  // 剥末尾斜杠，防止拼出 https://host//models
  const base = baseUrl.replace(/\/+$/, '');
  const path = model ? 'chat/completions' : 'models';

  // baseUrl 已含 /v1 结尾则不重复拼；否则优先试 /v1/… 再 fallback 到 /…
  const urls: string[] = base.endsWith('/v1')
    ? [`${base}/${path}`]
    : [`${base}/v1/${path}`, `${base}/${path}`];

  const timeoutMs = model ? 15000 : 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let lastError = '未知错误';
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;
      try {
        const result = model
          ? await tryChat(url, apiKey, model, controller.signal)
          : await tryUrl(url, apiKey, controller.signal);
        // 2xx 成功，直接返回
        if (result.ok) return result;
        // HTTP 非 2xx：认为服务可达但有问题（如认证失败），不再 fallback
        return result;
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          return { ok: false, latencyMs: timeoutMs, models: [], error: `请求超时（${timeoutMs / 1000}s）` };
        }
        // 网络层错误（ECONNREFUSED、DNS 失败等）：记录错误，继续试下一个 URL
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false, latencyMs: 0, models: [], error: lastError };
  } finally {
    clearTimeout(timer);
  }
}

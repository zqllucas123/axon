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
 * 测试当前配置的网关连通性。
 *
 * 流程：
 * 1. loadConfig() 读取 ~/.axon/config.json（不直接访问文件）
 * 2. resolveModelChoice 返回 faux → 直接返回失败原因，不发网络请求
 * 3. 根据 baseUrl 是否已含 /v1 决定探测 URL：
 *    - 已含 /v1 结尾 → 只试 `${base}/models`
 *    - 否则 → 先试 `${base}/v1/models`，网络层错误时 fallback 到 `${base}/models`
 * 4. 超时 8000ms（AbortController + setTimeout）
 * 5. HTTP 非 2xx（如 403）视为「连通但认证失败」，不再 fallback
 */
export async function probeProvider(): Promise<ProbeResult> {
  const { config } = await loadConfig();
  const choice = resolveModelChoice(config);

  if (choice.kind === 'faux') {
    return { ok: false, latencyMs: 0, models: [], error: choice.reason };
  }

  const { baseUrl, apiKey } = choice;
  // 剥末尾斜杠，防止拼出 https://host//models
  const base = baseUrl.replace(/\/+$/, '');

  // baseUrl 已含 /v1 结尾则不重复拼；否则优先试 /v1/models 再 fallback 到 /models
  const urls: string[] = base.endsWith('/v1')
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    let lastError = '未知错误';
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;
      try {
        const result = await tryUrl(url, apiKey, controller.signal);
        // 2xx 成功，直接返回
        if (result.ok) return result;
        // HTTP 非 2xx：认为服务可达但有问题（如认证失败），不再 fallback
        return result;
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          return { ok: false, latencyMs: 8000, models: [], error: '请求超时（8s）' };
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

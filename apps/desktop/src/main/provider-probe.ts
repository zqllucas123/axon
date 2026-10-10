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

import { parseModelRef, type ProviderConfig } from '@axon/protocol';
import { loadConfig } from './model-config.ts';
import { getKey } from './keychain.ts';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  error?: string;
}

/**
 * 探测哪种端点。
 *
 * 必须由调用方按 `ModelSpec.kind` 显式给出，不能在主进程按模型名猜：
 * `text-embedding-v3` 这类名字一眼可辨，但自建网关的向量模型叫什么都可能
 * （`bge-m3`、`vec-1`、`embed`），猜错就是把「端点不存在」当成「配置错」报给用户。
 */
export type ProbeKind = 'chat' | 'embedding';

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
 * 向一个端点 POST 探测体；2xx 视为可用，非 2xx 视为「可达但该模型不可用」。
 *
 * chat 与 embedding 两种探测只差 URL 与 body，共用一个实现：非 2xx 时要带上
 * 响应体片段 —— 判断「模型名错」还是「鉴权失败」全靠它。
 */
async function tryPost(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
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

  return { ok: true, latencyMs, models: [String(body['model'])] };
}

/**
 * 对话模型探测：POST /chat/completions，一个字的 prompt + max_tokens=1，开销最低。
 *
 * 为什么不用 /models 判可用性：不少 OpenAI 兼容网关没实现 /v1/models（或权限
 * 不同），但 /chat/completions 完全可用；模型能不能用只有真跑一次才作数。
 */
function tryChat(url: string, apiKey: string, model: string, signal: AbortSignal): Promise<ProbeResult> {
  return tryPost(
    url,
    apiKey,
    { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
    signal,
  );
}

/**
 * 向量模型探测：POST /embeddings，input 一个单字串。
 *
 * 为什么不能沿用 tryChat：向量模型**没有** /chat/completions 端点，拿 chat 探它
 * 恒 400（阿里百炼 `text-embedding-v3` 实测），界面于是报「连接失败」——
 * 用户看到的是 baseUrl/key 像错的，实际错的是探测端点。
 */
function tryEmbed(url: string, apiKey: string, model: string, signal: AbortSignal): Promise<ProbeResult> {
  return tryPost(url, apiKey, { model, input: 'ping' }, signal);
}

/**
 * 解析出要探测的那个网关（含 keychain 注入的 apiKey）；不可用时返回 error。
 *
 * `providerId` 来自 UI：设置页每个 provider 卡片上的「测试 / 拉取模型列表」都要
 * 打到**自己**那一行，不能统一打默认 provider —— 否则新加的网关永远测不到。
 * 不传时回落到默认 provider（`defaultModelRef` 指向的那个），兼容无 id 的旧调用。
 *
 * **刻意不走 `resolveModelChoice`**：那是「这次会话用哪个模型」的结论，模型清单为空
 * 或清单里只剩向量模型的 provider 都会被它跳过。而探测只关心「这个网关通不通」——
 * 走它会让两个真实场景恒失败：(1) 刚加好的空网关测不了（而「先测通再拉模型列表」
 * 正是自然顺序）；(2) 只挂向量模型的网关测不了（那恰恰是知识库要用的那个）。
 */
async function resolveEffective(providerId?: string): Promise<
  | { ok: true; baseUrl: string; apiKey: string }
  | { ok: false; error: string }
> {
  const { config } = await loadConfig();
  // legacy 单 provider 形状兜底：迁移前的 config.json 只有 `provider{}`。
  const list: ProviderConfig[] = config.providers?.length
    ? config.providers
    : config.provider
      ? [{ ...config.provider, id: config.provider.id || 'default' }]
      : [];

  // keychain 迁移后 config.json 里已无明文 apiKey，逐个从 keychain 解密后注入。
  // env 覆盖只作用于第一个 provider（与 resolveModelChoice 的覆盖范围严格一致，
  // 设置页「被环境变量锁定」的标注也是这个口径）。
  const providers = list.map((p, i) => {
    const id = p.id || 'default';
    const plain = getKey(`providerKeys.${id}.apiKey`);
    return {
      id,
      baseUrl: (i === 0 ? process.env.AXON_BASE_URL : undefined) || p.baseUrl,
      apiKey: (i === 0 ? process.env.AXON_API_KEY : undefined) || plain || p.apiKey,
    };
  });

  // 指定了 id 就必须命中它；命中不了是真错误（UI 上那张卡片还没存盘，或 id 打错），
  // 静默回落到别的 provider 会让用户看到「测试通过」却测的是另一个网关。
  const wanted = providerId
    ? providers.find((p) => p.id === providerId)
    : providers.find((p) => p.id === parseModelRef(config.defaultModelRef ?? '')?.providerId) ??
      providers[0];
  if (!wanted) {
    return { ok: false, error: providerId ? `配置里没有提供商 ${providerId}` : '还没有配置任何模型提供商' };
  }
  if (!wanted.baseUrl) return { ok: false, error: `提供商 ${wanted.id} 缺 baseUrl` };
  if (!wanted.apiKey) return { ok: false, error: `提供商 ${wanted.id} 缺 apiKey` };
  return { ok: true, baseUrl: wanted.baseUrl, apiKey: wanted.apiKey };
}

/**
 * 测试当前配置的网关连通性。
 *
 * - 传 `model` → 对该模型发一次真探测（单模型「测试」按钮用），端点由 `kind` 决定：
 *   `'embedding'` 打 /embeddings，其余打 /chat/completions。
 * - 不传 → GET /models 拉取网关模型清单（「拉取模型列表」用）。
 *
 * 流程：
 * 1. resolveEffective() 读配置 + 从 keychain 注入 apiKey
 * 2. 网关拿不到（id 打错 / 缺 baseUrl / 缺 apiKey）→ 直接返回原因，不发网络请求
 * 3. 根据 baseUrl 是否已含 /v1 决定探测 URL（缺 /v1 时 fallback 补一次）
 * 4. 超时 15000ms（chat 探测可能比列表慢；AbortController + setTimeout）
 * 5. HTTP 非 2xx（如 403）视为「连通但有问题」，不再 fallback
 */
export async function probeProvider(
  model?: string,
  providerId?: string,
  kind: ProbeKind = 'chat',
): Promise<ProbeResult> {
  const resolved = await resolveEffective(providerId);
  if (!resolved.ok) return { ok: false, latencyMs: 0, models: [], error: resolved.error };

  const { baseUrl, apiKey } = resolved;
  // 剥末尾斜杠，防止拼出 https://host//models
  const base = baseUrl.replace(/\/+$/, '');
  const path = model ? (kind === 'embedding' ? 'embeddings' : 'chat/completions') : 'models';

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
          ? kind === 'embedding'
            ? await tryEmbed(url, apiKey, model, controller.signal)
            : await tryChat(url, apiKey, model, controller.signal)
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

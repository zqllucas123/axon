/**
 * 模型配置的读取与解析 —— 决定「这次运行用 faux 还是真模型」。
 *
 * ── 为什么配置要落在文件而不是环境变量 ──
 *
 * API key 走 env 有两个实际问题：(1) Electron 从 Finder 双击启动时拿不到
 * shell 的环境变量，用户只能从终端起应用；(2) 一个网关往往挂着多个模型，
 * env 表达不了「模型清单 + 默认模型 + 单价」这种结构。
 *
 * 所以真相是 `~/.axon/config.json`，env 只保留**覆盖**能力（CI / 冒烟脚本用）。
 *
 * ── key 的存放 ──
 *
 * v0.1 明文存 `~/.axon/config.json`（权限 0600），**不进 git**。
 * 系统 keychain 是 M6 正式接入时的事（03 §3 M6「API key 存放」），
 * 尖峰阶段引入 keytar 这类原生依赖会拖累打包链路，不值得。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatModelRef, resolveModelRef, type AxonConfig, type ProviderConfig } from '@axon/protocol';
import type { OpenAICompatModel } from '@axon/kernel';

/**
 * `AxonConfig` 的形状真相已搬到 `@axon/protocol`（config.ts）。
 *
 * 搬家的理由：设置界面（S8）与 `config.get/patch` 命令都要用它，而渲染层
 * 不能依赖主进程内部模块。这里保留 re-export，让既有调用点不必改 import。
 */
export type { AxonConfig };

/** 一个已解析完毕、可直接建 ModelSource 的 provider 规格。 */
export interface ResolvedProvider {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  models: OpenAICompatModel[];
  /** provider 内默认模型（裸 id）。 */
  defaultModel: string;
  headers?: Record<string, string>;
}

/**
 * 解析结果：要么用 faux，要么给出 **N 份**可用的真 provider 规格。
 *
 * M15 起 `providers` 是数组：一个 pi registry 能装多个 provider，
 * `stream()` 按 `model.provider` 自己路由（`pi-ai/dist/models.js:352,380`），
 * 所以多网关不需要多个 ModelSource，只需要多条 provider 注册。
 *
 * `defaultRef` 是 `providerId:modelId` 复合键 —— 两个网关挂同名模型是常态，
 * 裸 id 无法寻址（见 protocol 的 `formatModelRef`）。
 */
export type ModelChoice =
  | { kind: 'faux'; reason: string }
  | {
      kind: 'openai-compat';
      providers: ResolvedProvider[];
      /** 全局默认模型的复合键 `providerId:modelId`，保证能在 providers 里解到。 */
      defaultRef: string;
    };

export const CONFIG_PATH = process.env.AXON_CONFIG || join(homedir(), '.axon', 'config.json');

/** 读配置文件。不存在 / 坏 JSON 都不抛 —— 降级到 faux 比启动失败好。 */
export async function loadConfig(path = CONFIG_PATH): Promise<{ config: AxonConfig; error?: string }> {
  try {
    return { config: JSON.parse(await readFile(path, 'utf8')) as AxonConfig };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { config: {} };
    return { config: {}, error: `读取 ${path} 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 配置 + 环境变量 → 模型选择。纯函数，env 显式传入以便测试。
 *
 * 优先级：env 覆盖 > 配置文件。`AXON_PROVIDER=faux` 是逃生门 ——
 * 配置已写好但想临时跑假模型时用，不用来回改文件。
 */
export function resolveModelChoice(
  config: AxonConfig,
  env: Record<string, string | undefined> = process.env,
): ModelChoice {
  if (env.AXON_PROVIDER === 'faux') return { kind: 'faux', reason: 'AXON_PROVIDER=faux 显式指定' };

  // legacy 形状兜底：`ConfigStore.load()` 会把 `provider{}` 迁成 `providers[]`，
  // 但这个函数也被不过 store 的调用点直接用（测试、provider-probe），所以这里也接一手。
  const list: ProviderConfig[] = config.providers?.length
    ? config.providers
    : config.provider
      ? [{ ...config.provider, id: config.provider.id || 'default' }]
      : [];
  if (!list.length) {
    return { kind: 'faux', reason: '没有任何已配置的模型提供商，降级到 faux' };
  }

  // env 覆盖只作用于**第一个** provider（= 设置页里的默认那个）：
  // CI 与冒烟脚本靠 AXON_BASE_URL/AXON_API_KEY/AXON_MODEL 注入单网关，
  // 让它扫过所有 provider 会把用户真实配置也一起改写。
  const envModel = env.AXON_MODEL;
  const resolved: ResolvedProvider[] = [];
  const skipped: string[] = [];

  for (const [i, p] of list.entries()) {
    const isDefaultProvider = i === 0;
    const baseUrl = (isDefaultProvider ? env.AXON_BASE_URL : undefined) || p.baseUrl;
    const apiKey = (isDefaultProvider ? env.AXON_API_KEY : undefined) || p.apiKey;
    const id = p.id || 'default';
    if (!baseUrl || !apiKey) {
      skipped.push(`${id}（缺 baseUrl 或 apiKey）`);
      continue;
    }

    // env 只能指定模型 id；单价等元数据仍从配置里取（取不到就用 kernel 的默认值）。
    const models = p.models?.length ? p.models : [];
    const merged =
      isDefaultProvider && envModel && !models.some((m) => m.id === envModel)
        ? [{ id: envModel }, ...models]
        : models;
    if (!merged.length) {
      skipped.push(`${id}（模型清单为空）`);
      continue;
    }

    // defaultModel 写错（不在清单）时回落到清单首个，而不是把整个 provider 丢掉。
    // M15 的权衡：单 provider 时代「写错就降级 faux」还能接受，多网关下一个 typo
    // 会连带掐掉其他好网关；回落 + 告警让用户仍能开工，错配也不至于无声无息。
    const within = (isDefaultProvider ? envModel : undefined) || p.defaultModel || merged[0]!.id;
    let defaultModel = within;
    if (!merged.some((m) => m.id === within)) {
      defaultModel = merged[0]!.id;
      console.warn(`[M15] ${id} 的 defaultModel=${within} 不在模型清单内，回落 ${defaultModel}`);
    }

    // M6：cost 全零告警。cost 字段缺失或全为 0 时，pi 算出的 `usage.cost.total`
    // 恒为零 —— 用量屏与顶栏的金额会一直是 $0.000，用户以为没花钱。
    // （原先这条告警的理由是「预算熔断静默失效」，熔断已于 2026-10-10 下线。）
    // 这里只 warn 不降级——模型可能确实免费，不该强制要求填单价。
    for (const m of merged) {
      const c = m.cost;
      if (!c || Object.values(c).every((v) => !v)) {
        console.warn(
          `[M6] ${id}/${m.id} cost 字段全零或缺失，用量金额将恒显示 $0.000。` +
            `请在 ~/.axon/config.json 的 providers[].models 里补充 cost（单位：美元/百万 token）。`,
        );
      }
    }

    resolved.push({
      providerId: id,
      providerName: p.name || id,
      baseUrl,
      apiKey,
      models: merged,
      defaultModel,
      ...(p.headers ? { headers: p.headers } : {}),
    });
  }

  if (!resolved.length) {
    return {
      kind: 'faux',
      reason: `已配置的提供商都不可用：${skipped.join('、')}，降级到 faux`,
    };
  }

  // 全局默认：配了 defaultModelRef 且能解到就用它，否则回落首个 provider 的内部默认。
  // 「解不到就回落」而不是降级 faux：删掉某个 provider 后 ref 会悬空，
  // 那时该让会话照常起来（provider.delete 会顺手改指，这里是双保险）。
  const first = resolved[0]!;
  const fallbackRef = formatModelRef(first.providerId, first.defaultModel);
  const wanted = config.defaultModelRef;
  let defaultRef = fallbackRef;
  if (wanted) {
    const hit = resolveModelRef(
      resolved.map((r) => ({ id: r.providerId, models: r.models })),
      wanted,
    );
    if (hit) defaultRef = formatModelRef(hit.provider.id, hit.model.id);
    else console.warn(`[M15] defaultModelRef=${wanted} 解析不到，回落 ${fallbackRef}`);
  }

  return { kind: 'openai-compat', providers: resolved, defaultRef };
}

/** 日志用：绝不能把 key 原样打出来。 */
export function maskKey(key: string): string {
  return key.length <= 8 ? '***' : `${key.slice(0, 3)}***${key.slice(-3)}`;
}

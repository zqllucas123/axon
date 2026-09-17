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
import type { AxonConfig } from '@axon/protocol';
import type { OpenAICompatModel } from '@axon/kernel';

/**
 * `AxonConfig` 的形状真相已搬到 `@axon/protocol`（config.ts）。
 *
 * 搬家的理由：设置界面（S8）与 `config.get/patch` 命令都要用它，而渲染层
 * 不能依赖主进程内部模块。这里保留 re-export，让既有调用点不必改 import。
 */
export type { AxonConfig };

/** 解析结果：要么用 faux，要么给出一份完整可用的真 provider 规格。 */
export type ModelChoice =
  | { kind: 'faux'; reason: string }
  | {
      kind: 'openai-compat';
      providerId: string;
      providerName: string;
      baseUrl: string;
      apiKey: string;
      models: OpenAICompatModel[];
      defaultModel: string;
      headers?: Record<string, string>;
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

  const p = config.provider ?? {};
  const baseUrl = env.AXON_BASE_URL || p.baseUrl;
  const apiKey = env.AXON_API_KEY || p.apiKey;
  if (!baseUrl || !apiKey) {
    return { kind: 'faux', reason: '未配置 provider.baseUrl / provider.apiKey，降级到 faux' };
  }

  // env 只能指定模型 id；单价等元数据仍从配置里取（取不到就用 kernel 的默认值）。
  const models = p.models?.length ? p.models : [];
  const envModel = env.AXON_MODEL;
  const merged = envModel && !models.some((m) => m.id === envModel)
    ? [{ id: envModel }, ...models]
    : models;
  if (!merged.length) {
    return { kind: 'faux', reason: '配置了网关但没有任何模型（provider.models 为空），降级到 faux' };
  }

  const defaultModel = envModel || p.defaultModel || merged[0]!.id;
  if (!merged.some((m) => m.id === defaultModel)) {
    return { kind: 'faux', reason: `defaultModel=${defaultModel} 不在 models 清单里，降级到 faux` };
  }

  // M6：cost 全零告警。cost 字段缺失或全为 0 时 BudgetGuard 永远算不出花费，
  // 预算熔断静默失效。这里只 warn 不降级——模型可能确实免费，不该强制要求填单价。
  for (const m of merged) {
    const c = m.cost;
    const allZero = !c || Object.values(c).every((v) => !v);
    if (allZero) {
      console.warn(
        `[M6] models[${m.id}] cost 字段全零或缺失，BudgetGuard 将无法触发。` +
        `请在 ~/.axon/config.json 的 provider.models 里补充 cost（单位：美元/百万 token）。`,
      );
    }
  }

  return {
    kind: 'openai-compat',
    providerId: p.id ?? 'axon-gateway',
    providerName: p.name ?? p.id ?? 'Axon Gateway',
    baseUrl,
    apiKey,
    models: merged,
    defaultModel,
    ...(p.headers ? { headers: p.headers } : {}),
  };
}

/** 日志用：绝不能把 key 原样打出来。 */
export function maskKey(key: string): string {
  return key.length <= 8 ? '***' : `${key.slice(0, 3)}***${key.slice(-3)}`;
}

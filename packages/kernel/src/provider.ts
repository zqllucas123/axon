/**
 * L0 边界层 —— Axon 与 `pi-ai`（provider / model）的唯一接触面。
 *
 * 与 engine.ts 分开的理由：pi-ai 与 pi-agent-core 是**两个独立的包**，
 * 版本与破坏性变更各走各的（例如 0.81.0 把 `uuidv7` 的导出从 agent-core
 * 挪到了 ai）。混在一个文件里，升级时分不清哪半边在疼。
 *
 * ── 这一层顺带承担的一件事：懒加载不能被打包器破坏 ──
 *
 * `pi-ai` 的 44 个 provider 里，`@aws-sdk/client-bedrock-runtime`、
 * `@google/genai`、`@anthropic-ai/sdk`、`openai` 都是**硬依赖**（装了必在），
 * 但运行时是懒加载的（`pi-ai/dist/index.js:2` 只导出 `api/lazy.js`，
 * `lazy.js:46-49` 用动态 import）。
 *
 * 这意味着 Electron 打包时**必须**把 `@earendil-works/pi-ai` 标为 external，
 * 否则 bundler 会把动态 import 静态提升，四套 SDK 全进主进程包体。
 * 参见 `docs/02-调研补充与结论复核.md` §4 风险 B。
 */

import { createModels, createAssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export type { Model };

/**
 * `Type` 是定义工具参数 schema 用的 TypeBox 构造器，经由 pi-ai 转出。
 * 所有工具定义都要用它，所以必须从边界层再导出——
 * 否则每个写工具的地方都得 import pi，边界当场破功。
 */
export { Type } from '@earendil-works/pi-ai';

/** faux 消息构造器 —— 测试与示例里拼脚本化回复用。 */
export {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';

/**
 * 一个可用的模型来源：模型本身 + 驱动它的 streamFn。
 *
 * 打包成一个对象而非两个游离参数，是因为二者**必须配套** ——
 * 用 A 家的 model 配 B 家的 streamFn 不会在类型上报错，
 * 但会在运行时得到一堆莫名其妙的 400。
 */
export interface ModelSource {
  model: Model<any>;
  streamFn: StreamFn;
}

/** `createModels()` 的返回值类型（pi 未导出具名类型，从函数反推）。 */
export type ModelRegistry = ReturnType<typeof createModels>;

/** 建一个空的模型注册表。provider 由调用方按需装入。 */
export function createRegistry(): ModelRegistry {
  return createModels();
}

/**
 * 把注册表包成 streamFn。
 *
 * 注意 `streamFn` 在 pi 0.81.0 起是 `AgentOptions` 的**必填项**
 * （CHANGELOG 记录过一次「可选→必填→又加回 host fallback」的反复），
 * 所以这里始终显式提供，不依赖上游默认值。
 */
export function streamFnOf(registry: ModelRegistry): StreamFn {
  return (model, context, options) => registry.stream(model, context, options);
}

/**
 * 测试与示例用的假 provider —— 脚本化模型回复，零成本、无需 API key、可重复。
 *
 * 刻意放在生产代码里而非测试文件里：契约测试、示例、将来的编排层集成测试
 * 都要用它，散落三份必然走样。
 *
 * 用动态 import 是为了让打包器有机会把它摇掉（faux 只在开发期使用）。
 */
export async function createFauxSource(options?: {
  provider?: string;
}): Promise<ModelSource & { setResponses: (responses: unknown[]) => void }> {
  const { fauxProvider } = await import('@earendil-works/pi-ai');
  const faux = fauxProvider({ provider: options?.provider ?? 'axon-faux', api: 'faux' });
  const registry = createRegistry();
  registry.setProvider(faux.provider);

  return {
    model: faux.getModel(),
    streamFn: streamFnOf(registry),
    setResponses: (responses) => faux.setResponses(responses as never),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 真实模型接入（OpenAI 兼容网关）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 一个模型的最小声明。
 *
 * 为什么要手写而不是拉 pi 内置的 44 个 provider 目录：企业网关（如寒武智能/
 * 研究院网关）是**自定义 baseUrl + 自定义模型名**的组合，`/v1/models` 往往
 * 不实现（实测 kotei 网关返回 404），内置目录里也不会有这些模型 id。
 * 与其猜，不如让用户在配置里写清楚——写错了立刻 400，比静默走错模型强。
 *
 * `cost` 单位是**美元 / 百万 token**（pi 的 `calculateCost` 除以 1e6，
 * `pi-ai/dist/models.js:543-547`）。填 0 不会报错，只是预算熔断永远不触发。
 */
export interface OpenAICompatModel {
  id: string;
  name?: string;
  /** 模型是否会吐 reasoning/thinking 内容（如 deepseek-r1）。默认 false。 */
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

export interface OpenAICompatSpec {
  /** provider id，会出现在 assistant 消息的 `provider` 字段里。默认 `axon-gateway`。 */
  providerId?: string;
  providerName?: string;
  /** 网关根地址，形如 `https://host/path/v1`（不含 `/chat/completions`）。 */
  baseUrl: string;
  apiKey: string;
  models: OpenAICompatModel[];
  /** 默认模型 id；缺省用 models[0]。 */
  defaultModel?: string;
  headers?: Record<string, string>;
}

/** 默认值集中一处，免得三个调用点各写一套。 */
const MODEL_DEFAULTS = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

/**
 * 静态 key 的 ApiKeyAuth —— 不走 env、不走 credential store。
 *
 * pi 自带的 `envApiKeyAuth` 只认环境变量或已登录凭据（`auth/helpers.js:7-30`），
 * 而 Axon 的 key 来自 `~/.axon/config.json`（用户可编辑、可多网关），
 * 硬塞进 `process.env` 会污染子进程与日志。这里直接给一个常量 resolve。
 */
function staticApiKeyAuth(name: string, apiKey: string) {
  return {
    name,
    resolve: async () => ({
      auth: { apiKey },
      source: 'axon config',
    }),
    check: async () => ({ type: 'api_key' as const, source: 'axon config' }),
  };
}

/**
 * 建一个 OpenAI 兼容网关的 {@link ModelSource}。
 *
 * 走 `openAICompletionsApi()` 这条**懒 API**（`pi-ai/dist/api/openai-completions.lazy.js`）
 * 而不是直接 import 实现：`openai` SDK 有 ~40 个传递依赖，懒加载让它只在
 * 第一次真的发请求时才进内存。这条性质由 `scripts/verify-lazy-loading.mjs` 守着。
 *
 * 返回值多带一个 `selectModel`：同一个网关下按角色切模型（M6 的 per-role
 * model 映射）需要它，而 `ModelSource` 本身只装得下一个 model。
 */
export function createOpenAICompatSource(
  spec: OpenAICompatSpec,
): ModelSource & {
  models: Model<'openai-completions'>[];
  selectModel: (id: string) => ModelSource;
} {
  if (!spec.models.length) throw new Error('createOpenAICompatSource: models 不能为空');
  const providerId = spec.providerId ?? 'axon-gateway';
  // baseUrl 末尾斜杠会让 openai SDK 拼出 `//chat/completions`，部分网关 404。
  const baseUrl = spec.baseUrl.replace(/\/+$/, '');

  const models: Model<'openai-completions'>[] = spec.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: m.reasoning ?? false,
    input: ['text'],
    cost: { ...MODEL_DEFAULTS.cost, ...m.cost },
    contextWindow: m.contextWindow ?? MODEL_DEFAULTS.contextWindow,
    maxTokens: m.maxTokens ?? MODEL_DEFAULTS.maxTokens,
    ...(spec.headers ? { headers: spec.headers } : {}),
  }));

  const provider = createProvider<'openai-completions'>({
    id: providerId,
    name: spec.providerName ?? providerId,
    baseUrl,
    auth: { apiKey: staticApiKeyAuth(`${spec.providerName ?? providerId} API key`, spec.apiKey) },
    models,
    api: openAICompletionsApi(),
  });

  const registry = createRegistry();
  registry.setProvider(provider);
  const streamFn = streamFnOf(registry);

  const pick = (id: string): Model<'openai-completions'> => {
    const found = models.find((m) => m.id === id);
    if (!found) {
      throw new Error(
        `模型 ${id} 不在网关 ${providerId} 的清单里（已配置：${models.map((m) => m.id).join(', ')}）`,
      );
    }
    return found;
  };

  return {
    model: pick(spec.defaultModel ?? models[0]!.id),
    streamFn,
    models,
    selectModel: (id) => ({ model: pick(id), streamFn }),
  };
}

/**
 * 给 model source 的每一轮 LLM 调用注入成本 —— 测试预算熔断用的注水层。
 *
 * 为什么需要它：faux provider 的 `withUsageEstimate` 把 usage.cost **硬编码成全 0**
 * （`pi-ai/dist/providers/faux.js:147`），不管模型定义里 cost 配多少都归零。
 * 而 Axon 的预算熔断（M3）吃的正是 turn_end 的 `usage.cost.total`。
 *
 * 这一层包在流外：把 done 事件里的 assistant 消息 cost.total 改写成回调给的值。
 * 回调拿到「流调用上下文」与调用序号 —— 既可按序号计价，也可用
 * {@link lastUserText} 按最近一条 user 消息文本计价（多 Agent 交错调用时更稳）。
 * 仅在测试/示例用；真 provider（M6）自带真实成本，不需要它。
 */
export function withTurnCost(
  source: ModelSource,
  costUsd: (context: unknown, turnIndex: number) => number,
): ModelSource {
  let turn = 0;
  return {
    model: source.model,
    streamFn: async (model, context, options) => {
      // source.streamFn 可能是 async（如 scriptedSource），必须 await 出真正的流。
      // for-await 不会 await 裸 Promise——不 await 这里就是 TypeError。
      const inner = await source.streamFn(model, context, options);
      const outer = createAssistantMessageEventStream();
      const usd = costUsd(context, turn);
      turn += 1;
      void (async () => {
        let final: unknown;
        try {
          for await (const ev of inner) {
            if (ev.type === 'done') {
              // agent-loop 的 done 分支用 `response.result()` 而非事件里的
              // message（agent-loop.js），所以 end() 的终值也要一并改写。
              const patched = patchUsage(ev, usd);
              final = patched.message;
              outer.push(patched);
              continue;
            }
            outer.push(ev);
          }
          outer.end((final as AssistantMessage | undefined) ?? (await inner.result()));
        } catch {
          // 上游 abort/异常：把失败透传成 error 事件，避免外层永远悬挂。
          outer.push({
            type: 'error',
            reason: 'error',
            error: new Error('withTurnCost 包装的流中断'),
          } as unknown as AssistantMessageEvent);
        }
      })();
      return outer;
    },
  };
}

/** done 事件的 assistant 消息可能完全没有 usage（如脚本化消息），此时也要补上。 */
type DoneEvent = Extract<AssistantMessageEvent, { type: 'done' }>;

export function patchUsage(ev: DoneEvent, usd: number): DoneEvent {
  const message = ev.message as AssistantMessage & {
    usage?: { cost?: Partial<{ total: number }> };
  };
  return {
    ...ev,
    message: {
      ...message,
      usage: { ...message.usage, cost: { ...message.usage?.cost, total: usd } },
    },
  };
}

/** 从流调用上下文里抽出最近一条 user 消息的纯文本（LLM 消息两种 content 形态都吃）。 */
export function lastUserText(context: unknown): string {
  const messages = (context as { messages?: { role: string; content: unknown }[] })?.messages ?? [];
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.map((c) => (c as { text?: string }).text ?? '').join('');
  }
  return '';
}

/**
 * 脚本化回复源：按「最近一条 user 消息文本」路由到注册的回复工厂。
 *
 * 为什么不用 faux 的 setResponses 队列：它的消费语义是「每轮 LLM 调用
 * shift 掉一条」，多轮/多 Agent 交错调用时会被引擎的异步启动竞态打乱
 * 配对。路由表按**文本**寻址，永不耗尽 —— 多轮、多 Agent 测试的确定性
 * 来源；未注册的文本走 fallback（缺省直接抛错，宁可红不要谜）。
 *
 * 工厂参数：`(context, callIndex)` —— context 是 LLM 上下文（可读转录里
 * 的 toolResult 消息组装下一步工具参数），callIndex 是「该文本第几次被
 * 调用」（从 0 起），用于同一句话的多轮序列脚本。
 */
export function scriptedSource(
  base: ModelSource,
  routes: Record<string, (context: Record<string, unknown>, callIndex: number) => unknown>,
  fallback?: (text: string) => unknown,
): ModelSource {
  const calls = new Map<string, number>();
  return {
    model: base.model,
    streamFn: async (model, context, options) => {
      const text = lastUserText(context);
      const route = routes[text];
      if (!route && !fallback) {
        throw new Error(`scriptedSource 未注册回复: ${JSON.stringify(text)}`);
      }
      const callIndex = (calls.get(text) ?? 0);
      calls.set(text, callIndex + 1);
      // route/fallback 返回的就是 reply 消息（测试约定），配件只解释驳回。
      const message = (await (route ? route(context as unknown as Record<string, unknown>, callIndex) : fallback!(text))) as AssistantMessage;
      return singleMessageStream(message);
    },
  };
}

/** 把一条现成消息包成模型流（done + end 即可，agent-loop 自行播 message_start/end）。 */
function singleMessageStream(
  message: AssistantMessage,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const declared = (message as { stopReason?: unknown }).stopReason;
  const stopReason = (typeof declared === 'string' && declared !== 'pending'
    ? declared
    : 'stop') as 'stop' | 'length' | 'toolUse' | 'deferred';
  void (async () => {
    stream.push({ type: 'done', reason: stopReason, message });
    stream.end(message);
  })();
  return stream;
}

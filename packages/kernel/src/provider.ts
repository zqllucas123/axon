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
import type { ModelSpec } from '@axon/protocol';

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
 * **形状真相在 `@axon/protocol` 的 `ModelSpec`**（MU-1 搬家）：配置文件
 * `provider.models` 的白名单校验要用它，而协议层不能反过来依赖 kernel。
 * 这里保留别名，是因为 kernel 的调用点（createOpenAICompatSource 等）
 * 一直用这个名字，改名只会制造无意义的 diff。
 *
 * `cost` 单位是**美元 / 百万 token**（pi 的 `calculateCost` 除以 1e6）。
 * 填 0 不会报错，只是预算熔断永远不触发。
 */
export type OpenAICompatModel = ModelSpec;

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
  const built = buildProvider(spec);

  const registry = createRegistry();
  registry.setProvider(built.provider);
  const streamFn = streamFnOf(registry);
  const models = built.models;

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
 * 一个 spec → 一个 pi provider + 它的 model 清单。
 *
 * 从 {@link createOpenAICompatSource} 里抽出来给 {@link createMultiProviderSource} 复用：
 * 多网关与单网关唯一的区别是往几个 provider 进同一个 registry，model 的构造规则完全一样。
 */
function buildProvider(spec: OpenAICompatSpec): {
  providerId: string;
  provider: ReturnType<typeof createProvider<'openai-completions'>>;
  models: Model<'openai-completions'>[];
} {
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
    ...(m.compat ? { compat: m.compat } : {}),
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

  return { providerId, provider, models };
}

/**
 * 多网关合成一个 {@link ModelSource} —— M15 的多提供商入口。
 *
 * 为什么一个 source 吃得下 N 个网关：pi 的 `MutableModels` 本来就是多 provider 容器，
 * `setProvider` 按 `provider.id` upsert、`stream()` 按 `model.provider` 自己路由
 * （`pi-ai/dist/models.js:37,352,380`）。所以这里只要往**同一个 registry** 逐个塞 provider，
 * 一个 streamFn 就能把请求发到各自的 baseUrl，不需要 N 个 source 再做外层分发。
 *
 * `selectModel` 吃复合键 `providerId:modelId`（见 protocol 的 `formatModelRef`），
 * 也兼容裸 modelId —— 旧角色文件与 M15 前的落盘记录里存的都是裸 id，
 * 按注册顺序取首个匹配，与 `resolveModelRef` 的裸 id 语义保持一致。
 */
export function createMultiProviderSource(
  specs: OpenAICompatSpec[],
  defaultRef?: string,
): ModelSource & {
  models: Model<'openai-completions'>[];
  selectModel: (ref: string) => ModelSource;
} {
  if (!specs.length) throw new Error('createMultiProviderSource: specs 不能为空');

  const registry = createRegistry();
  const models: Model<'openai-completions'>[] = [];
  for (const spec of specs) {
    if (!spec.models.length) continue;
    const built = buildProvider(spec);
    registry.setProvider(built.provider);
    models.push(...built.models);
  }
  if (!models.length) throw new Error('createMultiProviderSource: 没有任何可用模型');

  const streamFn = streamFnOf(registry);

  const pick = (ref: string): Model<'openai-completions'> => {
    // 只切第一个冒号：模型 id 自身可能含冒号（ollama 的 `qwen3:8b`）。
    const at = ref.indexOf(':');
    const providerId = at > 0 ? ref.slice(0, at) : undefined;
    const modelId = at > 0 ? ref.slice(at + 1) : ref;
    const found = providerId
      ? models.find((m) => m.provider === providerId && m.id === modelId)
      : models.find((m) => m.id === modelId);
    if (!found) {
      throw new Error(
        `模型 ${ref} 不在任何已配置网关的清单里（已配置：${models
          .map((m) => `${m.provider}:${m.id}`)
          .join(', ')}）`,
      );
    }
    return found;
  };

  const resolveDefault = (): Model<'openai-completions'> => {
    if (defaultRef) {
      try {
        return pick(defaultRef);
      } catch {
        console.warn(`[axon] 默认模型 ${defaultRef} 解析不到，回落首个可用模型`);
      }
    }
    return models[0]!;
  };

  return {
    model: resolveDefault(),
    streamFn,
    models,
    selectModel: (ref) => ({ model: pick(ref), streamFn }),
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

// ────────────────────────────────────────────────────────────────────────────
// DeepSeek DSML 工具调用兼容层
// ────────────────────────────────────────────────────────────────────────────

/**
 * 解析 DeepSeek 原生工具调用格式（DSML special token），把它重建为
 * pi 的标准 ToolCall 内容块。
 *
 * 背景：部分网关（vLLM/SGLang 未开 tool-call-parser 时）直接把 DeepSeek
 * 的 special token 透传为明文，形如：
 *
 *   <｜DSML｜calls>
 *     <｜DSML｜invoke name="Bash">
 *       <｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *   </｜DSML｜calls>
 *
 * pi 的 openai-completions 解析器只认标准 `tool_calls` 字段，看不懂这段，
 * 于是它落入 text 块，原样渲染给用户。
 *
 * 这一层在 done 事件里拦截 assistant message，把 DSML 段从 text 块里抠出来，
 * 转成 ToolCall[]，再把 content 和 stopReason 修正后放行。
 *
 * 正则说明：
 * - `<｜DSML｜calls>` 是 DeepSeek tokenizer 的特殊边界符（U+FF5C 全角竖线）。
 * - `invoke name="…"` 是工具名，`parameter name="…"` 里的文本是参数值。
 * - 同一次调用可有多个 parameter 块，每个是一个命名参数。
 * - 一条回复可能包含多个 invoke（虽然 DeepSeek V3/R1 通常只吐一个）。
 */

// 分隔符 `<｜DSML｜` 后模型常插入一个空格（真实产出为 `<｜DSML｜ calls>`），
// 故所有标记都以 `\s*` 容忍空白。闭合标签也允许 `</｜DSML｜ calls>` 变体。
const DSML_CALLS_OPEN = /<｜DSML｜\s*calls\s*>/;
// calls 块：闭合缺失（流被截断）时退化到字符串结尾，尽量多解析。
const DSML_CALLS_BLOCK = /<｜DSML｜\s*calls\s*>([\s\S]*?)(?:<\/｜DSML｜\s*calls\s*>|$)/g;
// invoke 开标签：只锚定开标签。实测模型会吐出畸形闭合（如
// `</｜DSML｜<｜DSML｜ invoke>`），所以不依赖闭合标签，改用「下一个 invoke
// 开标签 / calls 块结束」来切分 invoke 体。
const DSML_INVOKE_OPEN = /<｜DSML｜\s*invoke\s+name="([^"]+)"\s*>/g;
// parameter 块：这一层实测闭合正常（`</｜DSML｜ parameter>`）。
const DSML_PARAM = /<｜DSML｜\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜DSML｜\s*parameter\s*>/g;

/** 从一段文本里解析出所有 DSML 工具调用，返回 ToolCall 数组（无匹配则空）。 */
function parseDsmlCalls(text: string): import('@earendil-works/pi-ai').ToolCall[] {
  const calls: import('@earendil-works/pi-ai').ToolCall[] = [];
  const callsBlockRe = new RegExp(DSML_CALLS_BLOCK.source, 'g');
  let callsMatch: RegExpExecArray | null;

  while ((callsMatch = callsBlockRe.exec(text)) !== null) {
    const block = callsMatch[1]!;
    if (callsMatch[0].length === 0) break; // 防空匹配死循环

    // 先收集块内所有 invoke 开标签的位置，再按相邻开标签切分 invoke 体，
    // 完全绕开畸形的 invoke 闭合标签。
    const opens: { name: string; bodyStart: number; tagStart: number }[] = [];
    const invokeRe = new RegExp(DSML_INVOKE_OPEN.source, 'g');
    let im: RegExpExecArray | null;
    while ((im = invokeRe.exec(block)) !== null) {
      opens.push({ name: im[1]!, bodyStart: im.index + im[0].length, tagStart: im.index });
    }

    for (let i = 0; i < opens.length; i++) {
      const bodyEnd = i + 1 < opens.length ? opens[i + 1]!.tagStart : block.length;
      const body = block.slice(opens[i]!.bodyStart, bodyEnd);
      const args: Record<string, unknown> = {};
      const paramRe = new RegExp(DSML_PARAM.source, 'g');
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(body)) !== null) {
        const pName = pm[1]!;
        const pVal = pm[2]!;
        // 尝试解析为 JSON；失败则保留原始字符串。
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }

      calls.push({
        type: 'toolCall',
        id: `dsml-${Date.now()}-${calls.length}`,
        // 模型对工具名大小写不稳定（实测 `bash` 与 `Bash` 都出现过），
        // 而 agent-loop 按 `t.name === toolCall.name` 精确匹配、axon 注册的
        // 工具 id 全为小写，故统一转小写以确保命中。
        name: opens[i]!.name.toLowerCase(),
        arguments: args,
      });
    }
  }

  return calls;
}

/** 如果 text 里包含 DSML 工具调用标记，返回 true。 */
function hasDsmlCalls(text: string): boolean {
  return DSML_CALLS_OPEN.test(text);
}

/**
 * 把 assistant message 里 text 块中的 DSML 工具调用抠出来，
 * 重建为 ToolCall 内容块，更新 stopReason。
 *
 * 文本块里 DSML 标记之外的部分（通常是空字符串或少量前导文字）
 * 保留为 text 块；如果变成空字符串则丢弃。
 */
function patchDsmlMessage(message: AssistantMessage): AssistantMessage {
  // 只有真正带 DSML 标记才处理，避免不必要的拷贝。
  const needsPatch = message.content.some(
    (b) => b.type === 'text' && hasDsmlCalls((b as { text?: string }).text ?? ''),
  );
  if (!needsPatch) return message;

  const newContent: AssistantMessage['content'] = [];
  let toolCallCount = 0;

  for (const block of message.content) {
    if (block.type !== 'text') {
      newContent.push(block);
      continue;
    }
    const text = (block as { text?: string }).text ?? '';
    if (!hasDsmlCalls(text)) {
      newContent.push(block);
      continue;
    }

    const parsed = parseDsmlCalls(text);
    // 带 DSML 标记却一个调用都没解析出来（格式又变体了）：不裁剪、不改
    // stopReason，原样保留 text 块，避免把正文吞掉或给 agent-loop 一个空
    // 的 toolUse 轮次。宁可暂时显示原文，也不制造更坏的状态。
    if (parsed.length === 0) {
      newContent.push(block);
      continue;
    }

    // DSML 标记之前的文字（如有）
    const beforeCalls = text.replace(/<｜DSML｜\s*calls\s*>[\s\S]*$/, '').trim();
    if (beforeCalls) {
      newContent.push({ type: 'text', text: beforeCalls });
    }

    for (const call of parsed) {
      newContent.push(call);
      toolCallCount++;
    }

    // DSML 标记之后的文字（如有）。闭合缺失时不裁剪，避免误删正文。
    const afterCalls = /<\/｜DSML｜\s*calls\s*>/.test(text)
      ? text.replace(/^[\s\S]*<\/｜DSML｜\s*calls\s*>/, '').trim()
      : '';
    if (afterCalls) {
      newContent.push({ type: 'text', text: afterCalls });
    }
  }

  // 没有任何调用被重建时，保持原消息语义不变。
  if (toolCallCount === 0) return message;

  return {
    ...message,
    content: newContent,
    // agent-loop 靠 stopReason=toolUse 决定是否回调工具；没有这个它不会执行。
    stopReason: 'toolUse',
  } as AssistantMessage;
}

/**
 * DSML 兼容垫片：包在任意 ModelSource 外层，对 done 事件做原地修补。
 *
 * 当网关未开启 DeepSeek tool-call parser 时挂上这层即可；
 * 若某天网关修好了，直接把 `withDsmlParsing(source)` 换回 `source`。
 */
export function withDsmlParsing(source: ModelSource): ModelSource {
  return {
    model: source.model,
    streamFn: async (model, context, options) => {
      const inner = await source.streamFn(model, context, options);
      const outer = createAssistantMessageEventStream();
      void (async () => {
        let final: AssistantMessage | undefined;
        try {
          for await (const ev of inner) {
            if (ev.type === 'done') {
              const patched = patchDsmlMessage(ev.message);
              final = patched;
              outer.push({ ...ev, message: patched });
              continue;
            }
            outer.push(ev);
          }
          outer.end(final ?? (await inner.result()));
        } catch {
          outer.push({
            type: 'error',
            reason: 'error',
            error: new Error('withDsmlParsing 包装的流中断'),
          } as unknown as AssistantMessageEvent);
        }
      })();
      return outer;
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

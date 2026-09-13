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

import { createModels, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
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
 */
export function scriptedSource(
  base: ModelSource,
  routes: Record<string, () => unknown>,
  fallback?: (text: string) => unknown,
): ModelSource {
  return {
    model: base.model,
    streamFn: async (model, context, options) => {
      const text = lastUserText(context);
      const route = routes[text];
      if (!route && !fallback) {
        throw new Error(`scriptedSource 未注册回复: ${JSON.stringify(text)}`);
      }
      // route/fallback 返回的就是 reply 消息（测试约定），配件只解释驳回。
      const message = (await (route ? route() : fallback!(text))) as AssistantMessage;
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

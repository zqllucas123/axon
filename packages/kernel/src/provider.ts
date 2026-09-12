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

import { createModels } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
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

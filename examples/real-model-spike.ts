/**
 * 真实模型尖峰 —— 用真网关跑一遍 Axon→pi 的链路，专挑 faux 掩盖不住的地方看。
 *
 *   bun run example:real                 # 用 ~/.axon/config.json 的默认模型
 *   AXON_MODEL=deepseek-r1 bun run example:real
 *
 * ── 它要回答的四个问题（faux 一个都答不了）──
 *
 *  1. **工具调用方言**：模型真的会发 toolCall 吗？参数 JSON 是分片流式拼出来的
 *     （实测网关逐块吐 `{"role": "assist` / `ant"` …），pi 的 partial-json 能不能拼对？
 *  2. **成本是否真实**：faux 的 usage.cost 被硬编码为 0（`pi-ai/providers/faux.js:147`），
 *     M3 的预算熔断吃的就是这个字段 —— 接真模型后它必须变成非零。
 *  3. **reasoning 通道**：deepseek-r1 会吐 `reasoning_content`，pi 把它归到哪种 content
 *     block？UI 要不要单独一栏？（这是 MU 信息架构的直接输入）
 *  4. **流式与 stopReason**：多轮工具循环能否自然收尾在 stopReason=stop。
 */

import { createAxonEngine } from '../packages/kernel/src/engine.ts';
import { createOpenAICompatSource, Type } from '../packages/kernel/src/provider.ts';
import { loadConfig, maskKey, resolveModelChoice } from '../apps/desktop/src/main/model-config.ts';

const { config, error } = await loadConfig();
if (error) console.warn(error);
const choice = resolveModelChoice(config);
if (choice.kind !== 'openai-compat') {
  console.error(`✗ 没有可用的真模型配置：${choice.reason}`);
  console.error('  请写 ~/.axon/config.json（形状见 apps/desktop/src/main/model-config.ts）');
  process.exit(1);
}

console.log(`网关 ${choice.baseUrl}`);
console.log(`模型 ${choice.defaultModel}　key ${maskKey(choice.apiKey)}\n`);

const source = createOpenAICompatSource({
  providerId: choice.providerId,
  providerName: choice.providerName,
  baseUrl: choice.baseUrl,
  apiKey: choice.apiKey,
  models: choice.models,
  defaultModel: choice.defaultModel,
});

// ── 一个有副作用可观察的工具：模型必须真的调它，否则答不出来 ──
let toolCalls = 0;
const lookup = {
  name: 'lookup_build_status',
  description: '查询某个服务的最近一次构建状态。只有调用它才能知道答案。',
  parameters: Type.Object({
    service: Type.String({ description: '服务名，如 axon-desktop' }),
  }),
  // pi 的工具签名是 `(toolCallId, args, signal, ctx)` —— 第一参**不是** args。
  // 写成 `(args) => ...` 不会报类型错（tools 那里是 `as never`），只会静默拿到
  // 一个 call_xxx 字符串，然后所有字段都是 undefined。实测踩过，留此注记。
  execute: async (_toolCallId: string, args: { service: string }) => {
    toolCalls += 1;
    console.log(`  [工具] lookup_build_status(${args.service}) ← 模型真的调了`);
    return {
      content: [
        { type: 'text' as const, text: `服务 ${args.service}：最近一次构建 FAILED，原因 tsc 类型错误 3 处。` },
      ],
    };
  },
};

const agent = createAxonEngine({
  systemPrompt: '你是 Axon 的开发执行体。需要事实时必须调用工具，不许编造。回答简洁。',
  model: source.model,
  messages: [],
  tools: [lookup] as never,
  streamFn: source.streamFn,
  sessionId: 'spike-real-model',
});

// 事件形态是 UI 设计的原材料。注意流式增量**嵌在 message_update.assistantMessageEvent 里**，
// 不在顶层；这一层嵌套是实测才发现的，MU 的流式渲染得按它接。
const seen = new Map<string, number>();
const innerSeen = new Map<string, number>();
let reasoningChars = 0;
let textChars = 0;
agent.subscribe((event) => {
  seen.set(event.type, (seen.get(event.type) ?? 0) + 1);
  const inner = (event as { assistantMessageEvent?: { type: string; delta?: string } })
    .assistantMessageEvent;
  if (!inner) return;
  innerSeen.set(inner.type, (innerSeen.get(inner.type) ?? 0) + 1);
  if (inner.type === 'text_delta') textChars += inner.delta?.length ?? 0;
  if (inner.type === 'thinking_delta') reasoningChars += inner.delta?.length ?? 0;
});

const t0 = Date.now();
await agent.prompt('axon-desktop 最近一次构建成功了吗？如果没成功，告诉我原因。');
await agent.waitForIdle();
const elapsed = Date.now() - t0;

// ── 结果盘点 ────────────────────────────────────────────────
const messages = agent.messages();
console.log(`\ntranscript ${messages.length} 条，用时 ${(elapsed / 1000).toFixed(1)}s`);
for (const m of messages) {
  console.log(`  ${m.role.padEnd(10)} ${m.content.map((b) => b.type).join('+') || '(空)'}`);
}

const last = messages.filter((m) => m.role === 'assistant').at(-1) as
  | { usage?: { input: number; output: number; cost?: { total?: number } }; stopReason?: string }
  | undefined;

console.log('\n事件类型分布（agent 层）：');
for (const [type, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${type.padEnd(24)} ${n}`);
console.log('流式增量（message_update.assistantMessageEvent）：');
for (const [type, n] of [...innerSeen].sort((a, b) => b[1] - a[1])) console.log(`  ${type.padEnd(24)} ${n}`);

console.log('\n四问验收：');
const checks: [string, boolean, string][] = [
  ['① 工具调用方言', toolCalls > 0, `模型调用工具 ${toolCalls} 次`],
  [
    '② 成本非零',
    (last?.usage?.cost?.total ?? 0) > 0,
    `cost.total = ${last?.usage?.cost?.total ?? 0}（in ${last?.usage?.input ?? 0} / out ${last?.usage?.output ?? 0} tokens）`,
  ],
  [
    '③ reasoning 通道',
    true,
    `thinking ${reasoningChars} 字符 / text ${textChars} 字符` +
      (reasoningChars === 0 ? '（本模型不吐 thinking，试 AXON_MODEL=deepseek-r1）' : ''),
  ],
  ['④ 正常收尾', last?.stopReason === 'stop', `stopReason = ${last?.stopReason}`],
];
for (const [name, ok, detail] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}：${detail}`);

console.log(`\n最终答复：\n${messages.at(-1)?.content.map((b) => (b as { text?: string }).text ?? '').join('') ?? ''}`);

// ② ④ 是硬指标（成本与收尾直接决定预算熔断与状态机），不过就退出码非零。
if (!checks[1]![1] || !checks[3]![1]) process.exit(1);

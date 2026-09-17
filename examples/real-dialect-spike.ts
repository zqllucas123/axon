/**
 * 真模型方言尖峰（S2）—— M6「真实模型接入」的前置取证。
 *
 *   bun run example:dialect
 *   AXON_MODEL=deepseek-r1 bun run example:dialect
 *
 * S1（`real-model-spike.ts`）已经证明「真模型能跑通」。S2 要回答的是**接下来怎么写**：
 * MU-2 台账 B 节把三件事挂起了，说「等真模型实测再定，若不发就把协议声明删掉」。
 * 这个脚本就是那次实测，逐条给出可引用的证据。
 *
 * ── 五个闸口（每一个都直接决定 M6 某项工作的存废）──
 *
 *  1. **B-1/B-3 存活判定**：`agent.message.delta` / `agent.tool.update` 有没有真实来源？
 *     ——把 `assistantMessageEvent` 的**完整载荷**打出来，作为 host.ts wire() 分支的规格。
 *     若一条 delta 都没有，B-1/B-3 当场作废，协议里的声明要删掉（别留死声明）。
 *  2. **成本归零根因**：同一个 prompt 跑两遍，一遍用 config 原样的 models 条目，一遍
 *     注入 `cost` 单价。若「注入后非零、原样为零」，则 cost=0 是**配置缺字段**而非
 *     网关不给数，M6 必须给配置校验补一条告警 —— 否则 M3 的预算熔断静默死亡。
 *  3. **看门狗阈值**：首字延迟与静默间隔的真实画像。kalo 的流式看门狗要设超时，
 *     阈值不能拍脑袋，得看真网关最慢的那一段有多长。
 *  4. **length 续写补丁必要性**：故意把 maxTokens 压到极小逼出 `stopReason=length`，
 *     看 pi 0.85.1 自己会不会续写。会 → kalo 补丁 2 不用移植；不会 → M6 得自己写。
 *  5. **thinking-only 回合**：有没有出现「只有 thinking 没有 text」的回合？这是 kalo
 *     补丁 1 的触发条件，也是 UI 折叠区要不要兜「空答复」的依据。
 */

import { createAxonEngine } from '../packages/kernel/src/engine.ts';
import { createOpenAICompatSource, Type } from '../packages/kernel/src/provider.ts';
import { loadConfig, maskKey, resolveModelChoice } from '../apps/desktop/src/main/model-config.ts';

const { config, error } = await loadConfig();
if (error) console.warn(error);
const choice = resolveModelChoice(config);
if (choice.kind !== 'openai-compat') {
  console.error(`✗ 没有可用的真模型配置：${choice.reason}`);
  process.exit(1);
}
// 上面的 guard 已经 narrow 到 openai-compat；下面的绑定让 TS 知道形状。
const compat = choice;

console.log(`网关 ${compat.baseUrl}`);
console.log(`模型 ${compat.defaultModel}　key ${maskKey(compat.apiKey)}`);
console.log(`config 里的 models 条目：${JSON.stringify(compat.models)}\n`);

/** 建 source 的公共部分；`overrides` 用来做闸口 2/4 的对照实验。 */
function build(models: typeof compat.models) {
  return createOpenAICompatSource({
    providerId: compat.providerId,
    providerName: compat.providerName,
    baseUrl: compat.baseUrl,
    apiKey: compat.apiKey,
    models,
    defaultModel: compat.defaultModel,
  });
}

const askTool = {
  name: 'lookup_build_status',
  description: '查询某个服务的最近一次构建状态。只有调用它才能知道答案。',
  parameters: Type.Object({ service: Type.String({ description: '服务名' }) }),
  execute: async (_id: string, args: { service: string }) => ({
    content: [{ type: 'text' as const, text: `服务 ${args.service}：构建 FAILED，tsc 类型错误 3 处。` }],
  }),
};

// ══ 闸口 1 + 3 + 5：跑一轮带工具的对话，全程录事件 ══════════════

interface Frame {
  at: number;
  outer: string;
  inner?: string;
  /** 只留前 200 字符：delta 载荷可能很长，报告里要的是形状不是全文。 */
  payload?: string;
}
const frames: Frame[] = [];
const innerSeen = new Map<string, number>();

const source = build(choice.models);
const agent = createAxonEngine({
  systemPrompt: '你是 Axon 的开发执行体。需要事实时必须调用工具，不许编造。先思考再回答。',
  model: source.model,
  messages: [],
  tools: [askTool] as never,
  streamFn: source.streamFn,
  sessionId: 'spike-dialect',
});

const t0 = Date.now();
let firstByteAt = 0;
agent.subscribe((event) => {
  const inner = (event as { assistantMessageEvent?: Record<string, unknown> }).assistantMessageEvent;
  if (inner) {
    const t = String(inner.type);
    innerSeen.set(t, (innerSeen.get(t) ?? 0) + 1);
    if (!firstByteAt && (t === 'text_delta' || t === 'thinking_delta')) firstByteAt = Date.now();
  }
  frames.push({
    at: Date.now() - t0,
    outer: event.type,
    ...(inner ? { inner: String(inner.type), payload: JSON.stringify(inner).slice(0, 200) } : {}),
  });
});

await agent.prompt('axon-desktop 最近一次构建成功了吗？没成功就说原因。');
await agent.waitForIdle();
const elapsed = Date.now() - t0;

// ── 闸口 1：delta 载荷形状（host.ts wire() 的实现规格）──────
console.log('══ 闸口 1：流式增量的真实载荷 ══');
console.log(`assistantMessageEvent 总计 ${[...innerSeen.values()].reduce((a, b) => a + b, 0)} 条`);
for (const [t, n] of [...innerSeen].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(18)} ${n}`);
console.log('\n每类取首条，作为 wire() 分支的规格：');
const shown = new Set<string>();
for (const f of frames) {
  if (!f.inner || shown.has(f.inner)) continue;
  shown.add(f.inner);
  console.log(`  [${String(f.at).padStart(6)}ms] ${f.outer} → ${f.inner}`);
  console.log(`           ${f.payload}`);
}

// ── 闸口 3：延迟画像（看门狗阈值的输入）────────────────────
const gaps = frames.slice(1).map((f, i) => f.at - frames[i]!.at);
const maxGap = Math.max(0, ...gaps);
const maxGapAt = gaps.indexOf(maxGap);
console.log('\n══ 闸口 3：延迟画像 ══');
console.log(`  总时长        ${(elapsed / 1000).toFixed(1)}s`);
console.log(`  首个增量      ${firstByteAt ? `${firstByteAt - t0}ms` : '（无增量）'}`);
console.log(`  最长静默间隔  ${maxGap}ms（在第 ${maxGapAt + 1} 帧后，${frames[maxGapAt]?.outer ?? '?'}）`);
console.log(`  事件帧总数    ${frames.length}`);

// ── 闸口 5：thinking-only 回合 ────────────────────────────
const msgs = agent.messages();
const assistantTurns = msgs.filter((m) => m.role === 'assistant');
const thinkingOnly = assistantTurns.filter((m) => {
  const kinds = new Set(m.content.map((b) => b.type));
  return kinds.has('thinking') && !kinds.has('text') && !kinds.has('toolCall');
});
console.log('\n══ 闸口 5：thinking-only 回合 ══');
console.log(`  assistant 回合 ${assistantTurns.length} 个，其中只有 thinking 的 ${thinkingOnly.length} 个`);
for (const m of assistantTurns) {
  console.log(`    ${m.content.map((b) => b.type).join('+') || '(空)'}`);
}

// ══ 闸口 2：成本归零根因（配置缺 cost，还是网关不给数？）══════

console.log('\n══ 闸口 2：成本归零根因 ══');
const bare = assistantTurns.at(-1) as { usage?: { input: number; output: number; cost?: { total?: number } } } | undefined;
console.log(`  A. config 原样（models 无 cost 字段）`);
console.log(`     tokens in ${bare?.usage?.input ?? 0} / out ${bare?.usage?.output ?? 0}`);
console.log(`     cost.total = ${bare?.usage?.cost?.total ?? 0}`);

// 同一模型，注入一个真实量级的单价（$/百万 token），只看 cost 是否随之变非零。
const priced = build(choice.models.map((m) => ({ ...m, cost: { input: 0.27, output: 1.1 } })));
const agent2 = createAxonEngine({
  systemPrompt: '回答简洁。',
  model: priced.model,
  messages: [],
  tools: [] as never,
  streamFn: priced.streamFn,
  sessionId: 'spike-dialect-cost',
});
await agent2.prompt('用一句话说明什么是类型系统。');
await agent2.waitForIdle();
const pricedLast = agent2.messages().filter((m) => m.role === 'assistant').at(-1) as
  | { usage?: { input: number; output: number; cost?: { total?: number } } }
  | undefined;
console.log(`  B. 注入 cost: {input: 0.27, output: 1.1}`);
console.log(`     tokens in ${pricedLast?.usage?.input ?? 0} / out ${pricedLast?.usage?.output ?? 0}`);
console.log(`     cost.total = ${pricedLast?.usage?.cost?.total ?? 0}`);
const costIsConfigGap = (pricedLast?.usage?.cost?.total ?? 0) > 0 && (bare?.usage?.cost?.total ?? 0) === 0;
console.log(`  ⇒ ${costIsConfigGap ? '成本归零是【配置缺 cost 字段】，网关照常返回 token 数' : '注入单价也算不出成本，需另查'}`);

// ══ 闸口 4：stopReason=length 时 pi 会不会自己续写 ═══════════

console.log('\n══ 闸口 4：length 截断与自动续写 ══');
const tiny = build(choice.models.map((m) => ({ ...m, maxTokens: 48 })));
const agent3 = createAxonEngine({
  systemPrompt: '你必须写得很长很详细，不要精简。',
  model: tiny.model,
  messages: [],
  tools: [] as never,
  streamFn: tiny.streamFn,
  sessionId: 'spike-dialect-length',
});
let turnEnds = 0;
agent3.subscribe((e) => {
  if (e.type === 'turn_end') turnEnds += 1;
});
await agent3.prompt('详细讲解 TypeScript 的结构化类型系统，要求至少 800 字，分点展开。');
await agent3.waitForIdle();
const tinyTurns = agent3.messages().filter((m) => m.role === 'assistant') as {
  stopReason?: string;
  content: { type: string }[];
}[];
console.log(`  maxTokens=48，assistant 回合 ${tinyTurns.length} 个，turn_end ${turnEnds} 次`);
for (const m of tinyTurns) console.log(`    stopReason=${m.stopReason} content=${m.content.map((b) => b.type).join('+')}`);
const gotLength = tinyTurns.some((m) => m.stopReason === 'length');
const autoContinued = gotLength && tinyTurns.length > 1;
console.log(`  ⇒ 触发 length：${gotLength ? '是' : '否（模型/网关未按 maxTokens 截断）'}`);
console.log(`  ⇒ pi 自动续写：${autoContinued ? '是（kalo 补丁 2 不必移植）' : '否（M6 需自建续写，或明确不做）'}`);

// ══ 结论摘要 ═══════════════════════════════════════════════

console.log('\n══ 五闸口结论摘要 ══');
const deltaAlive = (innerSeen.get('text_delta') ?? 0) > 0;
const toolDeltaAlive = (innerSeen.get('toolcall_delta') ?? 0) > 0;
const verdicts: [string, string][] = [
  ['1 B-1 流式文本', deltaAlive ? `存活（text_delta ${innerSeen.get('text_delta')} 条）⇒ M6 要接` : '无来源 ⇒ 删协议声明'],
  ['1 B-3 工具增量', toolDeltaAlive ? `存活（toolcall_delta ${innerSeen.get('toolcall_delta')} 条）⇒ M6 要接` : '无来源 ⇒ 删协议声明'],
  ['2 成本归零', costIsConfigGap ? '配置缺 cost ⇒ M6 补配置校验告警' : '待查'],
  ['3 看门狗阈值', `最长静默 ${maxGap}ms ⇒ 阈值不低于它的数倍`],
  ['4 length 续写', autoContinued ? 'pi 已自理' : gotLength ? 'pi 不续写 ⇒ M6 决策' : '未触发，无结论'],
  ['5 thinking-only', thinkingOnly.length > 0 ? `出现 ${thinkingOnly.length} 次 ⇒ 需兜空答复` : '未出现 ⇒ 补丁 1 暂不需要'],
];
for (const [k, v] of verdicts) console.log(`  ${k.padEnd(18)} ${v}`);

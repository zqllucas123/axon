/**
 * 真实模型 × 编排内核尖峰 —— M3 的六工具第一次交给真模型驱动。
 *
 *   bun run example:orchestration
 *   AXON_MODEL=deepseek-v3 bun run example:orchestration
 *
 * ── 它与 orchestration.e2e.test.ts 的区别 ──
 *
 * E2E 测试用 `scriptedSource` 把模型的每一步**钉死**，验的是宿主状态机；
 * 这里把方向盘交给真模型，验的是**模型看得懂不看得懂这套工具**：
 *   - 六个编排工具的 description 是否足以让模型选对工具（planner 会不会 spawn？）
 *   - `agent` 工具的 role 参数，模型会不会瞎填一个不存在的角色？
 *   - spawn 之后它会不会主动 `agent_wait`，还是直接向用户交差（编排的最大失败模式）？
 *   - 真实 token 成本在父链上汇总得对不对
 *   - （M4）模型自主驱动的协作是否真的落了账，且子终态后自动结算
 *
 * 失败是有价值的输出：模型不会用工具 = prompt/description 要改，而不是代码有 bug。
 */

import { AxonHost } from '../apps/desktop/src/main/host.ts';
import { ALL_ROLES } from '../apps/desktop/src/main/roles.ts';
import { loadConfig, resolveModelChoice } from '../apps/desktop/src/main/model-config.ts';
import { createOpenAICompatSource } from '../packages/kernel/src/provider.ts';
import { ROOT_PATH } from '@axon/protocol';

const { config } = await loadConfig();
const choice = resolveModelChoice(config);
if (choice.kind !== 'openai-compat') {
  console.error(`✗ 没有可用的真模型配置：${choice.reason}`);
  process.exit(1);
}

const modelSource = createOpenAICompatSource({
  providerId: choice.providerId,
  providerName: choice.providerName,
  baseUrl: choice.baseUrl,
  apiKey: choice.apiKey,
  models: choice.models,
  defaultModel: choice.defaultModel,
});
console.log(`模型 ${choice.defaultModel} @ ${choice.baseUrl}\n`);

// 事件流即观测面：真模型下它是唯一能看清编排在干嘛的东西。
const timeline: string[] = [];
const host = new AxonHost({
  modelSource,
  roles: ALL_ROLES,
  // 闸门开到 2：父 + 一个子。要的是「父 wait 退位让额」这条路径被真模型走到。
  maxConcurrent: 2,
  budget: { hardUsd: 0.5 },
  emit: (event, payload, source) => {
    const p = payload as { status?: string; toolName?: string; error?: unknown };
    const detail = p.status ?? p.toolName ?? '';
    timeline.push(`${String(event).padEnd(18)} ${source.padEnd(22)} ${detail}`);
    if (String(event) === 'agent.status') console.log(`  · ${source} → ${p.status}`);
    if (p.error) console.log(`  ! ${source} error: ${JSON.stringify(p.error).slice(0, 200)}`);
  },
});

// planner 是唯一被期望「先拆活再派活」的内置角色；六件套它全都有（M3 授权矩阵）。
const planner = await host.execute('agent.spawn', {
  role: 'planner',
  parent: ROOT_PATH,
});
console.log(`planner = ${planner.path}\n`);

const task =
  '需求：给 Axon 桌面端加一个「导出会话为 Markdown」的功能。' +
  '请你先拆解，然后用 agent 工具派一个 developer 子 Agent 去写实现方案，' +
  '用 agent_wait 等它交付，拿到结果后汇总成最终答复给我。';

void host.execute('agent.prompt', { path: planner.path, text: task });

// 真模型没有确定性完成信号，只能轮询到整棵树进入终态/静默。
// 注意 `waiting` 不算静默（父正等后代），`failed`/`interrupted` 算终态。
const SETTLED = new Set(['idle', 'done', 'failed', 'interrupted']);
const deadline = Date.now() + 180_000;
const idle = () =>
  host.execute('agent.list', {}).then((list) => list.every((a) => SETTLED.has(a.status)));
await new Promise((r) => setTimeout(r, 1500));
while (Date.now() < deadline && !(await idle())) await new Promise((r) => setTimeout(r, 1000));

// ── 盘点 ────────────────────────────────────────────────────
const agents = await host.execute('agent.list', {});
console.log('\nAgent 树：');
for (const a of agents) {
  console.log(
    `  ${a.path.padEnd(26)} ${String(a.role).padEnd(12)} ${a.status.padEnd(10)} ` +
      `$${(a.usage?.costUsd ?? 0).toFixed(6)}`,
  );
}

const children = agents.filter((a) => a.path !== planner.path && a.path !== ROOT_PATH);
const waited = timeline.some((l) => l.includes('waiting'));
const root = agents.find((a) => a.path === ROOT_PATH);

// ── M4：账本盘点 ──────────────────────────────────────────
const ledger = await host.execute('ledger.query', {});
console.log('\n协作账本：');
for (const r of ledger.records) {
  console.log(
    `  ${r.action.padEnd(9)} ${r.from} → ${r.to}  ${r.status.padEnd(8)} ` +
      `${r.adoption.padEnd(15)} $${(r.usage?.costUsd ?? 0).toFixed(6)}`,
  );
  if (r.summary) console.log(`      ↳ ${r.summary.slice(0, 120)}`);
}
if (ledger.records.length === 0) console.log('  (空)');

console.log('\n五问验收：');
const checks: [string, boolean, string][] = [
  ['① 模型会 spawn', children.length > 0, `派生了 ${children.length} 个子 Agent`],
  [
    '② role 参数合法',
    children.every((c) => ALL_ROLES.some((r) => r.name === c.role)),
    children.map((c) => c.role).join(', ') || '(无)',
  ],
  ['③ 会主动 wait', waited, waited ? '出现过 waiting 状态' : '父从未挂起 —— 它可能直接向用户交差了'],
  [
    '④ 成本沿父链汇总',
    (root?.usage?.costUsd ?? 0) > 0,
    `root 累计 $${(root?.usage?.costUsd ?? 0).toFixed(6)}`,
  ],
  // 第五问是 M4 新增的：FakeDriver 单测只能证明「工具被调用时会落账」，
  // 证不了真模型自主选工具时账也落得上——中间隔着参数解析与 forkMode 判定。
  [
    '⑤ 协作已落账且结算',
    ledger.records.length > 0 && ledger.records.every((r) => r.status === 'settled'),
    ledger.records.length === 0
      ? '账本为空 —— 模型没用编排工具，或落账拦截点漏了'
      : `${ledger.records.length} 笔，` +
        `未结算 ${ledger.records.filter((r) => r.status !== 'settled').length} 笔，` +
        `动作 ${[...new Set(ledger.records.map((r) => r.action))].join('/')}`,
  ],
];
for (const [name, ok, detail] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}：${detail}`);

const final = await host.execute('agent.messages', { path: planner.path });
const lastText = final
  .filter((m) => m.role === 'assistant')
  .at(-1)
  ?.content.map((b) => (b as { text?: string }).text ?? '')
  .join('');
console.log(`\nplanner 最终答复（截断 600 字）：\n${(lastText ?? '(无)').slice(0, 600)}`);

if (process.env.AXON_SPIKE_TIMELINE) {
  console.log('\n完整事件时间线：');
  for (const l of timeline) console.log(`  ${l}`);
}

host.dispose();

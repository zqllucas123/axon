/**
 * 端到端冒烟：用 faux provider 驱动一个 Axon 管理的 pi Agent。
 *
 * 用假 provider 而非真模型，是为了让这条链路**可重复、零成本、无需 API key**。
 * 它验证的不是模型质量，而是 Axon→pi 的接线是否正确：
 * initialState 注入生效、事件流可订阅、工具闸门能拦截、transcript 可快照。
 *
 *   bun run example:single
 */

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from '@earendil-works/pi-ai';
import { createEngine, snapshotMessages } from '../packages/kernel/src/engine.ts';
import { forkMessages, intersectTools } from '../packages/kernel/src/fork.ts';
import { FORK_ALL, formatForkMode, forkLastRounds } from '@axon/protocol';

// ── 1. 假 provider：脚本化模型回复 ───────────────────────────

const faux = fauxProvider({ provider: 'axon-faux', api: 'faux' });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

// 脚本：先调用一次工具，拿到结果后给出最终答复
faux.setResponses([
  fauxAssistantMessage([
    fauxText('我先查一下当前目录。'),
    fauxToolCall('list_dir', { path: '.' }, { id: 'call-1' }),
  ]),
  fauxAssistantMessage('目录里有 packages 和 docs 两个子目录。'),
]);

// ── 2. 工具定义 ─────────────────────────────────────────────

const listDir = {
  name: 'list_dir',
  description: '列出目录内容',
  parameters: Type.Object({ path: Type.String() }),
  execute: async (args: { path: string }) => ({
    content: [{ type: 'text' as const, text: `packages/\ndocs/  (from ${args.path})` }],
  }),
};

const dangerousShell = {
  name: 'shell',
  description: '执行 shell 命令',
  parameters: Type.Object({ cmd: Type.String() }),
  execute: async () => ({ content: [{ type: 'text' as const, text: 'done' }] }),
};

// ── 3. 角色减能：这个角色只准列目录，不准执行 shell ───────────

const parentTools = ['list_dir', 'shell'];
const roleTools = intersectTools(parentTools, ['list_dir']);
console.log('父级工具:', parentTools);
console.log('角色裁剪后:', roleTools);

const allowed = new Set(roleTools ?? []);

// ── 4. 建 Agent ─────────────────────────────────────────────

const agent = createEngine({
  systemPrompt: '你是 Axon3（开发执行）。保持简洁。',
  model,
  messages: [],
  tools: [listDir, dangerousShell] as never,
  streamFn: (m, context, options) => models.stream(m, context, options),
  sessionId: 'example-single',
  // 闸门在这里兜底：即使工具在 tools 列表里，未获角色授权也执行不了
  onBeforeTool: async (name) =>
    allowed.has(name)
      ? { allow: true }
      : { allow: false, reason: `角色未获授权使用 ${name}` },
});

// ── 5. 订阅事件 ─────────────────────────────────────────────

agent.subscribe((event) => {
  switch (event.type) {
    case 'tool_execution_start':
      console.log(`  [工具] ${event.toolName} 开始`);
      break;
    case 'tool_execution_end':
      console.log(`  [工具] ${event.toolName} 结束`);
      break;
    case 'turn_end':
      console.log('  [turn] 结束');
      break;
    default:
      break;
  }
});

// ── 6. 跑一轮 ───────────────────────────────────────────────

console.log('\n--- prompt ---');
await agent.prompt('看看当前目录有什么');
await agent.waitForIdle();

const transcript = snapshotMessages(agent);
console.log(`\ntranscript 共 ${transcript.length} 条消息`);
for (const m of transcript) {
  const kinds = m.content.map((b) => b.type).join('+');
  console.log(`  ${m.role.padEnd(10)} ${kinds}`);
}

// ── 7. 分身验证 ─────────────────────────────────────────────

console.log('\n--- 分身 ---');
for (const mode of [FORK_ALL, forkLastRounds(1), { kind: 'none' } as const]) {
  const forked = forkMessages(transcript, mode);
  console.log(`  ${formatForkMode(mode).padEnd(5)} → ${forked.length} 条消息`);
}

console.log('\n✓ 单 Agent 链路跑通');

/**
 * 端到端验证：全栈小队在空白目录里开发一个贪吃蛇应用。
 *
 *   bun run examples/e2e-snake.ts
 *
 * 验证的是：
 *   - 全栈小队（主控 + 架构师 + 后端实现 + 测试工程师）能否被正确实例化
 *   - 主控能否拆解任务、分派成员并汇总交付
 *   - 最终在 /Users/lucaszhou/works/prjs/test/贪吃蛇 产出可运行的 HTML 贪吃蛇
 */

import { AxonHost } from '../apps/desktop/src/main/host.ts';
import { ALL_ROLES } from '../apps/desktop/src/main/roles.ts';
import { mergeTeamFiles } from '../apps/desktop/src/main/team-loader.ts';
import { BUILTIN_TEAMS } from '../apps/desktop/src/main/teams.ts';
import { loadConfig, resolveModelChoice } from '../apps/desktop/src/main/model-config.ts';
import { createOpenAICompatSource } from '../packages/kernel/src/provider.ts';

// ── 模型 ────────────────────────────────────────────────────────────────────

const { config } = await loadConfig();
const choice = resolveModelChoice(config);
if (choice.kind !== 'openai-compat') {
  console.error(`✗ 没有可用的真模型配置：${choice.reason}`);
  console.error('');
  console.error('config.json 里的 apiKey 是 Electron safeStorage 密文，CLI 无法解密。');
  console.error('请通过 env var 传入明文 key：');
  console.error('');
  console.error('  AXON_API_KEY=<你的key> bun run examples/e2e-snake.ts');
  console.error('');
  console.error('baseUrl 和 model 会从 ~/.axon/config.json 读取，只需补 key。');
  process.exit(1);
}

// spike 脚本只验证单网关链路，取第一个可用 provider 即可
const p = choice.providers[0]!;
const modelSource = createOpenAICompatSource({
  providerId: p.providerId,
  providerName: p.providerName,
  baseUrl: p.baseUrl,
  apiKey: p.apiKey,
  models: p.models,
  defaultModel: p.defaultModel,
});
console.log(`模型  ${p.defaultModel} @ ${p.baseUrl}`);
console.log(`团队  全栈小队`);
console.log(`目标  /Users/lucaszhou/works/prjs/test/贪吃蛇\n`);

// ── 事件观测 ─────────────────────────────────────────────────────────────────

const timeline: string[] = [];
let rootPath: string | undefined;
let done = false;

// 完成信号：主控（根路径）进入终态即算全队交付完毕。
let resolveCompletion!: () => void;
const completion = new Promise<void>((res) => {
  resolveCompletion = res;
});

const TERMINAL = new Set(['done', 'error', 'aborted', 'idle']);

const host = new AxonHost({
  modelSource,
  roles: ALL_ROLES,
  maxConcurrent: 3,   // 与全栈小队的 maxConcurrent 一致
  budget: { softUsd: 1.0, hardUsd: 1.5 },
  defaultApproval: 'auto',  // e2e 脚本里不需要人工批准每一步
  emit: (event, payload, source) => {
    const p = payload as { status?: string; toolName?: string; error?: unknown; text?: string };
    const detail = p.status ?? p.toolName ?? '';
    const line = `${String(event).padEnd(20)} ${(source ?? '-').padEnd(28)} ${detail}`;
    timeline.push(line);

    if (String(event) === 'agent.status') {
      console.log(`  · ${(source ?? '-').padEnd(28)} → ${p.status}`);
      // 主控进入终态 = 全队完成
      if (rootPath && source === rootPath && TERMINAL.has(p.status ?? '')) {
        if (!done) {
          done = true;
          resolveCompletion();
        }
      }
    }

    if (String(event) === 'agent.text_delta' && p.text) {
      process.stdout.write(p.text);
    }

    if (p.error) {
      console.error(`  ! ${source ?? '-'} error: ${JSON.stringify(p.error).slice(0, 300)}`);
    }
  },
});

// ── 注册团队 ──────────────────────────────────────────────────────────────────

const { entries, issues } = mergeTeamFiles(BUILTIN_TEAMS, [], { roles: ALL_ROLES });
const blocking = issues.filter((i) => i.level === 'error');
if (blocking.length > 0) {
  console.error('✗ 团队校验有阻断性错误：');
  for (const issue of blocking) console.error(`  ${issue.code}：${issue.message}`);
  process.exit(1);
}
host.updateTeams(entries, issues);
console.log(`团队注册完成（${entries.length} 个团队，${issues.length} 条 issue）\n`);

// ── 创建会话 ──────────────────────────────────────────────────────────────────

const session = host.createSession({
  title: '贪吃蛇 e2e 验证',
  executor: 'team',
  teamId: '全栈小队',
  cwd: '/Users/lucaszhou/works/prjs/test/贪吃蛇',
  initialPrompt: [
    '在当前工作目录（/Users/lucaszhou/works/prjs/test/贪吃蛇）开发一个贪吃蛇游戏，要求：',
    '',
    '1. 单文件 HTML（index.html），内嵌 CSS 和 JavaScript，无外部依赖，直接双击可在浏览器运行。',
    '2. 使用 <canvas> 渲染，格子大小 20px，画布 400×400（即 20×20 格）。',
    '3. 用户用方向键（↑↓←→）控制蛇的前进方向；反向键无效（不能直接掉头）。',
    '4. 蛇吃到食物后身体增长 1 格，分数加 1，食物随机重新生成。',
    '5. 蛇撞墙或撞自身时游戏结束，显示「Game Over」和最终分数，按任意键重新开始。',
    '6. 界面简洁：深色背景，蛇身绿色，食物红色，顶部显示当前分数。',
    '',
    '交付物：仅 index.html 一个文件，确保代码能在最新版 Chrome/Firefox 中运行。',
  ].join('\n'),
  budget: { softUsd: 0.8, hardUsd: 1.2 },
});

rootPath = session.rootPath;
console.log(`会话 ${session.record.id}  根路径 ${rootPath}\n`);

// ── 等待完成 ──────────────────────────────────────────────────────────────────

// 超时保险：全栈小队应在 20 分钟内完成，否则主动中断。
const timeout = setTimeout(() => {
  if (!done) {
    done = true;
    console.error('\n⏱  超时（20 分钟），强制退出。');
    resolveCompletion();
  }
}, 20 * 60 * 1000);

await completion;
clearTimeout(timeout);

// ── 结果摘要 ──────────────────────────────────────────────────────────────────

console.log('\n\n══ 事件时间线 ══');
for (const line of timeline) console.log(line);

console.log('\n══ 完成 ══');
console.log('检查 /Users/lucaszhou/works/prjs/test/贪吃蛇/index.html 是否存在：');

import { existsSync } from 'node:fs';
const output = '/Users/lucaszhou/works/prjs/test/贪吃蛇/index.html';
if (existsSync(output)) {
  console.log(`✓ ${output} 已生成`);
} else {
  console.log(`✗ ${output} 未找到`);
  process.exit(1);
}

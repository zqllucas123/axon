/**
 * M3 E2E 集成测试 —— 真实 pi 引擎 × AxonHost 全链路（milestone 验收）。
 *
 * 与 host.orchestration.test.ts（fake driver 单测）不同，这里跑的是真家伙：
 * 模型回复里的 toolCall 块 → engine 执行编排工具 → 工具改变宿主状态 → 新 LLM
 * 调用（同轮转录可见 toolResult）→ …… 直到任务完成。两幕：
 *
 *   幕 1 三幕 happy path：planner spawn developer → agent_wait 等 → agent_resume
 *        追加返工 → 再 wait → 收尾。断言状态轨道 / 转录文本 / 事件无 error。
 *   幕 2 gate=1 死锁免检：父占唯一额度 spawn 两子（双双 parked），父 agent_wait
 *        退位 → FIFO 补位 → 串行跑完 → 父被唤醒收尾。断言 parked 先于 running、
 *        子串行（前一 done 先于后一 running）、父 waiting 期间两子共享额度无死锁。
 *
 * 确定性纪律（延续单测的约定）：
 *   - scriptedSource 按「最近一条 user 文本 + 第几次调用」路由，永不耗尽；
 *   - wait/resume 的交错用「回复门」（gate）钉死：子卡在答话上时父必然挂起；
 *   - 工具参数（子路径）从 LLM 转录的 toolResult 文本解析，不硬编码 id。
 * 唯一放行的竞态：幕 1 第一次 agent_wait 时「子可能先跑完导致父不挂起」——
 * 断言不押注它，只押「resume 后带门的那次 wait 父必 waiting」。
 */

import { describe, expect, it } from 'vitest';
import type { AgentPath } from '@axon/protocol';
import {
  createFauxSource,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedSource,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost, type HostOptions } from './host.ts';
import { ALL_ROLES } from './roles.ts';

// ── 测试小件 ────────────────────────────────────────────────────────────

interface RawEvent {
  event: string;
  source: string;
  payload: { path?: string; status?: string; error?: unknown } & Record<string, unknown>;
}

interface E2EOpts {
  maxConcurrent?: number;
  routes: Record<string, (ctx: Record<string, unknown>, callIndex: number) => unknown>;
  budget?: HostOptions['budget'];
}

async function e2e(opts: E2EOpts) {
  const src = await createFauxSource();
  const modelSource: ModelSource = scriptedSource(src, opts.routes);
  const events: RawEvent[] = [];
  const host = new AxonHost({
    modelSource,
    roles: ALL_ROLES,
    emit: (event, payload, source) =>
      events.push({ event: String(event), source, payload: payload as RawEvent['payload'] }),
    maxConcurrent: opts.maxConcurrent,
    budget: opts.budget,
  });
  return { host, events };
}

/** 从 LLM 转录里解析 agent 工具已创建的子路径（toolResult 文本：「已创建子 Agent /path」）。 */
function createdAgentIds(ctx: Record<string, unknown>): AgentPath[] {
  const messages = (ctx.messages ?? []) as { role?: string; content?: unknown }[];
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'toolResult') continue;
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    for (const b of blocks) {
      const text = (b as { text?: string }).text ?? String((b as { text?: string }) ?? '');
      for (const match of text.matchAll(/已创建子 Agent (\S+?)(?:（|$)/g)) {
        const id = match[1];
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}

/** 状态轨道：某路径的全部 agent.status 事件里的 status 序列。 */
function statusRail(events: RawEvent[], path: string): string[] {
  return events
    .filter((e) => e.event === 'agent.status' && e.payload.path === path)
    .map((e) => e.payload.status ?? '');
}

/** 事件数组里第一个匹配下标（无则 -1）。 */
function firstIndex(events: RawEvent[], pred: (e: RawEvent) => boolean): number {
  return events.findIndex(pred);
}

/** 转录里该角色的全部 assistant 纯文本（跨 all turns 拼接）。 */
function assistantTexts(host: AxonHost, path: AgentPath): string[] {
  return host
    .messagesOf(path)
    .filter((m) => m.role === 'assistant')
    .map((m) =>
      Array.isArray(m.content)
        ? m.content
            .filter(
              (b) =>
                typeof b === 'object' &&
                b !== null &&
                'text' in b &&
                (b as { type?: string }).type !== 'toolCall',
            )
            .map((b) => (b as { text: string }).text)
            .join('')
        : String(m.content ?? ''),
    );
}

/** 小轮询辅助（同单测：事件驱动的状态落定，无 sleep 竞态）。 */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 「何时放行」的回复门：卡住某个剧本回复，等断言落定再 release（钉死交错）。 */
function replyGate(text: string) {
  let release!: () => void;
  const lock = new Promise<void>((res) => {
    release = () => res();
  });
  return {
    reply: () => lock.then(() => fauxAssistantMessage(text)),
    release: () => release(),
  };
}

function toolCallMsg(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
}

// ── 幕 1：三幕 happy path ──────────────────────────────────────────────

describe('M3 E2E 幕 1：spawn → wait → resume → 收尾', () => {
  it('planner 全链路跑通：建子、等子、追加返工、再等、最终文本收尾', async () => {
    const gateB = replyGate('B 已完成');
    // 对象引用而非闭包 let：TS 对闭包捕获变量的窄化分析不会因匿名函数内的赋值
    // 失效，会把外层读窄成 null。属性读取 + 非空断言永远合法。
    const childRef: { path: AgentPath | null } = { path: null };

    const { host, events } = await e2e({
      routes: {
        '做 X': (ctx, i) => {
          if (i === 0) return toolCallMsg('agent', { role: 'developer', task: '实现 A' });
          // 子路径从转录解析：agent 工具的 toolResult 文本里有「已创建子 Agent …」
          childRef.path ??= createdAgentIds(ctx).sort()[0] ?? null;
          if (!childRef.path) throw new Error('脚本解析不到已创建子 Agent，转录或工具文本变了');
          if (i === 1) return toolCallMsg('agent_wait', { ids: [childRef.path] });
          if (i === 2) return toolCallMsg('agent_resume', { id: childRef.path, text: '返工，把 A 改成 B' });
          if (i === 3) return toolCallMsg('agent_wait', { ids: [childRef.path] });
          return fauxAssistantMessage('收到 B 的结果，任务完成');
        },
        '实现 A': () => fauxAssistantMessage('A 已完成'),
        '返工，把 A 改成 B': gateB.reply,
      },
    });

    const planner = host.spawn({ role: 'planner' });
    const run = host.requestRun(planner.path, '做 X');

    // 第二次 agent_wait 是确定性挂起点：子被 gate B 卡在答话上（running），父必然 waiting。
    await waitFor(
      () =>
        statusRail(events, planner.path).includes('waiting') &&
        childRef.path !== null &&
        host.get(childRef.path)?.status === 'running',
    );

    const childPath = childRef.path!;
    expect(host.get(planner.path)?.status).toBe('waiting'); // 父退位让额，子正在跑
    expect(statusRail(events, childPath)).toContain('done'); // 子已完成第一轮（A）

    gateB.release(); // 放行返工答复 → 子 done → 父被唤醒 → 最后一段剧本

    await waitFor(() => host.get(planner.path)?.status === 'done' && host.get(childPath)?.status === 'done');
    await run; // requestRun 的 Promise 在整轮跑完时 resolve —— 无超时即无死锁

    const planRail = statusRail(events, planner.path);
    expect(planRail[0]).toBe('running');
    expect(planRail[planRail.length - 1]).toBe('done');

    const childRail = statusRail(events, childPath);
    // 子轨道：第一轮 done 后 resume 归位（done→idle 为终态重置）再第二轮。
    expect(childRail).toEqual(['running', 'done', 'idle', 'running', 'done']);

    // 转录收尾：父最后一句是收尾文本；子两次答复都在。
    expect(assistantTexts(host, planner.path).at(-1)).toBe('收到 B 的结果，任务完成');
    expect(assistantTexts(host, childPath)).toEqual(['A 已完成', 'B 已完成']);

    // 全程无 error 状态事件。
    for (const e of events) expect(e.payload.error).toBeUndefined();
    // 工具调用全计入事件账：agent / wait / resume / wait 共 4 次。
    const toolStarts = events.filter((e) => e.event === 'agent.tool.start' && e.source === planner.path);
    expect(toolStarts.map((e) => e.payload.tool)).toEqual(['agent', 'agent_wait', 'agent_resume', 'agent_wait']);
  });
});

// ── 幕 2：gate=1 死锁免检 ──────────────────────────────────────────────

describe('M3 E2E 幕 2：gate=1 父等两子，退位补位无死锁', () => {
  it('parent 独占额度 spawn 两子 → 双双 parked → 父退位 → 串行 FIFO → 唤醒收尾', async () => {
    const gateA = replyGate('A 已完成');
    const gateB = replyGate('B 已完成');
    const idsRef: { ids: AgentPath[] | null } = { ids: null };

    const { host, events } = await e2e({
      maxConcurrent: 1,
      routes: {
        '做 X': (ctx, i) => {
          if (i === 0) return toolCallMsg('agent', { role: 'developer', task: '实现 A' });
          if (i === 1) return toolCallMsg('agent', { role: 'developer', task: '实现 B' });
          if (i === 2) {
            idsRef.ids = createdAgentIds(ctx).sort();
            if (idsRef.ids.length !== 2) throw new Error('脚本解析不到两个已创建子 Agent');
            return toolCallMsg('agent_wait', { ids: idsRef.ids });
          }
          return fauxAssistantMessage('两个都好了，任务完成');
        },
        '实现 A': gateA.reply,
        '实现 B': gateB.reply,
      },
    });

    const planner = host.spawn({ role: 'planner' });
    const run = host.requestRun(planner.path, '做 X');

    // 父 agent_wait → 退位 waiting；d1 FIFO 补位 running；d2 仍 parked waiting。
    await waitFor(() => statusRail(events, planner.path).includes('waiting') && idsRef.ids !== null);
    const [d1, d2] = idsRef.ids! as [AgentPath, AgentPath];
    expect(host.get(d1)?.status).toBe('running');
    expect(host.get(d2)?.status).toBe('waiting'); // parked

    const d1Rail = statusRail(events, d1);
    const d2Rail = statusRail(events, d2);
    expect(d1Rail[0]).toBe('waiting'); // 出生即 parked（父占唯一额度）
    expect(d2Rail[0]).toBe('waiting');

    gateA.release();
    await waitFor(() => host.get(d1)?.status === 'done' && host.get(d2)?.status === 'running');

    // 串行铁证：d1 的 done 事件先于 d2 的 running 事件（FIFO drain 序列化）。
    const d1Done = firstIndex(events, (e) => e.event === 'agent.status' && e.payload.path === d1 && e.payload.status === 'done');
    const d2Run = firstIndex(events, (e) => e.event === 'agent.status' && e.payload.path === d2 && e.payload.status === 'running');
    expect(d1Done).toBeGreaterThan(-1);
    expect(d2Run).toBeGreaterThanOrEqual(d1Done + 1);

    gateB.release();
    await waitFor(() => host.get(planner.path)?.status === 'done' && host.get(d2)?.status === 'done');
    await run; // 全链路无死锁即本测试的最终断言

    expect(statusRail(events, d1)).toEqual(['waiting', 'running', 'done']);
    expect(statusRail(events, d2)).toEqual(['waiting', 'running', 'done']);
    const planRail = statusRail(events, planner.path);
    expect(planRail[0]).toBe('running');
    expect(planRail[planRail.length - 1]).toBe('done');
    expect(assistantTexts(host, planner.path).at(-1)).toBe('两个都好了，任务完成');
    for (const e of events) expect(e.payload.error).toBeUndefined();
  });
});
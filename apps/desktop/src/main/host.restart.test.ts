/**
 * 重启集成测试（M5 §八「最重要的一例」）。
 *
 * 不 mock 文件系统：真盘建会话 → dispose → 新 host 开在同一个根上 → 逐项断言
 * 「列表 / 树 / 消息 / 账本 / 用量 / 状态」全部回来，且懒加载成立。
 *
 * 覆盖三条决策：1A（重启把未决结算掉）、2A（open 账目结算 + 注明）、3A（懒加载）。
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoleDefinition, TeamDefinition, TeamEntry } from '@axon/protocol';
import {
  createFauxSource,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedSource,
  Type,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence, type SessionListItem } from './session-persistence.ts';
import {
  encodeLedgerLine,
  encodeTranscriptLine,
  parseLedgerFile,
  parseTranscriptFile,
  sessionPaths,
  transcriptFileName,
} from './session-files.ts';
import { ALL_ROLES } from './roles.ts';
import { BUILTIN_TEAMS } from './teams.ts';

const TEST_ROLES: RoleDefinition[] = [
  {
    name: 'boss',
    displayName: '主管',
    description: '',
    instructions: '你是主管。',
    tools: ['peek', 'poke'],
    approval: 'auto',
    defaultForkMode: 'none',
  },
  {
    name: 'worker',
    displayName: '干活的',
    description: '',
    instructions: '你干活。',
    tools: ['poke'],
    approval: 'auto',
    defaultForkMode: 'none',
  },
];

function makeTools() {
  const mk = (name: string) => ({
    name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: `${name} ok` }] }),
  });
  return [mk('peek'), mk('poke')];
}

/** 有状态路由：第一次派活，之后收口（无状态路由会让引擎空转）。 */
function delegatingRoutes() {
  let n = 0;
  return {
    分派: () =>
      n++ === 0
        ? fauxAssistantMessage([fauxToolCall('agent', { role: 'worker', task: '写实现' })], {
            stopReason: 'toolUse',
          })
        : fauxAssistantMessage('已派人，等它回话。'),
  };
}

const roots: string[] = [];
/** 收尾前先把待写落盘：写入是异步的，`rm` 与它们抢同一个目录就会 ENOTEMPTY。 */
const boots: SessionPersistence[] = [];
afterEach(async () => {
  const ps = boots.splice(0);
  await Promise.all(ps.map((p) => p.flush().catch(() => undefined)));
  // rollup 走定时器：给一拍让「最后一笔」排队，再收一次口
  await new Promise((r) => setTimeout(r, 25));
  await Promise.all(ps.map((p) => p.flush().catch(() => undefined)));
  await Promise.all(
    roots.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }),
    ),
  );
});

interface Booted {
  host: AxonHost;
  root: string;
  persistence: SessionPersistence;
}

/** 起一个宿主；`records` 非空 = 这次是「重启后的第二次开机」。 */
async function boot(root: string, records?: SessionListItem[]): Promise<Booted> {
  const persistence = new SessionPersistence({ root, rollupIntervalMs: 1 });
  boots.push(persistence);
  const src = await createFauxSource();
  const modelSource: ModelSource = scriptedSource(
    src,
    delegatingRoutes(),
    (text) => fauxAssistantMessage(`${text} 的答复`),
  );
  const host = new AxonHost({
    modelSource,
    roles: [...ALL_ROLES, ...TEST_ROLES],
    tools: makeTools(),
    emit: () => undefined,
    persistence,
    ...(records ? { records } : {}),
  });
  const teams: TeamEntry[] = BUILTIN_TEAMS.map((team: TeamDefinition) => ({
    team,
    source: 'builtin' as const,
    errors: [],
  }));
  host.updateTeams(teams, []);
  return { host, root, persistence };
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'axon-restart-'));
  roots.push(dir);
  return dir;
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pathsFor = (b: Booted, list: SessionListItem[]) => {
  const item = list[0];
  if (!item) throw new Error('没有会话');
  return sessionPaths(b.root, item.record.cwd, item.record.id);
};

/** 跑一轮「建队 → 派活 → 收工」，返回第一次开机的现场。 */
async function runThenQuit(root: string) {
  const first = await boot(root);
  const created = first.host.createSession({
    title: '跨层改动',
    executor: 'team',
    teamId: '测试双人',
    initialPrompt: '分派',
  });
  const sessionId = created.record.id;
  const rootPath = created.rootPath;
  await waitFor(() => first.host.get(rootPath)?.status === 'done');
  // 等被派的成员也收工（否则账目还是 open，「重启结算」一测就混）
  await waitFor(() => first.host.queryLedger({ sessionId }).records.every((r) => r.status === 'settled'));
  await first.persistence.flush();

  const before = first.host.getSession(sessionId);
  const items = await first.persistence.listRecords();
  first.host.dispose();
  return { first, sessionId, rootPath, before, items };
}

// ────────────────────────────────────────────────────────────
// 一、列表秒开：不读树（决策 3A）
// ─────────────────────────────────────────────────────────────

describe('重启 · 懒加载', () => {
  it('第二次开机：列表不读树就有正确的成员数与用量；点开才加载', async () => {
    const root = await tempRoot();
    const { before, items } = await runThenQuit(root);
    expect(before?.counts.members).toBe(3); // 主控 + 测试双人的两名成员

    const second = await boot(root, items);
    // ① 列表：不触发任何 transcript 读取（loadedCount 还是 0）
    const list = second.host.listSessions();
    expect(list).toHaveLength(1);
    expect(second.host.storageStatus().loadedCount).toBe(0);
    // 成员数/用量来自落盘的 rollup —— 不读树也能显示
    expect(list[0]?.counts.members).toBe(before?.counts.members);
    expect(list[0]?.usage.costUsd).toBeCloseTo(before?.usage.costUsd ?? 0, 6);
    expect(list[0]?.record.title).toBe('跨层改动');

    // ② 点开才加载
    const detail = second.host.getSession(list[0]!.record.id);
    expect(detail).not.toBeNull();
    expect(second.host.storageStatus().loadedCount).toBe(1);
    expect(detail?.members.map((m) => m.path).sort()).toEqual(
      before?.members.map((m) => m.path).sort(),
    );
  });

  it('storage.status 说清「东西在哪」：根目录 / 会话数 / 已加载数 / 无 issue', async () => {
    const root = await tempRoot();
    const { items } = await runThenQuit(root);
    const second = await boot(root, items);
    const status = second.host.storageStatus();
    expect(status.root).toBe(root);
    expect(status.sessionCount).toBe(1);
    expect(status.loadedCount).toBe(0);
    expect(status.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 二、树 / 消息 / 账本 / 用量都回来
// ─────────────────────────────────────────────────────────────

describe('重启 · 内容恢复', () => {
  it('树、消息、账本、用量逐项恢复（真盘 → 新 host）', async () => {
    const root = await tempRoot();
    const { sessionId, rootPath, before, items } = await runThenQuit(root);
    const second = await boot(root, items);

    // ① 树：根 + 2 名成员，身份与父子关系都在
    const detail = second.host.getSession(sessionId);
    expect(detail?.members.map((m) => m.path).sort()).toEqual(
      before?.members.map((m) => m.path).sort(),
    );
    for (const member of detail?.members ?? []) {
      expect(member.sessionId).toBe(sessionId);
      expect(second.host.get(member.path)?.parent).toBe(
        member.path === rootPath ? undefined : rootPath,
      );
    }

    // ② 消息：磁盘上的每条都读回来了（主控 transcript 一条不少）
    const paths = sessionPaths(root, items[0]!.record.cwd, sessionId);
    const parsed = parseTranscriptFile(
      await readFile(join(paths.agentsDir, transcriptFileName(rootPath)), 'utf8'),
    );
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(second.host.messagesOf(rootPath).length).toBeGreaterThanOrEqual(
      parsed.messages.length,
    );

    // ③ 账本：笔数与内容一致（delegate 还在）
    const ledger = second.host.queryLedger({ sessionId });
    expect(ledger.records.length).toBeGreaterThan(0);
    expect(ledger.records.some((r) => r.action === 'delegate')).toBe(true);

    // ④ 用量：root 的累计用量恢复（预算熔断吃的是这一个）
    const restoredRoot = second.host.get(rootPath);
    expect(restoredRoot?.usage.costUsd).toBeCloseTo(
      before?.members.find((m) => m.path === rootPath)?.usage.costUsd ?? 0,
      6,
    );
  });

  it('重启后主控仍拿得到编排工具（升级过的会话按 record 校正根身份）', async () => {
    const root = await tempRoot();
    const first = await boot(root);
    const solo = first.host.createSession({ title: '单干', executor: 'engine' });
    // 单兵 → 团队：磁盘上的根 header 仍是 engine 身份（升级只追加 note）
    first.host.escalateSession({ sessionId: solo.record.id, teamId: '测试双人' });
    await first.persistence.flush();
    const items = await first.persistence.listRecords();
    first.host.dispose();

    const second = await boot(root, items);
    const detail = second.host.getSession(solo.record.id);
    expect(second.host.get(solo.rootPath)?.role).toBe('lead'); // 按 record.executor 校正
    expect(detail?.members.length).toBe(3);
    expect(second.host.orchestrationToolsFor(solo.rootPath).length).toBeGreaterThan(0);
  });

  it('重启后还能接着干活：引擎用读回来的消息重灌', async () => {
    const root = await tempRoot();
    const { sessionId, rootPath, items } = await runThenQuit(root);
    const second = await boot(root, items);
    second.host.getSession(sessionId); // 触发加载
    const before = second.host.messagesOf(rootPath).length;
    await second.host.prompt(rootPath, '继续');
    expect(second.host.messagesOf(rootPath).length).toBeGreaterThan(before);
  });
});

// ────────────────────────────────────────────────────────────
// 三、恢复语义（§4.6）：降级 + 结算 + 留痕
// ────────────────────────────────────────────────────────────

describe('重启 · 恢复语义', () => {
  it('running → idle：状态降级 + note 留痕 + rollup.interruptedAt', async () => {
    const root = await tempRoot();
    const { sessionId, rootPath, items } = await runThenQuit(root);
    // 造一个「崩溃在运行中」的现场：磁盘上最后一条 state 是 running
    const paths = sessionPaths(root, items[0]!.record.cwd, sessionId);
    // 模拟「崩溃在运行中途」：磁盘上最后一条 state 停在 running
    await appendStateLine(paths.agentsDir, rootPath, 'running');

    const second = await boot(root, items);
    const detail = second.host.getSession(sessionId);
    expect(detail?.status).toBe('idle'); // 降为空闲（不是 failed：那是失败，这不是）
    // note 是排队写的：先 flush 再读盘（否则读到的是旧文件）
    await second.persistence.flush();
    const transcript = parseTranscriptFile(
      await readFile(join(paths.agentsDir, transcriptFileName(rootPath)), 'utf8'),
    );
    expect(transcript.notes.some((n) => n.text.includes('应用重启'))).toBe(true);
    const rollup = second.persistence.loadSessionSync(items[0]!.record).rollup;
    expect(rollup?.interruptedAt).toBeGreaterThan(0);
  });

  it('rollup 透到 UI（MU-3 E-1）：未加载的 summary 就带 interruptedAt，加载后不丢', async () => {
    const root = await tempRoot();
    const first = await boot(root);
    first.host.createSession({ title: '被中断的', executor: 'engine' });
    // 同「全局预算」那例：先把建会话带起的异步写链收干、停掉宿主，
    // 手写的汇总才不会被后到的 rollup 盖掉。
    await first.persistence.flush();
    await new Promise((r) => setTimeout(r, 30));
    await first.persistence.flush();
    first.host.dispose();
    await new Promise((r) => setTimeout(r, 30));
    await first.persistence.flush();
    const item = (await first.persistence.listRecords())[0]!;
    const interruptedAt = Date.now() - 60_000;
    await first.persistence.saveRecord(item.record, {
      at: Date.now(),
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      counts: { members: 2, running: 1, parked: 0, suspended: 0, ledger: 0, pending: 0 },
      status: 'running',
      interruptedAt,
    });
    const items = await first.persistence.listRecords();

    const second = await boot(root, items);
    // ① 未加载态（session.list 不读树）：摘要就要能说出「上次中断」
    expect(second.host.storageStatus().loadedCount).toBe(0);
    const listed = second.host.listSessions({}).find((s) => s.record.id === item.record.id);
    expect(listed?.rollup?.interruptedAt).toBe(interruptedAt);
    // ② 加载后仍在：那是历史事实，不因本次装载而消失
    const detail = second.host.getSession(item.record.id);
    expect(detail?.rollup?.interruptedAt).toBe(interruptedAt);
  });

  it('账本 open → settled：summary 写明「应用重启，未及结算」（决策 2A）', async () => {
    const root = await tempRoot();
    const { sessionId, items } = await runThenQuit(root);
    const paths = sessionPaths(root, items[0]!.record.cwd, sessionId);
    // 造一笔「重启时还没结算」的账：把最后一笔改成 open 追加回去
    const parsed = parseLedgerFile(await readFile(paths.ledgerFile, 'utf8'));
    const record = parsed.records.at(-1);
    expect(record).toBeDefined();
    const open = { ...record!, id: `${record!.id}-open`, version: record!.version + 1, status: 'open' as const };
    await appendFile(paths.ledgerFile, encodeLedgerLine({ type: 'record', record: open }), 'utf8');

    const second = await boot(root, items);
    second.host.getSession(sessionId); // 触发加载 → 结算
    const settled = second.host
      .queryLedger({ sessionId })
      .records.filter((r) => r.id === open.id);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('settled');
    expect(settled[0]?.summary).toContain('应用重启');
  });

  it('全局预算接着上次算：已花按 rollup 之和种子化，UI 也看得见（§4.5）', async () => {
    const root = await tempRoot();
    const first = await boot(root);
    const solo = first.host.createSession({ title: '花钱的', executor: 'engine' });
    // 建会话会带起一条异步链（createSession → 写账本头 → 排一次 rollup）。
    // 先把这条链收干、把宿主停掉，再往盘上写这份「上次退出时的汇总」——
    // 否则后到的写会把手写的汇总带走（踩过：同样的代码随机红）。
    await first.persistence.flush(); // 建会话的写是排队的，读盘前先收口
    await new Promise((r) => setTimeout(r, 30)); // 等 1ms 的 rollup 定时器真的落地
    await first.persistence.flush();
    first.host.dispose(); // 之后没有谁再来调度 rollup，手写的那份才不会被盖
    await new Promise((r) => setTimeout(r, 30));
    await first.persistence.flush();
    const item = (await first.persistence.listRecords())[0]!;
    // 手写一份「上次退出时已花 $1.25」的汇总（faux 的用量是 0，跑不出真钱）。
    // saveRecord 是排队写，await 本身就等到落盘，不需要再 flush（再 flush 会把
    // 可能残留的 pending rollup 写下去，反而盖掉这一份）。
    await first.persistence.saveRecord(item.record, {
      at: Date.now(),
      usage: { inputTokens: 1000, outputTokens: 500, costUsd: 1.25 },
      counts: { members: 1, running: 0, parked: 0, suspended: 0, ledger: 0, pending: 0 },
      status: 'idle',
    });
    const items = await first.persistence.listRecords();

    const second = await boot(root, items);
    // 冷启动：registry 里没有节点，全局已花只能来自种子化
    expect(second.host.storageStatus().loadedCount).toBe(0);
    expect(second.host.budgetSnapshot().spentUsd).toBeCloseTo(1.25, 6);
    expect(solo.record.id.length).toBeGreaterThan(0);
  });
});

// ─ 小工具 ──────────────────────────────────────────────────

/** 直接往 transcript 追加一条 state 行（模拟「崩溃在 running 中途」）。 */
async function appendStateLine(
  agentsDir: string,
  path: string,
  status: 'running' | 'waiting' | 'done',
): Promise<void> {
  const file = join(agentsDir, transcriptFileName(path));
  await appendFile(file, encodeTranscriptLine({ type: 'state', at: Date.now(), status }), 'utf8');
}

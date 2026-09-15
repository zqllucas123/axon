/**
 * AxonHost 落盘接线测试（M5 §4.4「写入点 = 状态变更点」）。
 *
 * 这一片只验**接线**：格式归 session-files.test.ts，IO 与并发归
 * session-persistence.test.ts。所以这里一律走真盘（mkdtemp），不注入假 IO ——
 * 「假 IO 能过、真机不落盘」的接线错误只有真盘才抓得住。
 */

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_STORAGE_VERSION,
  type AgentPath,
  type EventMap,
  type RoleDefinition,
  type SessionRecord,
  type TeamDefinition,
  type TeamEntry,
} from '@axon/protocol';
import {
  createFauxSource,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedSource,
  Type,
  type ModelSource,
} from '@axon/kernel';
import { AxonHost } from './host.ts';
import { SessionPersistence } from './session-persistence.ts';
import {
  parseLedgerFile,
  parseSessionFile,
  parseTranscriptFile,
  sessionPaths,
  transcriptFileName,
  type ParsedSessionFile,
  type ParsedTranscript,
} from './session-files.ts';
import { ALL_ROLES } from './roles.ts';
import { BUILTIN_TEAMS } from './teams.ts';

/** 两个能碰假工具的测试角色（名字要真在白名单里，理由见 host.session.test.ts）。 */
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

interface Harness {
  host: AxonHost;
  root: string;
  persistence: SessionPersistence;
  events: { event: keyof EventMap; payload: unknown }[];
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(
  opts: { routes?: Record<string, () => unknown>; failAppend?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'axon-m5-host-'));
  roots.push(root);
  const persistence = new SessionPersistence({
    root,
    rollupIntervalMs: 1,
    ...(opts.failAppend
      ? {
          io: {
            appendFile: async (): Promise<void> => {
              throw new Error('磁盘满了（测试注入）');
            },
          },
        }
      : {}),
  });
  const src = await createFauxSource();
  const modelSource: ModelSource = scriptedSource(
    src,
    opts.routes ?? {},
    (text) => fauxAssistantMessage(`${text} 的答复`),
  );
  const events: { event: keyof EventMap; payload: unknown }[] = [];
  const host = new AxonHost({
    modelSource,
    roles: [...ALL_ROLES, ...TEST_ROLES],
    tools: makeTools(),
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    persistence,
  });
  const teams: TeamEntry[] = BUILTIN_TEAMS.map((team: TeamDefinition) => ({
    team,
    source: 'builtin' as const,
    errors: [],
  }));
  host.updateTeams(teams, []);
  return { host, root, persistence, events };
}

const pathsFor = (h: Harness, rec: SessionRecord) => sessionPaths(h.root, rec.cwd, rec.id);

async function transcriptOf(h: Harness, rec: SessionRecord, path: AgentPath): Promise<ParsedTranscript> {
  const file = join(pathsFor(h, rec).agentsDir, transcriptFileName(path));
  return parseTranscriptFile(await readFile(file, 'utf8'));
}

async function sessionFileOf(h: Harness, rec: SessionRecord): Promise<ParsedSessionFile> {
  return parseSessionFile(await readFile(pathsFor(h, rec).sessionFile, 'utf8'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─────────────────────────────────────────────────────────────
// 一、建会话：目录 + session.json + 成员 header
// ─────────────────────────────────────────────────────────────

describe('host 落盘 · 建会话', () => {
  it('engine 会话：session.json 与根的 transcript header 同时就位', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '持久化', executor: 'engine' });
    await h.persistence.flush();

    const parsed = await sessionFileOf(h, s.record);
    expect(parsed.issues).toEqual([]);
    expect(parsed.file?.storageVersion).toBe(SESSION_STORAGE_VERSION);
    expect(parsed.file?.record.id).toBe(s.record.id);
    expect(parsed.file?.record.title).toBe('持久化');

    const t = await transcriptOf(h, s.record, s.rootPath);
    expect(t.issues).toEqual([]);
    expect(t.header?.path).toBe(s.rootPath);
    expect(t.header?.role).toBe('engine');
  });

  it('team 会话：全部成员的 header 一次写全（建树早于建记录，不能漏人）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '组队', executor: 'team', teamId: '测试双人' });
    await h.persistence.flush();

    // 主控 + 两名成员
    expect(s.counts.members).toBe(2);
    const files = (await readdir(pathsFor(h, s.record).agentsDir)).sort();
    expect(files).toHaveLength(3);

    const headers = await Promise.all(
      files.map(async (f) =>
        parseTranscriptFile(await readFile(join(pathsFor(h, s.record).agentsDir, f), 'utf8')).header,
      ),
    );
    for (const header of headers) {
      expect(header?.sessionId).toBe(s.record.id);
      expect(header?.displayName).toBeTruthy();
    }
    expect(headers.map((x) => x?.path).sort()).toEqual(
      h.host
        .list()
        .map((a) => a.path)
        .sort(),
    );

    // 账本 header 也已就位（还没有记录）
    const ledger = parseLedgerFile(await readFile(pathsFor(h, s.record).ledgerFile, 'utf8'));
    expect(ledger.sessionId).toBe(s.record.id);
    expect(ledger.records).toEqual([]);
  });

  it('建会话后立刻来消息：消息行仍排在 header 之后（顺序 = 能不能恢复出这个人）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '抢时序', executor: 'engine' });
    // 有意不 flush：prompt 紧跟着建会话（真实用户就是这样点的）
    await h.host.prompt(s.rootPath, '立刻说话');
    await h.persistence.flush();

    const t = await transcriptOf(h, s.record, s.rootPath);
    const text = await readFile(
      join(pathsFor(h, s.record).agentsDir, transcriptFileName(s.rootPath)),
      'utf8',
    );
    const firstType = (JSON.parse(text.trim().split('\n')[0] ?? '{}') as { type?: string }).type;
    expect(firstType).toBe('agent');
    expect(t.header?.path).toBe(s.rootPath);
  });
});

// ─────────────────────────────────────────────────────────────
// 二、运行中的写入：消息 / 状态 / 汇总
// ─────────────────────────────────────────────────────────────

describe('host 落盘 · 运行中', () => {
  it('一轮对话：user 与 assistant 两条消息行 + 终态 state（带 usage）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '聊天', executor: 'engine' });
    await h.host.prompt(s.rootPath, '你好');
    await h.persistence.flush();

    const t = await transcriptOf(h, s.record, s.rootPath);
    const roles = t.messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    // 用户那条就是原文（前端时间线要靠它）
    expect(JSON.stringify(t.messages.find((m) => m.role === 'user'))).toContain('你好');

    // 一轮跑完的终态是 done（不是 idle：idle 是「还没跑过」）
    expect(t.states.at(-1)?.status).toBe('done');
    expect(t.states.some((st) => st.status === 'running')).toBe(true);
    expect(t.states.some((st) => st.usage !== undefined)).toBe(true);
  });

  it('汇总缓存写进 session.json（懒加载下列表只看它）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '汇总', executor: 'engine' });
    await h.host.prompt(s.rootPath, '你好');
    await h.persistence.flush();

    const parsed = await sessionFileOf(h, s.record);
    expect(parsed.issues).toEqual([]);
    expect(parsed.file?.rollup?.counts).toBeDefined();
    expect(parsed.file?.rollup?.status).toBe('done');
    expect(parsed.file?.rollup?.usage).toBeDefined();
    expect(parsed.file?.rollup?.at).toBeGreaterThan(0);
  });

  it('spawn 出来的新成员补写 header，parent 指向会话根', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '派活', executor: 'team', teamId: '测试双人' });
    const child = h.host.spawn({ parent: s.rootPath, role: 'worker' });
    await waitFor(() => h.host.list().some((a) => a.path === child.path));
    await h.persistence.flush();

    const t = await transcriptOf(h, s.record, child.path);
    expect(t.header?.parent).toBe(s.rootPath);
    expect(t.header?.role).toBe('worker');
    expect(t.header?.sessionId).toBe(s.record.id);
  });

  it('账本变更即追加：delegate 落盘，读回来能对上', async () => {
    // 路由必须**有状态**：否则引擎在「调工具 → 失败 → 再问模型」之间空转
    // （host.session.test.ts 头注记过的坑）。
    let n = 0;
    const h = await harness({
      routes: {
        分派: () =>
          n++ === 0
            ? fauxAssistantMessage([fauxToolCall('agent', { role: 'developer', task: '写实现' })], {
                stopReason: 'toolUse',
              })
            : fauxAssistantMessage('已派人，等它回话。'),
      },
    });
    const s = h.host.createSession({
      title: '组队',
      executor: 'team',
      teamId: '测试双人',
      initialPrompt: '分派',
    });
    await waitFor(() => h.host.queryLedger({ sessionId: s.record.id }).records.length > 0);
    await h.persistence.flush();

    const ledger = parseLedgerFile(await readFile(pathsFor(h, s.record).ledgerFile, 'utf8'));
    const actions = ledger.records.map((r) => r.action);
    expect(actions).toContain('delegate');
    for (const rec of ledger.records) expect(rec.sessionId).toBe(s.record.id);
  });
});

// ─────────────────────────────────────────────────────────────
// 三、改 / 删：rename、删会话、删成员、升级注记
// ─────────────────────────────────────────────────────────────

describe('host 落盘 · 改与删', () => {
  it('rename：session.json 的 title 立刻改写', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '旧名', executor: 'engine' });
    await h.persistence.flush();
    h.host.renameSession(s.record.id, '新名');
    await h.persistence.flush();

    const parsed = await sessionFileOf(h, s.record);
    expect(parsed.file?.record.title).toBe('新名');
  });

  it('删会话：整个目录物理消失（决策 4A）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '待删', executor: 'engine' });
    await h.host.prompt(s.rootPath, '你好');
    await h.persistence.flush();
    const dir = pathsFor(h, s.record).sessionDir;
    expect(await exists(dir)).toBe(true);

    h.host.removeSession(s.record.id);
    await h.persistence.flush();
    expect(await exists(dir)).toBe(false);
  });

  it('删成员：它的 transcript 也要删（留着会在重启后复活成僵尸节点）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '裁员', executor: 'team', teamId: '测试双人' });
    const child = h.host.spawn({ parent: s.rootPath, role: 'worker' });
    await waitFor(() => h.host.list().some((a) => a.path === child.path));
    await h.persistence.flush();
    const file = join(pathsFor(h, s.record).agentsDir, transcriptFileName(child.path));
    expect(await exists(file)).toBe(true);

    h.host.remove(child.path);
    await h.persistence.flush();
    expect(await exists(file)).toBe(false);
    // 根的 transcript 不受牵连
    expect(
      await exists(join(pathsFor(h, s.record).agentsDir, transcriptFileName(s.rootPath))),
    ).toBe(true);
  });

  it('escalate：根 transcript 留一条注记（不进模型上下文，只在时间线显示）', async () => {
    const h = await harness();
    const s = h.host.createSession({ title: '单干', executor: 'engine' });
    h.host.escalateSession({ sessionId: s.record.id, teamId: '测试双人' });
    await h.persistence.flush();

    const t = await transcriptOf(h, s.record, s.rootPath);
    expect(t.notes.some((n) => n.text.includes('会话升级'))).toBe(true);
    // 升级不重写 header：同一个文件 = 同一个人（transcript 是追加流，改身份要
    // 追加第二条 agent 行，而读侧认第一份）。留一个已知缺口记在这里：
    // header.role 仍是 engine，恢复时**必须**按 record.executor/teamId 校正根身份，
    // 否则升级过的会话重启后主控会丢掉编排工具（切片 5 的恢复语义）。
    expect(t.header?.role).toBe('engine');
    expect(t.header?.path).toBe(s.rootPath);
  });
});

// ─────────────────────────────────────────────────────────────
// 四、写失败：不静默，也不回滚内存（R6）
// ────────────────────────────────────────────────────────────

describe('host 落盘 · 写失败', () => {
  it('追加失败：issue 记 write-failed，业务照常（内存状态不回滚）', async () => {
    const h = await harness({ failAppend: true });
    const s = h.host.createSession({ title: '写不进去', executor: 'engine' });
    await h.host.prompt(s.rootPath, '你好');
    await h.persistence.flush();

    // 会话在内存里一切正常 —— 磁盘坏了不该让用户用不了
    expect(h.host.get(s.rootPath)?.role).toBe('engine');
    expect(h.host.messagesOf(s.rootPath).length).toBeGreaterThan(0);
    // 但失败必须留痕，不能吞掉
    expect(h.persistence.issues().some((i) => i.kind === 'write-failed')).toBe(true);
  });
});

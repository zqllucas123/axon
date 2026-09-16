/**
 * SessionPersistence 单测 —— **真盘**（M5 §八）。
 *
 * 用 mkdtemp 真目录而不是内存 IO（抄 `config-store.test.ts:14-23` 范式）：
 * 原子写、临时文件清理、目录删除这些行为在内存替身上验不出来。
 * 只有「写失败」一例用注入 IO 造错（`config-store.test.ts:255-274` 同款）。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_VERSION,
  type MessageLike,
  type SessionRecord,
  type StorageIssueKind,
} from '@axon/protocol';
import { SessionPersistence } from './session-persistence.ts';
import {
  AGENTS_DIR_NAME,
  CORRUPT_DIR_NAME,
  LEDGER_FILE_NAME,
  SESSION_FILE_NAME,
  encodeSessionFile,
  parseLedgerFile,
  parseSessionFile,
  sessionPaths,
  type TranscriptHeader,
} from './session-files.ts';

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'axon-sessions-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const CWD = '/Users/lucaszhou/works/prjs/demo';

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1abc-def0',
    title: '把支付回调改成幂等',
    cwd: CWD,
    executor: 'engine',
    status: 'open',
    createdAt: 1_758_000_000_000,
    updatedAt: 1_758_000_001_000,
    schemaVersion: SESSION_SCHEMA_VERSION,
    ...over,
  };
}

function header(path: string, over: Partial<TranscriptHeader> = {}): TranscriptHeader {
  return {
    sessionId: 's1abc-def0',
    path: path as TranscriptHeader['path'],
    role: 'developer',
    displayName: '后端',
    forkMode: 'none',
    createdAt: 1_758_000_000_500,
    ...over,
  };
}

const MSG: MessageLike = { role: 'user', content: [{ type: 'text', text: '开始吧' }] };
const kinds = (issues: { kind: StorageIssueKind }[]) => issues.map((i) => i.kind);

async function readSessionFile(root: string, rec = record()) {
  const text = await readFile(sessionPaths(root, rec.cwd, rec.id).sessionFile, 'utf8');
  return parseSessionFile(text);
}

// ─────────────────────────────────────────────────────────────
// 扫描（启动路径）
// ─────────────────────────────────────────────────────────────

describe('SessionPersistence · 扫描', () => {
  it('根目录不存在 ⇒ 空列表，不抛（首次启动）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    expect(await p.listRecords()).toEqual([]);
    expect(p.issues()).toEqual([]); // 没有根目录不是问题
  });

  it('建会话后扫描得到 record 与 rollup（不读 transcript）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    const created = await p.createSession(rec, [header(`/${rec.id}`)]);
    expect(created.ok).toBe(true);
    await p.saveRecord(rec, {
      at: 1_758_000_009_000,
      usage: { inputTokens: 11, outputTokens: 22, costUsd: 0.03 },
      counts: { members: 1, running: 0, parked: 0, suspended: 0, ledger: 2, pending: 0 },
      status: 'idle',
    });

    const items = await p.listRecords();
    expect(items).toHaveLength(1);
    expect(items[0]?.record.title).toBe('把支付回调改成幂等');
    expect(items[0]?.rollup?.usage.costUsd).toBe(0.03);
    expect(p.sessionCount()).toBe(1);
  });

  it('缺 session.json 的目录 ⇒ orphan-dir 且跳过，不删', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const stray = join(root, '--Users-me-proj--', 's9orphan');
    await mkdir(join(stray, AGENTS_DIR_NAME), { recursive: true });
    await writeFile(join(stray, AGENTS_DIR_NAME, 'dev-1.jsonl'), '');

    expect(await p.listRecords()).toEqual([]);
    expect(kinds(p.issues())).toEqual(['orphan-dir']);
    // 目录还在（不自动删用户数据）
    expect(await readdir(stray)).toContain(AGENTS_DIR_NAME);
  });

  it('坏 session.json ⇒ corrupt-line issue，其余会话照收', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    await p.createSession(record({ id: 'good' }));
    const bad = sessionPaths(root, CWD, 'bad');
    await mkdir(bad.sessionDir, { recursive: true });
    await writeFile(bad.sessionFile, '{ nope');

    const items = await p.listRecords();
    expect(items.map((i) => i.record.id)).toEqual(['good']);
    expect(kinds(p.issues())).toEqual(['corrupt-line']);
  });

  it('storageVersion 过新 ⇒ 拒载该会话（version-too-new）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record({ id: 'future' });
    const paths = sessionPaths(root, rec.cwd, rec.id);
    await mkdir(paths.sessionDir, { recursive: true });
    await writeFile(
      paths.sessionFile,
      JSON.stringify({ storageVersion: SESSION_STORAGE_VERSION + 1, savedAt: 0, record: rec }),
    );

    expect(await p.listRecords()).toEqual([]);
    expect(kinds(p.issues())).toEqual(['version-too-new']);
  });

  it('多个会话按 updatedAt 倒序（同刻按 id 兜底）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    await p.createSession(record({ id: 'a', updatedAt: 100 }));
    await p.createSession(record({ id: 'b', updatedAt: 300 }));
    await p.createSession(record({ id: 'c', updatedAt: 200 }));
    expect((await p.listRecords()).map((i) => i.record.id)).toEqual(['b', 'c', 'a']);
  });
});

// ─────────────────────────────────────────────────────────────
// 装载
// ─────────────────────────────────────────────────────────────

describe('SessionPersistence · 装载', () => {
  it('往返：header + 消息 + 状态 + 注记 + 账本', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root, now: () => 1_758_000_500_000 });
    const rec = record();
    const rootPath = `/${rec.id}`;
    await p.createSession(rec, [header(rootPath)]);
    await p.writeLedgerHeader(rec);
    await p.flush();
    await p.appendMessage(rec, rootPath, MSG, 1_758_000_100_000);
    await p.appendMessage(rec, rootPath, { role: 'assistant', content: [{ type: 'text', text: '好' }] }, 1_758_000_200_000);
    await p.appendState(rec, rootPath, {
      at: 1_758_000_300_000,
      status: 'done',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      lastError: null,
    });
    await p.appendNote(rec, rootPath, '应用重启：运行中被中断，已降为空闲');
    await p.appendLedger(rec, {
      version: 1,
      id: 'l-000001-ab',
      sessionId: rec.id,
      action: 'delegate',
      from: rootPath,
      to: `${rootPath}/dev-1`,
      origin: { tool: 'agent', toolCallId: 'tc-1' },
      mention: 'mention://agent-session/dev-1',
      adoption: 'not_applicable',
      status: 'open',
      at: 1_758_000_200_000,
    });
    await p.flush();

    const loaded = await p.loadSession(rec);
    expect(p.issues()).toEqual([]);
    expect(loaded.record.title).toBe(rec.title);
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0]?.header?.path).toBe(rootPath);
    expect(loaded.agents[0]?.messages).toHaveLength(2);
    expect(loaded.agents[0]?.states).toEqual([
      { at: 1_758_000_300_000, status: 'done', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }, lastError: null },
    ]);
    expect(loaded.agents[0]?.notes[0]?.text).toContain('应用重启');
    expect(loaded.ledger.map((r) => r.id)).toEqual(['l-000001-ab']);
  });

  it('会话目录不存在（还没落盘）⇒ 空壳，不抛也不报错', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const loaded = await p.loadSession(record());
    expect(loaded.agents).toEqual([]);
    expect(loaded.ledger).toEqual([]);
    expect(p.issues()).toEqual([]);
  });

  it('文件名与 header.path 不一致 ⇒ path-mismatch（以 header 为准）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    const paths = sessionPaths(root, rec.cwd, rec.id);
    await mkdir(paths.agentsDir, { recursive: true });
    // 文件名 dev-1.jsonl，header 却是 dev-2
    await writeFile(
      join(paths.agentsDir, 'dev-1.jsonl'),
      `${JSON.stringify({ type: 'agent', storageVersion: 1, schemaVersion: 1, sessionId: rec.id, path: `/${rec.id}/dev-2`, role: 'r', displayName: 'D', createdAt: 1 })}\n`,
    );

    const loaded = await p.loadSession(rec);
    expect(loaded.agents[0]?.header?.path).toBe(`/${rec.id}/dev-2`);
    expect(kinds(p.issues())).toEqual(['path-mismatch']);
  });

  it('坏行不阻断：好行照收，坏行进 issue', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    const path = `/${rec.id}`;
    await p.createSession(rec, [header(path)]);
    await p.flush();
    const file = join(sessionPaths(root, rec.cwd, rec.id).agentsDir, `${rec.id}.jsonl`);
    await writeFile(
      file,
      (await readFile(file, 'utf8')) +
        '{oops\n' +
        `${JSON.stringify({ type: 'message', at: 5, message: MSG })}\n`,
    );

    const loaded = await p.loadSession(rec);
    expect(loaded.agents[0]?.messages).toHaveLength(1);
    expect(kinds(p.issues())).toEqual(['corrupt-line']);
  });

  it('非 transcript 文件（.corrupt 之类）被跳过', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    const paths = sessionPaths(root, rec.cwd, rec.id);
    await p.createSession(rec, [header(`/${rec.id}`)]);
    await mkdir(paths.corruptDir, { recursive: true });
    await writeFile(join(paths.corruptDir, 'dev-1.jsonl.2026-09-15T00-00-00'), '{ nope');

    const loaded = await p.loadSession(rec);
    expect(loaded.agents).toHaveLength(1);
    expect(p.issues()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 写入
// ─────────────────────────────────────────────────────────────

describe('SessionPersistence · 写入', () => {
  it('原子写不留 tmp；旧 tmp 在下次写入时被清掉（R11）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    await p.createSession(rec);
    const paths = sessionPaths(root, rec.cwd, rec.id);

    const stray = `${paths.sessionFile}.tmp-999`;
    await writeFile(stray, '残留');
    await p.saveRecord(rec);
    expect(await readdir(paths.sessionDir)).not.toContain(`${SESSION_FILE_NAME}.tmp-999`);
    expect(await readdir(paths.sessionDir)).toContain(SESSION_FILE_NAME);
  });

  it('并发 append 不交错：同文件按调用顺序落 N 行', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    const path = `/${rec.id}`;
    await p.createSession(rec, [header(path)]);
    await p.flush();

    const writes = Array.from({ length: 25 }, (_, i) =>
      p.appendMessage(rec, path, { role: 'user', content: [{ type: 'text', text: `#${i}` }] }, i),
    );
    expect((await Promise.all(writes)).every((r) => r.ok)).toBe(true);

    const loaded = await p.loadSession(rec);
    expect(loaded.agents[0]?.messages).toHaveLength(25);
    expect(loaded.agents[0]?.messages.map((m) => (m.content as { text: string }[])[0]?.text)).toEqual(
      Array.from({ length: 25 }, (_, i) => `#${i}`),
    );
    expect(p.issues()).toEqual([]);
  });

  it('同一个成员的两个文件互不阻塞（各排各的队）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    await p.createSession(rec, [header(`/${rec.id}`), header(`/${rec.id}/dev-1`)]);
    await p.flush();
    await Promise.all([
      p.appendNote(rec, `/${rec.id}`, 'a'),
      p.appendNote(rec, `/${rec.id}/dev-1`, 'b'),
    ]);
    const loaded = await p.loadSession(rec);
    const notes = loaded.agents.flatMap((a) => a.notes.map((n) => n.text)).sort();
    expect(notes).toEqual(['a', 'b']);
  });

  it('写 session.json 失败 ⇒ ok:false + write-failed issue（不谎报）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({
      root,
      io: { writeFile: async () => Promise.reject(new Error('磁盘满了')) },
    });
    const rec = record();
    const res = await p.saveRecord(rec);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('磁盘满了');
    expect(kinds(p.issues())).toEqual(['write-failed']);
  });

  it('append transcript 失败 ⇒ ok:false + write-failed issue', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({
      root,
      io: { appendFile: async () => Promise.reject(new Error('只读文件系统')) },
    });
    const res = await p.appendMessage(record(), `/${record().id}`, MSG, 1);
    expect(res.ok).toBe(false);
    expect(kinds(p.issues())).toEqual(['write-failed']);
  });

  it('删会话 = 整目录消失（决策 4A）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    await p.createSession(rec, [header(`/${rec.id}`)]);
    await p.appendMessage(rec, `/${rec.id}`, MSG, 1);
    await p.flush();

    expect((await p.removeSession(rec)).ok).toBe(true);
    expect(await p.listRecords()).toEqual([]);
    await expect(readdir(sessionPaths(root, rec.cwd, rec.id).sessionDir)).rejects.toThrow();
  });

  it('隔离坏文件：移入 .corrupt 且原文名保留（不删）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root, now: () => 1_758_000_600_000 });
    const rec = record();
    const paths = sessionPaths(root, rec.cwd, rec.id);
    await p.createSession(rec, [header(`/${rec.id}/dev-9`)]);
    await p.flush();

    expect((await p.quarantine(rec, 'dev-9.jsonl')).ok).toBe(true);
    const moved = await readdir(paths.corruptDir);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.startsWith('dev-9.jsonl.')).toBe(true);
    expect(await readdir(paths.agentsDir)).not.toContain('dev-9.jsonl');
  });

  it('rollup 合并到窗口外才写；flush 收口待写（§4.4）', async () => {
    const root = await tempRoot();
    let clock = 10_000;
    const p = new SessionPersistence({ root, now: () => clock, rollupIntervalMs: 500 });
    const rec = record();
    await p.createSession(rec);

    const rollup = (ledger: number) => ({
      at: clock,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      counts: { members: 1, running: 0, parked: 0, suspended: 0, ledger, pending: 0 },
      status: 'idle' as const,
    });

    p.scheduleRollup(rec, rollup(1)); // 首次：窗口外（lastRollupAt=0）⇒ 立刻写
    await p.flush();
    expect((await readSessionFile(root, rec)).file?.rollup?.counts.ledger).toBe(1);

    clock = 10_100;
    p.scheduleRollup(rec, rollup(2)); // 窗口内 ⇒ 挂起
    expect((await readSessionFile(root, rec)).file?.rollup?.counts.ledger).toBe(1);

    clock = 10_600;
    await p.flush();
    expect((await readSessionFile(root, rec)).file?.rollup?.counts.ledger).toBe(2);
  });

  it('汇总的延迟写不回退元数据：以盘上的 record 为准（老快照写回会丢 executor）', async () => {
    const root = await tempRoot();
    let clock = 100; // 离 lastRollupAt(0) 还在窗口内 ⇒ 这一笔会挂起
    const p = new SessionPersistence({ root, now: () => clock, rollupIntervalMs: 500 });
    const rec = record();
    await p.createSession(rec);

    const rollupAt = (at: number) => ({
      at,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      counts: { members: 1, running: 0, parked: 0, suspended: 0, ledger: 0, pending: 0 },
      status: 'idle' as const,
    });

    p.scheduleRollup(rec, rollupAt(clock)); // 挂起（窗口内）
    clock = 110;
    await p.saveRecord({ ...rec, executor: 'team' }); // 同一会话升级成团队
    clock = 120;
    await p.flush(); // 老快照到此才落地

    const after = await readSessionFile(root, rec);
    expect(after.file?.record.executor).toBe('team'); // 没被老快照盖回 engine
    expect(after.file?.rollup?.at).toBe(100); // 汇总本身照写
  });

  it('待写的汇总按会话分槽：两个会话各写各的（单槽时后者顶掉前者）', async () => {
    const root = await tempRoot();
    const clock = 100;
    const p = new SessionPersistence({ root, now: () => clock, rollupIntervalMs: 500 });
    const a = record({ id: 'sA-1' });
    const b = record({ id: 'sB-1' });
    await p.createSession(a);
    await p.createSession(b);

    const rollupAt = (ledger: number) => ({
      at: clock,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      counts: { members: 1, running: 0, parked: 0, suspended: 0, ledger, pending: 0 },
      status: 'idle' as const,
    });

    p.scheduleRollup(a, rollupAt(1)); // 两笔都在窗口内 ⇒ 都挂起
    p.scheduleRollup(b, rollupAt(2));
    await p.flush();

    expect((await readSessionFile(root, a)).file?.rollup?.counts.ledger).toBe(1);
    expect((await readSessionFile(root, b)).file?.rollup?.counts.ledger).toBe(2);
  });

  it('issue 上限：超出丢最旧（§4.8 上限 100）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root, issueLimit: 3 });
    const paths = sessionPaths(root, CWD, 's1');
    await mkdir(paths.sessionDir, { recursive: true });
    await writeFile(paths.sessionFile, '{ nope');
    for (let i = 0; i < 5; i += 1) await p.listRecords();
    const issues = p.issues();
    expect(issues).toHaveLength(3);
    expect(issues.every((i) => i.kind === 'corrupt-line')).toBe(true);
  });

  it('status() 报出 root / 会话数 / issues（host 补 loadedCount）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    await p.createSession(record());
    await p.listRecords();
    const s = p.status();
    expect(s.root).toBe(root);
    expect(s.sessionCount).toBe(1);
    expect(s.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 与纯格式层的接口一致性
// ─────────────────────────────────────────────────────────────

describe('SessionPersistence · 落盘形状', () => {
  it('session.json 带外箱版本与 savedAt（可被 parseSessionFile 读回）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root, now: () => 42 });
    const rec = record();
    await p.createSession(rec);
    const raw = JSON.parse(await readFile(sessionPaths(root, rec.cwd, rec.id).sessionFile, 'utf8'));
    expect(raw.storageVersion).toBe(SESSION_STORAGE_VERSION);
    expect(raw.savedAt).toBe(42);
    expect(raw.record.id).toBe(rec.id);
  });

  it('账本文件首行是 header，其余是 record（读侧 last-wins）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    await p.writeLedgerHeader(rec);
    await p.appendLedger(rec, {
      version: 1,
      id: 'l-1',
      sessionId: rec.id,
      action: 'consult',
      from: `/${rec.id}`,
      to: `/${rec.id}/dev-1`,
      origin: { tool: 'agent', toolCallId: 'tc-1' },
      mention: 'mention://agent-session/dev-1',
      adoption: 'not_applicable',
      status: 'open',
      at: 1,
    });
    await p.flush();
    const parsed = parseLedgerFile(
      await readFile(sessionPaths(root, rec.cwd, rec.id).ledgerFile, 'utf8'),
    );
    expect(parsed.sessionId).toBe(rec.id);
    expect(parsed.records).toHaveLength(1);
  });

  it('落盘的 session.json 形状：外箱版本 + savedAt + record', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    await p.createSession(rec);
    const text = await readFile(sessionPaths(root, rec.cwd, rec.id).sessionFile, 'utf8');
    const raw = JSON.parse(text) as { storageVersion: number; savedAt: number; record: unknown };
    expect(raw.storageVersion).toBe(SESSION_STORAGE_VERSION);
    expect(raw.savedAt).toBeGreaterThan(0);
    expect(raw.record).toEqual(rec);
  });
});

// ─────────────────────────────────────────────────────────────
// 同步装载（懒加载：host.getSession / queryLedger 是同步 API）
// ─────────────────────────────────────────────────────────────

describe('session-persistence · loadSessionSync', () => {
  it('与异步装载同结果：header / 消息 / 状态 / 账本逐项一致', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    const h = header('/s1abc-def0');
    await p.createSession(rec, [h]);
    await p.appendMessage(rec, h.path, MSG, 1_758_000_002_000);
    await p.appendState(rec, h.path, { at: 1_758_000_003_000, status: 'done' });
    await p.writeLedgerHeader(rec);
    await p.flush();

    const asyncLoaded = await p.loadSession(rec);
    const syncLoaded = p.loadSessionSync(rec);
    expect(syncLoaded.record).toEqual(asyncLoaded.record);
    expect(syncLoaded.agents.map((a) => a.header?.path)).toEqual(
      asyncLoaded.agents.map((a) => a.header?.path),
    );
    expect(syncLoaded.agents[0]?.messages).toEqual(asyncLoaded.agents[0]?.messages);
    expect(syncLoaded.agents[0]?.states).toEqual(asyncLoaded.agents[0]?.states);
    expect(syncLoaded.ledger).toEqual(asyncLoaded.ledger);
    expect(p.issues()).toEqual([]);
  });

  it('会话目录还不存在：返回空壳，不报错也不记 issue（新会话尚未落盘）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const loaded = p.loadSessionSync(record({ id: 'sghost000-0000' }));
    expect(loaded.agents).toEqual([]);
    expect(loaded.ledger).toEqual([]);
    expect(p.issues()).toEqual([]);
  });

  it('坏行照旧容错：同步路径的 issue 与异步路径一致（同一套解析）', async () => {
    const root = await tempRoot();
    const p = new SessionPersistence({ root });
    const rec = record();
    await p.createSession(rec, [header('/s1abc-def0')]);
    await p.flush();
    // 手工往 transcript 里插一行垃圾（模拟外部改坏）
    const file = join(sessionPaths(root, rec.cwd, rec.id).agentsDir, 's1abc-def0.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')) + '{ 这不是 JSON\n', 'utf8');

    const p2 = new SessionPersistence({ root });
    const syncLoaded = p2.loadSessionSync(rec);
    expect(kinds(p2.issues())).toContain('corrupt-line');
    expect(syncLoaded.agents[0]?.header?.path).toBe('/s1abc-def0'); // 坏行不影响好行
  });
});

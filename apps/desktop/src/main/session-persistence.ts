/**
 * SessionPersistence —— `~/.axon/sessions/` 的 IO 层（M5 §4.3/§4.4）。
 *
 * 分工：`session-files.ts` 是纯函数（路径与编解码），本文件只负责**碰磁盘**：
 * 扫描、装载、原子写、append 队列、坏文件隔离、issue 汇总。
 *
 * 三条纪律（都来自 M5 的拍板）：
 *
 * 1. **写失败不静默、也不抛**：返回 `{ ok:false, error }` + 记一条 `write-failed`
 *    issue（R6）。内存状态不回滚 —— 用户的操作继续有效，只是这一笔没落盘。
 * 2. **per-file 串行**：同一文件的 append 依次落盘（并发写会交错出坏行）；
 *    不同文件互不阻塞（各排各的队）。
 * 3. **读侧永不阻断**：坏行/半行/版本过新/缺 header 都只进 issue 清单，
 *    能读多少读多少（R2）；**不自动修复、不自动删**任何用户数据。
 *
 * 写入模型见 §4.4：写入点 = 状态变更点；transcript 与 ledger 走 append，
 * session.json 走原子写（tmp + rename）；**不做 fsync**（显式取舍）。
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import {
  SESSION_STORAGE_VERSION,
  type LedgerRecord,
  type MessageLike,
  type SessionRecord,
  type SessionRollup,
  type StorageIssue,
  type StorageIssueKind,
} from '@axon/protocol';
import {
  SESSION_FILE_NAME,
  agentLine,
  encodeLedgerLine,
  encodeSessionFile,
  encodeTranscriptLine,
  isTranscriptFileName,
  ledgerHeaderLine,
  messageLine,
  noteLine,
  parseLedgerFile,
  parseSessionFile,
  parseTranscriptFile,
  sessionPaths,
  stateLine,
  transcriptFileName,
  type SessionPaths,
  type TranscriptHeader,
  type TranscriptState,
} from './session-files.ts';
import type { ParsedTranscript } from './session-files.ts';

/** 写结果：失败不抛，交给调用方决定是否提示（R6）。 */
export type WriteResult = { ok: true } | { ok: false; error: string };

export interface SessionPersistenceIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  /** 目录不存在时 reject（调用方按 ENOENT 判定「没有」）。 */
  readdir(dir: string): Promise<string[]>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface SessionPersistenceOptions {
  /** sessions 根；`AXON_SESSIONS_DIR` 可覆盖（测试/冒烟用临时目录）。 */
  root: string;
  io?: Partial<SessionPersistenceIO>;
  /** 注入时钟（测试用）；缺省 Date.now。 */
  now?: () => number;
  /** issue 清单上限（超出丢最旧）。缺省 100（§4.8）。 */
  issueLimit?: number;
  /** rollup 合并窗口（§4.4：≥500ms）。 */
  rollupIntervalMs?: number;
}

/** `listRecords` 的一个条目：列表要显示的字段全在这里（懒加载下不读树）。 */
export interface SessionListItem {
  record: SessionRecord;
  rollup?: SessionRollup;
}

/** 一个会话的全部落盘内容（懒加载时读一次）。 */
export interface LoadedSession {
  record: SessionRecord;
  rollup?: SessionRollup;
  agents: ParsedTranscript[];
  ledger: LedgerRecord[];
}

const fsIO: SessionPersistenceIO = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, data) => writeFile(p, data, 'utf8'),
  appendFile: (p, data) => appendFile(p, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  readdir: (dir) => readdir(dir),
  rm: (p, o) => rm(p, o),
};

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionPersistence {
  readonly root: string;
  private readonly io: SessionPersistenceIO;
  private readonly now: () => number;
  private readonly issueLimit: number;
  private readonly rollupIntervalMs: number;
  /** 每文件一条串行链（写入不交错，见文件头纪律 2）。 */
  private readonly queues = new Map<string, Promise<void>>();
  /** 非队列的异步操作（删除/隔离）也纳入 flush 的等待集合。 */
  private readonly inflight = new Set<Promise<unknown>>();
  /** 每会话最近一次的汇总缓存：元数据变更（rename 等）不许把它冲掉。 */
  private readonly rollups = new Map<string, SessionRollup>();
  private readonly issueList: StorageIssue[] = [];
  private sessionCountCache = 0;
  /** 待写的汇总缓存（合并到 window 之后落盘）。 */
  private pendingRollup?: { record: SessionRecord; rollup: SessionRollup };
  private rollupTimer?: ReturnType<typeof setTimeout>;
  private lastRollupAt = 0;

  constructor(options: SessionPersistenceOptions) {
    this.root = options.root;
    this.io = { ...fsIO, ...options.io };
    this.now = options.now ?? Date.now;
    this.issueLimit = options.issueLimit ?? 100;
    this.rollupIntervalMs = options.rollupIntervalMs ?? 500;
  }

  /** 相对 sessions root 的路径（issue 里不暴露用户绝对路径，§4.8）。 */
  private rel(path: string): string {
    return relative(this.root, path) || '.';
  }

  private pushIssue(kind: StorageIssueKind, path: string, detail: string, sessionId?: string): void {
    this.issueList.push({
      kind,
      path: this.rel(path),
      detail,
      at: this.now(),
      ...(sessionId ? { sessionId } : {}),
    });
    while (this.issueList.length > this.issueLimit) this.issueList.shift();
  }

  /** 把一个不在队列里的异步操作登记进来，让 `flush()` 能等到它。 */
  private track<T>(task: Promise<T>): Promise<T> {
    this.inflight.add(task);
    void task.then(
      () => this.inflight.delete(task),
      () => this.inflight.delete(task),
    );
    return task;
  }

  private absorb(issues: StorageIssue[]): void {
    for (const i of issues) this.issueList.push(i);
    while (this.issueList.length > this.issueLimit) this.issueList.shift();
  }

  /** issue 清单的快照（`storage.status` 的数据源）。 */
  issues(): StorageIssue[] {
    return [...this.issueList];
  }

  sessionCount(): number {
    return this.sessionCountCache;
  }

  /** 会话目录下三个文件与隔离区的路径。 */
  pathsOf(record: SessionRecord): SessionPaths {
    return sessionPaths(this.root, record.cwd, record.id);
  }

  // ──────────────────────────────────────────────────────────
  // 读侧
  // ───────────────────────────────────────────────────────────

  /**
   * 扫描所有桶下的 `session.json`（**两层扫描，非递归**）。
   *
   * 这是启动路径：只读小文件，不碰 transcript 与账本（决策 3A 懒加载）。
   * 缺 session.json 的目录记 `orphan-dir` 并跳过 —— **不自动删**（§5.4）。
   */
  async listRecords(): Promise<SessionListItem[]> {
    const items: SessionListItem[] = [];
    let buckets: string[];
    try {
      buckets = await this.io.readdir(this.root);
    } catch (err) {
      if (!isNotFound(err)) this.pushIssue('unreadable-dir', this.root, `读根目录失败：${errText(err)}`);
      this.sessionCountCache = 0;
      return items;
    }

    for (const bucket of buckets.sort()) {
      if (bucket.startsWith('.')) continue; // 隐藏目录不是桶（例如将来可能的 .trash）
      const bucketDir = join(this.root, bucket);
      let ids: string[];
      try {
        ids = await this.io.readdir(bucketDir);
      } catch (err) {
        if (!isNotFound(err)) {
          this.pushIssue('unreadable-dir', bucketDir, `读桶目录失败：${errText(err)}`);
        }
        continue;
      }

      for (const id of ids.sort()) {
        const dir = join(bucketDir, id);
        const file = join(dir, SESSION_FILE_NAME);
        let text: string;
        try {
          text = await this.io.readFile(file);
        } catch (err) {
          if (isNotFound(err)) {
            this.pushIssue('orphan-dir', dir, `会话目录缺 ${SESSION_FILE_NAME}`);
          } else {
            this.pushIssue('unreadable-dir', file, `读 ${SESSION_FILE_NAME} 失败：${errText(err)}`);
          }
          continue;
        }
        const parsed = parseSessionFile(text, {
          at: this.now(),
          relPath: this.rel(file),
        });
        this.absorb(parsed.issues);
        if (!parsed.file) continue;
        items.push({ record: parsed.file.record, rollup: parsed.file.rollup });
      }
    }

    // 列表顺序：最近更新在前；同刻按 id 兜底（与 SessionStore 的排序同款）。
    items.sort((a, b) => b.record.updatedAt - a.record.updatedAt || (a.record.id < b.record.id ? -1 : 1));
    this.sessionCountCache = items.length;
    return items;
  }

  /**
   * 装载一个会话的全部内容（懒加载触发点）。
   *
   * 读 `session.json` + `agents/*.jsonl` + `ledger.jsonl`；坏文件只记 issue。
   * 会话目录还不存在时返回空壳（新会话尚未落盘，不是错误）。
   */
  async loadSession(record: SessionRecord): Promise<LoadedSession> {
    const paths = this.pathsOf(record);
    const out: LoadedSession = { record, agents: [], ledger: [] };

    const sessionText = await this.readFileOrIssue(paths.sessionFile, record.id);
    if (sessionText !== undefined) {
      const parsed = parseSessionFile(sessionText, {
        at: this.now(),
        sessionId: record.id,
        relPath: this.rel(paths.sessionFile),
      });
      this.absorb(parsed.issues);
      if (parsed.file) {
        out.record = parsed.file.record;
        if (parsed.file.rollup) out.rollup = parsed.file.rollup;
      }
    }

    let names: string[];
    try {
      names = await this.io.readdir(paths.agentsDir);
    } catch (err) {
      if (!isNotFound(err)) {
        this.pushIssue('unreadable-dir', paths.agentsDir, `读 agents 目录失败：${errText(err)}`, record.id);
      }
      names = [];
    }

    for (const name of names.sort()) {
      if (!isTranscriptFileName(name)) continue;
      const file = join(paths.agentsDir, name);
      const text = await this.readFileOrIssue(file, record.id);
      if (text === undefined) continue;
      const parsed = parseTranscriptFile(text, {
        at: this.now(),
        sessionId: record.id,
        relPath: this.rel(file),
      });
      this.absorb(parsed.issues);
      // 文件名只是索引，权威身份在 header 里；两者不一致时以 header 为准并记 issue（§4.1）。
      if (parsed.header && transcriptFileName(parsed.header.path) !== name) {
        this.pushIssue(
          'path-mismatch',
          file,
          `文件名 ${name} 与 header.path ${parsed.header.path} 不一致（以 header 为准）`,
          record.id,
        );
      }
      out.agents.push(parsed);
    }

    const ledgerText = await this.readFileOrIssue(paths.ledgerFile, record.id);
    if (ledgerText !== undefined) {
      const parsed = parseLedgerFile(ledgerText, {
        at: this.now(),
        sessionId: record.id,
        relPath: this.rel(paths.ledgerFile),
      });
      this.absorb(parsed.issues);
      out.ledger = parsed.records;
    }

    return out;
  }

  private async readFileOrIssue(path: string, sessionId: string): Promise<string | undefined> {
    try {
      return await this.io.readFile(path);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      this.pushIssue('unreadable-dir', path, `读文件失败：${errText(err)}`, sessionId);
      return undefined;
    }
  }

  // ──────────────────────────────────────────────────────────
  // 写侧
  // ───────────────────────────────────────────────────────────

  /**
   * 建会话目录：`session.json` + 各成员的 transcript header。
   *
   * 崩溃判据是「目录在不在 + session.json 在不在」：这个会话有它才算建过；
   * header 可能缺（那成员就当没有），不影响会话本身。
   */
  async createSession(record: SessionRecord, headers: TranscriptHeader[] = []): Promise<WriteResult> {
    // **每一笔写都在这里同步入队，一个 await 都不先走**。两个理由，都是真盘上
    // 抓出来的（`host.persistence.test.ts`）：1) 入队是同步的，`flush()` 才等得到
    // 它们 —— 先 await 再入队的话，「建完会话立刻 flush」会漏掉 session.json，
    // 随后那笔迟到的写还会把汇总缓存冲掉（saveRecord 不带 rollup）；2) header 与
    // 消息行共用一条 per-file 队列，先入队 = 先落地 —— 反过来时消息行会排在
    // header 前，而读侧只认第一份 agent 头（session-files.ts:397），那个成员
    // 重启后就读不出身份了。目录创建下沉到各笔写自己的队列任务里。
    const writes = [this.saveRecord(record), ...headers.map((h) => this.writeAgentHeader(record, h))];
    let failed: WriteResult | undefined;
    for (const write of writes) {
      const result = await write;
      if (!result.ok) failed = failed ?? result;
    }
    if (failed) return failed;
    this.sessionCountCache = Math.max(this.sessionCountCache, 1);
    return { ok: true };
  }

  /**
   * 原子写 `session.json`（tmp + rename）。元数据变化时立刻写。
   *
   * rollup **粘性**：不传时沿用本会话上一次的汇总。否则任何一次元数据变更
   * （rename / 预算改写）都会把列表要看的汇总顺手抹掉 —— 而它下一次刷新要
   * 等到 500ms 合并窗口之后。
   */
  saveRecord(record: SessionRecord, rollup?: SessionRollup): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    if (rollup) this.rollups.set(record.id, rollup);
    const effective = rollup ?? this.rollups.get(record.id);
    const payload = encodeSessionFile({
      storageVersion: SESSION_STORAGE_VERSION,
      savedAt: this.now(),
      record,
      ...(effective ? { rollup: effective } : {}),
    });
    return this.enqueue(paths.sessionFile, async () => {
      // mkdir 下沉到队列任务里：createSession 必须同步入队每一笔写，而入队时
      // 目录可能还没建出来（见 createSession 注释）。
      await this.io.mkdir(paths.sessionDir);
      return this.writeAtomic(paths.sessionFile, payload, record.id);
    });
  }

  /**
   * 合并写汇总缓存（§4.4：≥500ms 一次）。
   *
   * 只在窗口外立刻写；窗口内记待写，由一个定时器（或 `flush()`）收口。
   * 用途是列表显示，**丢一次不会丢真相**。
   */
  scheduleRollup(record: SessionRecord, rollup: SessionRollup): void {
    this.pendingRollup = { record, rollup };
    const wait = this.rollupIntervalMs - (this.now() - this.lastRollupAt);
    if (wait <= 0) {
      void this.writePendingRollup();
      return;
    }
    if (this.rollupTimer) return;
    this.rollupTimer = setTimeout(() => {
      this.rollupTimer = undefined;
      void this.writePendingRollup();
    }, wait);
    // 别让定时器把进程留活（Electron 的 will-quit 另有 flush）。
    (this.rollupTimer as { unref?: () => void }).unref?.();
  }

  private async writePendingRollup(): Promise<void> {
    const pending = this.pendingRollup;
    if (!pending) return;
    this.pendingRollup = undefined;
    this.lastRollupAt = this.now();
    await this.saveRecord(pending.record, pending.rollup);
  }

  /** 落盘所有待写内容（will-quit 收尾）。返回是否全部成功。 */
  async flush(): Promise<void> {
    if (this.rollupTimer) {
      clearTimeout(this.rollupTimer);
      this.rollupTimer = undefined;
    }
    await this.writePendingRollup();
    await Promise.all([...this.queues.values(), ...this.inflight]);
  }

  /** 写成员 transcript 的第一行（agent header）。 */
  writeAgentHeader(record: SessionRecord, header: TranscriptHeader): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    const file = join(paths.agentsDir, transcriptFileName(header.path));
    return this.enqueue(file, async () => {
      try {
        await this.io.mkdir(paths.agentsDir);
        await this.io.appendFile(file, encodeTranscriptLine(agentLine(header)));
        return { ok: true as const };
      } catch (err) {
        return this.writeFailed(file, `写 transcript header 失败：${errText(err)}`, record.id);
      }
    });
  }

  /** append 一条消息行（每条 user/assistant/toolResult 一次）。 */
  appendMessage(
    record: SessionRecord,
    path: string,
    message: MessageLike,
    at: number,
  ): Promise<WriteResult> {
    return this.appendTranscript(record, path, encodeTranscriptLine(messageLine(message, at)), '消息');
  }

  /** append 一条状态行（done/failed/interrupted/waiting 跃迁时必写）。 */
  appendState(record: SessionRecord, path: string, state: TranscriptState): Promise<WriteResult> {
    return this.appendTranscript(record, path, encodeTranscriptLine(stateLine(state)), '状态');
  }

  /** append 一条注记行（重启降级/孤儿修复等；不进模型上下文）。 */
  appendNote(record: SessionRecord, path: string, text: string, at?: number): Promise<WriteResult> {
    return this.appendTranscript(
      record,
      path,
      encodeTranscriptLine(noteLine(text, at ?? this.now())),
      '注记',
    );
  }

  private appendTranscript(
    record: SessionRecord,
    path: string,
    line: string,
    label: string,
  ): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    const file = join(paths.agentsDir, transcriptFileName(path));
    return this.enqueue(file, async () => {
      try {
        await this.io.appendFile(file, line);
        return { ok: true as const };
      } catch (err) {
        return this.writeFailed(file, `追加${label}失败：${errText(err)}`, record.id);
      }
    });
  }

  /** 写账本 header（建会话时一次）。 */
  writeLedgerHeader(record: SessionRecord): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    return this.enqueue(paths.ledgerFile, async () => {
      try {
        await this.io.mkdir(paths.sessionDir);
        await this.io.appendFile(paths.ledgerFile, encodeLedgerLine(ledgerHeaderLine(record.id)));
        return { ok: true as const };
      } catch (err) {
        return this.writeFailed(paths.ledgerFile, `写账本 header 失败：${errText(err)}`, record.id);
      }
    });
  }

  /** append 一条账本记录（变更即追加；读侧 last-wins）。 */
  appendLedger(record: SessionRecord, entry: LedgerRecord): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    return this.enqueue(paths.ledgerFile, async () => {
      try {
        await this.io.appendFile(paths.ledgerFile, encodeLedgerLine({ type: 'record', record: entry }));
        return { ok: true as const };
      } catch (err) {
        return this.writeFailed(paths.ledgerFile, `追加账本失败：${errText(err)}`, record.id);
      }
    });
  }

  /** 物理删除整个会话目录（决策 4A：一次 rm -rf 就是完整语义）。 */
  removeSession(record: SessionRecord): Promise<WriteResult> {
    return this.track(this.doRemoveSession(record));
  }

  private async doRemoveSession(record: SessionRecord): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    try {
      await this.io.rm(paths.sessionDir, { recursive: true, force: true });
      this.sessionCountCache = Math.max(0, this.sessionCountCache - 1);
      this.rollups.delete(record.id);
      return { ok: true };
    } catch (err) {
      return this.writeFailed(paths.sessionDir, `删会话目录失败：${errText(err)}`, record.id);
    }
  }

  /**
   * 删掉一个成员的 transcript（成员被移除时）。
   *
   * 必须真的删：留着它，下次启动扫 agents/*.jsonl 会把那个成员「复活」——
   * 而它的引擎、队列、等待边都不在了，用户会看到一个永远不会动的僵尸节点。
   */
  removeTranscript(record: SessionRecord, path: string): Promise<WriteResult> {
    return this.track(this.doRemoveTranscript(record, path));
  }

  private async doRemoveTranscript(record: SessionRecord, path: string): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    const file = join(paths.agentsDir, transcriptFileName(path));
    try {
      await this.io.rm(file, { recursive: false, force: true });
      return { ok: true };
    } catch (err) {
      return this.writeFailed(file, `删 transcript 失败：${errText(err)}`, record.id);
    }
  }

  /**
   * 隔离一个坏文件：移到 `<sessionId>/.corrupt/<name>.<ts>`（**不删原文**，§4.8）。
   */
  quarantine(record: SessionRecord, fileName: string): Promise<WriteResult> {
    return this.track(this.doQuarantine(record, fileName));
  }

  private async doQuarantine(record: SessionRecord, fileName: string): Promise<WriteResult> {
    const paths = this.pathsOf(record);
    const from = join(paths.agentsDir, fileName);
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const to = join(paths.corruptDir, `${fileName}.${stamp}`);
    try {
      await this.io.mkdir(paths.corruptDir);
      await this.io.rename(from, to);
      return { ok: true };
    } catch (err) {
      return this.writeFailed(from, `隔离坏文件失败：${errText(err)}`, record.id);
    }
  }

  /** `storage.status` 的数据源（host 补 loadedCount）。 */
  status(): { root: string; sessionCount: number; issues: StorageIssue[] } {
    return { root: this.root, sessionCount: this.sessionCountCache, issues: this.issues() };
  }

  // ───────────────────────────────────────────────────────────
  // 内部：原子写 / 队列
  // ───────────────────────────────────────────────────────────

  private writeFailed(path: string, detail: string, sessionId: string): WriteResult {
    this.pushIssue('write-failed', path, detail, sessionId);
    return { ok: false, error: detail };
  }

  /** tmp + rename 原子写；顺手清掉同目录里的旧 tmp（R11，不做全局巡检）。 */
  private async writeAtomic(file: string, payload: string, sessionId: string): Promise<WriteResult> {
    try {
      const dir = dirname(file);
      await this.io.mkdir(dir);
      await this.cleanTmp(dir, basename(file));
      const tmp = `${file}.tmp-${this.now()}`;
      await this.io.writeFile(tmp, payload);
      await this.io.rename(tmp, file);
      return { ok: true };
    } catch (err) {
      return this.writeFailed(file, `写入失败：${errText(err)}`, sessionId);
    }
  }

  private async cleanTmp(dir: string, prefix: string): Promise<void> {
    let names: string[];
    try {
      names = await this.io.readdir(dir);
    } catch {
      return; // 目录还不存在：没有 tmp 可清
    }
    await Promise.all(
      names
        .filter((n) => n.startsWith(`${prefix}.tmp-`))
        .map((n) => this.io.rm(join(dir, n), { recursive: false, force: true }).catch(() => undefined)),
    );
  }

  /** 把任务挂到该文件的队尾，保证同文件写入顺序 = 调用顺序。 */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }
}
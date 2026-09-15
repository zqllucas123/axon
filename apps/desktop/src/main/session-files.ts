/**
 * 会话落盘的文件格式层（M5 §4.2）—— **纯函数、零 IO**。
 *
 * 为什么单独一层：格式与容错是整个 M5 里最需要穷举测试的部分（坏行、半行、
 * 版本过新、文件名与 header 不一致…），而它们全都能在字符串上写完。IO 层
 * （`session-persistence.ts`）只负责「读进来 / 写出去 / 隔离坏文件」，
 * 不解析、不修补 —— 这样格式测试可以零文件系统跑几百例。
 *
 * 布局（M5 §4.1，MU-1 §4.3 已定）：
 *
 *     ~/.axon/sessions/<enc(cwd)>/<sessionId>/
 *       session.json              元数据 + 汇总缓存（原子写）
 *       agents/<leaf>.jsonl       每个成员一份 transcript（append-only）
 *       ledger.jsonl              本会话账本切片（append-only，last-wins）
 *       .corrupt/                 坏文件隔离区
 *
 * 三段式版本号（互不牵连）：
 *   - `SESSION_STORAGE_VERSION`：布局与文件集（本文件里的常量）
 *   - `SESSION_SCHEMA_VERSION`：SessionRecord / transcript 的字段形状
 *   - `LEDGER_SCHEMA_VERSION`：账本记录的字段形状
 */

import {
  LEDGER_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_VERSION,
  type AgentPath,
  type AgentStatus,
  type ForkModeSpec,
  type LedgerRecord,
  type MessageLike,
  type SessionRecord,
  type SessionRollup,
  type StorageIssue,
  type StorageIssueKind,
  type UsageTotals,
} from '@axon/protocol';

// ────────────────────────────────────────────────────────────
// 目录与文件名
// ─────────────────────────────────────────────────────────────

export const SESSIONS_DIR_NAME = 'sessions';
export const AGENTS_DIR_NAME = 'agents';
export const CORRUPT_DIR_NAME = '.corrupt';
export const SESSION_FILE_NAME = 'session.json';
export const LEDGER_FILE_NAME = 'ledger.jsonl';

/**
 * cwd → 桶名。抄 kalo（`session-manager.ts:476-481`）：
 * 去前导斜杠、把 `/ \ :` 换成 `-`，两侧包 `--`。
 *
 * 为什么按 cwd 分桶：一个目录下的会话在 Finder 里聚在一起；为什么**只**影响
 * 分组：会话目录自包含（版本、成员、账本都在会话目录里），桶名与 cwd 不一致
 * 也不影响任何寻址（M5 §六 R3）。
 */
export function encodeCwdBucket(cwd: string): string {
  const stripped = cwd.replace(/[/\\]+$/, '').replace(/^[/\\]/, '');
  return `--${stripped.replace(/[/\\:]/g, '-')}--`;
}

/** 路径末段（`/sX/dev-1` → `dev-1`；`/sX` → `sX`）。 */
export function leafOf(path: AgentPath): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export interface SessionPaths {
  /** `<root>/<bucket>/<sessionId>` */
  sessionDir: string;
  /** `<sessionDir>/session.json` */
  sessionFile: string;
  /** `<sessionDir>/agents` */
  agentsDir: string;
  /** `<sessionDir>/ledger.jsonl` */
  ledgerFile: string;
  /** `<sessionDir>/.corrupt` */
  corruptDir: string;
}

export function sessionPaths(sessionsRoot: string, cwd: string, sessionId: string): SessionPaths {
  const sessionDir = `${sessionsRoot}/${encodeCwdBucket(cwd)}/${sessionId}`;
  return {
    sessionDir,
    sessionFile: `${sessionDir}/${SESSION_FILE_NAME}`,
    agentsDir: `${sessionDir}/${AGENTS_DIR_NAME}`,
    ledgerFile: `${sessionDir}/${LEDGER_FILE_NAME}`,
    corruptDir: `${sessionDir}/${CORRUPT_DIR_NAME}`,
  };
}

/** 成员的 transcript 文件名 = path 末段 + `.jsonl`（权威身份在 header 里，见 M5 §3.1）。 */
export function transcriptFileName(path: AgentPath): string {
  return `${leafOf(path)}.jsonl`;
}

export function isTranscriptFileName(name: string): boolean {
  return name.endsWith('.jsonl') && !name.startsWith('.');
}

// ─────────────────────────────────────────────────────────────
// 解析公共件
// ─────────────────────────────────────────────────────────────

export interface ParseOptions {
  /** 时钟注入（测试用；issue.at）。 */
  at?: number;
  sessionId?: string;
  /** 相对 sessions root 的路径，写进 issue（不暴露用户绝对路径）。 */
  relPath?: string;
  /** 期望的成员路径（用于发现「文件名 vs header.path」不一致）。 */
  expectPath?: AgentPath;
}

function issue(kind: StorageIssueKind, opts: ParseOptions, detail: string): StorageIssue {
  return {
    kind,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    path: opts.relPath ?? '',
    detail,
    at: opts.at ?? 0,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

const STATUSES: readonly AgentStatus[] = [
  'idle',
  'running',
  'waiting',
  'done',
  'failed',
  'interrupted',
];

function isStatus(v: unknown): v is AgentStatus {
  return isStr(v) && (STATUSES as readonly string[]).includes(v);
}

function isUsage(v: unknown): v is UsageTotals {
  return isObject(v) && isNum(v.inputTokens) && isNum(v.outputTokens) && isNum(v.costUsd);
}

/**
 * 按行切分。
 *
 * 关键规则（与 pi / kalo 同款）：**文件不以 `\n` 结尾时，最后一段是撕裂写的半行，
 * 整段丢弃**。我们的写入侧每条都带 `\n`，所以缺尾换行只可能是「写到这里被杀」。
 * 代价：外部工具手写一个没有尾换行的完整文件会丢最后一行 —— 接受（M5 §六 R1）。
 */
function splitLines(text: string, opts: ParseOptions, issues: StorageIssue[]): string[] {
  if (text === '') return [];
  const hadTrailing = text.endsWith('\n');
  const parts = text.split('\n');
  if (hadTrailing) {
    parts.pop(); // 尾换行产生的空串
  } else {
    const partial = parts.pop();
    issues.push(issue('partial-line', opts, `末尾半行已丢弃（${(partial ?? '').length} 字符）`));
  }
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** 逐行 JSON 解析；坏行记 issue 并跳过（不阻断整文件）。 */
function parseJsonLines(
  lines: readonly string[],
  opts: ParseOptions,
  issues: StorageIssue[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue; // 容忍空行，不报 issue
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push(issue('corrupt-line', opts, `第 ${i + 1} 行 JSON 解析失败`));
      continue;
    }
    if (!isObject(parsed)) {
      issues.push(issue('corrupt-line', opts, `第 ${i + 1} 行不是 JSON 对象`));
      continue;
    }
    out.push(parsed);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// session.json
// ─────────────────────────────────────────────────────────────

export interface StoredSessionFile {
  storageVersion: number;
  savedAt: number;
  record: SessionRecord;
  /** 汇总缓存（懒加载下列表的数据源；见 SessionRollup 注释）。 */
  rollup?: SessionRollup;
}

export function encodeSessionFile(file: StoredSessionFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function isSessionRecord(v: unknown): v is SessionRecord {
  return (
    isObject(v) &&
    isStr(v.id) &&
    isStr(v.title) &&
    isStr(v.cwd) &&
    isStr(v.executor) &&
    isStr(v.status) &&
    isNum(v.createdAt) &&
    isNum(v.updatedAt) &&
    isNum(v.schemaVersion)
  );
}

function isRollup(v: unknown): v is SessionRollup {
  return (
    isObject(v) &&
    isNum(v.at) &&
    isUsage(v.usage) &&
    isObject(v.counts) &&
    isStatus(v.status)
  );
}

export interface ParsedSessionFile {
  file?: StoredSessionFile;
  issues: StorageIssue[];
}

export function parseSessionFile(text: string, opts: ParseOptions = {}): ParsedSessionFile {
  const issues: StorageIssue[] = [];
  const trimmed = text.trim();
  if (trimmed === '') {
    issues.push(issue('corrupt-line', opts, 'session.json 为空'));
    return { issues };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    issues.push(issue('corrupt-line', opts, 'session.json 不是合法 JSON'));
    return { issues };
  }
  if (!isObject(parsed)) {
    issues.push(issue('corrupt-line', opts, 'session.json 不是 JSON 对象'));
    return { issues };
  }
  const storageVersion = parsed.storageVersion;
  if (!isNum(storageVersion)) {
    issues.push(issue('corrupt-line', opts, '缺 storageVersion'));
    return { issues };
  }
  if (storageVersion > SESSION_STORAGE_VERSION) {
    // 拒载但**保留原文件**：高版本可能由更新的 Axon 写入，降级写会毁数据（M5 §六 R10）。
    issues.push(
      issue('version-too-new', opts, `storageVersion=${storageVersion} > ${SESSION_STORAGE_VERSION}`),
    );
    return { issues };
  }
  if (!isSessionRecord(parsed.record)) {
    issues.push(issue('corrupt-line', opts, 'record 字段不合法或缺字段'));
    return { issues };
  }
  if (parsed.record.schemaVersion > SESSION_SCHEMA_VERSION) {
    issues.push(
      issue(
        'version-too-new',
        opts,
        `record.schemaVersion=${parsed.record.schemaVersion} > ${SESSION_SCHEMA_VERSION}`,
      ),
    );
    return { issues };
  }
  const file: StoredSessionFile = {
    storageVersion,
    savedAt: isNum(parsed.savedAt) ? parsed.savedAt : 0,
    record: parsed.record,
  };
  if (isObject(parsed.rollup)) {
    if (isRollup(parsed.rollup)) file.rollup = parsed.rollup;
    else issues.push(issue('corrupt-line', opts, 'rollup 形状不合法，已忽略'));
  }
  return { file, issues };
}

// ────────────────────────────────────────────────────────────
// transcript（agents/<leaf>.jsonl）
// ────────────────────────────────────────────────────────────

export interface TranscriptHeader {
  sessionId: string;
  /** 权威身份 —— 不靠文件名反推（kalo 的教训，M5 §3.1）。 */
  path: AgentPath;
  parent?: AgentPath;
  role: string;
  displayName: string;
  forkMode?: ForkModeSpec;
  createdAt: number;
}

export interface TranscriptState {
  at: number;
  status: AgentStatus;
  usage?: UsageTotals;
  lastError?: string | null;
}

export interface TranscriptNote {
  at: number;
  /** 系统注记：**不进入模型上下文**，只在 S2 时间线显示（M5 §4.2 B）。 */
  text: string;
}

export type TranscriptLine =
  | ({ type: 'agent'; storageVersion: number; schemaVersion: number } & TranscriptHeader)
  | { type: 'message'; at: number; message: MessageLike }
  | ({ type: 'state' } & TranscriptState)
  | ({ type: 'note' } & TranscriptNote);

export function agentLine(header: TranscriptHeader): TranscriptLine {
  return {
    type: 'agent',
    storageVersion: SESSION_STORAGE_VERSION,
    schemaVersion: SESSION_SCHEMA_VERSION,
    ...header,
  };
}

export function messageLine(message: MessageLike, at: number): TranscriptLine {
  return { type: 'message', at, message };
}

export function stateLine(state: TranscriptState): TranscriptLine {
  return { type: 'state', ...state };
}

export function noteLine(text: string, at: number): TranscriptLine {
  return { type: 'note', at, text };
}

export function encodeTranscriptLine(line: TranscriptLine): string {
  return `${JSON.stringify(line)}\n`;
}

export interface ParsedTranscript {
  header?: TranscriptHeader;
  messages: MessageLike[];
  states: TranscriptState[];
  notes: TranscriptNote[];
  issues: StorageIssue[];
}

function isHeader(v: Record<string, unknown>): v is Record<string, unknown> & TranscriptHeader {
  return (
    isStr(v.sessionId) && isStr(v.path) && isStr(v.role) && isStr(v.displayName) && isNum(v.createdAt)
  );
}

export function parseTranscriptFile(text: string, opts: ParseOptions = {}): ParsedTranscript {
  const issues: StorageIssue[] = [];
  const out: ParsedTranscript = { messages: [], states: [], notes: [], issues };
  const lines = splitLines(text, opts, issues);
  const objs = parseJsonLines(lines, opts, issues);

  for (const obj of objs) {
    const type = obj.type;
    if (type === 'agent') {
      if (!isHeader(obj)) {
        issues.push(issue('missing-header', opts, 'agent 头字段不完整'));
        continue;
      }
      const version = isNum(obj.storageVersion) ? obj.storageVersion : 0;
      if (version > SESSION_STORAGE_VERSION) {
        issues.push(issue('version-too-new', opts, `transcript storageVersion=${version}`));
        return out; // 拒载整份文件
      }
      if (out.header) {
        issues.push(issue('corrupt-line', opts, '重复的 agent 头（保留第一份）'));
        continue;
      }
      if (opts.expectPath && obj.path !== opts.expectPath) {
        // 以 header 为准（文件名只是索引），但要让用户知道有文件被改名过。
        issues.push(
          issue('path-mismatch', opts, `header.path=${obj.path} ≠ 期望 ${opts.expectPath}`),
        );
      }
      out.header = {
        sessionId: obj.sessionId,
        path: obj.path,
        ...(isStr(obj.parent) ? { parent: obj.parent } : {}),
        role: obj.role,
        displayName: obj.displayName,
        ...(obj.forkMode !== undefined ? { forkMode: obj.forkMode as ForkModeSpec } : {}),
        createdAt: obj.createdAt,
      };
      continue;
    }

    if (!out.header) {
      // 头之前的行一律不收：没有 header 就无法确定这些消息属于谁。
      issues.push(issue('missing-header', opts, 'agent 头之前出现数据行（已忽略该行）'));
      continue;
    }

    if (type === 'message') {
      if (!isObject(obj.message) || !isStr(obj.message.role)) {
        issues.push(issue('corrupt-line', opts, 'message 行缺少合法 message'));
        continue;
      }
      out.messages.push(obj.message as unknown as MessageLike);
      continue;
    }

    if (type === 'state') {
      if (!isStatus(obj.status) || !isNum(obj.at)) {
        issues.push(issue('corrupt-line', opts, 'state 行缺少 status/at'));
        continue;
      }
      const state: TranscriptState = {
        at: obj.at,
        status: obj.status,
        ...(isUsage(obj.usage) ? { usage: obj.usage } : {}),
        ...(obj.lastError === null || isStr(obj.lastError)
          ? { lastError: obj.lastError as string | null }
          : {}),
      };
      out.states.push(state);
      continue;
    }

    if (type === 'note') {
      if (!isStr(obj.text) || !isNum(obj.at)) {
        issues.push(issue('corrupt-line', opts, 'note 行缺少 text/at'));
        continue;
      }
      out.notes.push({ at: obj.at, text: obj.text });
      continue;
    }

    issues.push(issue('corrupt-line', opts, `未知行类型 ${String(type)}`));
  }

  if (!out.header && issues.length === 0) {
    issues.push(issue('missing-header', opts, '空文件（缺 agent 头）'));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// ledger.jsonl
// ─────────────────────────────────────────────────────────────

export interface LedgerHeaderLine {
  type: 'ledger-header';
  storageVersion: number;
  schemaVersion: number;
  sessionId: string;
}

export type LedgerLine = LedgerHeaderLine | { type: 'record'; record: LedgerRecord };

export function ledgerHeaderLine(sessionId: string): LedgerHeaderLine {
  return {
    type: 'ledger-header',
    storageVersion: SESSION_STORAGE_VERSION,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sessionId,
  };
}

export function ledgerRecordLine(record: LedgerRecord): { type: 'record'; record: LedgerRecord } {
  // 精确返回类型：读侧/测试无需从联合里收窄
  return { type: 'record', record };
}

export function encodeLedgerLine(line: LedgerLine): string {
  return `${JSON.stringify(line)}\n`;
}

export interface ParsedLedger {
  sessionId?: string;
  /** **last-wins** 后的记录（同一 id 的多行只留最后一个），保持首次出现的顺序。 */
  records: LedgerRecord[];
  issues: StorageIssue[];
}

function isLedgerRecord(v: unknown): v is LedgerRecord {
  return (
    isObject(v) &&
    isStr(v.id) &&
    isStr(v.sessionId) &&
    isStr(v.action) &&
    isStr(v.status) &&
    isNum(v.at)
  );
}

export function parseLedgerFile(text: string, opts: ParseOptions = {}): ParsedLedger {
  const issues: StorageIssue[] = [];
  const out: ParsedLedger = { records: [], issues };
  const lines = splitLines(text, opts, issues);
  const objs = parseJsonLines(lines, opts, issues);
  /** id → 在 out.records 中的下标（last-wins 覆盖原地，保持顺序）。 */
  const index = new Map<string, number>();

  for (const obj of objs) {
    if (obj.type === 'ledger-header') {
      const version = isNum(obj.storageVersion) ? obj.storageVersion : 0;
      if (version > SESSION_STORAGE_VERSION) {
        issues.push(issue('version-too-new', opts, `ledger storageVersion=${version}`));
        return out;
      }
      if (isStr(obj.sessionId)) out.sessionId = obj.sessionId;
      continue;
    }
    if (obj.type !== 'record') {
      issues.push(issue('corrupt-line', opts, `未知行类型 ${String(obj.type)}`));
      continue;
    }
    if (!isLedgerRecord(obj.record)) {
      issues.push(issue('corrupt-line', opts, 'record 形状不合法'));
      continue;
    }
    const rec = obj.record;
    const prev = index.get(rec.id);
    if (prev === undefined) {
      index.set(rec.id, out.records.length);
      out.records.push(rec);
    } else {
      out.records[prev] = rec; // settle / adopt 后的新版本覆盖旧版本
    }
  }
  return out;
}
/**
 * session-files 单测 —— **零 IO**（M5 §八：格式与容错必须能在字符串上穷举）。
 *
 * 覆盖三类文件（session.json / transcript / ledger）的往返、容错与版本闸门，
 * 以及路径计算的边界。IO 与崩溃注入在下一片（session-persistence.test.ts）测。
 */

import { describe, expect, it } from 'vitest';
import {
  LEDGER_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_VERSION,
  type LedgerRecord,
  type MessageLike,
  type SessionRecord,
  type StorageIssueKind,
} from '@axon/protocol';
import {
  AGENTS_DIR_NAME,
  CORRUPT_DIR_NAME,
  LEDGER_FILE_NAME,
  SESSION_FILE_NAME,
  agentLine,
  encodeCwdBucket,
  encodeLedgerLine,
  encodeSessionFile,
  encodeTranscriptLine,
  isTranscriptFileName,
  leafOf,
  ledgerHeaderLine,
  ledgerRecordLine,
  messageLine,
  noteLine,
  parseLedgerFile,
  parseSessionFile,
  parseTranscriptFile,
  sessionPaths,
  stateLine,
  transcriptFileName,
} from './session-files.ts';

// ─────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────

const RECORD: SessionRecord = {
  id: 's1abc-def0',
  title: '把支付回调改成幂等',
  cwd: '/Users/lucaszhou/works/prjs/demo',
  executor: 'engine',
  status: 'open',
  createdAt: 1_758_000_000_000,
  updatedAt: 1_758_000_001_000,
  schemaVersion: SESSION_SCHEMA_VERSION,
};

const MSG_USER: MessageLike = { role: 'user', content: [{ type: 'text', text: '开始吧' }] };
const MSG_ASSISTANT: MessageLike = {
  role: 'assistant',
  content: [{ type: 'text', text: '好' }],
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
};

const LEDGER: LedgerRecord = {
  version: 1,
  id: 'l-000001-ab',
  sessionId: RECORD.id,
  action: 'delegate',
  from: '/s1abc-def0',
  to: '/s1abc-def0/dev-1',
  origin: { tool: 'agent', toolCallId: 'tc-1' },
  mention: 'mention://agent-session/dev-1',
  adoption: 'pending',
  status: 'open',
  at: 1_758_000_002_000,
};

const kinds = (issues: { kind: StorageIssueKind }[]) => issues.map((i) => i.kind);

// ─────────────────────────────────────────────────────────────
// 路径
// ─────────────────────────────────────────────────────────────

describe('session-files · 路径计算', () => {
  it('encodeCwdBucket 抄 kalo：去前导斜杠 + / 反斜杠 冒号 → - + 两侧 --', () => {
    expect(encodeCwdBucket('/Users/lucaszhou/works/prjs/axon')).toBe(
      '--Users-lucaszhou-works-prjs-axon--',
    );
    expect(encodeCwdBucket('/Users/foo/bar/')).toBe('--Users-foo-bar--');
    expect(encodeCwdBucket('/')).toBe('----');
  });

  it('leafOf 取末段；根会话的末段就是会话 id', () => {
    expect(leafOf('/s1abc-def0')).toBe('s1abc-def0');
    expect(leafOf('/s1abc-def0/dev-1')).toBe('dev-1');
    expect(leafOf('/s1abc-def0/dev-1/sub-2')).toBe('sub-2');
  });

  it('sessionPaths 给出会话目录、三个文件与隔离区', () => {
    const p = sessionPaths('/root', '/Users/me/proj', 's1');
    expect(p.sessionDir).toBe('/root/--Users-me-proj--/s1');
    expect(p.sessionFile).toBe(`/root/--Users-me-proj--/s1/${SESSION_FILE_NAME}`);
    expect(p.agentsDir).toBe(`/root/--Users-me-proj--/s1/${AGENTS_DIR_NAME}`);
    expect(p.ledgerFile).toBe(`/root/--Users-me-proj--/s1/${LEDGER_FILE_NAME}`);
    expect(p.corruptDir).toBe(`/root/--Users-me-proj--/s1/${CORRUPT_DIR_NAME}`);
  });

  it('transcript 文件名 = path 末段 + .jsonl；隐藏文件不算 transcript', () => {
    expect(transcriptFileName('/s1/dev-1')).toBe('dev-1.jsonl');
    expect(isTranscriptFileName('dev-1.jsonl')).toBe(true);
    expect(isTranscriptFileName('.corrupt')).toBe(false);
    expect(isTranscriptFileName('notes.md')).toBe(false);
  });
});
// ────────────────────────────────────────────────────────────
// transcript
// ───────────────────────────────────────────────────────────

describe('session-files · transcript', () => {
  const HEADER = {
    sessionId: RECORD.id,
    path: '/s1abc-def0/dev-1' as const,
    parent: '/s1abc-def0' as const,
    role: 'developer',
    displayName: '后端',
    forkMode: 'none' as const,
    createdAt: 1_758_000_000_500,
  };

  it('往返：header + 消息 + 状态 + 注记', () => {
    const text =
      encodeTranscriptLine(agentLine(HEADER)) +
      encodeTranscriptLine(messageLine(MSG_USER, 1)) +
      encodeTranscriptLine(messageLine(MSG_ASSISTANT, 2)) +
      encodeTranscriptLine(
        stateLine({
          at: 3,
          status: 'done',
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          lastError: null,
        }),
      ) +
      encodeTranscriptLine(noteLine('应用重启：运行中被中断，已降为空闲', 4));
    const parsed = parseTranscriptFile(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.header).toEqual(HEADER);
    expect(parsed.messages).toEqual([MSG_USER, MSG_ASSISTANT]);
    expect(parsed.states).toEqual([
      {
        at: 3,
        status: 'done',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        lastError: null,
      },
    ]);
    expect(parsed.notes).toEqual([{ at: 4, text: '应用重启：运行中被中断，已降为空闲' }]);
  });

  it('末尾半行（无尾换行）被丢弃并记 partial-line', () => {
    const text = encodeTranscriptLine(agentLine(HEADER)) + '{"type":"message","at":9,"messa';
    const parsed = parseTranscriptFile(text, { at: 1 });
    expect(parsed.messages).toEqual([]);
    expect(kinds(parsed.issues)).toEqual(['partial-line']);
  });

  it('坏行跳过、后面照收（不阻断整文件）', () => {
    const text =
      encodeTranscriptLine(agentLine(HEADER)) +
      '{oops\n' +
      encodeTranscriptLine(messageLine(MSG_USER, 1)) +
      '\n' +
      '[1,2]\n' +
      encodeTranscriptLine(messageLine(MSG_ASSISTANT, 2));
    const parsed = parseTranscriptFile(text);
    expect(parsed.messages).toEqual([MSG_USER, MSG_ASSISTANT]);
    expect(kinds(parsed.issues)).toEqual(['corrupt-line', 'corrupt-line']);
  });

  it('未知行类型 → corrupt-line', () => {
    const text = encodeTranscriptLine(agentLine(HEADER)) + '{"type":"wat"}\n';
    expect(kinds(parseTranscriptFile(text).issues)).toEqual(['corrupt-line']);
  });

  it('缺 header（空文件 / 头之前有数据行）→ missing-header', () => {
    expect(kinds(parseTranscriptFile('').issues)).toEqual(['missing-header']);
    const text = encodeTranscriptLine(messageLine(MSG_USER, 1));
    const parsed = parseTranscriptFile(text);
    expect(parsed.messages).toEqual([]);
    expect(kinds(parsed.issues)).toEqual(['missing-header']);
  });

  it('重复 agent 头：保留第一份并记一条', () => {
    const text = encodeTranscriptLine(agentLine(HEADER)) + encodeTranscriptLine(agentLine(HEADER));
    const parsed = parseTranscriptFile(text);
    expect(parsed.header?.path).toBe(HEADER.path);
    expect(kinds(parsed.issues)).toEqual(['corrupt-line']);
  });

  it('文件名与 header.path 不一致 → path-mismatch（以 header 为准）', () => {
    const text = encodeTranscriptLine(agentLine(HEADER));
    const parsed = parseTranscriptFile(text, { expectPath: '/s1abc-def0/dev-9' });
    expect(parsed.header?.path).toBe(HEADER.path);
    expect(kinds(parsed.issues)).toEqual(['path-mismatch']);
  });

  it('expectPath 一致时不报 issue', () => {
    const text = encodeTranscriptLine(agentLine(HEADER));
    expect(parseTranscriptFile(text, { expectPath: HEADER.path }).issues).toEqual([]);
  });

  it('storageVersion 过新 → 拒载整份文件（不返回任何消息）', () => {
    const text =
      '{"type":"agent","storageVersion":9,"schemaVersion":1,"sessionId":"s1","path":"/s1/a","role":"r","displayName":"A","createdAt":1}\n' +
      encodeTranscriptLine(messageLine(MSG_USER, 1));
    const parsed = parseTranscriptFile(text);
    expect(parsed.header).toBeUndefined();
    expect(parsed.messages).toEqual([]);
    expect(kinds(parsed.issues)).toEqual(['version-too-new']);
  });

  it('header 字段不完整 → missing-header', () => {
    const text = '{"type":"agent","sessionId":"s1"}\n';
    expect(kinds(parseTranscriptFile(text).issues)).toEqual(['missing-header']);
  });

  it('state 行缺 status/at → corrupt-line；usage 可选', () => {
    const text =
      encodeTranscriptLine(agentLine(HEADER)) +
      '{"type":"state","at":1}\n' +
      encodeTranscriptLine(stateLine({ at: 2, status: 'idle' }));
    const parsed = parseTranscriptFile(text);
    expect(kinds(parsed.issues)).toEqual(['corrupt-line']);
    expect(parsed.states).toEqual([{ at: 2, status: 'idle' }]);
  });

  it('message 行缺合法 message → corrupt-line', () => {
    const text =
      encodeTranscriptLine(agentLine(HEADER)) +
      '{"type":"message","at":1,"message":{"content":[]}}\n';
    expect(kinds(parseTranscriptFile(text).issues)).toEqual(['corrupt-line']);
  });
});

// ─────────────────────────────────────────────────────────────
// ledger.jsonl
// ─────────────────────────────────────────────────────────────

describe('session-files · ledger', () => {
  it('往返：header + 记录', () => {
    const text =
      encodeLedgerLine(ledgerHeaderLine(RECORD.id)) + encodeLedgerLine(ledgerRecordLine(LEDGER));
    const parsed = parseLedgerFile(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.sessionId).toBe(RECORD.id);
    expect(parsed.records).toEqual([LEDGER]);
  });

  it('last-wins：同一 id 的后续版本覆盖前者，且保持首次出现的位置', () => {
    const settled: LedgerRecord = {
      ...LEDGER,
      status: 'settled',
      settledAt: 99,
      summary: '做完了',
    };
    const other: LedgerRecord = { ...LEDGER, id: 'l-000002-ab', action: 'consult' };
    const text =
      encodeLedgerLine(ledgerHeaderLine(RECORD.id)) +
      encodeLedgerLine(ledgerRecordLine(LEDGER)) +
      encodeLedgerLine(ledgerRecordLine(other)) +
      encodeLedgerLine(ledgerRecordLine(settled));
    const parsed = parseLedgerFile(text);
    expect(parsed.records.map((r) => r.id)).toEqual(['l-000001-ab', 'l-000002-ab']);
    expect(parsed.records[0]).toEqual(settled);
    expect(parsed.records[0]?.summary).toBe('做完了');
  });

  it('坏行 / 未知类型 / 不合法 record → corrupt-line，其余照收', () => {
    const text =
      encodeLedgerLine(ledgerHeaderLine(RECORD.id)) +
      '{oops\n' +
      '{"type":"wat"}\n' +
      '{"type":"record","record":{"id":"x"}}\n' +
      encodeLedgerLine(ledgerRecordLine(LEDGER));
    const parsed = parseLedgerFile(text);
    expect(parsed.records).toEqual([LEDGER]);
    expect(kinds(parsed.issues)).toEqual(['corrupt-line', 'corrupt-line', 'corrupt-line']);
  });

  it('storageVersion 过新 → 拒载整本账（不返回任何记录）', () => {
    const text =
      '{"type":"ledger-header","storageVersion":9,"schemaVersion":1,"sessionId":"s1"}\n' +
      encodeLedgerLine(ledgerRecordLine(LEDGER));
    const parsed = parseLedgerFile(text);
    expect(parsed.records).toEqual([]);
    expect(kinds(parsed.issues)).toEqual(['version-too-new']);
  });

  it('空文件合法（新会话还没账）', () => {
    const parsed = parseLedgerFile('');
    expect(parsed.records).toEqual([]);
    expect(parsed.issues).toEqual([]);
  });

  it('LEDGER_SCHEMA_VERSION 出现在 header 里（供读侧迁移判断）', () => {
    const header = ledgerHeaderLine('s1');
    expect(header.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────
// 边界
// ─────────────────────────────────────────────────────────────

describe('session-files · 边界', () => {
  it('CRLF 兼容（行尾回车被剥掉）', () => {
    const crlf = (s: string) => s.replace('\n', '\r\n');
    const header = {
      sessionId: 's1',
      path: '/s1/dev-1' as const,
      parent: '/s1' as const,
      role: 'developer',
      displayName: '后端',
      forkMode: 'none' as const,
      createdAt: 1,
    };
    const text =
      crlf(encodeTranscriptLine(agentLine(header))) +
      crlf(encodeTranscriptLine(messageLine(MSG_USER, 1)));
    const parsed = parseTranscriptFile(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.header?.path).toBe('/s1/dev-1');
    expect(parsed.messages).toEqual([MSG_USER]);
  });

  it('空 transcript / 空 ledger 不抛；空 session.json 记 issue', () => {
    expect(parseTranscriptFile('').header).toBeUndefined();
    expect(parseLedgerFile('').records).toEqual([]);
    expect(parseSessionFile('').file).toBeUndefined();
  });
});

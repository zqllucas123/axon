/**
 * groupSessionsByProject 纯函数单测（项目模块 §验证）。
 *
 * 分组是左栏「项目」区的数据源，边界（空项目 / 无归属会话 / 悬空 projectId /
 * 排序）靠穷举验证最稳，不该只在 ui-smoke 里间接覆盖。
 */

import { describe, expect, it } from 'vitest';
import type { ProjectRecord, SessionSummary } from '@axon/protocol';
import { groupSessionsByProject } from './selectors.ts';

function project(id: string, over: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id, name: id, cwd: `/works/${id}`, createdAt: 1, updatedAt: 1, ...over };
}

function session(id: string, over: { projectId?: string; updatedAt?: number } = {}): SessionSummary {
  return {
    record: {
      id,
      title: `会话 ${id}`,
      cwd: '/tmp',
      executor: 'engine',
      status: 'open',
      createdAt: 1,
      updatedAt: over.updatedAt ?? 1,
      schemaVersion: 1,
      ...(over.projectId !== undefined ? { projectId: over.projectId } : {}),
    },
    rootPath: `/${id}`,
    status: 'idle',
    counts: { members: 0, running: 0, parked: 0, suspended: 0, ledger: 0, pending: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    budget: {
      spentUsd: 0,
      global: {},
      effectiveSoftUsd: 0,
      effectiveHardUsd: 0,
      tier: 'ok',
    },
  } as SessionSummary;
}

describe('groupSessionsByProject', () => {
  it('空项目也返回分组（sessions: []）', () => {
    const groups = groupSessionsByProject([project('p-a')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions).toEqual([]);
  });

  it('只把 projectId 匹配的会话放进对应项目', () => {
    const groups = groupSessionsByProject(
      [project('p-a'), project('p-b')],
      [session('s1', { projectId: 'p-a' }), session('s2', { projectId: 'p-b' })],
    );
    expect(groups[0]!.sessions.map((s) => s.record.id)).toEqual(['s1']);
    expect(groups[1]!.sessions.map((s) => s.record.id)).toEqual(['s2']);
  });

  it('无 projectId 或悬空 projectId 的会话不进任何项目', () => {
    const groups = groupSessionsByProject(
      [project('p-a')],
      [session('free'), session('ghost', { projectId: 'p-gone' })],
    );
    expect(groups[0]!.sessions).toEqual([]);
  });

  it('项目内会话按 updatedAt 倒序', () => {
    const groups = groupSessionsByProject(
      [project('p-a')],
      [
        session('old', { projectId: 'p-a', updatedAt: 100 }),
        session('new', { projectId: 'p-a', updatedAt: 300 }),
      ],
    );
    expect(groups[0]!.sessions.map((s) => s.record.id)).toEqual(['new', 'old']);
  });

  it('分组顺序跟随传入的项目顺序', () => {
    const groups = groupSessionsByProject([project('p-b'), project('p-a')], []);
    expect(groups.map((g) => g.project.id)).toEqual(['p-b', 'p-a']);
  });
});

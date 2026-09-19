/**
 * ProjectStore —— 用户项目的加载 / 创建 / 热重载（electron-free）。
 *
 * 与 team-loader/role-loader 同一套纪律：坏文件隔离（只出一条 issue，不打瘸
 * 整个列表）、纯 IO 分离、原子写、watch 防抖后全量重扫、不依赖 electron。
 *
 * 项目比团队简单：没有内置模板、没有跨角色校验、没有覆盖语义。一项目一文件
 * （`<projectId>.json`），文件名即身份，与 roles/teams 的目录约定一致。
 * 会话对项目的归属由 `SessionRecord.projectId` 派生，这里不维护 sessionIds。
 */

import {
  validateProject,
  type ProjectIssue,
  type ProjectRecord,
} from '@axon/protocol';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';

export interface ProjectLoadState {
  entries: ProjectRecord[];
  issues: ProjectIssue[];
}

export interface ProjectStoreIO {
  readDir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  watchDir(dir: string, onChange: () => void): () => void;
}

const fsIO: ProjectStoreIO = {
  readDir: (dir) =>
    readdir(dir, { withFileTypes: true }).then((ents) =>
      ents.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name),
    ),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, data) => writeFile(p, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  watchDir: (dir, onChange) => {
    const w = fsWatch(dir, () => onChange());
    return () => w.close();
  },
};

/** 稳定项目 id：时间前缀 + 随机后缀（不由路径派生，允许同 cwd 多项目）。 */
function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 磁盘文件 → 项目条目（校验 + 排序），坏文件转 issue。 */
export function mergeProjectFiles(
  files: { name: string; content: string }[],
): ProjectLoadState {
  const issues: ProjectIssue[] = [];
  const entries: ProjectRecord[] = [];
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sorted) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch (e) {
      issues.push({
        level: 'error',
        code: 'parse-error',
        message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
        filePath: file.name,
      });
      continue;
    }
    const def = (parsed as Record<string, unknown>)?.project ?? parsed;
    const errs = validateProject(def);
    if (errs.some((i) => i.level === 'error')) {
      issues.push(...errs.map((e) => ({ ...e, filePath: file.name })));
      continue;
    }
    const rec = def as ProjectRecord;
    if (rec.id !== file.name) {
      issues.push({
        level: 'error',
        code: 'invalid-project',
        message: `文件名 ${file.name} 与项目 id "${rec.id}" 不一致，已跳过（文件名即身份）`,
        filePath: file.name,
      });
      continue;
    }
    entries.push(rec);
  }
  // 稳定排序：按创建时间升序（未来「+」加的排在后面），id 兜底。
  entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { entries, issues };
}

export interface ProjectStoreOptions {
  dir: string;
  io?: Partial<ProjectStoreIO>;
  debounceMs?: number;
}

export class ProjectStore {
  readonly dir: string;
  private readonly io: ProjectStoreIO;
  private readonly debounceMs: number;
  private state: ProjectLoadState = { entries: [], issues: [] };
  private watcher: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private loading: Promise<void> | null = null;

  constructor(options: ProjectStoreOptions) {
    this.dir = options.dir;
    this.io = { ...fsIO, ...options.io };
    this.debounceMs = options.debounceMs ?? 300;
  }

  current(): ProjectLoadState {
    return { entries: [...this.state.entries], issues: [...this.state.issues] };
  }

  get(id: string): ProjectRecord | undefined {
    return this.state.entries.find((p) => p.id === id);
  }

  /** 读目录 + 合并。永不 throw —— 目录读不了就退回空表。 */
  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        await this.io.mkdir(this.dir);
        const names = await this.io.readDir(this.dir);
        const files = await Promise.all(
          names.map(async (name) => ({
            name: name.replace(/\.json$/, ''),
            content: await this.io.readFile(join(this.dir, name)).catch(() => ''),
          })),
        );
        this.state = mergeProjectFiles(files);
      } catch {
        this.state = { entries: [], issues: [] };
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** 创建项目（仅元数据）。校验失败不落盘。 */
  async create(
    input: { name: string; cwd: string },
  ): Promise<{ accepted: boolean; errors: ProjectIssue[]; project?: ProjectRecord }> {
    const name = input.name.trim();
    const cwd = input.cwd.trim();
    const errors = validateProject({ name, cwd });
    if (errors.some((i) => i.level === 'error')) return { accepted: false, errors };

    const now = Date.now();
    const project: ProjectRecord = { id: newProjectId(), name, cwd, createdAt: now, updatedAt: now };
    const target = join(this.dir, `${project.id}.json`);
    const tmp = `${target}.tmp-${now}`;
    const payload = `${JSON.stringify({ version: 1, project }, null, 2)}\n`;
    try {
      await this.io.mkdir(this.dir);
      await this.io.writeFile(tmp, payload);
      await this.io.rename(tmp, target);
    } catch (e) {
      return {
        accepted: false,
        errors: [{ level: 'error', code: 'io-error', message: `写入项目文件失败：${e instanceof Error ? e.message : String(e)}` }],
      };
    }
    await this.load();
    return { accepted: true, errors: [], project };
  }

  /** 监听目录变化（防抖后全量重载）。返回取消函数。 */
  watch(onChange: (state: ProjectLoadState) => void): () => void {
    if (this.watcher) return () => {};
    const schedule = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        void this.load().then(() => onChange(this.current()));
      }, this.debounceMs);
    };
    let dispose: () => void = () => {};
    try {
      dispose = this.io.watchDir(this.dir, schedule);
      this.watcher = dispose;
    } catch {
      return () => {};
    }
    return () => {
      this.watcher = null;
      dispose();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
    };
  }

  dispose(): void {
    this.watcher?.();
    this.watcher = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}

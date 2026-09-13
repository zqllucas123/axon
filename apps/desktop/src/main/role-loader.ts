/**
 * RoleLoader —— 用户角色文件的加载 / 校验 / 合并 / 热重载。
 *
 * 设计要点（见 docs/milestones/M2-role-loader.md §4）：
 *
 * 1. **坏文件隔离**：一个文件 JSON 烂了，只产生一条 RoleIssue，
 *    绝不会抛出去把整棵树打瘸。加载器只承诺「坏文件不生效、好文件不受牵连」。
 * 2. **用户可覆盖内置**（已拍板）：同名时用户定义替换内置，`overridesBuiltin: true`；
 *    删掉用户文件，内置自动复活。
 * 3. **纯函数与 IO 分离**：validateRole / mergeRoleFiles 是纯函数（可穷举单测）；
 *    RoleLoader 只做 IO + 防抖 + 状态缓存。IO 全部可注入，测试不用碰真文件系统。
 * 4. **不依赖 electron**（沿用 host.ts 纪律）：主进程接线在 index.ts。
 */

import { parseForkMode } from '@axon/protocol';
import type {
  ApprovalMode,
  RoleDefinition,
  RoleEntry,
  RoleIssue,
} from '@axon/protocol';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────
// 校验（纯函数）
// ─────────────────────────────────────────────────────────────

/** 角色名约束：小写字母开头，只含小写字母/数字/下划线/连字符。 */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export const APPROVAL_MODES: readonly ApprovalMode[] = Object.freeze([
  'always_ask',
  'auto',
  'full_access',
]);

/**
 * 校验一个角色定义（用户文件内层的 role 对象）。
 * issues 空 = 可用。永不 throw —— 所有问题都进返回列表。
 */
export function validateRole(role: unknown): RoleIssue[] {
  const issues: RoleIssue[] = [];
  const fail = (message: string) => issues.push({ code: 'validation', message });

  if (typeof role !== 'object' || role === null) {
    return [{ code: 'validation', message: '角色定义必须是对象' }];
  }
  const def = role as Record<string, unknown>;

  if (typeof def.name !== 'string' || !ROLE_NAME_PATTERN.test(def.name)) {
    fail(`name 必须是 ^[a-z][a-z0-9_-]*$（小写字母开头），收到 ${JSON.stringify(def.name)}`);
  }
  for (const field of ['displayName', 'description', 'instructions'] as const) {
    const v = def[field];
    if (typeof v !== 'string' || v.trim() === '') {
      fail(`${field} 必须是非空字符串`);
    }
  }
  if (def.instructions !== undefined) {
    const v = def.instructions;
    if (typeof v === 'string' && v.length < 8) {
      fail('instructions 太短（至少 8 字符）：它是角色的 systemPrompt，不是占位符');
    }
  }
  if (def.tools !== undefined) {
    if (!Array.isArray(def.tools) || def.tools.some((t) => typeof t !== 'string')) {
      fail('tools 必须是字符串数组');
    }
  }
  if (def.shellAllow !== undefined) {
    if (!Array.isArray(def.shellAllow) || def.shellAllow.some((t) => typeof t !== 'string')) {
      fail('shellAllow 必须是字符串数组');
    }
  }
  if (def.approval !== undefined) {
    if (!APPROVAL_MODES.includes(def.approval as ApprovalMode)) {
      fail(`approval 必须是 ${APPROVAL_MODES.join(' | ')}，收到 ${JSON.stringify(def.approval)}`);
    }
  }
  if (def.defaultForkMode !== undefined && def.defaultForkMode !== null) {
    try {
      parseForkMode(def.defaultForkMode as never);
    } catch (err) {
      fail(`defaultForkMode 无法解析：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (def.model !== undefined && typeof def.model !== 'string') {
    fail('model 必须是字符串');
  }
  return issues;
}

// ─────────────────────────────────────────────────────────────
// 合并（纯函数）
// ─────────────────────────────────────────────────────────────

/** 磁盘上读到的一个角色文件（name = 文件名，content = 原文）。 */
export interface RoleFile {
  name: string;
  content: string;
}

/**
 * 内置角色 + 用户文件 → 最终条目表 + 全局问题。
 *
 * 合并规则（已拍板，见 M2 文档 §4.2）：
 *  - 解析失败/校验失败 → 文件跳过，问题进 issues，不影响其它文件
 *  - 文件名与文件内 name 不一致 → 跳过（文件名即身份）
 *  - 用户名与内置同名 → 用户覆盖内置（overridesBuiltin: true）
 *  - 用户文件之间不可能重名：文件名=角色名的不变量保证同名条目
 *    在文件系统里就是同一个文件（同目录下无法共存）
 */
export function mergeRoleFiles(
  builtin: RoleDefinition[],
  files: RoleFile[],
): { entries: RoleEntry[]; issues: RoleIssue[] } {
  const issues: RoleIssue[] = [];
  // 先建表：内置兜底，用户文件按名字典序逐个覆盖。
  const table = new Map<string, RoleEntry>();
  for (const role of builtin) {
    table.set(role.name, { role, source: 'builtin', errors: [] });
  }

  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sorted) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch (err) {
      issues.push({
        code: 'parse_error',
        message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        file: file.name,
      });
      continue;
    }

    const def = (parsed as Record<string, unknown>)?.role ?? parsed;
    const errors = validateRole(def);
    if (errors.length > 0) {
      issues.push(...errors.map((e) => ({ ...e, file: file.name })));
      continue;
    }
    const role = def as RoleDefinition;
    if (role.name !== file.name) {
      issues.push({
        code: 'validation',
        message: `文件名 ${file.name} 与文件内 name "${role.name}" 不一致，已跳过（文件名即身份）`,
        file: file.name,
      });
      continue;
    }

    const existing = table.get(role.name);
    table.set(role.name, {
      role,
      source: 'user',
      overridesBuiltin: existing?.source === 'builtin' || undefined,
      filePath: file.name,
      errors: [],
    });
  }

  return { entries: [...table.values()], issues };
}

// ─────────────────────────────────────────────────────────────
// RoleLoader（IO + 防抖 + 状态缓存）
// ─────────────────────────────────────────────────────────────

export interface RoleLoaderIO {
  readDir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  /** 目录监听；返回取消函数。默认真实 fs.watch。 */
  watchDir(dir: string, onChange: () => void): () => void;
}

const fsIO: RoleLoaderIO = {
  readDir: (dir) =>
    readdir(dir, { withFileTypes: true }).then((ents) =>
      ents.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name),
    ),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, data) => writeFile(p, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  unlink: (p) => unlink(p),
  // Node 的 mkdir 返回 Promise<string|undefined>，接口上统一抹平为 void。
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  watchDir: (dir, onChange) => {
    const w = fsWatch(dir, () => onChange());
    return () => w.close();
  },
};

export interface RoleLoaderOptions {
  /** 角色目录（默认 ~/.axon/roles，由调用方解析后传入 —— 不进本文件逻辑）。 */
  dir: string;
  /** 内置角色（TS 常量），用户文件在此之上合并。 */
  builtin: RoleDefinition[];
  /** 测试注入口；缺省用真实 fs。 */
  io?: Partial<RoleLoaderIO>;
  /** watch 防抖毫秒数（缺省 300）。 */
  debounceMs?: number;
}

export interface RoleLoadState {
  entries: RoleEntry[];
  issues: RoleIssue[];
}

export class RoleLoader {
  private readonly dir: string;
  private readonly builtin: RoleDefinition[];
  private readonly io: RoleLoaderIO;
  private readonly debounceMs: number;
  private state: RoleLoadState = { entries: [], issues: [] };
  private watcher: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private loading: Promise<void> | null = null;

  constructor(options: RoleLoaderOptions) {
    this.dir = options.dir;
    this.builtin = options.builtin;
    this.io = { ...fsIO, ...options.io };
    this.debounceMs = options.debounceMs ?? 300;
  }

  current(): RoleLoadState {
    return {
      entries: [...this.state.entries],
      issues: [...this.state.issues],
    };
  }

  /** 读目录 + 合并。永远不会 throw —— 目录读不了就退回内置。 */
  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        await this.io.mkdir(this.dir);
        const names = await this.io.readDir(this.dir);
        const files: RoleFile[] = await Promise.all(
          names.map(async (name) => ({
            name: name.replace(/\.json$/, ''),
            content: await this.io.readFile(join(this.dir, name)).catch(() => {
              // 读失败（竞争删除等）：以空串占位，让 JSON 解析阶段报 parse_error。
              return '';
            }),
          })),
        );
        this.state = mergeRoleFiles(this.builtin, files);
      } catch {
        // 目录级失败（权限等）：保持内置可用，问题是兜底而不是崩。
        this.state = { entries: this.builtin.map((role) => ({ role, source: 'builtin', errors: [] })), issues: [] };
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * 保存角色（创建或覆盖）。写入后重载，保证单一真相。
   * 校验失败时 accepted=false，不落盘。
   */
  async save(role: RoleDefinition): Promise<{ accepted: boolean; errors: RoleIssue[] }> {
    const errors = validateRole(role);
    // 文件名即身份，额外对齐防御：name 不符 pattern 时 validateRole 已报，
    // 但为了不把奇怪路径写进磁盘，这里再兜一次。
    if (errors.length > 0) return { accepted: false, errors };
    if (role.name !== undefined && !/^[a-z][a-z0-9_-]*$/.test(role.name)) {
      return { accepted: false, errors: [{ code: 'validation', message: 'name 非法（无法落盘）' }] };
    }

    const target = join(this.dir, `${role.name}.json`);
    const tmp = `${target}.tmp-${Date.now()}`;
    const payload = JSON.stringify({ version: 1, role }, null, 2) + '\n';
    await this.io.writeFile(tmp, payload);
    await this.io.rename(tmp, target);
    await this.load();
    return { accepted: true, errors: [] };
  }

  /** 删除用户角色文件。文件不存在视为已删除（幂等）。 */
  async remove(name: string): Promise<{ deleted: boolean; errors: RoleIssue[] }> {
    await this.io
      .unlink(join(this.dir, `${name}.json`))
      .catch(() => null); // ENOENT 即达目的
    await this.load();
    return { deleted: true, errors: [] };
  }

  /**
   * 监听目录变化（防抖后全量重载）。
   * 不依赖事件参数：编辑器原子保存（vim swap / JetBrains rename-save）
   * 不会丢事件，因为任何事件我们都整目录重扫。目录小，成本可忽略。
   * 返回取消函数；watch 目录失败（目录还没创建等）时不抛，静默降级为无热重载。
   */
  watch(onChange: (state: RoleLoadState) => void): () => void {
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
}
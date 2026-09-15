/**
 * TeamLoader —— 用户团队文件的加载 / 校验 / 合并 / 热重载。
 *
 * 与 role-loader.ts 同一套纪律（有意同构，减少学习成本）：
 * 坏文件隔离（只出一条 issue，不打瘸整棵树）、用户可覆盖内置同名、
 * 纯函数与 IO 分离、不依赖 electron。
 *
 * 校验比角色层复杂，因为团队有**结构**（成员之间的父子、lead、权限交集链）。
 * 其中两条是 MU-1 的新规矩，值得写在这里备查：
 *
 * 1. `lead-approval-too-loose`（修②）：主控不得是 `auto`/`full_access` 档。
 *    理由是权力问题：lead 位于审批穿透链的顶端，它若是 auto，链上所有后代的
 *    工具调用都会被静默代批 —— 那不是「更方便」，是把 HITL 关掉。
 * 2. `lead-tools-insufficient`：主控的白名单必须是成员白名单的超集。
 *    权限沿树求交（父 ∩ 子），lead 的白名单就是整队的能力上限；不满足时
 *    实例化不会报错，只会**悄悄**把成员裁成只读 —— 那种失败方式最难查。
 */

import {
  TEAM_MEMBER_MAX,
  TEAM_MEMBER_MIN,
  isStricterOrEqualApproval,
  isTeamFormation,
  leadMember,
  parseForkMode,
  type ApprovalMode,
  type ForkModeSpec,
  type RoleDefinition,
  type TeamDefinition,
  type TeamEntry,
  type TeamIssue,
  type TeamMember,
} from '@axon/protocol';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────
// 校验（纯函数）
// ─────────────────────────────────────────────────────────────

/**
 * 团队名约束。
 *
 * 比角色名宽（中文名是主要的用法：「全栈小队」），但仍要挡住文件系统敌意字符 ——
 * 团队名同时就是 `~/.axon/teams/<name>.json` 的文件名。
 */
export const TEAM_NAME_PATTERN = /^[^/\\:*?"<>|]{1,40}$/;

export interface TeamValidationContext {
  /** 角色表（内置 + 用户合并后的最终表）——成员引用的类型必须在这里。 */
  roles: readonly RoleDefinition[] | ReadonlyMap<string, RoleDefinition>;
  /** 配置的全局缺省审批档；角色没写档位时用它。 */
  defaultApproval?: ApprovalMode;
}

function roleTable(roles: TeamValidationContext['roles']): Map<string, RoleDefinition> {
  return roles instanceof Map ? roles : new Map([...(roles as RoleDefinition[])].map((r) => [r.name, r]));
}

/** 成员生效的审批档：覆写 > 角色 > 全局缺省 > always_ask。 */
export function resolvedApproval(
  role: RoleDefinition | undefined,
  member: TeamMember,
  defaultApproval?: ApprovalMode,
): ApprovalMode {
  return member.overrides?.approval ?? role?.approval ?? defaultApproval ?? 'always_ask';
}

/** 成员生效的工具白名单：覆写与角色求交（**只减不增**）；两者都没有 = 不限制。 */
export function resolvedTools(
  role: RoleDefinition | undefined,
  member: TeamMember,
): string[] | undefined {
  const override = member.overrides?.tools;
  const base = role?.tools;
  if (override === undefined) return base;
  if (base === undefined) return [...override];
  const allowed = new Set(base);
  return override.filter((t) => allowed.has(t));
}

function subsetOf(small: readonly string[], big: readonly string[]): boolean {
  const set = new Set(big);
  return small.every((t) => set.has(t));
}

/**
 * 校验一个团队定义。issues 空 = 可用。**永不 throw** —— 所有问题都进返回列表。
 *
 * 错误（level='error'）= 团队不可用；警告（level='warn'）= 可用但有隐患，
 * UI 渲染成黄条而不是红条。这个区分是有用的：忘了标 lead 只是写法问题，
 * 会按「第一个成员」兜底，不该拦着用户开工。
 */
export function validateTeam(team: unknown, ctx: TeamValidationContext): TeamIssue[] {
  const issues: TeamIssue[] = [];
  const err = (code: TeamIssue['code'], message: string, member?: string) =>
    issues.push({ level: 'error', code, message, ...(member ? { member } : {}) });
  const warn = (code: TeamIssue['code'], message: string, member?: string) =>
    issues.push({ level: 'warn', code, message, ...(member ? { member } : {}) });

  if (typeof team !== 'object' || team === null) {
    return [{ level: 'error', code: 'name-required', message: '团队定义必须是对象' }];
  }
  const def = team as Record<string, unknown>;

  // ── 名字 ──
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    err('name-required', 'name 必填');
  } else if (!TEAM_NAME_PATTERN.test(def.name)) {
    err('name-invalid', `name 不能含路径字符（/ \\ : * ? " < > |），且不超过 40 字：${JSON.stringify(def.name)}`);
  }

  // ─ 成员表 ──
  if (!Array.isArray(def.members) || def.members.length === 0) {
    return [...issues, { level: 'error', code: 'members-empty', message: 'members 必须是非空数组' }];
  }
  const members = def.members as TeamMember[];
  if (members.length < TEAM_MEMBER_MIN || members.length > TEAM_MEMBER_MAX) {
    err(
      'member-limit',
      `成员数必须在 ${TEAM_MEMBER_MIN}~${TEAM_MEMBER_MAX} 之间，当前 ${members.length}`,
    );
  }

  const seen = new Set<string>();
  for (const m of members) {
    if (typeof m?.name !== 'string' || m.name.trim() === '') {
      err('member-name-invalid', '成员 name 必填', '');
      continue;
    }
    if (m.name.includes('/')) err('member-name-invalid', `成员名不得含 "/"：${m.name}`, m.name);
    if (seen.has(m.name)) err('member-name-duplicate', `成员名重复：${m.name}`, m.name);
    seen.add(m.name);
  }

  // ── 角色引用 ──
  const table = roleTable(ctx.roles);
  for (const m of members) {
    if (typeof m?.role !== 'string' || m.role === '') {
      err('role-not-found', '成员 role 必填', m?.name);
      continue;
    }
    const role = table.get(m.role);
    if (!role) {
      err('role-not-found', `角色不存在：${m.role}（可用类型见 S3 的「Agent 类型」tab）`, m.name);
      continue;
    }

    // 覆写只能减能：工具不得越出类型白名单，审批档不得放宽。
    const overrideTools = m.overrides?.tools;
    if (overrideTools !== undefined && role.tools !== undefined && !subsetOf(overrideTools, role.tools)) {
      const extra = overrideTools.filter((t) => !role.tools!.includes(t));
      err(
        'member-tools-escalation',
        `覆写工具超出类型 ${role.name} 的白名单（多出：${extra.join(', ')}）；Agent 级覆写只能减不能增`,
        m.name,
      );
    }
    const overrideApproval = m.overrides?.approval;
    if (overrideApproval !== undefined && !isStricterOrEqualApproval(overrideApproval, role.approval ?? ctx.defaultApproval ?? 'always_ask')) {
      err(
        'approval-not-stricter',
        `覆写审批档 ${overrideApproval} 比类型默认档更松（${role.name} 是 ${role.approval ?? '未设'}）；覆写只能更严`,
        m.name,
      );
    }
    if (m.overrides?.forkMode !== undefined && m.overrides.forkMode !== null) {
      try {
        parseForkMode(m.overrides.forkMode);
      } catch (e) {
        err('invalid-value', `forkMode 无法解析：${e instanceof Error ? e.message : String(e)}`, m.name);
      }
    }
  }

  // ── 主控 ──
  const leads = members.filter((m) => m?.lead === true);
  const lead = leadMember({ members } as TeamDefinition);
  if (leads.length > 1) {
    err('multiple-leads', `只能有一个 lead，当前 ${leads.length} 个：${leads.map((l) => l.name).join(', ')}`);
  } else if (leads.length === 0 && lead) {
    warn('no-lead', `没有成员标 lead，按约定用第一个成员「${lead.name}」当主控`);
  }

  if (lead) {
    const leadRole = table.get(lead.role);
    const mode = resolvedApproval(leadRole, lead, ctx.defaultApproval);
    if (mode === 'auto' || mode === 'full_access') {
      err(
        'lead-approval-too-loose',
        `主控「${lead.name}」的审批档是 ${mode}：位于穿透链顶端的主控若自动放行，后代的一切工具调用都会被静默代批。请收紧到 always_ask`,
        lead.name,
      );
    }

    // 权限交集链：lead 的白名单必须是每个成员的上限。
    const leadTools = resolvedTools(leadRole, lead);
    if (leadTools !== undefined) {
      for (const m of members) {
        if (m === lead) continue;
        const mt = resolvedTools(table.get(m.role), m);
        if (mt === undefined) continue; // 未声明 = 继承 lead 全集，交集不会丢东西
        if (!subsetOf(mt, leadTools)) {
          const extra = mt.filter((t) => !leadTools.includes(t));
          err(
            'lead-tools-insufficient',
            `主控「${lead.name}」的工具白名单不含 ${extra.join(', ')}，成员「${m.name}」实例化后会被悄悄裁掉这些能力；请给主控换一个更宽的类型，或收窄该成员`,
            m.name,
          );
        }
      }
    }
  }

  // ── 编队形状 ──
  const formation = def.formation;
  if (formation !== undefined && !isTeamFormation(formation)) {
    err('invalid-value', `formation 必须是 star | chain | custom，收到 ${JSON.stringify(formation)}`);
  }
  const shape = isTeamFormation(formation) ? formation : 'star';

  for (const m of members) {
    if (shape === 'custom') {
      if (m === lead) continue; // 主控永远挂会话根
      if (!m.parent) {
        warn('formation-mismatch', `custom 编队下成员「${m.name}」没写 parent，将挂到会话根`, m.name);
        continue;
      }
      if (m.parent === m.name) {
        err('parent-cycle', `成员「${m.name}」的 parent 指向自己`, m.name);
        continue;
      }
      const parent = members.find((x) => x.name === m.parent);
      if (!parent) {
        err('parent-not-found', `成员「${m.name}」的 parent「${m.parent}」不存在`, m.name);
        continue;
      }
      // 成环检测：沿 parent 链走到底，超过成员数即认为有环。
      let cursor: TeamMember | undefined = parent;
      let hops = 0;
      while (cursor && hops <= members.length + 1) {
        if (cursor.name === m.name) {
          err('parent-cycle', `成员「${m.name}」的 parent 链成环`, m.name);
          break;
        }
        cursor = members.find((x) => x.name === cursor!.parent);
        hops++;
      }
    } else if (m.parent) {
      warn(
        'formation-mismatch',
        `formation='${shape}' 下成员「${m.name}」的 parent 不生效（只有 custom 编队用它）`,
        m.name,
      );
    }
  }
  // chain 编队的第一个成员必须是 lead，否则链头会挂空。
  if (shape === 'chain' && lead && members[0] !== lead) {
    warn('formation-mismatch', `chain 编队下第一个成员应是主控（当前第一个是「${members[0]?.name}」）`);
  }

  // ─ 闸门与预算 ──
  if (def.maxConcurrent !== undefined) {
    const v = def.maxConcurrent;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > TEAM_MEMBER_MAX) {
      err('invalid-value', `maxConcurrent 必须是 0~${TEAM_MEMBER_MAX} 的数字（0 = 不限）`);
    }
  }
  const budget = def.budget as { softUsd?: unknown; hardUsd?: unknown } | undefined;
  if (budget !== undefined) {
    if (typeof budget !== 'object' || budget === null) {
      err('invalid-value', 'budget 必须是对象');
    } else {
      const { softUsd, hardUsd } = budget;
      for (const [k, v] of [['softUsd', softUsd], ['hardUsd', hardUsd]] as const) {
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          err('invalid-value', `budget.${k} 必须是非负数字`);
        }
      }
      if (typeof softUsd === 'number' && typeof hardUsd === 'number' && hardUsd > 0 && softUsd > hardUsd) {
        err('invalid-value', `budget.softUsd (${softUsd}) 不该大于 budget.hardUsd (${hardUsd})`);
      }
    }
  }
  if (def.defaultForkMode !== undefined && def.defaultForkMode !== null) {
    try {
      parseForkMode(def.defaultForkMode as ForkModeSpec);
    } catch (e) {
      err('invalid-value', `defaultForkMode 无法解析：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return issues;
}

/** 只有 error 级才算「不可用」。 */
export function hasBlockingIssue(issues: readonly TeamIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

// ─────────────────────────────────────────────────────────────
// 合并（纯函数）
// ─────────────────────────────────────────────────────────────

/** 磁盘上读到的一个团队文件（name = 文件名，content = 原文）。 */
export interface TeamFile {
  name: string;
  content: string;
}

/**
 * 内置团队 + 用户文件 → 最终条目表 + 全局问题。
 * 规则与 mergeRoleFiles 完全一致（覆盖、跳过坏文件、文件名即身份）。
 */
export function mergeTeamFiles(
  builtin: TeamDefinition[],
  files: TeamFile[],
  ctx: Omit<TeamValidationContext, 'roles'> & { roles: TeamValidationContext['roles'] },
): { entries: TeamEntry[]; issues: TeamIssue[] } {
  const issues: TeamIssue[] = [];
  const table = new Map<string, TeamEntry>();
  for (const team of builtin) {
    const errors = validateTeam(team, { ...ctx });
    table.set(team.name, { team, source: 'builtin', errors });
    // 内置团队自己的问题也要报出来：它是我们写的，坏了就是我们的 bug。
    issues.push(...errors.map((e) => ({ ...e, filePath: '(内置)' })));
  }

  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sorted) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch (e) {
      issues.push({
        level: 'error',
        code: 'parse_error',
        message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
        filePath: file.name,
      });
      continue;
    }

    const def = (parsed as Record<string, unknown>)?.team ?? parsed;
    const errors = validateTeam(def, { ...ctx });
    if (hasBlockingIssue(errors)) {
      issues.push(...errors.map((e) => ({ ...e, filePath: file.name })));
      continue; // 有错就不生效：半个团队比没有团队更危险
    }
    const team = def as TeamDefinition;
    if (team.name !== file.name) {
      issues.push({
        level: 'error',
        code: 'name-invalid',
        message: `文件名 ${file.name} 与文件内 name "${team.name}" 不一致，已跳过（文件名即身份）`,
        filePath: file.name,
      });
      continue;
    }

    const existing = table.get(team.name);
    table.set(team.name, {
      team,
      source: 'user',
      overridesBuiltin: existing?.source === 'builtin' || undefined,
      filePath: file.name,
      errors,
    });
  }

  return { entries: [...table.values()], issues };
}

// ─────────────────────────────────────────────────────────────
// TeamLoader（IO + 防抖 + 状态缓存）
// ─────────────────────────────────────────────────────────────

/**
 * IO 面与 RoleLoaderIO 相同。
 * 刻意不抽公共模块：两个加载器会各自演进（团队以后可能要支持导入/导出），
 * 共享一个 15 行的 IO 抽象买不到什么，却把两个文件的改动绑在一起了。
 */
export interface TeamLoaderIO {
  readDir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  watchDir(dir: string, onChange: () => void): () => void;
}

const fsIO: TeamLoaderIO = {
  readDir: (dir) =>
    readdir(dir, { withFileTypes: true }).then((ents) =>
      ents.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name),
    ),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, data) => writeFile(p, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  unlink: (p) => unlink(p),
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  watchDir: (dir, onChange) => {
    const w = fsWatch(dir, () => onChange());
    return () => w.close();
  },
};

export interface TeamLoaderOptions {
  /** 团队目录（默认 ~/.axon/teams，由调用方解析后传入）。 */
  dir: string;
  builtin: TeamDefinition[];
  /** 角色表提供者 —— 每次 load 现取，这样角色热重载后团队校验用的是新表。 */
  rolesProvider: () => TeamValidationContext['roles'];
  defaultApprovalProvider?: () => ApprovalMode | undefined;
  io?: Partial<TeamLoaderIO>;
  debounceMs?: number;
}

export interface TeamLoadState {
  entries: TeamEntry[];
  issues: TeamIssue[];
}

export class TeamLoader {
  private readonly dir: string;
  private readonly builtin: TeamDefinition[];
  private readonly rolesProvider: () => TeamValidationContext['roles'];
  private readonly defaultApprovalProvider?: () => ApprovalMode | undefined;
  private readonly io: TeamLoaderIO;
  private readonly debounceMs: number;
  private state: TeamLoadState = { entries: [], issues: [] };
  private watcher: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private loading: Promise<void> | null = null;

  constructor(options: TeamLoaderOptions) {
    this.dir = options.dir;
    this.builtin = options.builtin;
    this.rolesProvider = options.rolesProvider;
    this.defaultApprovalProvider = options.defaultApprovalProvider;
    this.io = { ...fsIO, ...options.io };
    this.debounceMs = options.debounceMs ?? 300;
  }

  current(): TeamLoadState {
    return { entries: [...this.state.entries], issues: [...this.state.issues] };
  }

  /** 按名字取团队定义（仅限可用条目）。 */
  get(name: string): TeamDefinition | undefined {
    return this.state.entries.find((e) => e.team.name === name)?.team;
  }

  /** 读目录 + 合并。永不 throw —— 目录读不了就退回内置。 */
  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const ctx: TeamValidationContext = {
        roles: this.rolesProvider(),
        defaultApproval: this.defaultApprovalProvider?.(),
      };
      try {
        await this.io.mkdir(this.dir);
        const names = await this.io.readDir(this.dir);
        const files: TeamFile[] = await Promise.all(
          names.map(async (name) => ({
            name: name.replace(/\.json$/, ''),
            content: await this.io.readFile(join(this.dir, name)).catch(() => ''),
          })),
        );
        this.state = mergeTeamFiles(this.builtin, files, ctx);
      } catch {
        this.state = mergeTeamFiles(this.builtin, [], ctx);
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** 保存团队（创建或覆盖）。校验失败不落盘。 */
  async save(team: TeamDefinition): Promise<{ accepted: boolean; errors: TeamIssue[] }> {
    const errors = validateTeam(team, {
      roles: this.rolesProvider(),
      defaultApproval: this.defaultApprovalProvider?.(),
    });
    if (hasBlockingIssue(errors)) return { accepted: false, errors };
    if (typeof team.name !== 'string' || !TEAM_NAME_PATTERN.test(team.name)) {
      return {
        accepted: false,
        errors: [{ level: 'error', code: 'name-invalid', message: 'name 非法（无法落盘）' }],
      };
    }

    const target = join(this.dir, `${team.name}.json`);
    const tmp = `${target}.tmp-${Date.now()}`;
    const payload = JSON.stringify({ version: 1, team }, null, 2) + '\n';
    await this.io.writeFile(tmp, payload);
    await this.io.rename(tmp, target);
    await this.load();
    return { accepted: true, errors };
  }

  /** 删除用户团队文件。不存在视为已删除（幂等）。 */
  async remove(name: string): Promise<{ deleted: boolean; errors: TeamIssue[] }> {
    await this.io.unlink(join(this.dir, `${name}.json`)).catch(() => null);
    await this.load();
    return { deleted: true, errors: [] };
  }

  /** 监听目录变化（防抖后全量重载）。返回取消函数。 */
  watch(onChange: (state: TeamLoadState) => void): () => void {
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
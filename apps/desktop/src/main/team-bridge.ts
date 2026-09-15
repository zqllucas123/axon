/**
 * TeamBridge —— 团队层与宿主之间的接线（electron-free）。
 *
 * 与 RoleBridge 同构，多一件职责：**角色表变化后要重新校验团队**。
 * 团队的合法性依赖角色表（成员引用的类型是否存在、工具白名单是否够宽），
 * 角色一改，原本合法的团队可能变成 `role-not-found` —— 不重算的话，
 * 用户会在「新建会话」那一步才撞上错误，而界面上团队卡片一直好好的。
 */

import type { ApprovalMode, RoleDefinition, TeamDefinition, TeamEntry, TeamIssue } from '@axon/protocol';
import { TeamLoader, type TeamLoadState, type TeamLoaderIO } from './team-loader.ts';
import type { AxonHost } from './host.ts';

export interface TeamBridgeOptions {
  dir: string;
  builtinTeams: TeamDefinition[];
  host: AxonHost;
  /** 角色表提供者（每次校验现取，保证热重载后用的是新表）。 */
  rolesProvider: () => readonly RoleDefinition[];
  defaultApprovalProvider?: () => ApprovalMode | undefined;
  debounceMs?: number;
  io?: Partial<TeamLoaderIO>;
}

export class TeamBridge {
  readonly dir: string;
  private readonly loader: TeamLoader;
  private readonly host: AxonHost;
  private disposeWatch: (() => void) | null = null;
  private lastKey = '';

  constructor(options: TeamBridgeOptions) {
    this.dir = options.dir;
    this.loader = new TeamLoader({
      dir: options.dir,
      builtin: options.builtinTeams,
      rolesProvider: options.rolesProvider,
      defaultApprovalProvider: options.defaultApprovalProvider,
      debounceMs: options.debounceMs,
      io: options.io,
    });
    this.host = options.host;
  }

  async init(): Promise<void> {
    await this.loader.load();
    this.sync(this.loader.current());
    this.disposeWatch = this.loader.watch((state) => this.sync(state));
  }

  /** 角色表变了之后重新校验团队（内容没变也会重算 errors）。 */
  async revalidate(): Promise<void> {
    await this.loader.load();
    this.lastKey = ''; // 强制重发，即使团队文件本身没动
    this.sync(this.loader.current());
  }

  async save(team: TeamDefinition): Promise<{ accepted: boolean; errors: TeamIssue[] }> {
    const res = await this.loader.save(team);
    if (res.accepted) this.sync(this.loader.current());
    return res;
  }

  async remove(name: string): Promise<{ deleted: boolean; errors: TeamIssue[] }> {
    const res = await this.loader.remove(name);
    this.sync(this.loader.current());
    return res;
  }

  list(): { entries: TeamEntry[]; issues: TeamIssue[] } {
    return this.host.getTeams();
  }

  /** 取一个可用团队（新建会话与升级都要用它）。 */
  get(name: string): TeamDefinition | undefined {
    const entry = this.loader.current().entries.find((e) => e.team.name === name);
    if (!entry || entry.errors.some((e) => e.level === 'error')) return undefined;
    return entry.team;
  }

  dispose(): void {
    this.disposeWatch?.();
    this.disposeWatch = null;
  }

  private sync(state: TeamLoadState): void {
    const key = JSON.stringify(state);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.host.updateTeams(state.entries, state.issues);
  }
}
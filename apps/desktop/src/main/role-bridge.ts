/**
 * RoleBridge —— 角色层与宿主之间的接线（electron-free）。
 *
 * index.ts 只负责把 IPC 命令丢进来；本类承担三件事：
 *  1. 初始化：loader.load() → host.updateRoles()（启动即合并）
 *  2. 保存/删除后**立即**同步宿主（不等 watch 防抖，UI 响应要快）
 *  3. watch 外部编辑（编辑器直接改 ~/.axon/roles）→ 防抖重载 → 同步
 *
 * 「立即同步 + watch 会再来一遍」的双触发不产生双事件：
 * sync() 对连续相同状态去重（JSON 全等跳过），save 的写盘必然触发
 * 一次 watch，但那时状态与刚同步过的相同，被去重吞掉。
 */

import type { RoleDefinition, RoleIssue } from '@axon/protocol';
import { RoleLoader, type RoleLoaderIO, type RoleLoadState } from './role-loader.ts';
import type { AxonHost } from './host.ts';

export interface RoleBridgeOptions {
  dir: string;
  builtinRoles: RoleDefinition[];
  host: AxonHost;
  debounceMs?: number;
  /** 测试注入口（透传给 RoleLoader）。 */
  io?: Partial<RoleLoaderIO>;
}

export class RoleBridge {
  readonly dir: string;
  private readonly loader: RoleLoader;
  private readonly host: AxonHost;
  private disposeWatch: (() => void) | null = null;
  /** 上次已同步状态的 JSON 快照，用于去重。 */
  private lastKey = '';

  constructor(options: RoleBridgeOptions) {
    this.dir = options.dir;
    this.loader = new RoleLoader({
      dir: options.dir,
      builtin: options.builtinRoles,
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

  async save(role: RoleDefinition): Promise<{ accepted: boolean; errors: RoleIssue[] }> {
    const res = await this.loader.save(role);
    if (res.accepted) this.sync(this.loader.current());
    return res;
  }

  async remove(name: string): Promise<{ deleted: boolean; errors: RoleIssue[] }> {
    const res = await this.loader.remove(name);
    this.sync(this.loader.current());
    return res;
  }

  dispose(): void {
    this.disposeWatch?.();
    this.disposeWatch = null;
  }

  private sync(state: RoleLoadState): void {
    const key = JSON.stringify(state);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.host.updateRoles(state.entries, state.issues);
  }
}
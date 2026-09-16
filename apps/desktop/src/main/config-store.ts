/**
 * ConfigStore —— `~/.axon/config.json` 的读侧快照与写侧 patch。
 *
 * 三条纪律（都来自 UX `03-设置界面设计.md` 的既有结论）：
 *
 * 1. **读回来的 key 永远是掩码**：类型上就没有明文这条路（`AxonConfigView`）。
 *    「界面上不小心把 key 渲染出来」这种事不该靠自觉避免。
 * 2. **写盘保留未知字段**：配置文件是用户手写物，可能被别的工具写过、或来自
 *    未来版本。patch 只改白名单里的键，其余原样保留 —— 否则一次保存就吃掉
 *    用户自己加的东西。
 * 3. **被环境变量覆盖的字段拒绝写入**：写了也不生效，静默失败是最坏的体验。
 *    这条与「顶栏显示 faux 的原因」是同一个诚实标准。
 */

import {
  CONFIG_PATCH_PATHS,
  ENV_OVERRIDE_SPECS,
  configFieldSpec,
  isConfigPatchPath,
  type AxonConfig,
  type AxonConfigView,
  type ConfigIssue,
  type ConfigPatch,
  type ConfigPaths,
  type ConfigResolution,
  type ConfigSnapshot,
  type EnvOverride,
  type ModelSpec,
  type ProviderConfigView,
} from '@axon/protocol';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_PATH, loadConfig, maskKey, resolveModelChoice } from './model-config.ts';

/** 密钥类的读侧掩码：`sk-***xyz`；未配置时不给字段。 */
function maskConfig(config: AxonConfig): AxonConfigView {
  const { provider, ...rest } = config;
  if (!provider) return { ...rest };
  const { apiKey, ...providerRest } = provider;
  const view: ProviderConfigView = {
    ...providerRest,
    apiKeySet: typeof apiKey === 'string' && apiKey.length > 0,
    ...(apiKey ? { apiKeyMasked: maskKey(apiKey) } : {}),
  };
  return { ...rest, provider: view };
}

/** 点号路径的读写（只覆盖白名单里那两层深度：顶层键与 provider.*）。 */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  const [head, tail] = path.split('.');
  if (!head) return undefined;
  if (tail === undefined) return obj[head];
  const nested = obj[head];
  if (typeof nested !== 'object' || nested === null) return undefined;
  return (nested as Record<string, unknown>)[tail];
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const [head, tail] = path.split('.');
  if (!head) return;
  if (tail === undefined) {
    obj[head] = value;
    return;
  }
  const nested = obj[head];
  if (typeof nested !== 'object' || nested === null) obj[head] = {};
  (obj[head] as Record<string, unknown>)[tail] = value;
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  const [head, tail] = path.split('.');
  if (!head) return;
  if (tail === undefined) {
    delete obj[head];
    return;
  }
  const nested = obj[head];
  if (typeof nested === 'object' && nested !== null) {
    delete (nested as Record<string, unknown>)[tail];
  }
}

/**
 * 逐字段校验。`value === null` 表示**清除该字段**（回到缺省），这是设置界面
 * 「清空 key」的唯一手段，所以不当成错误。
 */
function validateValue(path: string, value: unknown, raw: Record<string, unknown>): ConfigIssue[] {
  if (!isConfigPatchPath(path)) {
    return [{ path, code: 'unknown-field', message: `未知配置字段: ${path}（不在可写白名单里）` }];
  }
  if (value === null) return []; // 清除

  const spec = configFieldSpec(path);
  const issues: ConfigIssue[] = [];

  if (spec.kind === 'string') {
    if (typeof value !== 'string') {
      issues.push({ path, code: 'invalid-type', message: `${path} 必须是字符串` });
    } else if (spec.secret !== true && value.trim() === '' && path !== 'defaultCwd') {
      issues.push({ path, code: 'invalid-value', message: `${path} 不能为空（要清除请传 null）` });
    }
  } else if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, code: 'invalid-type', message: `${path} 必须是数字` });
    } else if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
      issues.push({
        path,
        code: 'out-of-range',
        message: `${path} 必须在 ${spec.min ?? '-∞'} ~ ${spec.max ?? '+∞'} 之间，收到 ${value}`,
      });
    }
  } else if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      issues.push({ path, code: 'invalid-type', message: `${path} 必须是 true / false` });
    }
  } else if (spec.kind === 'enum') {
    if (typeof value !== 'string' || !(spec.values ?? []).includes(value)) {
      issues.push({
        path,
        code: 'invalid-value',
        message: `${path} 必须是 ${(spec.values ?? []).join(' | ')}，收到 ${JSON.stringify(value)}`,
      });
    }
  } else if (spec.kind === 'json') {
    if (typeof value !== 'object' || value === null) {
      issues.push({ path, code: 'invalid-type', message: `${path} 必须是对象或数组` });
    } else if (path === 'provider.headers') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.some(([, v]) => typeof v !== 'string')) {
        issues.push({ path, code: 'invalid-value', message: 'provider.headers 的值必须都是字符串' });
      }
    } else if (path === 'provider.models') {
      if (!Array.isArray(value)) {
        issues.push({ path, code: 'invalid-type', message: 'provider.models 必须是数组' });
      } else {
        for (const [i, m] of (value as unknown[]).entries()) {
          if (typeof m !== 'object' || m === null || typeof (m as ModelSpec).id !== 'string' || !(m as ModelSpec).id) {
            issues.push({ path, code: 'invalid-value', message: `provider.models[${i}] 缺少 id` });
          }
        }
      }
    }
  }

  // 跨字段：defaultModel 必须在该清单里（否则启动时静默降级到 faux，
  // 用户会以为「保存成功了但模型没换」）。
  if (path === 'provider.defaultModel' && issues.length === 0 && typeof value === 'string') {
    const models = (getPath(raw, 'provider.models') as ModelSpec[] | undefined) ?? [];
    if (models.length > 0 && !models.some((m) => m.id === value)) {
      issues.push({
        path,
        code: 'invalid-value',
        message: `defaultModel=${value} 不在 provider.models 清单里（现有：${models.map((m) => m.id).join(', ')}）`,
      });
    }
  }

  return issues;
}

export interface ConfigStoreOptions {
  configPath?: string;
  roleDir: string;
  teamDir: string;
  env?: Record<string, string | undefined>;
  io?: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string, mode: number): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(dir: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
  };
}

const fsIO: NonNullable<ConfigStoreOptions['io']> = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, data, mode) => writeFile(p, data, { encoding: 'utf8', mode }),
  rename: (from, to) => rename(from, to),
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  chmod: (p, mode) => chmod(p, mode).then(() => undefined),
};

export class ConfigStore {
  readonly configPath: string;
  private readonly roleDir: string;
  private readonly teamDir: string;
  private readonly env: Record<string, string | undefined>;
  private readonly io: NonNullable<ConfigStoreOptions['io']>;
  /** 磁盘原文（含未知字段）—— patch 在它之上改，读侧从它导出掩码视图。 */
  private raw: Record<string, unknown> = {};
  private lastError?: string;

  constructor(options: ConfigStoreOptions) {
    this.configPath = options.configPath ?? CONFIG_PATH;
    this.roleDir = options.roleDir;
    this.teamDir = options.teamDir;
    this.env = options.env ?? process.env;
    this.io = options.io ?? fsIO;
  }

  paths(): ConfigPaths {
    return { config: this.configPath, roles: this.roleDir, teams: this.teamDir };
  }

  /** 读盘（不存在/坏 JSON 都降级，不抛 —— 沿用 model-config.ts 的纪律）。 */
  async load(): Promise<void> {
    const { config, error } = await loadConfig(this.configPath);
    this.raw = config as Record<string, unknown>;
    this.lastError = error;
  }

  /** 未脱敏的原始配置（**只允许主进程内部用**：建模型源、造 HostOptions）。 */
  rawConfig(): AxonConfig {
    return this.raw as AxonConfig;
  }

  /** 当前模型解析结论（顶栏「faux（未配置…）」与设置界面共用）。 */
  modelChoice(): ReturnType<typeof resolveModelChoice> {
    return resolveModelChoice(this.raw as AxonConfig, this.env);
  }

  /** 被环境变量实际覆盖的字段（只算「env 真的有值」的那些）。 */
  envOverrides(): EnvOverride[] {
    const out: EnvOverride[] = [];
    for (const { env, path } of ENV_OVERRIDE_SPECS) {
      const value = this.env[env];
      if (value === undefined || value === '') continue;
      const secret = isConfigPatchPath(path) && configFieldSpec(path).secret === true;
      out.push({ path, env, value: secret ? maskKey(value) : value });
    }
    return out;
  }

  resolution(): ConfigResolution {
    if (this.lastError) return { degraded: true, reason: this.lastError };
    const choice = this.modelChoice();
    if (choice.kind === 'faux') return { degraded: true, reason: choice.reason };
    return {
      degraded: false,
      effectiveModel: choice.defaultModel,
      providerId: choice.providerId,
    };
  }

  /** 读侧快照（脱敏）。 */
  snapshot(): ConfigSnapshot {
    return {
      config: maskConfig(this.raw as AxonConfig),
      envOverrides: this.envOverrides(),
      paths: this.paths(),
      resolution: this.resolution(),
    };
  }

  /**
   * 应用一批 patch。逐字段校验：**任何字段不合法就整批不落盘**（部分成功
   * 会让用户以为改好了，实际只改了一半——设置界面的表单是一个整体）。
   * 唯一例外是被 env 锁定的字段：它单独报 issue 并跳过，其余照常。
   */
  async patch(
    patch: ConfigPatch,
  ): Promise<{ accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot }> {
    const errors: ConfigIssue[] = [];
    const locked = new Set(this.envOverrides().map((o) => o.path));
    const draft: Record<string, unknown> = structuredClone(this.raw);

    for (const [path, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (locked.has(path)) {
        errors.push({
          path,
          code: 'env-locked',
          message: `${path} 已被环境变量覆盖（${ENV_OVERRIDE_SPECS.find((s) => s.path === path)?.env}），写入不会生效`,
        });
        continue;
      }
      const issues = validateValue(path, value, draft);
      if (issues.length > 0) {
        errors.push(...issues);
        continue;
      }
      if (value === null) deletePath(draft, path);
      else setPath(draft, path, value);
    }

    const blocking = errors.filter((e) => e.code !== 'env-locked');
    if (blocking.length > 0) {
      // 不落盘：返回的是**当前**（未改）的快照，UI 因此不会显示假成功。
      return { accepted: false, errors, config: this.snapshot() };
    }

    return this.commit(draft, errors);
  }

  /**
   * 恢复出厂（`config.reset`，S8 危险区）—— 把**白名单内**的字段删回缺省。
   *
   * 为什么不能用 `patch` 逐个置 null 代替：那样会被 env-locked 挡住（被环境变量
   * 覆盖的字段依旧留在文件里，用户看到的是「重置了但没重置干净」）。重置是
   * 对**文件**的操作，env 覆盖是运行时的事，两件事不该耦在一起。
   *
   * 两条不变量：
   *  - **未知键原样保留**（同 patch 的纪律；用户手写的东西不得被一键吃掉）；
   *  - **不动角色目录与团队目录**（它们不在这个文件里，S8 文案也这么写）。
   */
  async reset(): Promise<{ accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot }> {
    const draft: Record<string, unknown> = structuredClone(this.raw);
    for (const path of CONFIG_PATCH_PATHS) deletePath(draft, path);
    // 删完叶子后别留下 `"ui": {}` 这种空壳：它会让下次读盘看起来「配过」。
    // 但容器里还有未知键（如 provider.id）时必须保留容器本身。
    for (const key of ['provider', 'ui']) {
      const nested = draft[key];
      if (typeof nested === 'object' && nested !== null && Object.keys(nested).length === 0) {
        delete draft[key];
      }
    }
    return this.commit(draft, []);
  }

  /** 原子落盘 + 接管内存真相。patch 与 reset 共用同一条写路径。 */
  private async commit(
    draft: Record<string, unknown>,
    errors: ConfigIssue[],
  ): Promise<{ accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot }> {
    try {
      await this.io.mkdir(dirname(this.configPath));
      const payload = `${JSON.stringify(draft, null, 2)}\n`;
      const tmp = `${this.configPath}.tmp-${Date.now()}`;
      // 0600：v0.1 明文存 key（M6 才上 keychain），权限是唯一的防线。
      await this.io.writeFile(tmp, payload, 0o600);
      await this.io.rename(tmp, this.configPath);
      await this.io.chmod(this.configPath, 0o600).catch(() => null);
      this.raw = draft;
      this.lastError = undefined;
    } catch (err) {
      errors.push({
        code: 'io_error',
        message: `写入 ${this.configPath} 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return { accepted: false, errors, config: this.snapshot() };
    }

    return { accepted: true, errors, config: this.snapshot() };
  }

  /** 目录名（index.ts 用它拼默认角色/团队目录）。 */
  static dirsFor(home: string): { roles: string; teams: string } {
    return { roles: join(home, '.axon', 'roles'), teams: join(home, '.axon', 'teams') };
  }
}
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
  formatModelRef,
  isConfigPatchPath,
  isValidProviderId,
  parseModelRef,
  resolveModelRef,
  type AxonConfig,
  type AxonConfigView,
  type ConfigIssue,
  type ConfigPatch,
  type ConfigPaths,
  type ConfigResolution,
  type ConfigSnapshot,
  type EnvOverride,
  type ModelSpec,
  type ProviderConfig,
  type ProviderConfigView,
} from '@axon/protocol';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_PATH, loadConfig, maskKey, resolveModelChoice } from './model-config.ts';
import { deleteKey, getKey, hasKey, setKey } from './keychain.ts';

/** 一个 provider 的 keychain key 路径。id 不含点号由 `isValidProviderId` 保证。 */
function providerKeyPath(id: string): string {
  return `providerKeys.${id}.apiKey`;
}

/** 单个 provider 的读侧脱敏。解密明文只在本函数内，不出 config-store。 */
function maskProvider(p: ProviderConfig, configPath: string): ProviderConfigView {
  const { apiKey, ...rest } = p;
  const path = providerKeyPath(p.id);
  const keychainPlain = hasKey(path, configPath) ? getKey(path, configPath) : null;
  const effectiveKey = keychainPlain ?? apiKey;
  return {
    ...rest,
    apiKeySet: typeof effectiveKey === 'string' && effectiveKey.length > 0,
    ...(effectiveKey ? { apiKeyMasked: maskKey(effectiveKey) } : {}),
  };
}

/** 密钥类的读侧掩码：`sk-***xyz`；未配置时不给字段。 */
function maskConfig(config: AxonConfig, configPath: string): AxonConfigView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { provider: _legacy, providers, providerKeys: _keys, ...rest } = config as AxonConfig & { providerKeys?: unknown };
  if (!providers?.length) return { ...rest };
  return { ...rest, providers: providers.map((p) => maskProvider(p, configPath)) };
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
    } else if (path === 'proxy.url' && value !== '') {
      try {
        const u = new URL(value);
        if (!['http:', 'https:', 'socks5:'].includes(u.protocol)) {
          issues.push({ path, code: 'invalid-value', message: 'proxy.url 协议须为 http://、https:// 或 socks5://' });
        }
      } catch {
        issues.push({ path, code: 'invalid-value', message: 'proxy.url 不是合法 URL，请填 http://host:port 形式' });
      }
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
    }
  }

  // 跨字段：defaultModelRef 必须能在现有 providers 里解到（否则启动时静默降级，
  // 用户会以为「保存成功了但模型没换」）。providers 为空时不校验：
  // 允许「先设默认模型、后加提供商」这种顺序，反正解不到会 warn + 回落。
  if (path === 'defaultModelRef' && issues.length === 0 && typeof value === 'string') {
    const providers = (raw['providers'] as ProviderConfig[] | undefined) ?? [];
    if (providers.length > 0 && !resolveModelRef(providers, value)) {
      issues.push({
        path,
        code: 'invalid-value',
        message: `defaultModelRef=${value} 在已配置的提供商里找不到对应模型`,
      });
    }
  }

  return issues;
}

/**
 * 整体校验一个 provider（`provider.save` 用）。
 *
 * 与 `validateValue` 的分工：那个管点号路径的单字段，这个管「一张卡提交上来的
 * 整个对象」。issue 的 path 用 `providers.<id>.<field>` 形式，让 UI 能逐字段标红。
 */
function validateProvider(p: ProviderConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const at = (field: string) => `providers.${p?.id ?? '?'}.${field}`;

  if (!isValidProviderId(p?.id)) {
    issues.push({
      path: at('id'),
      code: 'invalid-value',
      message: 'id 必须是字母或数字开头，只含字母、数字、下划线、连字符（不能有点号或冒号）',
    });
  }
  if (p?.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string' || p.baseUrl.trim() === '') {
      issues.push({ path: at('baseUrl'), code: 'invalid-value', message: 'Base URL 不能为空' });
    } else {
      try {
        const u = new URL(p.baseUrl);
        if (!['http:', 'https:'].includes(u.protocol)) {
          issues.push({ path: at('baseUrl'), code: 'invalid-value', message: 'Base URL 必须是 http:// 或 https://' });
        }
      } catch {
        issues.push({ path: at('baseUrl'), code: 'invalid-value', message: 'Base URL 不是合法 URL' });
      }
    }
  }
  if (p?.models !== undefined) {
    if (!Array.isArray(p.models)) {
      issues.push({ path: at('models'), code: 'invalid-type', message: 'models 必须是数组' });
    } else {
      const seen = new Set<string>();
      for (const [i, m] of p.models.entries()) {
        const id = (m as ModelSpec | undefined)?.id;
        if (typeof id !== 'string' || !id) {
          issues.push({ path: at(`models.${i}.id`), code: 'invalid-value', message: `models[${i}] 缺少 id` });
          continue;
        }
        if (seen.has(id)) {
          issues.push({ path: at(`models.${i}.id`), code: 'invalid-value', message: `模型 id 重复：${id}` });
        }
        seen.add(id);
      }
    }
  }
  if (p?.defaultModel !== undefined && p.defaultModel !== '') {
    const models = Array.isArray(p.models) ? p.models : [];
    if (models.length > 0 && !models.some((m) => m?.id === p.defaultModel)) {
      issues.push({
        path: at('defaultModel'),
        code: 'invalid-value',
        message: `defaultModel=${p.defaultModel} 不在该提供商的模型清单里（现有：${models.map((m) => m?.id).join(', ')}）`,
      });
    }
  }
  if (p?.headers !== undefined) {
    if (typeof p.headers !== 'object' || p.headers === null || Array.isArray(p.headers)) {
      issues.push({ path: at('headers'), code: 'invalid-type', message: 'headers 必须是对象' });
    } else if (Object.values(p.headers).some((v) => typeof v !== 'string')) {
      issues.push({ path: at('headers'), code: 'invalid-value', message: 'headers 的值必须都是字符串' });
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
    await this.migrate();
  }

  /**
   * 两步迁移，幂等（已迁完的配置走进来是空操作）：
   *
   * 1. **形状**：`provider{}` → `providers[{id:'default'}]`，`provider.defaultModel`
   *    → 顶层 `defaultModelRef`。老用户升级后不该看到空的提供商列表。
   * 2. **密钥**：config.json 里残留的明文 apiKey → safeStorage，并删明文。
   *    旧 keychain 路径 `provider.apiKey` 也一并搬到 `providerKeys.default.apiKey`。
   */
  private async migrate(): Promise<void> {
    const raw = this.raw;
    const legacy = raw['provider'];
    const hasLegacyShape = typeof legacy === 'object' && legacy !== null && !Array.isArray(legacy);
    const needsShape = hasLegacyShape && !Array.isArray(raw['providers']);

    if (needsShape) {
      const { apiKey: _drop, defaultModel, ...rest } = legacy as Record<string, unknown>;
      raw['providers'] = [{ id: 'default', ...rest, ...(defaultModel ? { defaultModel } : {}) }];
      if (!raw['defaultModelRef'] && typeof defaultModel === 'string' && defaultModel) {
        raw['defaultModelRef'] = formatModelRef('default', defaultModel);
      }
      console.log('[migrate] provider{} → providers[default]');
    }

    // 明文 key：优先取 provider.apiKey（老形状），其次 providers[].apiKey（手写新形状）。
    const pending: { id: string; key: string }[] = [];
    const legacyPlain = hasLegacyShape ? (legacy as Record<string, unknown>)['apiKey'] : undefined;
    if (typeof legacyPlain === 'string' && legacyPlain) pending.push({ id: 'default', key: legacyPlain });
    for (const p of (raw['providers'] as ProviderConfig[] | undefined) ?? []) {
      if (typeof p?.apiKey === 'string' && p.apiKey && p.id) pending.push({ id: p.id, key: p.apiKey });
    }
    // 旧 keychain 路径的搬迁（明文已清但 key 还在老槽位）。
    if (!pending.some((x) => x.id === 'default') && hasKey('provider.apiKey', this.configPath)) {
      const old = getKey('provider.apiKey', this.configPath);
      if (old) pending.push({ id: 'default', key: old });
    }

    if (pending.length === 0) {
      if (needsShape) await this.persist(raw);
      return;
    }
    for (const { id, key } of pending) {
      await setKey(providerKeyPath(id), key, this.configPath);
    }
    // setKey 会重写 config.json（删明文），重新读回以拿到干净的 raw，
    // 再把形状迁移的结果盖回去落盘 —— 否则 providers[] 会被回读覆盖掉。
    const { config: reloaded } = await loadConfig(this.configPath);
    const next = reloaded as Record<string, unknown>;
    if (needsShape) {
      next['providers'] = raw['providers'];
      if (raw['defaultModelRef']) next['defaultModelRef'] = raw['defaultModelRef'];
      delete next['provider'];
    }
    this.raw = next;
    await this.persist(next);
    console.log(`[keychain] ${pending.length} 个 apiKey 已迁移到 safeStorage`);
  }

  /** 未脱敏的原始配置（**只允许主进程内部用**：建模型源、造 HostOptions）。
   * keychain 迁移后 this.raw 里没有 apiKey 明文，从 keychain 解密后注入。 */
  rawConfig(): AxonConfig {
    const base = this.raw as AxonConfig;
    if (!base.providers?.length) return base;
    return {
      ...base,
      providers: base.providers.map((p) => {
        const plain = getKey(providerKeyPath(p.id), this.configPath);
        return plain === null ? p : { ...p, apiKey: plain };
      }),
    };
  }

  /** 当前模型解析结论（顶栏「faux（未配置…）」与设置界面共用）。
   * 用 rawConfig()（含 keychain 解密的 apiKey）而非 this.raw：keychain 迁移后
   * this.raw 里已无明文 apiKey，直接解析会误判「未配置 apiKey」而降级到 faux。 */
  modelChoice(): ReturnType<typeof resolveModelChoice> {
    return resolveModelChoice(this.rawConfig(), this.env);
  }

  /**
   * 被环境变量实际覆盖的字段（只算「env 真的有值」的那些）。
   *
   * 多 provider 下 env 只锁**第一个** provider 的字段（与 `resolveModelChoice`
   * 的覆盖范围严格一致，见 model-config.ts 的注释）：path 用
   * `providers.<id>.<field>`，和 `validateProvider` 的报错路径同构，
   * 设置页按这个 path 去查锁即可。没有任何 provider 时不产锁 ——
   * 锁一个不存在的 id 只会让界面显示一条点不到的提示。
   */
  envOverrides(): EnvOverride[] {
    const first = (this.raw['providers'] as ProviderConfig[] | undefined)?.[0];
    if (!first?.id) return [];
    const out: EnvOverride[] = [];
    for (const { env, field } of ENV_OVERRIDE_SPECS) {
      const value = this.env[env];
      if (value === undefined || value === '') continue;
      out.push({
        path: `providers.${first.id}.${field}`,
        env,
        value: field === 'apiKey' ? maskKey(value) : value,
      });
    }
    return out;
  }

  resolution(): ConfigResolution {
    if (this.lastError) return { degraded: true, reason: this.lastError };
    const choice = this.modelChoice();
    if (choice.kind === 'faux') return { degraded: true, reason: choice.reason };
    // defaultRef 由 resolveModelChoice 保证能在 providers 里解到，这里的 ?? 只是类型兜底。
    const hit = resolveModelRef(
      choice.providers.map((p) => ({ id: p.providerId, models: p.models })),
      choice.defaultRef,
    );
    const owner = choice.providers.find((p) => p.providerId === hit?.provider.id) ?? choice.providers[0]!;
    return {
      degraded: false,
      effectiveModel: hit?.model.id ?? owner.defaultModel,
      effectiveModelRef: choice.defaultRef,
      providerId: owner.providerId,
      providerName: owner.providerName,
    };
  }

  /** 读侧快照（脱敏）。 */
  snapshot(): ConfigSnapshot {
    return {
      config: maskConfig(this.raw as AxonConfig, this.configPath),
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
    const lockedBy = new Map(this.envOverrides().map((o) => [o.path, o.env]));
    const draft: Record<string, unknown> = structuredClone(this.raw);
    let pendingApiKey: string | undefined;

    for (const [path, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const lock = lockedBy.get(path);
      if (lock) {
        errors.push({
          path,
          code: 'env-locked',
          message: `${path} 已被环境变量覆盖（${lock}），写入不会生效`,
        });
        continue;
      }
      const issues = validateValue(path, value, draft);
      if (issues.length > 0) {
        errors.push(...issues);
        continue;
      }
      if (path === 'provider.apiKey' && typeof value === 'string') {
        pendingApiKey = value;
        // 明文不写进 draft，走 keychain 加密存储
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

    const result = await this.commit(draft, errors);
    if (result.accepted && pendingApiKey !== undefined) {
      await setKey('provider.apiKey', pendingApiKey, this.configPath);
      const { config: updated } = await loadConfig(this.configPath);
      this.raw = updated as Record<string, unknown>;
      return { ...result, config: this.snapshot() };
    }
    return result;
  }

  /**
   * 创建或整体覆盖一个 provider（按 `id` upsert，`provider.save`）。
   *
   * 与 `patch` 的分工：patch 管点号路径的单字段，这里管「一张卡整体提交」——
   * provider 现在是数组，点号路径表达不了「第几个的哪个字段」（见 config.ts
   * 对 `ConfigPatchPath` 的说明）。校验失败整体不落盘，回 issues 让 UI 逐字段标红。
   *
   * apiKey 的三态（协议里写死的）：不传 = 不动已存的 key，空串 = 清除，
   * 有值 = 写 keychain。明文**绝不**进 draft，因此也不会落到 config.json。
   */
  async saveProvider(
    provider: ProviderConfig,
  ): Promise<{ accepted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot }> {
    const errors = validateProvider(provider);
    if (errors.length > 0) {
      return { accepted: false, errors, config: this.snapshot() };
    }

    // env 锁只作用于第一个 provider（= 默认那个）。对被锁的字段报 env-locked
    // 并保留文件原值——与 config.patch 的 env-locked 语义同构：写了不生效，
    // 静默失败是最坏的体验。非默认 provider 不受 env 影响。
    const lockedBy = new Map(this.envOverrides().map((o) => [o.path, o.env]));
    const fieldPath = (field: string) => `providers.${provider.id}.${field}`;

    const { apiKey, ...rest } = provider;
    const existing = (this.raw['providers'] as ProviderConfig[] | undefined)?.find(
      (p) => p.id === provider.id,
    );

    // 对被锁字段回退到已存值，让其余字段照常更新
    const merged: ProviderConfig = { ...rest };
    for (const field of ['baseUrl', 'apiKey', 'defaultModel'] as const) {
      const path = fieldPath(field);
      const lock = lockedBy.get(path);
      if (lock) {
        errors.push({
          path,
          code: 'env-locked',
          message: `${path} 已被环境变量覆盖（${lock}），写入不会生效`,
        });
        if (existing) {
          const existingVal = (existing as unknown as Record<string, unknown>)[field];
          if (existingVal !== undefined) (merged as unknown as Record<string, unknown>)[field] = existingVal;
          else delete (merged as unknown as Record<string, unknown>)[field];
        } else {
          delete (merged as unknown as Record<string, unknown>)[field];
        }
      }
    }

    const draft: Record<string, unknown> = structuredClone(this.raw);
    const list = Array.isArray(draft['providers']) ? ([...draft['providers']] as ProviderConfig[]) : [];
    const at = list.findIndex((p) => p?.id === provider.id);
    // 整体覆盖而非合并：UI 提交的是整张卡的当前值，合并会让「删掉一个 header」
    // 这种操作永远生效不了。但 env-locked 字段已在上一步回退到原值。
    if (at === -1) list.push(merged);
    else list[at] = merged;
    draft['providers'] = list;

    const result = await this.commit(draft, errors);
    if (!result.accepted) return result;

    if (apiKey !== undefined) {
      const path = providerKeyPath(provider.id);
      if (apiKey === '') await deleteKey(path, this.configPath);
      else await setKey(path, apiKey, this.configPath);
      const { config: updated } = await loadConfig(this.configPath);
      this.raw = updated as Record<string, unknown>;
      return { ...result, config: this.snapshot() };
    }
    return result;
  }

  /**
   * 删除一个 provider 及其 keychain 条目（`provider.delete`，幂等）。
   *
   * `defaultModelRef` 指向被删对象时顺手改指到剩余首个 provider 的默认模型 ——
   * 否则下次启动会静默降级到 faux，用户只看到「模型没了」却看不到原因。
   */
  async deleteProvider(
    id: string,
  ): Promise<{ deleted: boolean; errors: ConfigIssue[]; config: ConfigSnapshot }> {
    const draft: Record<string, unknown> = structuredClone(this.raw);
    const list = Array.isArray(draft['providers']) ? ([...draft['providers']] as ProviderConfig[]) : [];
    const next = list.filter((p) => p?.id !== id);
    if (next.length === list.length) {
      // 不存在视为已删除：不写盘，也不报错。
      return { deleted: false, errors: [], config: this.snapshot() };
    }
    draft['providers'] = next;

    const ref = draft['defaultModelRef'];
    if (typeof ref === 'string' && parseModelRef(ref)?.providerId === id) {
      const fallback = next[0];
      const model = fallback?.defaultModel ?? fallback?.models?.[0]?.id;
      if (fallback?.id && model) draft['defaultModelRef'] = formatModelRef(fallback.id, model);
      else delete draft['defaultModelRef'];
    }

    const result = await this.commit(draft, []);
    if (!result.accepted) return { deleted: false, errors: result.errors, config: result.config };

    await deleteKey(providerKeyPath(id), this.configPath);
    const { config: updated } = await loadConfig(this.configPath);
    this.raw = updated as Record<string, unknown>;
    return { deleted: true, errors: [], config: this.snapshot() };
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
    for (const key of ['provider', 'ui', 'proxy']) {
      const nested = draft[key];
      if (typeof nested === 'object' && nested !== null && Object.keys(nested).length === 0) {
        delete draft[key];
      }
    }
    return this.commit(draft, []);
  }

  /**
   * 纯落盘（不碰 lastError、不产 snapshot）。migrate 用它把迁移结果写回去 ——
   * 迁移失败不该拦住启动，所以这里吞异常只 warn：内存里的 raw 已经是迁移后的
   * 形状，本次运行照常工作，下次启动会再试一遍（migrate 幂等）。
   */
  private async persist(draft: Record<string, unknown>): Promise<void> {
    try {
      await this.io.mkdir(dirname(this.configPath));
      const tmp = `${this.configPath}.tmp-${Date.now()}`;
      await this.io.writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, 0o600);
      await this.io.rename(tmp, this.configPath);
      await this.io.chmod(this.configPath, 0o600).catch(() => null);
    } catch (err) {
      console.warn(`[migrate] 写回 ${this.configPath} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
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
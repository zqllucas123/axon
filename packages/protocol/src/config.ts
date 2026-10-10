/**
 * 运行时配置 —— `~/.axon/config.json` 的形状、可写白名单与生效快照。
 *
 * ─ 为什么这份类型住在 protocol 而不是主进程 ──
 *
 * `AxonConfig` 原先长在 `apps/desktop/src/main/model-config.ts:25-38`，于是
 * 渲染层拿不到配置的形状：设置界面（S8）只能靠「猜字段名 + 猜取值范围」写表单，
 * 而协议层（`config.get/patch`）也没有类型可依。UX `03-设置界面设计.md` §6
 * 把这条列为既有障碍；本文件就是它的解。
 *
 * ── 一条纪律：读回来的 key 永远不是明文 ──
 *
 * 写侧接受明文（用户就是要填 key），读侧一律走 `AxonConfigView`
 * （`apiKeyMasked` + `apiKeySet`）。这样「界面上不小心把 key 渲染出来」
 * 这个事故在类型层面就不可能发生——不是靠自觉。
 *
 * 这个文件只放纯类型、纯常量与纯函数，不得引入运行时依赖。
 */

import type { ApprovalMode } from './agent.ts';
import type { SessionExecutor } from './session.ts';

// ─────────────────────────────────────────────────────────────
// 模型清单
// ─────────────────────────────────────────────────────────────

/**
 * 一个模型的最小声明。
 *
 * 为什么手写而不拉 pi 内置的 44 个 provider 目录：企业网关是
 * 「自定义 baseUrl + 自定义模型名」的组合，`/v1/models` 往往不实现
 * （实测某网关返回 404），内置目录里也不会有这些模型 id。与其猜，不如让用户写清楚。
 *
 * `cost` 单位是**美元 / 百万 token**。填 0 不报错，只是预算熔断永远不触发。
 *
 * 形状真相在这里（kernel 的 `OpenAICompatModel` 是它的别名）：
 * config 白名单要校验 `provider.models`，协议层不能反过来依赖 kernel。
 */
export interface ModelSpec {
  id: string;
  name?: string;
  /** 模型是否会吐 reasoning/thinking 内容（如 deepseek-r1）。默认 false。 */
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  /**
   * OpenAI 兼容网关的方言修正。
   *
   * 为什么需要这个字段：pi 的 openai-completions.js:601-605 靠 `model.compat.maxTokensField`
   * 决定把 maxTokens 发成 `max_tokens` 还是 `max_completion_tokens`。
   * 缺省时 pi 会「自动探测」，但自定义网关（如 DeepSeek）往往只认 `max_tokens`，
   * 探测结果错了就导致截断参数静默失效（S2 闸口 4 取证）。
   * 填上这个字段就能绕过探测，直接告诉 pi 该用哪个字段名。
   */
  compat?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  };
}

// ─────────────────────────────────────────────────────────────
// 配置文件形状
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 网络代理
// ─────────────────────────────────────────────────────────────

/**
 * 应用级网络代理配置。
 *
 * 生效范围：引擎所有出站请求（LLM 调用、工具网络请求）都走主进程 fetch，
 * 通过 `node:undici` 的全局 dispatcher 统一代理，无需各处单独注入。
 */
export interface ProxyConfig {
  /** 代理地址，形如 `http://host:port` 或 `socks5://host:port`。留空 = 不用代理。 */
  url?: string;
  /**
   * 不走代理的主机列表，逗号分隔。
   * 支持精确主机名（`localhost`）和后缀通配（`.internal` 匹配所有 .internal 子域）。
   */
  noProxy?: string;
}

/**
 * 一个模型提供商（网关）。
 *
 * `id` 是**身份字段**：它进 keychain 的点号路径（`providerKeys.<id>.apiKey`），
 * 也进模型引用的复合键（`<id>:<modelId>`）。所以必须唯一、稳定、**不含点号**
 * —— 带点会把 keychain 路径劈开，带冒号会把模型 ref 劈错。
 * 校验规则见 `isValidProviderId`。
 *
 * 为什么用 id 而不是数组下标做身份：下标会随设置页里的重排失效，
 * 而 keychain 里的密文是跟着 id 走的。
 */
export interface ProviderConfig {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: ModelSpec[];
  /** provider **内**的默认模型 id（裸 id，不带 providerId 前缀）。 */
  defaultModel?: string;
  headers?: Record<string, string>;
}

/** provider id 的合法形状：字母数字起头，后接字母数字/下划线/连字符。 */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * provider id 是否合法。
 *
 * 不接受点号与冒号不是洁癖：点号会劈开 keychain 的点号路径，
 * 冒号会让 `parseModelRef` 把 id 当成 `provider:model` 再切一刀。
 */
export function isValidProviderId(id: unknown): id is string {
  return typeof id === 'string' && PROVIDER_ID_RE.test(id);
}

// ─────────────────────────────────────────────────────────────
// 模型引用（modelRef）
// ─────────────────────────────────────────────────────────────

/**
 * 模型引用 = `providerId:modelId`。
 *
 * 为什么不能只用裸 modelId：两个网关挂同名模型是常态
 * （公司内网网关与公有云都叫 `deepseek-v3`），裸 id 无法寻址。
 * 冒号是分隔符，所以 providerId 不许含冒号（`isValidProviderId` 已堵）。
 */
export function formatModelRef(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/**
 * 拆 modelRef。**无冒号 = 裸 modelId**（兼容既有角色文件与落盘记录）。
 *
 * 只切第一个冒号：模型 id 自身可能含冒号（如 ollama 的 `qwen3:8b`）。
 */
export function parseModelRef(ref: string): { providerId?: string; modelId: string } {
  const at = ref.indexOf(':');
  if (at <= 0) return { modelId: ref };
  return { providerId: ref.slice(0, at), modelId: ref.slice(at + 1) };
}

/**
 * 把 modelRef 解到具体的 provider + 模型。
 *
 * 裸 id（无 providerId）按 `providers` 顺序取**首个**挂了该模型的 provider ——
 * 这是旧数据（角色文件里的 `model: "deepseek-v3"`、M15 前的落盘记录）的兼容路径，
 * 所以不做数据迁移：顺序即优先级，用户在设置页重排就能改默认落点。
 *
 * 解析失败回 undefined，由调用方决定降级还是报错（主进程一律 warn + 回落，
 * 沿用 `host.ts` 既有纪律：配置坏了不能让会话起不来）。
 */
export function resolveModelRef(
  providers: readonly ProviderConfig[] | undefined,
  ref: string | undefined,
): { provider: ProviderConfig; model: ModelSpec } | undefined {
  if (!ref || !providers?.length) return undefined;
  const { providerId, modelId } = parseModelRef(ref);
  const pool = providerId ? providers.filter((p) => p.id === providerId) : providers;
  for (const provider of pool) {
    const model = provider.models?.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  return undefined;
}

/**
 * `~/.axon/config.json` 的形状。字段全可选 —— 文件不存在等价于「用 faux」。
 *
 * 「降级而非报错」是刻意的：没配 key 就启动不了会把整个开发链路绑在外部依赖上，
 * 冒烟、CI、新克隆的仓库都应该能直接 `bun run dev`。
 */
export interface AxonConfig {
  /**
   * **legacy 单 provider 字段**（M15 前的形状）。
   *
   * 只在 `ConfigStore.load()` 的迁移里读一次 —— 读到就搬进 `providers[]`
   * 并把这个键删掉，之后永不写入。保留类型是为了让迁移代码有类型可依，
   * 不是为了让新代码读它：新代码一律走 `providers`。
   *
   * `id` 在这里是**可选**的：M15 之前磁盘上根本没有这个字段，迁移时由
   * `LEGACY_PROVIDER_ID` 补上。写成必填会让迁移代码被迫先编一个 id 才能读。
   */
  provider?: Omit<ProviderConfig, 'id'> & { id?: string };
  /**
   * 模型提供商清单（有序，**顺序即设置界面里的顺序**）。
   *
   * 为什么是数组而不是 `Record<id, ...>`：顺序要稳定（用户能重排，裸模型 id
   * 的消歧也按这个顺序取首个匹配），而 JS 对象键序在增删后不可靠。
   */
  providers?: ProviderConfig[];
  /**
   * 全局默认模型，`providerId:modelId` 形式（见 `formatModelRef`）。
   *
   * 与各 provider 自己的 `defaultModel` 的分工：后者是「这个网关内部默认用哪个」，
   * 前者是「跨网关时那个主对话用哪个」。只有它能跨 provider。
   */
  defaultModelRef?: string;
  /* budgetUsd / budgetSoftUsd 已删（2026-10-10）：成本熔断下线。
     旧 config.json 里残留这两个键读出即忽略，不做迁移也不报错。 */
  /** 全局并发上限（同时 running 的 agent 数）；0 = 不限。 */
  maxConcurrent?: number;
  /** 分身树最大深度（会话根为 0）；缺省 2。 */
  maxDepth?: number;
  /** idle 看门狗（毫秒）；0 = 关闭；缺省 5 分钟。 */
  idleTimeoutMs?: number;
  /** 审批请求超时（毫秒）；0 = 不超时。 */
  approvalTimeoutMs?: number;
  /**
   * 全局默认审批档 —— 只作**角色未写 approval** 时的兜底。
   *
   * 不是「强制档位」：角色写了以角色为准（`agent.ts` 的 RoleDefinition.approval 语义不变）。
   * 想统一收紧就到角色/团队那一层改，这条只堵「什么都没写」的情况。
   */
  defaultApproval?: ApprovalMode;
  /** 新建会话的缺省工作目录。 */
  defaultCwd?: string;
  /** 新建会话的缺省执行方式（S0 三张卡的默认选中项）。 */
  defaultExecutor?: SessionExecutor;
  /** 界面偏好（MU-3 拍板 P-3：落在 config 而不是 localStorage，理由见 UiPreferences）。 */
  ui?: UiPreferences;
  /** 应用级网络代理。引擎所有出站请求统一走此代理（undici 全局 dispatcher）。 */
  proxy?: ProxyConfig;
}

/**
 * 界面偏好（S8 「外观」 pane）。
 *
 * 为什么落在 `config.json` 而不是渲染层的 localStorage：MU-3 起有**两个窗口**
 * （主窗 + 设置窗），设置窗改完主窗必须立刻跟着变。落配置后两窗靠
 * `config.changed` 天然同步；localStorage 在 `file://` 下跨窗通知不可靠，必须再
 * 自建一条广播通道 —— 等于把已有的事件总线再造一遍。
 *
 * 这五项**不影响安全边界**，是白名单里唯一的纯外观字段；它们不参与
 * `HostOptions`，只由渲染层读。
 */
export interface UiPreferences {
  /**
   * 主题。MU-3 只实现 `light`（用户拍板 P-4：不做暗色换肤），
   * `dark`/`system` 先占位且在设置页置灰，避免以后改枚举倒致旧配置失效。
   */
  theme?: 'light' | 'dark' | 'system';
  /** 信息密度：紧凑把列表行高收紧，会话正文不受影响。 */
  density?: 'comfortable' | 'compact';
  /** 会话正文字号（px）；缺省 15。 */
  fontSize?: number;
  /** 减弱动态效果：跟随系统（prefers-reduced-motion）或始终减弱。 */
  reduceMotion?: 'system' | 'always';
  /**
   * 显示协议数据标注（每项数据来自哪个事件/命令）。
   *
   * MU-3 切片 8：字段保留（白名单 + 校验 + 默认值都在），但 **S8 暂无对应开关**：
   * 渲染层连一个标注元素都没有（原型里它是 `assets/shell.js` 的 `⌘/` 评审工具），
   * 摆一个点了没反应的开关就是假控件。待 G11.13 做出标注系统后再加回那一行。
   */
  annotations?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 读侧视图（脱敏）
// ─────────────────────────────────────────────────────────────

/** provider 的读侧视图：key 只报「配没配」+ 掩码，永不回传明文。 */
export interface ProviderConfigView extends Omit<ProviderConfig, 'apiKey'> {
  apiKeySet: boolean;
  /** 形如 `sk-***xyz`；未配置则缺省。 */
  apiKeyMasked?: string;
}

/** 配置文件的读侧视图。 */
export interface AxonConfigView extends Omit<AxonConfig, 'provider' | 'providers'> {
  /** legacy 单 provider 的读侧镜像：迁移后恒为 undefined，新代码别读。 */
  provider?: ProviderConfigView;
  providers?: ProviderConfigView[];
}

/** 某个字段被环境变量覆盖的事实（UX 03 §4.2 的「环境变量已锁定」标注）。 */
export interface EnvOverride {
  /** 被覆盖的配置路径。 */
  path: string;
  /** 来源环境变量名。 */
  env: string;
  /** 覆盖值（密钥类只给掩码）。 */
  value?: string;
}

/** 三个真相目录（设置界面的「打开目录」按钮与故障排查用）。 */
export interface ConfigPaths {
  config: string;
  roles: string;
  teams: string;
}

/** 当前模型解析的结论 —— 与顶栏「faux（未配置 provider…）」同源（UX 03 §4.3）。 */
export interface ConfigResolution {
  /** true = 没在跑真模型。 */
  degraded: boolean;
  /** 降级原因（人话，直接展示）。 */
  reason?: string;
  /** 生效的模型 id / provider（未降级时）。 */
  effectiveModel?: string;
  providerId?: string;
  /** provider 显示名（顶栏胶囊用；缺省回落 providerId）。 */
  providerName?: string;
  /** 生效模型的复合键 `providerId:modelId` —— 多 provider 下 effectiveModel 可能重名。 */
  effectiveModelRef?: string;
}

export interface ConfigSnapshot {
  config: AxonConfigView;
  envOverrides: EnvOverride[];
  paths: ConfigPaths;
  resolution: ConfigResolution;
}

// ─────────────────────────────────────────────────────────────
// 写侧白名单
// ─────────────────────────────────────────────────────────────

/**
 * 可写字段白名单（**第一批**）。
 *
 * 为什么要有白名单而不是「随便 patch，主进程合并」：配置文件是用户手写物，
 * 里面可能有我们不认识的键（别的工具写的、或者未来版本的），patch 时
 * 必须原样保留未知字段；反过来说，**不认识**的键也不能被写进来——否则
 * 一个拼错的字段会被静默吞掉，用户在设置界面点了保存却什么都没发生。
 *
 * UI 专有项（`ui.*`）**第二批加入**（MU-3 拍板 P-3）：它们在 MU-1 时刻意缓一缓，
 * 理由是「没人读的死配置」；到 MU-3（S8 外观 pane + 主窗消费）才有了读侧。
 */
export type ConfigPatchPath =
  // provider.* 六条在 M15 移出白名单：provider 现在是**数组**，点号路径表达不了
  // 「第几个 provider 的哪个字段」，而带下标的路径（providers.0.baseUrl）会随 UI 重排失效。
  // 改由 `provider.save` / `provider.delete` 两条 IPC 整体提交（与 role.save/team.save 同构）。
  | 'defaultModelRef'
  | 'maxConcurrent'
  | 'maxDepth'
  | 'idleTimeoutMs'
  | 'approvalTimeoutMs'
  | 'defaultApproval'
  | 'defaultCwd'
  | 'defaultExecutor'
  | 'ui.theme'
  | 'ui.density'
  | 'ui.fontSize'
  | 'ui.reduceMotion'
  | 'ui.annotations'
  | 'proxy.url'
  | 'proxy.noProxy';

export type ConfigFieldKind = 'string' | 'number' | 'enum' | 'json' | 'boolean';

export interface ConfigFieldSpec {
  path: ConfigPatchPath;
  kind: ConfigFieldKind;
  /** kind='enum' 时的合法取值。 */
  values?: readonly string[];
  min?: number;
  max?: number;
  /** 密钥：读侧永不回传明文，写侧接受明文。 */
  secret?: boolean;
  /** 字段语义（中文）。设置界面与错误信息共用一份，避免两处写死。 */
  note: string;
}

/** 数值字段的上界：一天。超过一天的超时等于没超时，写错只会让人以为设了。 */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const CONFIG_FIELD_SPECS: readonly ConfigFieldSpec[] = Object.freeze([
  { path: 'defaultModelRef', kind: 'string', note: '全局默认模型，形如 providerId:modelId；必须能在 providers 里解析到' },
  { path: 'maxConcurrent', kind: 'number', min: 0, max: 64, note: '全局并发上限（同时 running）；0 = 不限' },
  { path: 'maxDepth', kind: 'number', min: 1, max: 8, note: '分身树最大深度（会话根为 0）' },
  { path: 'idleTimeoutMs', kind: 'number', min: 0, max: MAX_TIMEOUT_MS, note: 'idle 看门狗（毫秒）；0 = 关闭' },
  { path: 'approvalTimeoutMs', kind: 'number', min: 0, max: MAX_TIMEOUT_MS, note: '审批超时（毫秒）；0 = 不超时' },
  { path: 'defaultApproval', kind: 'enum', values: ['always_ask', 'auto', 'full_access'], note: '角色未写审批档时的兜底' },
  { path: 'defaultCwd', kind: 'string', note: '新建会话的缺省工作目录' },
  { path: 'defaultExecutor', kind: 'enum', values: ['engine', 'team', 'adhoc'], note: '新建会话的缺省执行方式' },
  // ui.*：S8 「外观」 pane。唯一一组不改变安全边界的字段，也是唯一一组不进 HostOptions 的字段。
  { path: 'ui.theme', kind: 'enum', values: ['light', 'dark', 'system'], note: '界面主题；MU-3 只实现 light，dark/system 在设置页置灰' },
  { path: 'ui.density', kind: 'enum', values: ['comfortable', 'compact'], note: '列表信息密度；会话正文不受影响' },
  { path: 'ui.fontSize', kind: 'number', min: 12, max: 20, note: '会话正文字号（px）；缺省 15' },
  { path: 'ui.reduceMotion', kind: 'enum', values: ['system', 'always'], note: '减弱动态效果：跟随系统 prefers-reduced-motion 或始终减弱' },
  { path: 'ui.annotations', kind: 'boolean', note: '在界面上标出每项数据来自哪个协议事件/命令（字段已就绪，渲染层的标注系统待 G11.13）' },
  // proxy.*：引擎出站流量代理（undici 全局 dispatcher）。
  { path: 'proxy.url', kind: 'string', note: '代理地址，形如 http://host:port 或 socks5://host:port；留空不用代理' },
  { path: 'proxy.noProxy', kind: 'string', note: '不走代理的主机列表，逗号分隔，支持后缀通配（.internal）' },
]);

const SPEC_BY_PATH = new Map<string, ConfigFieldSpec>(
  CONFIG_FIELD_SPECS.map((spec) => [spec.path, spec]),
);

export function isConfigPatchPath(value: unknown): value is ConfigPatchPath {
  return typeof value === 'string' && SPEC_BY_PATH.has(value);
}

export function configFieldSpec(path: ConfigPatchPath): ConfigFieldSpec {
  const spec = SPEC_BY_PATH.get(path);
  if (!spec) throw new Error(`未知配置字段: ${path}`);
  return spec;
}

export const CONFIG_PATCH_PATHS: readonly ConfigPatchPath[] = Object.freeze(
  CONFIG_FIELD_SPECS.map((s) => s.path),
);

/** patch 的载荷：扁平的「点号路径 → 值」。 */
export type ConfigPatch = Partial<Record<ConfigPatchPath, unknown>>;

/** patch 的校验结论。一条 issue = 一个字段被拒的原因。 */
export interface ConfigIssue {
  /** 出问题的配置路径（整文件级问题则缺省）。 */
  path?: string;
  code:
    | 'unknown-field'
    | 'invalid-type'
    | 'out-of-range'
    | 'invalid-value'
    | 'env-locked'
    | 'not-writable'
    | 'parse_error'
    | 'io_error';
  message: string;
}

/**
 * 环境变量覆盖表。
 *
 * 存在的理由有两层：(1) 设置界面要能标注「这个字段已被环境变量锁定」，
 * 否则用户改了没生效会以为是 bug；(2) patch 侧要靠它**拒绝**写入被覆盖的字段
 * ——写了也不会生效，静默失败是最坏的体验。
 *
 * `AXON_PROVIDER=faux`（强制假模型）与 `AXON_CONFIG`（配置文件路径）不在这张表里：
 * 它们改变的是「读哪个文件 / 走哪条路」，不是某个字段的值。
 */
/**
 * 这三条锁的是**默认 provider 的字段**，不是白名单路径。
 *
 * M15 起 provider 是数组，所以 path 不再是 `ConfigPatchPath`（白名单里已无 provider.*），
 * 而是运行时拼出的 `providers.<defaultId>.<field>` —— 具体 id 要等配置加载后才知道。
 * 这里只声明「哪个 env 锁哪个字段名」，拼接由主进程的 `config-store` 完成。
 *
 * 为什么只锁默认 provider：这三个 env 是 CI 与冒烟脚本的入口（一套 baseUrl/key/model
 * 跑通全链路），没有「第二个网关」的概念。多 provider 是用户态配置，env 不该能凭空造出一个。
 */
export const ENV_OVERRIDE_SPECS: readonly { env: string; field: keyof ProviderConfig }[] =
  Object.freeze([
    { env: 'AXON_BASE_URL', field: 'baseUrl' },
    { env: 'AXON_API_KEY', field: 'apiKey' },
    { env: 'AXON_MODEL', field: 'defaultModel' },
  ]);

// ─────────────────────────────────────────────────────────────
// 缺省值（解析用；不写进文件）
// ─────────────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = {
  maxConcurrent: 6,
  maxDepth: 2,
  idleTimeoutMs: 5 * 60_000,
  /** 审批超时缺省 = 5 分钟（与 approval.ts 的 DEFAULT_APPROVAL_TIMEOUT_MS 同值）。 */
  approvalTimeoutMs: 300_000,
  executor: 'engine' as SessionExecutor,
  /** 界面偏好的缺省（`config.reset` 也回到这一组：实际上是把 `ui.*` 删干净）。 */
  ui: Object.freeze({
    theme: 'light',
    density: 'comfortable',
    fontSize: 15,
    reduceMotion: 'system',
    annotations: false,
  }) as Readonly<Required<UiPreferences>>,
} as const;
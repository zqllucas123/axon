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
}

// ─────────────────────────────────────────────────────────────
// 配置文件形状
// ─────────────────────────────────────────────────────────────

export interface ProviderConfig {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: ModelSpec[];
  defaultModel?: string;
  headers?: Record<string, string>;
}

/**
 * `~/.axon/config.json` 的形状。字段全可选 —— 文件不存在等价于「用 faux」。
 *
 * 「降级而非报错」是刻意的：没配 key 就启动不了会把整个开发链路绑在外部依赖上，
 * 冒烟、CI、新克隆的仓库都应该能直接 `bun run dev`。
 */
export interface AxonConfig {
  provider?: ProviderConfig;
  /** 预算硬线（美元）；缺省/0 = 不设限（与 BudgetGuard 的 hard<=0 同义）。 */
  budgetUsd?: number;
  /** 预算软线（美元）；缺省 = hard × 0.8。 */
  budgetSoftUsd?: number;
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
export interface AxonConfigView extends Omit<AxonConfig, 'provider'> {
  provider?: ProviderConfigView;
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
  | 'provider.baseUrl'
  | 'provider.apiKey'
  | 'provider.defaultModel'
  | 'provider.name'
  | 'provider.headers'
  | 'provider.models'
  | 'budgetUsd'
  | 'budgetSoftUsd'
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
  | 'ui.annotations';

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
  { path: 'provider.baseUrl', kind: 'string', note: '网关根地址，形如 https://host/path/v1（不含 /chat/completions）' },
  { path: 'provider.apiKey', kind: 'string', secret: true, note: 'API key；明文只写不读，读侧只回掩码' },
  { path: 'provider.defaultModel', kind: 'string', note: '默认模型 id；必须在 provider.models 清单里' },
  { path: 'provider.name', kind: 'string', note: 'provider 显示名（顶栏与设置界面用）' },
  { path: 'provider.headers', kind: 'json', note: '自定义请求头（企业网关鉴权常用）' },
  { path: 'provider.models', kind: 'json', note: '模型清单：id 必填，cost 为美元/百万 token' },
  { path: 'budgetUsd', kind: 'number', min: 0, note: '全局预算硬线（美元）；0 = 不设限' },
  { path: 'budgetSoftUsd', kind: 'number', min: 0, note: '全局预算软线（美元）；缺省 = 硬线 × 0.8' },
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
export const ENV_OVERRIDE_SPECS: readonly { env: string; path: ConfigPatchPath }[] = Object.freeze([
  { env: 'AXON_BASE_URL', path: 'provider.baseUrl' },
  { env: 'AXON_API_KEY', path: 'provider.apiKey' },
  { env: 'AXON_MODEL', path: 'provider.defaultModel' },
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
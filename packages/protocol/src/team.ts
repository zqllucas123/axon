/**
 * 团队（Team）—— 可复用的班子模板（UX `02-团队与会话模型.md` §2.2 的第三层）。
 *
 * 用户复用的是一个**班子**（主控 + 架构 + 实现 + 测试），而不是单个角色：
 * 旧模型里想复用得先背出「该派哪几个角色、谁当 lead」，那是记忆负担不是能力。
 *
 * 两个产品判断被写进了类型里：
 *
 * 1. **成员是团队私有的**（UX 02 §6 倾向，用户拍板）：团队 JSON 内嵌成员，
 *    不做跨团队共享的 Agent 实体。复用交给「Agent 类型」这一层——成员只是
 *    「引用一个类型 + 本队覆写」。代价是同一个人配置要复制多份，换来的是
 *    改一处不会影响别队。
 * 2. **团队不嵌套**：没有「子队当一个成员」这种形态。嵌套会让「父 ∩ 子白名单」
 *    与并发闸门的语义同时变复杂，而编队形状（星形/链形/自定义父子）已覆盖大部分需求。
 *
 * 关键不变量（沿用 AGENTS.md §5）：团队**不引入新的提权路径**。成员的覆写只能减能力，
 * 不能突破所引用类型的白名单——合成顺序仍是「角色 → 权限（父 ∩ 子）→ 上下文（ForkMode）」。
 *
 * 这个文件只放纯类型、纯常量与纯函数，不得引入运行时依赖。
 */

import type { ApprovalMode, ForkModeSpec } from './agent.ts';
import type { BudgetTier, SessionBudgetSpec } from './session.ts';

// ─────────────────────────────────────────────────────────────
// 成员
// ─────────────────────────────────────────────────────────────

/**
 * Agent 级覆写 —— **只减不增**。
 *
 * `tools` 是白名单的子集（`intersectTools` 会再与父级求交，越权写不进去）；
 * `approval` 只允许更严（见 isStricterApproval）；`model` 与 `forkMode` 是中性的，
 * 换模型不改变权限，换上下文口径受 forkDefault 约束。
 */
export interface TeamMemberOverride {
  displayName?: string;
  model?: string;
  approval?: ApprovalMode;
  /** 类型白名单的子集；写超集不会生效（求交时被裁掉）。 */
  tools?: string[];
  forkMode?: ForkModeSpec;
}

/** 团队里的一名具名成员。 */
export interface TeamMember {
  /** 本队内的显示名（「架构师」）；同时是路径段与 formation 的引用键。 */
  name: string;
  /** Agent 类型（`~/.axon/roles/*.json` 的 name，或内置角色名）。 */
  role: string;
  /** 团队主控；**恰好一个**。它拿 initialPrompt，也负责拆解与分派。 */
  lead?: boolean;
  /** formation='custom' 时的父成员 name；缺省挂会话根。 */
  parent?: string;
  description?: string;
  overrides?: TeamMemberOverride;
}

/**
 * 编队形状 —— 决定实例化后的分身树父子关系，也就决定了权限交集链与审批穿透路径。
 *
 * - `star`（缺省）：lead 直连所有人。成员都挂会话根，深度 1。
 * - `chain`：逐级转交。第 i 个成员的父是第 i-1 个，深度可达 4~5。
 * - `custom`：按成员的 `parent` 字段自建，允许「架构师下面挂两个实现」这类形状。
 */
export type TeamFormation = 'star' | 'chain' | 'custom';

export const TEAM_FORMATIONS: readonly TeamFormation[] = Object.freeze(['star', 'chain', 'custom']);

export function isTeamFormation(value: unknown): value is TeamFormation {
  return typeof value === 'string' && (TEAM_FORMATIONS as readonly string[]).includes(value);
}

export const TEAM_MEMBER_MIN = 2;
export const TEAM_MEMBER_MAX = 6;

/** 团队落盘 schema 版本（文件名即团队名，抄 roles 的约定）。 */
export const TEAM_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────
// 团队定义
// ─────────────────────────────────────────────────────────────

/**
 * 团队 = 成员组合 + 编队形状 + 并发闸门 + 团队预算 + 上下文默认。
 *
 * 字段全部可选（除 name/members）是有意的：手写一个最小团队只要两行
 * （名字 + 一个成员），其余按缺省走。缺省值在 session-instantiate 侧解析，
 * 不在这里填——协议层不是配置解析器。
 */
export interface TeamDefinition {
  schemaVersion?: number;
  /** 团队名，同时是文件名与 `session.teamId`。 */
  name: string;
  description?: string;
  members: TeamMember[];
  /** 缺省 'star'。 */
  formation?: TeamFormation;
  /** 本队会话的并发上限（同时 running 的成员数）；0/未设 = 不限。 */
  maxConcurrent?: number;
  /** 团队档预算；会话可下调不可上调（取更严者）。 */
  budget?: SessionBudgetSpec;
  /** 成员的缺省 ForkMode；成员自己的 forkMode 优先。 */
  defaultForkMode?: ForkModeSpec;
}

/** 团队列表条目 = 定义 + 来源 + 加载健康度（与 RoleEntry 同构）。 */
export interface TeamEntry {
  team: TeamDefinition;
  source: 'builtin' | 'user';
  /** 用户团队覆盖了同名内置团队时为 true。 */
  overridesBuiltin?: boolean;
  filePath?: string;
  errors: TeamIssue[];
}

// ─────────────────────────────────────────────────────────────
// 校验问题
// ─────────────────────────────────────────────────────────────

export type TeamIssueLevel = 'error' | 'warn';

/**
 * 机器可读的问题码。UI 据此选展示方式，测试据此断言（不靠文案匹配）。
 *
 * 与 RoleIssue 的一个区别：这里带 `member`，因为团队的问题几乎总是定位到人
 * （「哪个成员的角色不存在」比「这个团队坏了」有用得多）。
 */
export type TeamIssueCode =
  | 'parse_error'
  | 'io_error'
  | 'name-required'
  | 'name-invalid'
  | 'members-empty'
  | 'member-limit'
  | 'member-name-duplicate'
  | 'member-name-invalid'
  | 'role-not-found'
  | 'no-lead'
  | 'multiple-leads'
  | 'lead-approval-too-loose'
  | 'lead-tools-insufficient'
  | 'member-tools-escalation'
  | 'approval-not-stricter'
  | 'parent-not-found'
  | 'parent-cycle'
  | 'formation-mismatch'
  | 'invalid-value';

export interface TeamIssue {
  level: TeamIssueLevel;
  code: TeamIssueCode;
  message: string;
  filePath?: string;
  /** 定位到具体成员（若有）。 */
  member?: string;
}

// ─────────────────────────────────────────────────────────────
// 纯函数助手（loader / instantiate / UI 共用）
// ─────────────────────────────────────────────────────────────

/** 团队的编队形状（缺省 star）。 */
export function formationOf(team: TeamDefinition): TeamFormation {
  return team.formation ?? 'star';
}

/**
 * 谁是主控。缺省约定：**第一个成员**。
 *
 * 允许省略 lead 字段是有意的——手写团队时「第一个人就是 lead」是最省心的默认，
 * 与 Perl 的 `$1` 一样：写下顺序就是表达顺序。显式标了就用显式标的那位。
 */
export function leadMember(team: TeamDefinition): TeamMember | undefined {
  return team.members.find((m) => m.lead === true) ?? team.members[0];
}

export function memberByName(team: TeamDefinition, name: string): TeamMember | undefined {
  return team.members.find((m) => m.name === name);
}

/**
 * 计算每个成员实例化后的父成员 name（`undefined` = 挂会话根）。
 *
 * 纯函数，且**不**做合法性校验（父不存在、成环交给 validateTeam 报）。
 * 单独抽出来的理由：实例化、校验、UI 预览三处都要用同一个答案，各写一遍必然漂移。
 */
export function parentNamesOf(team: TeamDefinition): Map<string, string | undefined> {
  const formation = formationOf(team);
  const lead = leadMember(team);
  const out = new Map<string, string | undefined>();

  team.members.forEach((m, i) => {
    if (m === lead) {
      out.set(m.name, undefined); // 主控永远挂会话根
      return;
    }
    switch (formation) {
      case 'star':
        out.set(m.name, undefined);
        return;
      case 'chain': {
        const prev = team.members[i - 1];
        out.set(m.name, prev ? prev.name : undefined);
        return;
      }
      case 'custom':
        out.set(m.name, m.parent ?? undefined);
        return;
    }
  });

  return out;
}

/**
 * 审批档的严格度序：`always_ask` > `auto` > `full_access`。
 *
 * 「更严」的定义只与「请求能否被静默放行」有关：always_ask 必然惊动人；
 * auto 会代批后代（这就是 M4 修②要留痕的那条路）；full_access 连自己的都免问。
 */
const STRICTNESS: Record<ApprovalMode, number> = {
  always_ask: 2,
  auto: 1,
  full_access: 0,
};

/** a 是否比 b 更严或同等。成员覆写只允许用它判定「没放宽」。 */
export function isStricterOrEqualApproval(a: ApprovalMode, b: ApprovalMode): boolean {
  return STRICTNESS[a] >= STRICTNESS[b];
}

/** `approval` 档的严格度（导出给 UI 排序/染色用）。 */
export function approvalStrictness(mode: ApprovalMode): number {
  return STRICTNESS[mode];
}

/** 团队档预算的展示文案口径（S3 卡片上的「$1.50 上限」）。 */
export function budgetLabel(spec: SessionBudgetSpec | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec.hardUsd === undefined || spec.hardUsd <= 0) return undefined;
  return `$${spec.hardUsd.toFixed(2)} 上限`;
}

/** 预算档位的中文名（UI 与测试共用一份，避免两处写死）。 */
export const BUDGET_TIER_LABEL: Record<BudgetTier, string> = {
  ok: '正常',
  warning: '接近上限',
  frozen: '已冻结',
};
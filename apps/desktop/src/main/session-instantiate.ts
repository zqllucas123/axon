/**
 * 会话实例化 —— 把「团队定义」翻译成「一串待 spawn 的成员计划」（纯逻辑）。
 *
 * 刻意与 AxonHost 分开：
 *  - 这里是纯函数（给定义 + 角色表 → 计划），可以穷举单测，不必起一个宿主；
 *  - 宿主只负责按计划建根、spawn、注入 roster —— 它不解释团队语义。
 *
 * 三条被固化的规则（都来自 UX 02 §2.2 与 AGENTS.md §5 的不变量）：
 *
 * 1. **覆写只减不增**：成员的 tools 与角色白名单求交，approval 取更严者。
 *    在计划里就把这件事做掉，而不是指望 spawn 时再兜 —— 计划是这个里程碑里
 *    唯一能一眼看出「谁拿到什么权限」的地方。
 * 2. **父先于子**：chain/custom 编队下父子关系决定权限交集链，父必须先实例化。
 *    拓扑排序在这里做，宿主不必关心。
 * 3. **roster 注入主控**：主控需要知道「我的成员是谁、路径在哪」，否则它分派时
 *    只能猜角色名。roster 是**运行期事实**（已实例化成员的路径），所以只能在
 *    spawn 之后拼，故由调用方在拿到实际路径后调用 `rosterPrompt()`。
 */

import {
  approvalStrictness,
  formationOf,
  leadMember,
  type ApprovalMode,
  type AgentPath,
  type ForkModeSpec,
  type RoleDefinition,
  type TeamDefinition,
  type TeamMember,
} from '@axon/protocol';
import type { AdhocMemberSpec } from '@axon/protocol';
import { intersectTools } from '@axon/kernel';

/** 取更严的审批档（只减不增）。 */
export function stricterApproval(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return approvalStrictness(a) >= approvalStrictness(b) ? a : b;
}

/**
 * 成员生效的角色定义。
 *
 * 用「复制 + 覆写」而不是原地改：角色定义是跨会话共享的常量，
 * 一次改写会污染所有会话（这是最典型的「改一处坏一片」）。
 */
export function effectiveMemberRole(
  role: RoleDefinition,
  member: TeamMember,
  defaultApproval?: ApprovalMode,
): RoleDefinition {
  const ov = member.overrides ?? {};
  const base = role.approval ?? defaultApproval ?? 'always_ask';
  return {
    ...role,
    displayName: ov.displayName ?? role.displayName,
    ...(ov.model !== undefined ? { model: ov.model } : {}),
    approval: ov.approval !== undefined ? stricterApproval(ov.approval, base) : base,
    tools: intersectTools(role.tools, ov.tools),
    ...(ov.forkMode !== undefined ? { defaultForkMode: ov.forkMode } : {}),
  };
}

/** 一个待实例化的成员。 */
export interface MemberPlan {
  /** 成员名（团队内唯一）。 */
  name: string;
  /** 生效角色（已套覆写，且已保证只减不增）。 */
  role: RoleDefinition;
  displayName: string;
  /** 会话内的父成员名；undefined = 挂会话根（主控的直接下属）。 */
  parentName?: string;
  forkMode?: ForkModeSpec;
  /** 建完立刻交给它的任务（adhoc 成员的 task）。 */
  task?: string;
  lead: boolean;
  description?: string;
}

export interface TeamPlan {
  /** 主控 —— 它是会话根，不是根的子节点。 */
  lead: MemberPlan;
  /** 其余成员，**已拓扑排序**（父一定在子之前）。 */
  members: MemberPlan[];
  /** 规范化后的团队（adhoc 也先转成一份）。 */
  team: TeamDefinition;
}

export interface PlanOptions {
  /** 角色表（name → 定义）。 */
  roles: ReadonlyMap<string, RoleDefinition> | readonly RoleDefinition[];
  defaultApproval?: ApprovalMode;
  /** 成员名 → 首条任务（adhoc 用；团队成员的 task 无来源，留空）。 */
  tasks?: ReadonlyMap<string, string>;
}

function toRoleMap(roles: PlanOptions['roles']): Map<string, RoleDefinition> {
  return roles instanceof Map
    ? roles
    : new Map([...(roles as RoleDefinition[])].map((r) => [r.name, r]));
}

/**
 * 团队 → 实例化计划。
 *
 * 校验失败（角色不存在、没有主控）直接抛：调用方在更早的地方已经用
 * `validateTeam` 拦过一次，走到这里还出问题说明是程序 bug，不该静默降级。
 */
export function planTeam(team: TeamDefinition, opts: PlanOptions): TeamPlan {
  const table = toRoleMap(opts.roles);
  const lead = leadMember(team);
  if (!lead) throw new Error(`团队 ${team.name} 没有成员，无法实例化`);
  // 父子关系由编队形状决定（star/chain 不看成员字段），所以在这里算一次，
  // 后续所有环节（拓扑排序、宿主建树、UI 预览）共用同一个答案。
  const parents = resolveParentNames(team);

  const build = (member: TeamMember, isLead: boolean): MemberPlan => {
    const role = table.get(member.role);
    if (!role) throw new Error(`团队 ${team.name} 的成员「${member.name}」引用了不存在的角色: ${member.role}`);
    const eff = effectiveMemberRole(role, member, opts.defaultApproval);
    const parentName = isLead ? undefined : parents.get(member.name);
    return {
      name: member.name,
      role: eff,
      displayName: member.overrides?.displayName ?? member.name,
      lead: isLead,
      ...(parentName !== undefined ? { parentName } : {}),
      ...(eff.defaultForkMode !== undefined ? { forkMode: eff.defaultForkMode } : {}),
      ...(member.description !== undefined ? { description: member.description } : {}),
      ...(opts.tasks?.get(member.name) !== undefined ? { task: opts.tasks.get(member.name)! } : {}),
    };
  };

  const leadPlan = build(lead, true);

  // 拓扑排序：反复取出「父已就绪」的成员，直到取不动为止。
  // 成环时剩下的成员永远取不出来 —— 那种团队已经被 validateTeam 拦掉，
  // 这里再兜一次（抛而不是静默丢人）。
  const rest = team.members.filter((m) => m !== lead).map((m) => build(m, false));
  const ordered: MemberPlan[] = [];
  const ready = new Set<string>([leadPlan.name]);
  const pending = [...rest];
  while (pending.length > 0) {
    const idx = pending.findIndex((m) => m.parentName === undefined || ready.has(m.parentName));
    if (idx < 0) throw new Error(`团队 ${team.name} 的成员父子关系成环，无法实例化`);
    const [m] = pending.splice(idx, 1);
    if (m) {
      ordered.push(m);
      ready.add(m.name);
    }
  }

  return { lead: leadPlan, members: ordered, team };
}

/**
 * 解析每个成员的**实际父路径**。
 *
 * star/chain 的父子由编队形状决定（不是成员字段），所以必须与
 * `parentNamesOf` 用同一份规则 —— 这里直接按形状算，避免两处实现漂移。
 */
export function resolveParentNames(team: TeamDefinition): Map<string, string | undefined> {
  const shape = formationOf(team);
  const lead = leadMember(team);
  const out = new Map<string, string | undefined>();
  const ordered = team.members;
  ordered.forEach((m, i) => {
    if (m === lead) {
      out.set(m.name, undefined);
      return;
    }
    switch (shape) {
      case 'star':
        out.set(m.name, undefined);
        return;
      case 'chain': {
        const prev = ordered[i - 1];
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
 * 主控的 roster 提示词 —— 「你的成员是谁、路径在哪」。
 *
 * 只注入**已实例化**成员的名字与路径（不注入它们的内容或提示词），
 * 这是运行期事实而不是角色模板的一部分。放在这里而不是 host 里，
 * 是为了让「动态提示词只有这一处」这句话可验证（grep rosterPrompt）。**
 */
export function rosterPrompt(
  sessionId: string,
  entries: readonly { plan: MemberPlan; path: AgentPath }[],
): string {
  const lines = entries.map(({ plan, path }) => {
    const desc = plan.description ? ` —— ${plan.description}` : '';
    return `- ${plan.name}（${plan.role.displayName}）路径 ${path}${desc}`;
  });
  return [
    '[本会话团队] 以下成员已实例化，可以直接用它们干活：',
    ...lines,
    `它们的路径都在会话 ${sessionId} 之下，用 agent / agent_wait / agent_message 时填这些路径。`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// 临时编队 → 团队定义
// ─────────────────────────────────────────────────────────────

/**
 * 把临时编队（S0 第三张卡）转成一份团队定义，复用同一条实例化路径。
 *
 * 为什么转而不另写一条：临时编队与团队的区别只在「存不存盘」，
 * 实例化语义完全一样。两条实现路线必然在第三个月开始分叉。
 *
 * 约定：第一个成员当主控（没有显式标 lead 时），团队名用 `临时编队`（不落盘）。
 */
export function adhocTeam(members: AdhocMemberSpec[], name = '临时编队'): TeamDefinition {
  const teamMembers: TeamMember[] = members.map((m, i) => ({
    name: m.name ?? (i === 0 ? '主控' : m.role),
    role: m.role,
    ...(i === 0 ? { lead: true } : {}),
    ...(m.parent !== undefined ? { parent: m.parent } : {}),
    ...(m.forkMode !== undefined ? { overrides: { forkMode: m.forkMode } } : {}),
  }));
  return {
    name,
    description: '本会话的临时编队（用完即散）',
    members: teamMembers,
    formation: 'star',
  };
}

/** 临时编队成员的首条任务表（planTeam 的 tasks 参数）。 */
export function adhocTasks(members: AdhocMemberSpec[], nameOf: (m: AdhocMemberSpec, i: number) => string): Map<string, string> {
  const out = new Map<string, string>();
  members.forEach((m, i) => {
    if (m.task) out.set(nameOf(m, i), m.task);
  });
  return out;
}
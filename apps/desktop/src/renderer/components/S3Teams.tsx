/**
 * S3 团队管理 —— 三 tab（团队 / Agent / Agent 类型）。
 *
 * 拍板（MU-2 §十一-4）：「Agent」tab = **跨团队类型清单（只读）** ——
 * 它回答的是「我有哪些类型、各自能力如何、被谁引用」，编辑入口在「Agent 类型」tab。
 *
 * 数据纪律：本屏只读 `team.list` / `role.list` 的缓存（store.teams / store.roles），
 * 保存走 `team.save` / `role.save`，删除走 `team.delete` / `role.delete`；
 * 主进程落盘后会 emit `teams.changed` / `roles.changed`，列表自动重绘（不在前端打补丁）。
 *
 * 缺口处置（§4.6）：团队预算的「软线」在协议里有（SessionBudgetSpec.softUsd），
 * 但团队档没有单独的「只读」开关 —— 原型的「全员只读」标签不渲染（拿不到就不编）。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import {
  formatForkMode,
  leadMember,
  parseForkMode,
  type ApprovalMode,
  type ForkModeSpec,
  type RoleDefinition,
  type TeamDefinition,
  type TeamIssue,
  type TeamMember,
  type RoleIssue,
} from '@axon/protocol';

type Tab = 'teams' | 'agents' | 'types';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'teams', label: '团队' },
  { id: 'agents', label: 'Agent' },
  { id: 'types', label: 'Agent 类型' },
];

const APPROVALS: readonly ApprovalMode[] = ['always_ask', 'auto', 'full_access'];
const FORMATIONS: Array<{ id: 'star' | 'chain' | 'custom'; label: string; hint: string }> = [
  { id: 'star', label: '星形', hint: 'lead 直连所有人，深度 1' },
  { id: 'chain', label: '链形', hint: '逐级转交，深度可达 4~5' },
  { id: 'custom', label: '自定义父子', hint: '按成员的 parent 字段自建' },
];
const FORK_CHOICES: Array<{ id: string; label: string }> = [
  { id: 'none', label: 'none' },
  { id: 'lastRounds:3', label: '最近 3 轮' },
  { id: 'all', label: 'all' },
];

const money = (n: number | undefined): string => (n ? `$${n.toFixed(2)}` : '—');

/** 团队成员的「类型」提示：拿不到类型定义时不编（返回 null）。 */
function roleOf(roleName: string, roles: { entries: Array<{ role: RoleDefinition; source: string }> }): RoleDefinition | null {
  const hit = roles.entries.find((e) => e.role.name === roleName);
  return hit ? hit.role : null;
}

/** 团队卡（原型 `.team-card`）。 */
function TeamCard({
  team,
  active,
  inUse,
  onOpen,
}: {
  team: TeamDefinition;
  active: boolean;
  inUse: boolean;
  onOpen: () => void;
}): ReactElement {
  const lead = leadMember(team);
  return (
    <button
      className={`team-card${active ? ' is-on' : ''}`}
      data-smoke="team-card"
      data-team={team.name}
      onClick={onOpen}
    >
      <span className="tc-head">
        <span className="ava-stack">
          {team.members.slice(0, 4).map((m) => (
            <span key={m.name} className={`ava${m.lead ? ' lead' : ''}`}>
              {m.name.slice(0, 1)}
            </span>
          ))}
        </span>
        <span className="spacer" />
        {inUse ? <span className="tag">使用中</span> : null}
      </span>
      <span className="tc-name">{team.name}</span>
      <span className="tc-desc">{team.description ?? '（没有描述）'}</span>
      <span className="tc-foot">
        <span className="tag">{team.members.length} 成员</span>
        {team.maxConcurrent ? <span className="tag">并发 {team.maxConcurrent}</span> : null}
        {team.budget?.hardUsd ? <span className="tag">硬线 {money(team.budget.hardUsd)}</span> : null}
        {lead ? <span className="tag">lead {lead.name}</span> : null}
      </span>
    </button>
  );
}

/** 一行成员（团队详情里的「Agent」）。 */
function MemberRow({
  member,
  index,
  types,
  editing,
  onEdit,
}: {
  member: TeamMember;
  index: number;
  types: ReturnType<typeof useApp>['roles'];
  editing: boolean;
  onEdit: () => void;
}): ReactElement {
  const role = roleOf(member.role, types);
  const fork = member.overrides?.forkMode;
  return (
    <div className={`list-row${editing ? ' is-active' : ''}`} data-smoke="member-row" data-member={member.name}>
      <span className={`ava${member.lead ? ' lead' : ''}`}>{member.name.slice(0, 1)}</span>
      <span className="grow">
        <span className="t1">
          {member.name}
          <span className="tag">类型 {member.role}</span>
          {member.lead ? <span className="tag info">lead</span> : null}
          {fork !== undefined && fork !== null ? (
            <span className="tag info">覆写上下文 {formatForkMode(parseForkMode(fork))}</span>
          ) : null}
          {member.overrides?.approval ? <span className="tag">覆写审批 {member.overrides.approval}</span> : null}
        </span>
        <span className="t2">
          {member.description ?? role?.description ?? '（类型没有描述）'}
        </span>
      </span>
      <span className="tag">{role ? `${role.tools?.length ?? 0} 工具` : '类型缺失'}</span>
      <span className="tag">{role?.approval ?? '—'}</span>
      <button className="btn sm ghost" data-smoke="member-edit" onClick={onEdit}>
        编辑
      </button>
      <span className="hint" style={{ display: 'none' }}>{index}</span>
    </div>
  );
}

/** 成员编辑器（内联；改的是草稿，保存整份团队才提交）。 */
function MemberEditor({
  member,
  types,
  onChange,
  onRemove,
  onClose,
}: {
  member: TeamMember;
  types: ReturnType<typeof useApp>['roles'];
  onChange: (next: TeamMember) => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement {
  const patch = (p: Partial<TeamMember>): void => onChange({ ...member, ...p });
  const patchOverride = (p: Partial<NonNullable<TeamMember['overrides']>>): void =>
    onChange({ ...member, overrides: { ...(member.overrides ?? {}), ...p } });
  const fork = formatForkMode(parseForkMode(member.overrides?.forkMode));

  return (
    <div className="card-body" data-smoke="member-editor" style={{ paddingTop: 14 }}>
      <div className="form-row">
        <div className="lbl">名字</div>
        <div>
          <input
            className="inp"
            value={member.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="架构师"
          />
          <div className="hint">名字同时是路径段与编队引用键，队内唯一。</div>
        </div>
      </div>
      <div className="form-row">
        <div className="lbl">类型</div>
        <div>
          <select className="inp" value={member.role} onChange={(e) => patch({ role: e.target.value })}>
            {types.entries.map((e) => (
              <option key={e.role.name} value={e.role.name}>
                {e.role.name}（{e.role.displayName}）
              </option>
            ))}
          </select>
          <div className="hint">成员的能力天花板 = 类型的白名单 × 审批档；覆写只能减不能增。</div>
        </div>
      </div>
      <div className="form-row">
        <div className="lbl">说明</div>
        <div>
          <input
            className="inp"
            value={member.description ?? ''}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="定方案、不写码"
          />
        </div>
      </div>
      <div className="form-row">
        <div className="lbl">上下文覆写</div>
        <div>
          <span className="seg">
            <button className={fork === 'none' ? 'is-on' : ''} onClick={() => patchOverride({ forkMode: 'none' })}>
              none
            </button>
            <button
              className={fork === 'lastRounds:3' ? 'is-on' : ''}
              onClick={() => patchOverride({ forkMode: 3 })}
            >
              最近 3 轮
            </button>
            <button className={fork === 'all' ? 'is-on' : ''} onClick={() => patchOverride({ forkMode: 'all' })}>
              all
            </button>
          </span>
          <div className="hint">缺省走团队的「上下文默认」；成员覆写优先。</div>
        </div>
      </div>
      <div className="form-row">
        <div className="lbl">审批覆写</div>
        <div>
          <select
            className="inp"
            value={member.overrides?.approval ?? ''}
            onChange={(e) =>
              patchOverride({ approval: e.target.value === '' ? undefined : (e.target.value as ApprovalMode) })
            }
          >
            <option value="">（跟随类型）</option>
            {APPROVALS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <div className="hint">只允许更严：auto 的成员不能被覆写成 full_access。</div>
        </div>
      </div>
      <div className="form-row">
        <div className="lbl">身份</div>
        <div>
          <span className="seg">
            <button className={member.lead ? 'is-on' : ''} onClick={() => patch({ lead: !member.lead })}>
              {member.lead ? '主控（lead）' : '设为 lead'}
            </button>
          </span>
          <div className="hint">团队恰好一个 lead：它拿 initialPrompt，也负责拆解与分派。</div>
        </div>
      </div>
      <div className="card-foot" style={{ padding: '12px 0 0' }}>
        <button className="btn sm danger" onClick={onRemove}>
          <Icon name="trash" size={14} />
          移出本队
        </button>
        <span className="spacer" />
        <button className="btn sm" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  );
}

/** Agent 类型编辑器（内联；保存走 role.save，校验权威在主进程）。 */
function TypeEditor({
  seed,
  editing,
  onClose,
  onSave,
  onDelete,
}: {
  seed?: RoleDefinition;
  editing?: string;
  onClose: () => void;
  onSave: (role: RoleDefinition) => Promise<{ accepted: boolean; errors: RoleIssue[] }>;
  onDelete?: () => void;
}): ReactElement {
  const [name, setName] = useState(seed?.name ?? '');
  const [displayName, setDisplayName] = useState(seed?.displayName ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [instructions, setInstructions] = useState(seed?.instructions ?? '');
  const [tools, setTools] = useState((seed?.tools ?? []).join(', '));
  const [approval, setApproval] = useState<ApprovalMode>(seed?.approval ?? 'always_ask');
  const [forkKind, setForkKind] = useState<string>(() => formatForkMode(parseForkMode(seed?.defaultForkMode)));
  const [errors, setErrors] = useState<RoleIssue[]>([]);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const forkSpec: ForkModeSpec = (() => {
      if (forkKind === 'all') return 'all';
      if (forkKind.startsWith('lastRounds')) {
        const n = forkKind.split(':')[1];
        return n && /^\d+$/.test(n) ? Number(n) : 'none';
      }
      return 'none';
    })();
    setSaving(true);
    const res = await onSave({
      name,
      displayName,
      description,
      instructions,
      tools: tools.split(',').map((t) => t.trim()).filter(Boolean),
      approval,
      defaultForkMode: forkSpec,
    });
    setSaving(false);
    setErrors([...res.errors]);
  };

  return (
    <div className="card" data-smoke="type-editor" style={{ marginTop: 14 }}>
      <div className="card-head">
        <Icon name="spark" size={16} />
        <span className="name">{editing ? `编辑类型 ${editing}` : '新建 Agent 类型'}</span>
        <span className="spacer" />
        <button className="act" onClick={onClose} title="关闭">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="card-body" style={{ paddingTop: 14 }}>
        <div className="form-row">
          <div className="lbl">类型名</div>
          <div>
            <input
              className="inp"
              value={name}
              disabled={editing !== undefined}
              onChange={(e) => setName(e.target.value)}
              placeholder="devops"
            />
            <div className="hint">小写字母开头，是 `~/.axon/roles/&lt;name&gt;.json` 的文件名。</div>
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">显示名</div>
          <div>
            <input className="inp" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="运维分身" />
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">描述</div>
          <div>
            <input
              className="inp"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="部署、日志、环境诊断"
            />
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">指令</div>
          <div>
            <textarea
              className="inp inp-area"
              rows={6}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="你是……"
            />
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">工具白名单</div>
          <div>
            <input
              className="inp mono"
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder="read, grep, bash"
            />
            <div className="hint">逗号分隔；只减不加（与父级求交）。</div>
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">审批档</div>
          <div>
            <span className="seg">
              {APPROVALS.map((a) => (
                <button key={a} className={approval === a ? 'is-on' : ''} onClick={() => setApproval(a)}>
                  {a}
                </button>
              ))}
            </span>
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">默认上下文</div>
          <div>
            <span className="seg">
              {FORK_CHOICES.map((f) => (
                <button key={f.id} className={forkKind === f.id ? 'is-on' : ''} onClick={() => setForkKind(f.id)}>
                  {f.label}
                </button>
              ))}
            </span>
            <div className="hint">缺省 none（纯净上下文）；all 是显式逃生门。</div>
          </div>
        </div>
        {errors.length ? (
          <div className="card err" style={{ marginTop: 12 }}>
            <div className="card-body mono">
              {errors.map((e, i) => (
                <div key={i}>{e.message}</div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="card-foot">
        {onDelete ? (
          <button className="btn sm danger" onClick={onDelete}>
            <Icon name="trash" size={14} />
            删除类型
          </button>
        ) : null}
        <span className="spacer" />
        <button className="btn sm" onClick={onClose}>
          取消
        </button>
        <button className="btn sm primary" disabled={saving} onClick={() => void submit()} data-smoke="type-save">
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

export function S3Teams(): ReactElement {
  const {
    teams, roles, current, saveTeam, deleteTeam, saveRole, deleteRole, openPath,
  } = useApp();
  const [tab, setTab] = useState<Tab>('teams');
  /** 选中的团队名（详情区跟着它换）。 */
  const [picked, setPicked] = useState<string | null>(null);
  /** 团队编辑草稿：**改的是草稿**，点保存才落盘。 */
  const [draft, setDraft] = useState<TeamDefinition | null>(null);
  /** 正在内联编辑的成员下标（null = 没在编辑）。 */
  const [memberAt, setMemberAt] = useState<number | null>(null);
  /** 类型 tab 的编辑态。 */
  const [typeEditing, setTypeEditing] = useState<string | null>(null);
  const [typeNew, setTypeNew] = useState(false);
  const [teamIssues, setTeamIssues] = useState<readonly TeamIssue[]>([]);
  const [busy, setBusy] = useState(false);

  const pickedEntry = useMemo(
    () => teams.entries.find((t) => t.team.name === picked) ?? null,
    [teams.entries, picked],
  );

  const openTeam = (name: string): void => {
    const entry = teams.entries.find((t) => t.team.name === name);
    setPicked(name);
    setDraft(entry ? structuredClone(entry.team) : null);
    setMemberAt(null);
    setTeamIssues(entry?.errors ?? []);
  };

  const newTeam = async (): Promise<void> => {
    const used = new Set(teams.entries.map((t) => t.team.name));
    let name = '新团队';
    let i = 2;
    while (used.has(name)) name = `新团队 ${i++}`;
    const fresh: TeamDefinition = {
      name,
      description: '',
      members: [
        { name: '主控', role: 'lead', lead: true, description: '拆解与收口' },
        { name: '实现', role: 'developer', description: '按契约落地实现，自测后交' },
      ],
    };
    setBusy(true);
    const res = await saveTeam(fresh);
    setBusy(false);
    setTeamIssues(res.errors);
    if (res.accepted) {
      setPicked(name);
      setDraft(fresh);
    }
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    const res = await saveTeam(draft);
    setBusy(false);
    setTeamIssues(res.errors);
    if (!res.accepted && res.errors.length === 0) setTeamIssues([{ level: 'error', code: 'io_error', message: '保存失败，原因见顶栏错误条' }]);
  };

  const removeTeam = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    const ok = await deleteTeam(draft.name);
    setBusy(false);
    if (ok) {
      setPicked(null);
      setDraft(null);
    }
  };

  const patchMember = (at: number, next: TeamMember): void => {
    if (!draft) return;
    const members = draft.members.map((m, i) => (i === at ? next : m));
    setDraft({ ...draft, members });
  };

  const addMember = (): void => {
    if (!draft) return;
    // 起个不撞名的名字：新成员 / 新成员 2 …
    const used = new Set(draft.members.map((m) => m.name));
    let name = '新成员';
    let i = 2;
    while (used.has(name)) name = `新成员 ${i++}`;
    const fallback = roles.entries.find((e) => e.role.name !== 'lead')?.role.name ?? 'developer';
    const members = [...draft.members, { name, role: fallback, description: '' }];
    setDraft({ ...draft, members });
    setMemberAt(members.length - 1);
  };

  const removeMember = (at: number): void => {
    if (!draft) return;
    setDraft({ ...draft, members: draft.members.filter((_, i) => i !== at) });
    setMemberAt(null);
  };

  /** 「Agent」tab：跨团队的全部成员（只读清单）。 */
  const allMembers = teams.entries.flatMap((t) =>
    t.team.members.map((m) => ({ team: t.team.name, source: t.source, member: m })),
  );

  const forkLabelOf = (team: TeamDefinition): string => formatForkMode(parseForkMode(team.defaultForkMode));

  return (
    <div className="body">
      <section className="canvas">
        <div className="page page-wide">
          <div className="page-head">
            <h1>团队</h1>
            <p>
              团队 = 一组 Agent 的编队。Agent = 一个带类型的成员（类型决定提示 + 工具白名单 + 审批档 +
              上下文档）。会话开工时，团队成员被实例化成分身树。
            </p>
          </div>

          <div className="toolbar">
            <span className="seg">
              {TABS.map((t) => {
                const n =
                  t.id === 'teams' ? teams.entries.length : t.id === 'agents' ? allMembers.length : roles.entries.length;
                return (
                  <button
                    key={t.id}
                    className={tab === t.id ? 'is-on' : ''}
                    data-smoke={`tab-${t.id}`}
                    onClick={() => {
                      setTab(t.id);
                      setMemberAt(null);
                      setTypeEditing(null);
                      setTypeNew(false);
                    }}
                  >
                    {t.label} {n}
                  </button>
                );
              })}
            </span>
            <span className="spacer" />
            <button
              className="btn sm ghost"
              onClick={() => void openPath(tab === 'types' ? 'roles' : 'teams')}
            >
              <Icon name="folder" size={14} />
              打开配置目录
            </button>
            {tab === 'teams' ? (
              <button className="btn sm primary" onClick={() => void newTeam()} disabled={busy} data-smoke="new-team">
                <Icon name="plus" size={14} />
                新建团队
              </button>
            ) : null}
            {tab === 'types' ? (
              <button
                className="btn sm primary"
                data-smoke="new-type"
                onClick={() => {
                  setTypeNew(true);
                  setTypeEditing(null);
                }}
              >
                <Icon name="plus" size={14} />
                新建类型
              </button>
            ) : null}
          </div>

          {/* ── 团队 tab ── */}
          {tab === 'teams' ? (
            teams.entries.length === 0 ? (
              <div className="empty">
                <span className="k">还没有团队档</span>
                团队档是 JSON（~/.axon/teams/&lt;name&gt;.json）—— 用「新建团队」起步。
              </div>
            ) : (
              <>
                <div className="grid3" style={{ marginBottom: 26 }}>
                  {teams.entries.map((t) => (
                    <TeamCard
                      key={t.team.name}
                      team={t.team}
                      active={picked === t.team.name}
                      inUse={current?.record.teamId === t.team.name}
                      onOpen={() => openTeam(t.team.name)}
                    />
                  ))}
                </div>

                {draft ? (
                  <div className="card" data-smoke="team-detail" data-team={draft.name}>
                    <div className="card-head">
                      <Icon name="users" size={16} />
                      <span className="name">{draft.name}</span>
                      <span className="path">{pickedEntry?.filePath ?? '（内置团队，尚未落盘）'}</span>
                      <span className="spacer" />
                      <button className="btn sm ghost" onClick={addMember} data-smoke="member-add">
                        <Icon name="plus" size={14} />
                        新建 Agent
                      </button>
                    </div>

                    <div className="card-body" style={{ padding: 0 }}>
                      <div className="list" style={{ border: '0', borderRadius: 0, borderTop: '1px solid var(--line)' }}>
                        {draft.members.map((m, i) => (
                          <MemberRow
                            key={`${m.name}-${i}`}
                            member={m}
                            index={i}
                            types={roles}
                            editing={memberAt === i}
                            onEdit={() => setMemberAt(memberAt === i ? null : i)}
                          />
                        ))}
                      </div>
                    </div>

                    {memberAt !== null && draft.members[memberAt] ? (
                      <MemberEditor
                        member={draft.members[memberAt]}
                        types={roles}
                        onChange={(next) => patchMember(memberAt, next)}
                        onRemove={() => removeMember(memberAt)}
                        onClose={() => setMemberAt(null)}
                      />
                    ) : null}

                    <div className="card-body" style={{ paddingTop: 14 }}>
                      <div className="form-row">
                        <div className="lbl">编队形状</div>
                        <div>
                          <span className="seg">
                            {FORMATIONS.map((f) => (
                              <button
                                key={f.id}
                                className={(draft.formation ?? 'star') === f.id ? 'is-on' : ''}
                                onClick={() => setDraft({ ...draft, formation: f.id })}
                              >
                                {f.label}
                              </button>
                            ))}
                          </span>
                          <div className="hint">
                            {FORMATIONS.find((f) => f.id === (draft.formation ?? 'star'))?.hint}；形状决定权限交集链与审批穿透路径。
                          </div>
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="lbl">并发闸门</div>
                        <div>
                          <input
                            className="inp w-sm"
                            type="number"
                            min={0}
                            value={draft.maxConcurrent ?? 0}
                            onChange={(e) => setDraft({ ...draft, maxConcurrent: Number(e.target.value) || 0 })}
                          />
                          <div className="hint">同时最多这么多个成员 running，其余 parked 排队（gate 只数 running）；0 = 不限。</div>
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="lbl">团队预算</div>
                        <div>
                          <span className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            软线
                            <input
                              className="inp w-sm"
                              type="number"
                              step="0.1"
                              min={0}
                              value={draft.budget?.softUsd ?? 0}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  budget: { ...(draft.budget ?? {}), softUsd: Number(e.target.value) || 0 },
                                })
                              }
                            />
                            硬线
                            <input
                              className="inp w-sm"
                              type="number"
                              step="0.1"
                              min={0}
                              value={draft.budget?.hardUsd ?? 0}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  budget: { ...(draft.budget ?? {}), hardUsd: Number(e.target.value) || 0 },
                                })
                              }
                            />
                          </span>
                          <div className="hint">
                            硬线 {money(draft.budget?.hardUsd)}：与全局、会话三档取更严者。团队预算是会话预算的默认值，会话可下调不可上调。
                          </div>
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="lbl">上下文默认</div>
                        <div>
                          <span className="seg">
                            {FORK_CHOICES.map((f) => (
                              <button
                                key={f.id}
                                className={forkLabelOf(draft) === f.id ? 'is-on' : ''}
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    defaultForkMode: f.id === 'none' ? 'none' : f.id === 'all' ? 'all' : 3,
                                  })
                                }
                              >
                                {f.label}
                              </button>
                            ))}
                          </span>
                          <div className="hint">成员默认 fork；成员自己的覆写优先（原型里 lead 是「all」逃生门）。</div>
                        </div>
                      </div>

                      {teamIssues.length ? (
                        <div className="card err" style={{ marginTop: 12 }} data-smoke="team-issues">
                          <div className="card-body mono">
                            {teamIssues.map((e, i) => (
                              <div key={i}>
                                {e.member ? `[${e.member}] ` : ''}
                                {e.message}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="card-foot">
                      <button className="btn sm danger" onClick={() => void removeTeam()} disabled={busy} data-smoke="team-delete">
                        <Icon name="trash" size={14} />
                        删除团队
                      </button>
                      <span className="spacer" />
                      <button className="btn sm" onClick={() => void openPath('teams')}>
                        打开目录
                      </button>
                      <button className="btn sm primary" onClick={() => void saveDraft()} disabled={busy} data-smoke="team-save">
                        {busy ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="empty">
                    <span className="k">看团队的编队与策略</span>
                    点上面任意一张团队卡，这里显示它的成员、编队形状、并发闸门与预算。
                  </div>
                )}
              </>
            )
          ) : null}

          {/* ── Agent tab（跨团队清单，只读） ── */}
          {tab === 'agents' ? (
            allMembers.length === 0 ? (
              <div className="empty">
                <span className="k">还没有成员</span>
                成员是团队私有的：先建团队，再往队里加 Agent。
              </div>
            ) : (
              <div className="list">
                {allMembers.map(({ team, member, source }) => {
                  const role = roleOf(member.role, roles);
                  return (
                    <div
                      className="list-row"
                      key={`${team}/${member.name}`}
                      data-smoke="agent-row"
                      data-team={team}
                      data-agent={member.name}
                    >
                      <span className={`ava${member.lead ? ' lead' : ''}`}>{member.name.slice(0, 1)}</span>
                      <span className="grow">
                        <span className="t1">
                          {member.name}
                          <span className="tag">{team}</span>
                          <span className="tag">类型 {member.role}</span>
                          {member.lead ? <span className="tag info">lead</span> : null}
                          {source === 'builtin' ? <span className="tag">内置团队</span> : null}
                        </span>
                        <span className="t2">{member.description ?? role?.description ?? '（没有描述）'}</span>
                      </span>
                      <span className="tag">{role ? `${role.tools?.length ?? 0} 工具` : '类型缺失'}</span>
                      <span className="tag">fork: {formatForkMode(parseForkMode(member.overrides?.forkMode))}</span>
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          {/* ── Agent 类型 tab ── */}
          {tab === 'types' ? (
            <>
              {roles.entries.length === 0 ? (
                <div className="empty">
                  <span className="k">还没有 Agent 类型</span>
                  类型定义在 ~/.axon/roles/&lt;name&gt;.json（内置类型始终可见）。
                </div>
              ) : (
                <div className="list">
                  {roles.entries.map((r) => (
                    <button
                      key={r.role.name}
                      className={`list-row${typeEditing === r.role.name ? ' is-active' : ''}`}
                      data-smoke="type-row"
                      data-role={r.role.name}
                      onClick={() => {
                        setTypeEditing(r.role.name);
                        setTypeNew(false);
                      }}
                    >
                      <Icon name="spark" size={16} />
                      <span className="grow">
                        <span className="t1">
                          {r.role.name}
                          <span className={`tag ${r.overridesBuiltin ? 'info' : ''}`}>
                            {r.overridesBuiltin ? '覆盖内置' : r.source === 'builtin' ? '内置' : '用户'}
                          </span>
                          {r.errors.length ? <span className="tag err">{r.errors.length} 处校验问题</span> : null}
                        </span>
                        <span className="t2">
                          {r.role.description || '（没有描述）'} · 被{' '}
                          {teams.entries.filter((t) => t.team.members.some((m) => m.role === r.role.name)).length} 个团队引用
                        </span>
                      </span>
                      <span className="tag">{r.role.tools?.length ?? 0} 工具</span>
                      <span className="tag">{r.role.approval}</span>
                      <span className="tag">fork: {formatForkMode(parseForkMode(r.role.defaultForkMode))}</span>
                    </button>
                  ))}
                </div>
              )}

              {typeNew || typeEditing ? (
                <TypeEditor
                  key={typeEditing ?? 'new'}
                  {...(typeEditing
                    ? { seed: roles.entries.find((e) => e.role.name === typeEditing)?.role, editing: typeEditing }
                    : {})}
                  onClose={() => {
                    setTypeNew(false);
                    setTypeEditing(null);
                  }}
                  onSave={saveRole}
                  onDelete={
                    typeEditing && roles.entries.find((e) => e.role.name === typeEditing)?.source === 'user'
                      ? () => {
                          void deleteRole(typeEditing).then((ok) => {
                            if (ok) setTypeEditing(null);
                          });
                        }
                      : undefined
                  }
                />
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">
            <span>三层关系</span>
          </div>
          <div className="prow sub">
            <span className="tag">类型</span>
            <span>Agent 类型</span>
            <span className="val">能力模板</span>
          </div>
          <div className="prow sub">
            <span className="tag">成员</span>
            <span>Agent</span>
            <span className="val">类型 + 覆写 + 名字</span>
          </div>
          <div className="prow sub">
            <span className="tag">编队</span>
            <span>Team</span>
            <span className="val">Agent 组合 + 策略</span>
          </div>
          <div className="prow sub">
            <span className="tag">实例</span>
            <span>分身</span>
            <span className="val">会话里跑起来的成员</span>
          </div>
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            合成顺序不变：类型 → 权限（父 ∩ 子）→ 上下文（ForkMode）。团队只是在最外面加了一层「谁和谁一起上、树长什么形状」。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>用这些团队的会话</span>
          </div>
          {current?.record.teamId ? (
            <div className="prow sub">
              <span className={`sdot ${current.status === 'running' ? 'run' : 'done'}`} />
              <span>{current.record.title}</span>
              <span className="val">{current.counts.members} 分身</span>
            </div>
          ) : (
            <div className="hint" style={{ padding: '4px 10px 8px' }}>
              当前会话没有引用团队（单兵）。左栏点进一个团队会话后这里会显示它。
            </div>
          )}
          <div className="hint" style={{ padding: '2px 10px 8px' }}>
            改团队不影响已开的会话（合成发生在 session.create 时）。
          </div>
        </div>
      </aside>
    </div>
  );
}
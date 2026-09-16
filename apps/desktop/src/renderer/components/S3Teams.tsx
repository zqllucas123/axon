/**
 * S3 团队管理 —— 三 tab（团队 / Agent / Agent 类型）。
 *
 * 切片 8 会把团队详情（成员列表 + 编队策略 + 团队预算）与类型编辑器填满；
 * 本切片先立 tab 骨架 + 真实数据的卡片列表。
 * 拍板（MU-2 §十一-4）：「Agent」tab = 跨团队类型清单（只读）。
 */

import { useState, type ReactElement } from 'react';
import { useApp } from '../state/store.ts';
import { Icon } from '../icons.tsx';
import type { TeamDefinition } from '@axon/protocol';

type Tab = 'teams' | 'agents' | 'types';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'teams', label: '团队' },
  { id: 'agents', label: 'Agent' },
  { id: 'types', label: 'Agent 类型' },
];

export function S3Teams(): ReactElement {
  const { teams, roles, saveTeam } = useApp();
  const [tab, setTab] = useState<Tab>('teams');
  const [busy, setBusy] = useState(false);

  /** 新建空白团队：起个不撞名的名字再走 team.save（切片 8 会开完整编辑器）。 */
  const newTeam = async () => {
    const used = new Set(teams.entries.map((t) => t.team.name));
    let name = '新团队';
    let i = 2;
    while (used.has(name)) name = `新团队 ${i++}`;
    setBusy(true);
    const draft: TeamDefinition = {
      name,
      description: '',
      members: [{ name: '主控', role: 'engine', lead: true }],
    };
    const res = await saveTeam(draft);
    setBusy(false);
    if (!res.accepted && res.errors.length) {
      window.alert(res.errors.map((e) => e.message).join('\n'));
    }
  };

  const agents = roles.entries.flatMap((r) =>
    r.role.name === 'engine' ? [] : [{ name: r.role.name, tools: r.role.tools?.length ?? 0, approval: r.role.approval, source: r.source }],
  );

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>团队管理</h1>
        <p>团队是模板（编队 + 策略 + 预算），会话是实例。改团队不影响已开的会话。</p>
      </div>

      <div className="toolbar">
        <span className="seg">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'is-on' : ''} data-smoke={`tab-${t.id}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {tab === 'teams' ? (
          <button className="btn sm primary" onClick={() => void newTeam()} disabled={busy} data-smoke="new-team">
            <Icon name="plus" size={14} />
            新建团队
          </button>
        ) : null}
      </div>

      {tab === 'teams' ? (
        teams.entries.length === 0 ? (
          <div className="empty">
            <span className="k">还没有团队档</span>
            团队档是 JSON（`~/.axon/teams/&lt;name&gt;.json`）—— 用「新建团队」起步。
          </div>
        ) : (
          <div className="grid3">
            {teams.entries.map((t) => (
              <span key={t.team.name} className="team-card" data-smoke="team-card" data-team={t.team.name}>
                <span className="tc-head">
                  <Icon name="users" size={16} />
                  <span className="tc-name">{t.team.name}</span>
                  <span className="spacer" />
                  <span className="tag">{t.source === 'builtin' ? '内置' : '用户'}</span>
                </span>
                <span className="tc-desc">{t.team.description ?? '（没有描述）'}</span>
                <span className="tc-foot">
                  {t.team.members.length} 成员
                  {t.team.maxConcurrent ? ` · 并发 ${t.team.maxConcurrent}` : ''}
                  {t.team.budget?.hardUsd ? ` · 预算 $${t.team.budget.hardUsd}` : ''}
                </span>
                {t.errors.length ? <span className="tag err">{t.errors.length} 处校验问题</span> : null}
              </span>
            ))}
          </div>
        )
      ) : null}

      {tab === 'agents' ? (
        agents.length === 0 ? (
          <div className="empty">（没有可用的 Agent 类型）</div>
        ) : (
          <div className="list">
            {agents.map((a) => (
              <span key={a.name} className="list-row" data-smoke="agent-type-row" data-agent={a.name}>
                <Icon name="spark" size={16} />
                <span className="grow">
                  <span className="t1">
                    {a.name}
                    <span className="tag">{a.source === 'builtin' ? '内置' : '用户'}</span>
                  </span>
                  <span className="t2">
                    {a.tools} 工具（角色白名单） · 审批 {a.approval} · 被{' '}
                    {teams.entries.filter((t) => t.team.members.some((m) => m.role === a.name)).length} 个团队引用
                  </span>
                </span>
              </span>
            ))}
          </div>
        )
      ) : null}

      {tab === 'types' ? (
        roles.entries.length === 0 ? (
          <div className="empty">
            <span className="k">还没有 Agent 类型</span>
            类型定义在 `~/.axon/roles/&lt;name&gt;.json`（内置类型始终可见）。
          </div>
        ) : (
          <div className="list">
            {roles.entries.map((r) => (
              <span key={r.role.name} className="list-row" data-smoke="role-row" data-role={r.role.name}>
                <Icon name="spark" size={16} />
                <span className="grow">
                  <span className="t1">
                    {r.role.name}
                    <span className={`tag ${r.overridesBuiltin ? 'info' : ''}`}>
                      {r.overridesBuiltin ? '覆盖内置' : r.source === 'builtin' ? '内置' : '用户'}
                    </span>
                  </span>
                  <span className="t2">
                    {r.role.tools?.length ?? 0} 工具（角色白名单） · 审批 {r.role.approval}
                    {r.errors.length ? ` · ${r.errors.length} 处校验问题` : ''}
                  </span>
                </span>
              </span>
            ))}
          </div>
        )
      ) : null}

      <div className="hint" style={{ marginTop: 18 }}>
        类型编辑与团队成员编辑在切片 8 落地（复用旧 RoleEditor 能力，样式重做）。
      </div>
    </div>
  );
}

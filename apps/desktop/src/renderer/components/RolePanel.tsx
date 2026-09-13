/**
 * 角色面板 —— 分组渲染 + 加载健康度红条 + 编辑入口。
 * 只发意图（spawn/create/edit/delete/openDir），状态全由 props 进来。
 */

import type { RoleEntry, RoleIssue } from '@axon/protocol';
import { formatForkMode, parseForkMode } from '@axon/protocol';

export interface RolePanelProps {
  roles: RoleEntry[];
  issues: RoleIssue[];
  onSpawn: (entry: RoleEntry) => void;
  onCreate: () => void;
  onEdit: (entry: RoleEntry) => void;
  onDelete: (name: string) => void;
  onOpenDir: () => void;
}

export function RolePanel({
  roles,
  issues,
  onSpawn,
  onCreate,
  onEdit,
  onDelete,
  onOpenDir,
}: RolePanelProps) {
  const builtin = roles.filter((r) => r.source === 'builtin');
  const user = roles.filter((r) => r.source === 'user');

  return (
    <>
      <div className="panel-head">
        <span>角色</span>
        <span className="panel-actions">
          <button className="mini" onClick={onCreate} title="新建角色">
            ＋
          </button>
          <button className="mini" onClick={onOpenDir} title="打开角色目录">
            📂
          </button>
        </span>
      </div>
      <div className="roles">
        {issues.length > 0 && (
          <div className="issues">
            {issues.map((issue, i) => (
              <div key={i} className="issue">
                {issue.file && <b>{issue.file}</b>} {issue.message}
              </div>
            ))}
          </div>
        )}
        <RoleGroup label="自定义" entries={user} {...{ onSpawn, onEdit, onDelete }} />
        <RoleGroup label="内置" entries={builtin} {...{ onSpawn, onEdit, onDelete }} />
        {roles.length === 0 && <div className="dim">暂无角色</div>}
      </div>
    </>
  );
}

function RoleGroup({
  label,
  entries,
  onSpawn,
  onEdit,
  onDelete,
}: {
  label: string;
  entries: RoleEntry[];
  onSpawn: (entry: RoleEntry) => void;
  onEdit: (entry: RoleEntry) => void;
  onDelete: (name: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <div className="group-label">{label}</div>
      {entries.map((entry) => (
        <RoleCard
          key={entry.role.name}
          entry={entry}
          onSpawn={onSpawn}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function RoleCard({
  entry,
  onSpawn,
  onEdit,
  onDelete,
}: {
  entry: RoleEntry;
  onSpawn: (entry: RoleEntry) => void;
  onEdit: (entry: RoleEntry) => void;
  onDelete: (name: string) => void;
}) {
  const role = entry.role;
  // spec → ForkMode → 展示串；undefined 精致地落到默认 none。
  const mode = formatForkMode(parseForkMode(role.defaultForkMode));
  return (
    <div className="role" onClick={() => onSpawn(entry)}>
      <div className="meta">
        <div className="name">
          {role.displayName}
          {entry.overridesBuiltin && <span className="badge-override">覆盖</span>}
        </div>
        <div className="desc">{role.description}</div>
      </div>
      <span className="fork" data-mode={mode}>
        {mode}
      </span>
      {entry.source === 'user' && (
        <span
          className="role-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="mini"
            title="编辑"
            onClick={() => onEdit(entry)}
          >
            ✎
          </button>
          <button
            className="mini"
            title="删除"
            onClick={() => onDelete(role.name)}
          >
            ✕
          </button>
        </span>
      )}
      {entry.source === 'builtin' && entry.overridesBuiltin === undefined && (
        <span
          className="role-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="mini"
            title="用自定义角色覆盖内置"
            onClick={() => onEdit(entry)}
          >
            ⚙
          </button>
        </span>
      )}
    </div>
  );
}
/**
 * 角色编辑器 —— 新建 / 编辑模态。
 *
 * 校验权威在主进程：这里先按表单约束粗过滤，保存时 main 会用
 * validateRole 全量校验一遍，errors 原样回显。JSON 预览让用户
 * 看到最终落盘形态。
 */

import { useMemo, useState } from 'react';
import type { ApprovalMode, ForkModeSpec, RoleDefinition, RoleIssue } from '@axon/protocol';

export interface RoleEditorProps {
  /** 编辑既有角色时提供种子；新建时为 undefined。 */
  seed?: Partial<RoleDefinition>;
  /** 正在编辑的角色名（新建为 undefined，name 字段可改）。 */
  editing?: string;
  onClose: () => void;
  onSave: (role: RoleDefinition) => Promise<readonly RoleIssue[]>;
}

const APPROVALS: ApprovalMode[] = ['always_ask', 'auto', 'full_access'];
const FORK_MODES = ['none', 'lastRounds', 'all'] as const;

export function RoleEditor({ seed, editing, onClose, onSave }: RoleEditorProps) {
  const [name, setName] = useState(seed?.name ?? '');
  const [displayName, setDisplayName] = useState(seed?.displayName ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [instructions, setInstructions] = useState(seed?.instructions ?? '');
  const [tools, setTools] = useState((seed?.tools ?? []).join(', '));
  const [approval, setApproval] = useState<ApprovalMode>(seed?.approval ?? 'always_ask');
  const [forkMode, setForkMode] = useState<string>(() => {
    const spec = seed?.defaultForkMode;
    if (spec === 'all') return 'all';
    if (typeof spec === 'number' || /^\d+$/.test(String(spec ?? ''))) {
      return `lastRounds:${spec}`;
    }
    return 'none';
  });
  const [errors, setErrors] = useState<RoleIssue[]>([]);
  const [saving, setSaving] = useState(false);

  const role: RoleDefinition = useMemo(() => {
    const forkSpec: ForkModeSpec = (() => {
      if (forkMode === 'all') return 'all';
      if (forkMode === 'none') return 'none';
      const n = forkMode.split(':')[1];
      return n && /^\d+$/.test(n) ? Number(n) : 'none';
    })();
    return {
      name,
      displayName,
      description,
      instructions,
      tools: tools.split(',').map((t) => t.trim()).filter(Boolean),
      approval,
      defaultForkMode: forkSpec,
    };
  }, [name, displayName, description, instructions, tools, approval, forkMode]);

  const submit = async () => {
    setSaving(true);
    const issues = await onSave(role);
    setSaving(false);
    setErrors([...issues]);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{editing ? `编辑角色 ${editing}` : '新建角色'}</span>
          <button className="mini" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label>
            角色名（路径组成部分，小写字母开头）
            <input
              value={name}
              disabled={editing !== undefined}
              placeholder="devops"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            显示名
            <input
              value={displayName}
              placeholder="运维分身"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            描述
            <input
              value={description}
              placeholder="部署、日志、环境诊断"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            指令（systemPrompt）
            <textarea
              rows={6}
              value={instructions}
              placeholder="你是……"
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <label>
            工具白名单（逗号分隔；只减不加）
            <input
              value={tools}
              placeholder="read, grep, bash"
              onChange={(e) => setTools(e.target.value)}
            />
          </label>
          <div className="form-row">
            <label>
              审批档
              <select value={approval} onChange={(e) => setApproval(e.target.value as ApprovalMode)}>
                {APPROVALS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              上下文分身模式
              <select value={forkMode} onChange={(e) => setForkMode(e.target.value)}>
                {FORK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            {forkMode.startsWith('lastRounds:') && (
              <label>
                保留轮数
                <input
                  className="narrow"
                  defaultValue={forkMode.split(':')[1] ?? '1'}
                  onChange={(e) =>
                    /^\d+$/.test(e.target.value) && setForkMode(`lastRounds:${e.target.value}`)
                  }
                />
              </label>
            )}
          </div>
          {errors.length > 0 && (
            <div className="issues">
              {errors.map((issue, i) => (
                <div key={i} className="issue">
                  {issue.message}
                </div>
              ))}
            </div>
          )}
          <details>
            <summary>落盘 JSON 预览</summary>
            <pre>{JSON.stringify({ version: 1, role }, null, 2)}</pre>
          </details>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={saving} onClick={() => void submit()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
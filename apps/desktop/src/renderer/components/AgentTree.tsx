/**
 * Agent 树 —— 纯展示：递归渲染快照，选中态由 props 控制。
 */

import type { ReactNode } from 'react';
import type { AgentPath, AgentSnapshot } from '@axon/protocol';

export interface AgentTreeProps {
  agents: AgentSnapshot[];
  /** 要渲染的树根（MU-1：会话根 `/<sessionId>`，不再是全局 `/root`）。 */
  rootPath: AgentPath;
  selected: AgentPath;
  onSelect: (path: AgentPath) => void;
}

export function AgentTree({ agents, rootPath, selected, onSelect }: AgentTreeProps) {
  const byPath = new Map(agents.map((s) => [s.path, s]));

  const renderNode = (path: AgentPath, depth: number): ReactNode => {
    const snap = byPath.get(path);
    if (!snap) return null;
    return (
      <div key={path}>
        <div
          className={`node${path === selected ? ' sel' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onSelect(path)}
          title={`${snap.path} · ${snap.status} · ${snap.usage.inputTokens}/${snap.usage.outputTokens} tok`}
        >
          <span className="dot" data-s={snap.status} />
          <span className="lbl">{snap.displayName}</span>
        </div>
        {snap.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="panel-head">
        <span>Agent 树</span>
      </div>
      <div className="tree">
        {renderNode(rootPath, 0) ?? <div className="hint">（本会话还没有成员）</div>}
      </div>
    </>
  );
}
/**
 * 会话输入区的模型选择器（composer 发送按钮左边）。
 *
 * 只对**当前配置了 provider 且有模型清单**的会话生效——faux / 未配置时
 * 直接不渲染（`.composer .mode` 已经在显示焦点分身，不需要再叠一个假控件）。
 *
 * 选中即调用 `agent.setModel`：只换**当前焦点 Agent** 活引擎的
 * `model` / `thinkingLevel`（pi 语义：下一轮起生效），不改配置、不重建引擎。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import type { AxonThinkingLevel } from '@axon/protocol';

const THINKING_LEVELS: Array<{ id: AxonThinkingLevel; label: string }> = [
  { id: 'off', label: '关' },
  { id: 'minimal', label: '极简' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
];

export function ModelPicker({ focusPath }: { focusPath: string }): ReactElement | null {
  const { config, agents, setModel } = useApp();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const provider = config?.config.provider;
  const models = provider?.models ?? [];
  // faux / 未配置 provider：没有模型可选，不渲染假控件。
  if (models.length === 0) return null;

  const providerName = provider?.name ?? provider?.id ?? 'Provider';
  const focus = agents[focusPath];
  const currentModel = focus?.model ?? config?.resolution.effectiveModel ?? provider?.defaultModel ?? models[0]?.id;
  const currentLevel: AxonThinkingLevel = focus?.thinkingLevel ?? 'off';
  const currentLabel = models.find((m) => m.id === currentModel)?.name ?? currentModel ?? '选择模型';

  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className={`model-pick ${open ? 'is-on' : ''}`}
        data-smoke="model-picker"
        aria-expanded={open}
        title="切换本会话使用的模型"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="spark" size={14} />
        <span>{currentLabel}</span>
        <Icon name="chevD" size={14} cls="caret" />
      </button>

      {open ? (
        <div className="menu model-menu" onClick={(e) => e.stopPropagation()}>
          <div className="model-menu-group">{providerName}</div>
          {models.map((m) => (
            <button
              key={m.id}
              className="menu-item"
              data-smoke="model-option"
              onClick={() => {
                void setModel(focusPath, m.id);
                setOpen(false);
              }}
            >
              <span>{m.name ?? m.id}</span>
              {m.id === currentModel ? <Icon name="check" size={14} cls="mk" /> : null}
            </button>
          ))}

          <div className="menu-sep" />
          <div className="model-menu-group">推理深度</div>
          <div className="model-think-row">
            {THINKING_LEVELS.map((lv) => (
              <button
                key={lv.id}
                className={`model-think-btn ${lv.id === currentLevel ? 'is-on' : ''}`}
                data-smoke={`thinking-${lv.id}`}
                onClick={() => void setModel(focusPath, undefined, lv.id)}
              >
                {lv.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}

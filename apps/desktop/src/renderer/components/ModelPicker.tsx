/**
 * 模型选择器 —— 两个用法共用一套清单与下拉外观：
 *
 * - {@link ModelPicker}：**会话内**（composer 发送按钮左边）。选中即 `agent.setModel`，
 *   只换当前焦点 Agent 活引擎的 `model` / `thinkingLevel`（pi 语义：下一轮起生效），
 *   不改配置、不重建引擎。
 * - {@link ModelSelect}：**建会话前**（S0 工具栏）。没有活引擎可改，选中只落到本地
 *   状态，随 `session.create` 的 `modelRef` 下发，成为会话级默认。
 *
 * 寻址一律用复合键 `providerId:modelId`（`formatModelRef`）：两个网关挂同名模型是
 * 常态，裸 id 寻不到址。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import { formatModelRef, parseModelRef, type AxonThinkingLevel } from '@axon/protocol';

const THINKING_LEVELS: Array<{ id: AxonThinkingLevel; label: string }> = [
  { id: 'off', label: '关' },
  { id: 'minimal', label: '极简' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
];

interface ModelOption {
  ref: string;
  modelId: string;
  label: string;
  providerId: string;
  providerName: string;
}

/**
 * 把 `providers[]` 摊平成一张可选清单（按 provider 原序，provider 内按模型原序）。
 *
 * 只收**配了 baseUrl 且有模型**的 provider：半配的 provider 选了也跑不起来，
 * 摆在菜单里就是假选项（与「faux 不渲染假控件」同一条纪律）。
 */
function useModelOptions(): ModelOption[] {
  const { config } = useApp();
  const providers = config?.config.providers;
  return useMemo(() => {
    const out: ModelOption[] = [];
    for (const p of providers ?? []) {
      if (!p.baseUrl) continue;
      const providerName = p.name ?? p.id;
      for (const m of p.models ?? []) {
        out.push({
          ref: formatModelRef(p.id, m.id),
          modelId: m.id,
          label: m.name ?? m.id,
          providerId: p.id,
          providerName,
        });
      }
    }
    return out;
  }, [providers]);
}

/** 点外面/Esc 关菜单 —— 两个选择器同一套行为。 */
function useDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
}

/**
 * 当前选中项：先按复合键精确命中，命不中再退回裸 modelId 匹配。
 *
 * 为什么要退这一步：角色声明的 `model` 与旧会话快照里存的可能是裸 id
 * （多 provider 之前的写法），精确匹配会一个都命不中，菜单上就没有勾。
 */
function findOption(options: ModelOption[], current?: string): ModelOption | undefined {
  if (!current) return undefined;
  const hit = options.find((o) => o.ref === current);
  if (hit) return hit;
  const { modelId } = parseModelRef(current);
  return options.find((o) => o.modelId === modelId);
}

/** 菜单主体：按 provider 分组列模型，选中项打勾。 */
function ModelList({
  options,
  currentRef,
  onPick,
}: {
  options: ModelOption[];
  currentRef?: string;
  onPick: (ref: string) => void;
}): ReactElement[] {
  const rows: ReactElement[] = [];
  let lastProvider: string | undefined;
  for (const o of options) {
    if (o.providerId !== lastProvider) {
      lastProvider = o.providerId;
      rows.push(
        <div className="model-menu-group" key={`g-${o.providerId}`}>
          {o.providerName}
        </div>,
      );
    }
    rows.push(
      <button
        key={o.ref}
        className="menu-item"
        data-smoke="model-option"
        data-model-ref={o.ref}
        onClick={() => onPick(o.ref)}
      >
        <span>{o.label}</span>
        {o.ref === currentRef ? <Icon name="check" size={14} cls="mk" /> : null}
      </button>,
    );
  }
  return rows;
}

export function ModelPicker({ focusPath }: { focusPath: string }): ReactElement | null {
  const { config, agents, setModel } = useApp();
  const [open, setOpen] = useState(false);
  const options = useModelOptions();
  useDismiss(open, () => setOpen(false));

  // 没有任何可用模型（faux / 未配置 provider）：不渲染假控件。
  if (options.length === 0) return null;

  const focus = agents[focusPath];
  const current = findOption(options, focus?.model ?? config?.resolution.effectiveModelRef) ?? options[0];
  const currentLevel: AxonThinkingLevel = focus?.thinkingLevel ?? 'off';

  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className={`model-pick ${open ? 'is-on' : ''}`}
        data-smoke="model-picker"
        aria-expanded={open}
        title={`切换本会话使用的模型（当前：${current?.providerName} · ${current?.label}）`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="spark" size={14} />
        <span>{current?.label ?? '选择模型'}</span>
        <Icon name="chevD" size={14} cls="caret" />
      </button>

      {open ? (
        <div className="menu model-menu" onClick={(e) => e.stopPropagation()}>
          <ModelList
            options={options}
            currentRef={current?.ref}
            onPick={(ref) => {
              void setModel(focusPath, ref);
              setOpen(false);
            }}
          />

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

/**
 * 建会话前选模型（S0）。
 *
 * `value === undefined` = 跟全局默认：菜单里额外给一项「跟随默认」让用户退回去，
 * 否则选过一次就再也回不到「不指定」的状态。
 */
export function ModelSelect({
  value,
  onChange,
}: {
  value?: string;
  onChange: (ref?: string) => void;
}): ReactElement | null {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const options = useModelOptions();
  useDismiss(open, () => setOpen(false));

  if (options.length === 0) return null;

  const picked = findOption(options, value);
  // 没显式选时按钮上显示全局默认那个 —— 显示「默认模型」四个字等于什么都没说，
  // 用户想知道的是「不选的话会用哪个」。
  const fallback = findOption(options, config?.resolution.effectiveModelRef);
  const shown = picked ?? fallback;

  return (
    // 触发器与 S2 的 ModelPicker 逐类对齐（model-pick + 图标 + 模型名 + caret）：
    // 同一个控件在两屏长得不一样，用户会以为是两个东西。
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className={`model-pick ${open ? 'is-on' : ''}`}
        data-smoke="s0-model-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        title={`本会话模型：${shown?.providerName ?? ''} · ${shown?.label ?? '默认'}${picked ? '' : '（跟随默认）'}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="spark" size={14} />
        <span>{shown?.label ?? '选择模型'}</span>
        <Icon name="chevD" size={14} cls="caret" />
      </button>

      {open ? (
        <div className="menu model-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            className="menu-item"
            data-smoke="s0-model-default"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span>跟随默认</span>
            {picked ? (
              <span className="mk">{fallback?.label ?? '全局默认'}</span>
            ) : (
              <Icon name="check" size={14} cls="mk" />
            )}
          </button>
          <div className="menu-sep" />
          <ModelList
            options={options}
            currentRef={picked?.ref}
            onPick={(ref) => {
              onChange(ref);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </span>
  );
}

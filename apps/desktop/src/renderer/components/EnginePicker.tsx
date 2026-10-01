/**
 * 输入区工具栏的「执行引擎」popover（逐项对齐 docs/new_ux/01-home.html 的 engine-popover）。
 *
 * 列的是**全部已知** Agent 工具，逐项写明状态（主进程启动时探测一次并缓存，
 * 见 main/agent-tools.ts）。只列已装的、统一标一个「尚未接入」试过了：用户会把它
 * 读成「没检测到」—— 状态必须按工具写明（tutti 的 Manage Agents 也是全量列）。
 *
 * 哪一行能选由主进程给的 `runnable` 决定（已安装且 Axon 已接入它的运行时，M9 起是
 * Claude Code）；其余行置灰并写明原因 —— 标出位置的存在，但不撒谎。
 *
 * 两种用法：
 *   - S0 新建会话：受控可选（`onChange`），选中的引擎随 `session.create` 的 `engineId` 下发；
 *   - S2 会话中：只读（不传 `onChange`）。引擎在建会话时定死、会话中不能换 ——
 *     换引擎等于换一个上下文不相通的对话，与 tutti 同一个结论。
 *
 * 状态全在调用方与 store（`agentTools` 快照 + `redetectAgentTools` 意图），这里只渲染 + 发意图。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';

interface Props {
  /** 当前引擎 id；null = Axon 内置引擎。 */
  value: string | null;
  /** 选择回调；不传 = 只读（会话中）。 */
  onChange?: (engineId: string | null) => void;
}

export function EnginePicker({ value, onChange }: Props): ReactElement {
  const { agentTools, redetectAgentTools } = useApp();
  const [open, setOpen] = useState(false);
  const readOnly = !onChange;

  // 点 popover 外面收起（mousedown 而非 click 的理由同 S0 的模式 popover）。
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.engine-picker')) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 快照还没拉到（null）与主进程正在探测，对用户是同一件事：「还在查」。
  const detecting = agentTools?.status !== 'ready';
  const tools = agentTools?.tools ?? [];
  const current = value ? tools.find((t) => t.id === value) : undefined;
  // 探测结果还没到时，会话记录里的 id 是唯一能显示的东西。
  const currentLabel = value ? (current?.label ?? value) : 'Axon';

  const pick = (id: string | null) => {
    onChange?.(id);
    setOpen(false);
  };

  return (
    <div className="s0-mode engine-picker">
      <button
        className={`tool-btn${open || value ? ' is-on' : ''}${value ? ' has-label' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-smoke="engine-trigger"
        data-engine={value ?? 'axon'}
        title={`执行引擎：${currentLabel}`}
      >
        <Icon name="spark" size={16} />
        {/* 选了外部引擎就把名字亮出来：这是会改变「谁在干活」的选择，不能只藏在 tooltip 里。 */}
        {value ? <span className="tool-label">{currentLabel}</span> : null}
      </button>
      {open ? (
        <div className="menu s0-mode-menu" role="menu" data-smoke="engine-popover">
          <div className="s0-menu-title">{readOnly ? '执行引擎' : '选择执行引擎'}</div>
          <button
            className="menu-item"
            role="menuitemradio"
            aria-checked={value === null}
            disabled={readOnly && value !== null}
            data-smoke="engine-axon"
            onClick={() => pick(null)}
          >
            <span className="engine-mark">A</span>
            <span>Axon</span>
            <span className="mk">{value === null ? '✓ 已选' : '内置'}</span>
          </button>

          {tools.map((t) => {
            const selected = value === t.id;
            const selectable = !readOnly && t.runnable;
            return (
              <button
                key={t.id}
                className="menu-item"
                role="menuitemradio"
                aria-checked={selected}
                disabled={!selectable}
                data-smoke={`engine-${t.id}`}
                data-installed={t.installed}
                onClick={() => pick(t.id)}
                title={
                  !t.installed
                    ? `本机未找到 ${t.label}；安装后点「重新检测」`
                    : t.runnable
                      ? `${t.path}`
                      : `已安装：${t.path}\nAxon 暂不支持用它执行会话`
                }
              >
                <span className="engine-mark">{t.label[0]}</span>
                <span>{t.label}</span>
                {t.version ? <span className="engine-ver">{t.version}</span> : null}
                <span className={`mk${selected || t.runnable ? ' engine-ok' : ''}`}>
                  {selected ? '✓ 已选' : !t.installed ? '未安装' : t.runnable ? '已安装' : '已安装 · 暂不支持'}
                </span>
              </button>
            );
          })}
          {tools.length === 0 && detecting ? (
            <div className="engine-note">正在检测本机的 Agent 工具…</div>
          ) : null}
          {readOnly ? (
            <div className="engine-note">引擎在新建会话时选定，会话中不能切换。</div>
          ) : null}

          <div className="menu-sep" />
          <button
            className="menu-item"
            disabled={detecting}
            onClick={() => void redetectAgentTools()}
            data-smoke="engine-redetect"
            title="装了新的 Agent 工具后，点这里重新检测"
          >
            <span>重新检测</span>
            <span className="mk">{detecting ? '检测中…' : '装了新工具？'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

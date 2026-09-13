/**
 * 输入条 —— 发消息 / 中断 / 删除选中子树。
 * disabled（预算冻结）时输入与发送被禁；中断仍可用——用户可以停掉在跑的任务。
 */

import { useState } from 'react';

export interface ComposerProps {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function Composer({
  onSend,
  onInterrupt,
  onRemove,
  canRemove,
  disabled = false,
  disabledReason,
}: ComposerProps) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText('');
    onSend(t);
  };

  return (
    <footer>
      <input
        value={text}
        disabled={disabled}
        placeholder={disabled ? disabledReason : '给选中的 Agent 发消息…'}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button onClick={submit} disabled={disabled}>发送</button>
      <button onClick={onInterrupt}>中断</button>
      {canRemove && (
        <button
          className="danger"
          onClick={() => {
            if (window.confirm('删除选中的 Agent 及其整棵子树？运行将被中断。')) {
              onRemove();
            }
          }}
        >
          删除
        </button>
      )}
    </footer>
  );
}
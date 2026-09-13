/**
 * 输入条 —— 发消息 / 中断 / 删除选中子树。
 */

import { useState } from 'react';

export interface ComposerProps {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onRemove: () => void;
  canRemove: boolean;
}

export function Composer({ onSend, onInterrupt, onRemove, canRemove }: ComposerProps) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    onSend(t);
  };

  return (
    <footer>
      <input
        value={text}
        placeholder="给选中的 Agent 发消息…"
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button onClick={submit}>发送</button>
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
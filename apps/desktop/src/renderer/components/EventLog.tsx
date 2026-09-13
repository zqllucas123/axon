/**
 * 事件流 —— 纯展示 + 贴底自动滚动（用户上翻时不打扰）。
 */

import { useEffect, useRef } from 'react';

export interface LogLine {
  at: string;
  text: string;
  cls?: 't' | 'e' | 'k';
}

export function EventLog({ lines }: { lines: LogLine[] }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // 只在已贴底时自动滚动；用户往回翻时不被拽回来。
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="log" ref={elRef}>
      {lines.map((line, i) => (
        <div key={i} className={line.cls ?? ''}>
          <span className="ts">{line.at}</span> {line.text}
        </div>
      ))}
    </div>
  );
}
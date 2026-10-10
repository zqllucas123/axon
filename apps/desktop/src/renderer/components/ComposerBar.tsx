/**
 * 会话输入区外壳（S0 新建会话 / S2 会话中共用）。
 *
 * 为什么要抽：两屏的输入框**长相本该一样**，但每个控件的**行为确实不同**
 * （附件在 S2 没有协议面、引擎在 S2 只读、模式在 S0 是 popover 而 S2 是「叫人」弹层、
 * 模型在 S0 写本地 state 而 S2 立即 `agent.setModel`、发送在 S0 是建会话而 S2 是发 prompt）。
 * 之前两边各写一遍整行 `.row`，结果是「给输入区加一个控件」要改两处 —— 加 M15 的模型
 * 选择器时就漏了一处：S0 把它放在 spacer 之前（挤在左边）、还用了 `tool-btn`（只有图标），
 * 与 S2 的「spacer 之后 + `model-pick` 带模型名」漂移。
 *
 * 所以这里只收口**外壳**：`.composer` 容器 / textarea / `.row` 的三段式布局
 * （left → spacer → right → send）。控件本身仍由两屏各自传入，行为差异留在调用方。
 * 布局顺序写死在这里一处，两屏不可能再排错。
 *
 * textarea 不带 `className="ph"`：`.ph` 是原型里占位 div 的类，它的 `color: var(--text-dim)`
 * 会盖掉 `.composer textarea` 的 `color: var(--text)`（`.composer .ph` 特异性更高），
 * 让**已输入的文字**也是浅灰的。占位色由 `.composer textarea::placeholder` 负责，
 * 见 styles/components.css:1083 那段注释（该规则的值本就是从 `.ph` 搬过来的）。
 * 同理不写内联的 border/background/outline/resize 归零 —— 全在 `.composer textarea` 里。
 */

import type { ReactElement, ReactNode, Ref } from 'react';
import { Icon, type IconName } from '../icons.tsx';

/** 发送按钮：两屏的图标与语义都不同（S0 开始/排队，S2 发送/中断），全由调用方给。 */
interface SendSpec {
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** ui-smoke 钩子；S2 的发送键没有钩子，所以可选。 */
  smoke?: string;
}

interface ComposerBarProps {
  value: string;
  onChange: (next: string) => void;
  /** Enter（不按 Shift）触发；Shift+Enter 换行由本组件拦掉。 */
  onSubmit: () => void;
  placeholder: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  textareaSmoke?: string;
  rows?: number;
  /** 工具栏左段：附件 / 引擎 / 模式一类。 */
  left?: ReactNode;
  /** 工具栏右段：spacer 之后、发送键之前，贴着发送键（模型选择器在这）。 */
  right?: ReactNode;
  send: SendSpec;
}

export function ComposerBar({
  value,
  onChange,
  onSubmit,
  placeholder,
  textareaRef,
  textareaSmoke,
  rows,
  left,
  right,
  send,
}: ComposerBarProps): ReactElement {
  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        data-smoke={textareaSmoke}
        rows={rows}
      />
      <div className="row">
        {left}
        <span className="spacer" />
        {right}
        <button
          className="send"
          onClick={send.onClick}
          disabled={send.disabled}
          title={send.title}
          data-smoke={send.smoke}
        >
          <Icon name={send.icon} size={16} />
        </button>
      </div>
    </div>
  );
}

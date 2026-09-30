/**
 * 窗口 chrome —— 「这个平台要不要自绘标题栏」在渲染层的**唯一**判断点。
 *
 * 为什么收敛到一处：同一个判断有三个消费方 —— main 的窗口选项
 * （`main/window-chrome.ts`）、标题栏组件（`components/Titlebar.tsx`）、
 * 一组主题覆盖（`components.css` 里 `body[data-chrome='custom']` 那几条）。
 * 三处各写一遍 `platform === 'win32'`，以后多一个平台就是三处一起改、且漏一处不报错。
 *
 * 平台来自 `window.axon.platform`（preload 的**同步**字段，不是命令）：这个判断
 * 必须在首帧就有答案 —— 走异步往返会先画出一帧没有标题栏的布局再跳一下。
 */

/** 是否走「自绘标题栏 + 系统窗控叠加层」（当前仅 Windows）。 */
export function isCustomTitlebar(): boolean {
  return window.axon.platform === 'win32';
}

/**
 * 把 chrome 形态落到 `<body data-chrome>` 上，供 CSS 分支。
 *
 * 由 `main.tsx` 在挂载 React 之前调一次 —— 不能等组件的 effect：主题覆盖里有
 * 「侧栏顶部留白」这类首帧就要生效的规则，等一个 effect 会先闪一帧错位。
 * 采用 `body` 的 data-* 而不是 React 状态，理由同 `appearance.ts`：
 * 影响的是几百个既有选择器，走 props/context 是一次全量改造。
 *
 * 非 Windows 平台**不写这个属性**（缺省即原生 chrome），少一个属性少一条规则。
 */
export function applyChromeFlag(): void {
  if (isCustomTitlebar()) document.body.dataset.chrome = 'custom';
}
/**
 * 外观偏好的**应用层** —— 把 `config.ui.*` 真正作用到 DOM 上（MU-3 切片 8，主线）。
 *
 * ── 为什么需要这个文件 ──
 * 切片 1 让 `ui.*` 能存（白名单 + 校验 + 落盘），切片 3 让它能改（S8 外观 pane），
 * 但阶段 1 结束时真窗口探针发现：`document.body.dataset.density === undefined`，
 * 全仓除设置页外**没有任何消费方** —— 四项「能存能读能双窗同步，就是改了不生效」。
 * 那等于三个假控件（MU-3 台账 R-8）。这里补上最后一环。
 *
 * ── 为什么是 body 的 data-* + CSS 变量，而不是 React 状态 ──
 * 密度与字号要影响**几百个既有选择器**（列表行、面板行、会话正文）。走 React
 * 就得给每个组件传 props 或加 context 消费，是一次全量改造；走 CSS 变量则是
 * 「令牌换一组值」，改动集中在 `tokens.css` 一处，且两个窗口共用同一套规则。
 *
 * ── 为什么两个窗口都调它 ──
 * 设置窗自己也是界面：在设置窗里把密度调紧，设置窗自己不跟着紧，用户会以为没生效。
 * 主窗由 `state/store.tsx` 的 `config.changed` 驱动，设置窗由 `settings/SettingsStore.tsx`
 * 驱动，两边调的是同一个函数。
 *
 * ── 三项而不是五项 ──
 *  - `theme`：拍板 P-4 不做暗色，只有 `light` 一个可选值 ⇒ 没有可切换的东西；
 *  - `annotations`：渲染层根本没有标注元素（原型里它是 `shell.js` 的 `⌘/` 调试
 *    工具），做成开关就是假控件 ⇒ 设置页那一行已删，协议字段保留等 G11.13 实现。
 */

import type { UiPreferences } from '@axon/protocol';

/** 会话正文字号的合法区间（与 `CONFIG_FIELD_SPECS` 的 min/max 一致，防越界值污染排版）。 */
const FONT_MIN = 12;
const FONT_MAX = 20;

/**
 * 把偏好写到 `<body>` 上。传 `undefined`（配置还没拉到 / 用户清空了该项）时
 * 移除属性回到缺省 —— 缺省值写在 CSS 里，这里不复制一份默认值。
 */
export function applyAppearance(ui: UiPreferences | undefined): void {
  const body = document.body;

  // 密度：只有 compact 需要标记，comfortable 就是缺省（少一个属性少一条规则）。
  if (ui?.density === 'compact') body.dataset.density = 'compact';
  else delete body.dataset.density;

  // 字号：直接改 CSS 变量而不是加 data-font-size="15" 那样的枚举属性 ——
  // 字号是连续量，枚举化就要为每个值写一条规则，而且以后改区间还得同步改 CSS。
  const fs = ui?.fontSize;
  if (typeof fs === 'number' && fs >= FONT_MIN && fs <= FONT_MAX) {
    body.style.setProperty('--fs-msg', `${fs}px`);
  } else {
    body.style.removeProperty('--fs-msg');
  }

  // 减弱动效：always = 无条件减弱；system = 听 prefers-reduced-motion（规则写在 CSS 的
  // media query 里）。注意 system 也必须落属性 —— 缺省态（既不 always 也不 system）
  // 与「显式选了跟随系统」在 CSS 上是两条不同的规则。
  if (ui?.reduceMotion) body.dataset.reduceMotion = ui.reduceMotion;
  else delete body.dataset.reduceMotion;
}

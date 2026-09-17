/**
 * 线性图标表 —— 逐字来源：docs/ux/mockups/assets/shell.js 的 ICONS。
 * 规格（01 §2）：24 视窗 / 1.6px 描边 / 圆头 / currentColor；尺寸只用 14·16·18·20。
 * 用法：<Icon name="users" size={16} />（渲染成 <span class="i i-16">，与原型同构）
 */

import type { ReactElement } from 'react';

export const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5"/><path d="M10.4 20.5a1.9 1.9 0 0 0 3.2 0"/>',
  folder:
    '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.66.9l.68 1a2 2 0 0 0 1.66.9H19a2 2 0 0 1 2 2v6.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pen: '<path d="M12 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V12"/><path d="M18.1 2.9a1.9 1.9 0 0 1 2.7 2.7L12.3 14l-3.8 1.1L9.6 11.3z"/>',
  users:
    '<path d="M15.5 20.5v-1.7a3.5 3.5 0 0 0-3.5-3.5H6.5A3.5 3.5 0 0 0 3 18.8v1.7"/><circle cx="9.2" cy="7.6" r="3.4"/><path d="M21 20.5v-1.7a3.5 3.5 0 0 0-2.6-3.4"/><path d="M15.6 4.4a3.4 3.4 0 0 1 0 6.6"/>',
  inbox:
    '<path d="M21 12.5h-4.6l-1.6 2.6H9.2l-1.6-2.6H3"/><path d="M6.6 4.9 3 12.5v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-3.6-7.6a2 2 0 0 0-1.8-1.1H8.4a2 2 0 0 0-1.8 1.1z"/>',
  book: '<path d="M12 7.4v13.1"/><path d="M3 18.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1h5a4 4 0 0 1 4 3.6 4 4 0 0 1 4-3.6h5a1 1 0 0 1 1 1v12.8a1 1 0 0 1-1 1h-5.6a3.4 3.4 0 0 0-3.4 2.4 3.4 3.4 0 0 0-3.4-2.4z"/>',
  wallet:
    '<path d="M19 7.5v-2a2 2 0 0 0-2-2H5.4a2.4 2.4 0 0 0 0 4.8H19a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2H5.4a2.4 2.4 0 0 1-2.4-2.4V5.9"/><path d="M17 13.4h.01"/>',
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.2 8.6"/><path d="M3 4.4v4.4h4.4"/><path d="M12 7.8V12l3 1.9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3 1.9"/>',
  settings:
    '<circle cx="12" cy="12" r="2.8"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.4a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.8-.9 1.5v.4"/><path d="M12 16.8h.01"/>',
  chevD: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  minus: '<path d="M5.2 12h13.6"/>',
  dots: '<circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/>',
  arrowUp: '<path d="M12 19.2V5.2"/><path d="m5.6 11.6 6.4-6.4 6.4 6.4"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.4"/><path d="M5.5 15h-.9a2 2 0 0 1-2-2V5.4a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2V6"/>',
  branch:
    '<path d="M6.5 4v11.6"/><circle cx="17.5" cy="6.4" r="2.6"/><circle cx="6.5" cy="18" r="2.6"/><path d="M17.5 9a8.6 8.6 0 0 1-8.6 8.6"/>',
  commit: '<circle cx="12" cy="12" r="3"/><path d="M3.5 12H9M15 12h5.5"/>',
  monitor: '<rect x="2.8" y="4" width="18.4" height="12.8" rx="2"/><path d="M8.5 20.4h7M12 16.8v3.6"/>',
  terminal: '<path d="m4.6 17 5.4-5-5.4-5"/><path d="M12.4 18.6h7"/>',
  file: '<path d="M14.4 3H6.8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2V7.8z"/><path d="M14.2 3v5h5"/><path d="M8.4 13.4h7M8.4 17h4.6"/>',
  check: '<path d="m5.2 12.8 4.4 4.4 9.2-10"/>',
  x: '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v4.8M12 16.2h.01"/>',
  shield: '<path d="M12 21.2s7.4-3.6 7.4-9.2V5.6L12 2.8 4.6 5.6V12c0 5.6 7.4 9.2 7.4 9.2z"/>',
  hand: '<path d="M17.6 11V7.4a1.6 1.6 0 0 0-3.2 0"/><path d="M14.4 10.6V5.6a1.6 1.6 0 0 0-3.2 0v5"/><path d="M11.2 10.6V6.8a1.6 1.6 0 1 0-3.2 0v8.4l-1.8-2a1.7 1.7 0 0 0-2.4 2.4l3.4 4.2a4 4 0 0 0 3.1 1.4h3.1a4.2 4.2 0 0 0 4.2-4.2v-4.4a1.6 1.6 0 0 0-3.2 0"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="M9.2 4v16"/>',
  panelR: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="M14.8 4v16"/>',
  list: '<path d="M10.4 6.4h10M10.4 12h10M10.4 17.6h10"/><path d="m3.4 6.4 1.4 1.4 2.6-2.6"/><path d="m3.4 12 1.4 1.4 2.6-2.6"/><path d="m3.4 17.6 1.4 1.4 2.6-2.6"/>',
  spark:
    '<path d="m11 3.6 1.9 4.5 4.5 1.9-4.5 1.9L11 16.4 9.1 11.9 4.6 10l4.5-1.9z"/><path d="m17.8 15.2.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  link: '<path d="m9.4 14.6 5.2-5.2"/><path d="m11.6 6.6 1.2-1.2a3.9 3.9 0 0 1 5.5 5.5l-1.2 1.2"/><path d="m12.4 17.4-1.2 1.2a3.9 3.9 0 0 1-5.5-5.5l1.2-1.2"/>',
  reply: '<path d="m14.6 9.6 4.4 4.4-4.4 4.4"/><path d="M4.6 4.6v5.4a4 4 0 0 0 4 4H19"/>',
  play: '<path d="M8 5.4 18.6 12 8 18.6z"/>',
  pause: '<path d="M9.4 5.6v12.8M14.6 5.6v12.8"/>',
  trash: '<path d="M4.6 6.4h14.8"/><path d="M9 6.4V4.8a1.4 1.4 0 0 1 1.4-1.4h3.2A1.4 1.4 0 0 1 15 4.8v1.6"/><path d="M6.4 6.4 7.2 19a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.8-12.6"/>',
  filter: '<path d="M3.6 5.2h16.8l-6.6 7.8v5.8l-3.6 2v-7.8z"/>',
  eye: '<path d="M2.6 12s3.6-6.4 9.4-6.4S21.4 12 21.4 12s-3.6 6.4-9.4 6.4S2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
  layers: '<path d="m12 3.2 9 4.6-9 4.6-9-4.6z"/><path d="m3 16.2 9 4.6 9-4.6"/><path d="m3 12 9 4.6 9-4.6"/>',
  db: '<ellipse cx="12" cy="6" rx="7.6" ry="3"/><path d="M4.4 6v12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3V6"/><path d="M4.4 12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">';

export function Icon({
  name,
  size,
  cls,
  title,
}: {
  name: IconName;
  /**
   * 图标尺寸阶梯（缺省 18）。
   * 18 / 20 目前无调用点但保留 —— 它与 `tokens.css` 的 `--fs-*` 一样是**令牌阶梯**，
   * 不是死链：成套的尺寸梯度缺一档，下次需要时就会有人随手写 `style={{width:20}}`。
   * （MU-3 切片 8 盘点时确认过，不要再当死链删。）
   */
  size?: 14 | 16 | 18 | 20;
  cls?: string;
  title?: string;
}): ReactElement {
  // 图标路径是本模块的常量字符串（不来自任何数据），用 innerHTML 与原型保持逐字一致。
  const html = SVG_OPEN + ICON_PATHS[name] + '</svg>';
  return (
    <span
      className={['i', size ? `i-${size}` : '', cls ?? ''].filter(Boolean).join(' ')}
      {...(title ? { title } : {})}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

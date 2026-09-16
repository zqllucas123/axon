/**
 * 顶栏（原型：h56 / padding 0 18px 0 22px / 标题 fs17·500）。
 *
 * 标题右边是本屏焦点分身的 tag（`/0/1/2`）—— ux 01 §2.1-③「一屏一个焦点分身」的锚点。
 * 缺口处置（MU-2 §4.6）：原型顶栏的「正在：…」任务文本拿不到（快照无 task）⇒ 整块不渲染。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.ts';
import { Chips } from './Chips.tsx';

export function Topbar(): ReactElement {
  const { screen, current, focusPath } = useApp();

  const title =
    screen === 's0'
      ? '新建会话'
      : screen === 's1'
        ? '会话总览'
        : screen === 's3'
          ? '团队管理'
          : (current?.record.title ?? '会话');

  return (
    <div className="topbar">
      <span className="title">{title}</span>
      {screen === 's2' && focusPath ? (
        <span className="tag mono" title="当前焦点分身（点右栏成员切换）">
          {focusPath}
        </span>
      ) : null}
      <span className="spacer" />
      <Chips />
    </div>
  );
}

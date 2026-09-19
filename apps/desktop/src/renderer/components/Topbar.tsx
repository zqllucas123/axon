/**
 * 顶栏（原型：h56 / padding 0 18px 0 22px / 标题 fs17·500）。
 *
 * 标题右边是本屏焦点分身的 tag（`/0/1/2`）—— ux 01 §2.1-③「一屏一个焦点分身」的锚点。
 * 缺口处置（MU-2 §4.6）：原型顶栏的「正在：…」任务文本拿不到（快照无 task）⇒ 整块不渲染。
 */

import type { ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Chips } from './Chips.tsx';
import { Icon } from '../icons.tsx';

export function Topbar(): ReactElement {
  const { screen, current, focusPath, rightPanel, setRightPanel } = useApp();

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
      {screen === 's2' && current ? (
        <span className="panel-toggles">
          <button
            className={`btn sm ghost${rightPanel === 'files' ? ' is-on' : ''}`}
            data-smoke="toggle-files"
            title="打开文件（工作区目录树）"
            onClick={() => setRightPanel(rightPanel === 'files' ? 'none' : 'files')}
          >
            <Icon name="folder" size={14} />
            文件
          </button>
          <button
            className={`btn sm ghost${rightPanel === 'props' ? ' is-on' : ''}`}
            data-smoke="toggle-props"
            title="会话属性（成员 / 账本 / 协作动作）"
            onClick={() => setRightPanel(rightPanel === 'props' ? 'none' : 'props')}
          >
            <Icon name="list" size={14} />
            属性
          </button>
        </span>
      ) : null}
      <Chips />
    </div>
  );
}

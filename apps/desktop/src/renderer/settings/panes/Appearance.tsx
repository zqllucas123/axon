/**
 * 外观 pane —— `ui.*` 五项（UX 03 §3.2，字段见 MU-3 §4.4 / E-2）。
 *
 * 这五项是白名单里**唯一一组不改变安全边界**的字段，也是唯一一组不进 `HostOptions` 的
 * ——它们只被渲染层读。落在 `config.json` 而不是 localStorage 是 MU-3 拍板 P-3：
 * 两个窗口靠 `config.changed` 天然同步，localStorage 在 `file://` 下跨窗通知不可靠。
 *
 * **主题只有「浅色」可选**（拍板 P-4）：暗色是全量换肤 + 12 屏复核，属独立一片
 * （台账 D-7）。这里把「深色 / 跟随系统」两档置灰标「未实现」而不是删掉整行 ——
 * 与「协议给不出就删掉」不冲突：枚举值在协议里是**存在**的（`ui.theme` 三值），
 * 缺的是渲染层实现，如实标注比假装没有这回事更准确。
 */

import type { ReactElement } from 'react';
import { CONFIG_DEFAULTS } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import { SegField, SelectField, ToggleField, envLock } from '../fields.tsx';

const FONT_SIZES: Array<{ value: string; label: string }> = [
  { value: '13', label: '13px' },
  { value: '14', label: '14px' },
  { value: '15', label: '15px（默认）' },
  { value: '16', label: '16px' },
  { value: '17', label: '17px' },
];

export function AppearancePane(): ReactElement {
  const { config } = useSettings();
  if (!config) return <div className="empty">读取配置中…</div>;
  const ui = config.config.ui ?? {};
  const env = config.envOverrides;

  return (
    <section className="st-pane" data-pane="appearance">
      <h1 className="st-h1">外观</h1>
      <p className="st-lede">
        只影响界面呈现，不改变任何安全边界。改动会同时作用于主窗与本窗（两窗共用一份配置）。
      </p>

      <div className="st-sec">主题</div>
      <div className="grp">
        <SegField<'light' | 'dark' | 'system'>
          path="ui.theme"
          title="主题"
          desc="当前只实现了浅色。暗色是一次全量换肤（令牌 + 12 屏复核），单独排一片再做；在那之前这两档点不动，而不是点了没反应。"
          value={ui.theme ?? CONFIG_DEFAULTS.ui.theme}
          options={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色', disabled: true, note: '未实现' },
            { value: 'system', label: '跟随系统', disabled: true, note: '未实现' },
          ]}
          lock={envLock(env, 'ui.theme')}
          smoke="set-theme"
        />

        <ToggleField
          path="ui.annotations"
          title="显示协议数据标注"
          desc="在界面上标出每一项数据来自哪个协议事件 / 命令。排查「这个数字怎么来的」时不用读代码；日常关掉即可。"
          value={ui.annotations ?? CONFIG_DEFAULTS.ui.annotations}
          lock={envLock(env, 'ui.annotations')}
          smoke="set-annotations"
        />
      </div>

      <div className="st-sec">排版</div>
      <div className="grp">
        <SegField<'comfortable' | 'compact'>
          path="ui.density"
          title="信息密度"
          desc="「紧凑」把列表行高收紧，一屏多放约三分之一；会话正文不受影响（长文阅读优先，这是刻意的）。"
          value={ui.density ?? CONFIG_DEFAULTS.ui.density}
          options={[
            { value: 'comfortable', label: '舒适' },
            { value: 'compact', label: '紧凑' },
          ]}
          lock={envLock(env, 'ui.density')}
          smoke="set-density"
        />

        <SelectField<string>
          path="ui.fontSize"
          title="会话正文字号"
          desc="只改会话流正文，界面其余部分的字号不动。缺省 15px —— 会话比界面大一档是刻意的。"
          value={String(ui.fontSize ?? CONFIG_DEFAULTS.ui.fontSize)}
          options={FONT_SIZES}
          toStored={(v) => Number(v)}
          clearable
          lock={envLock(env, 'ui.fontSize')}
          smoke="set-fontSize"
        />

        <SegField<'system' | 'always'>
          path="ui.reduceMotion"
          title="减弱动态效果"
          desc="关掉流式逐字与卡片进场动画。「跟随系统」= 听系统的 prefers-reduced-motion；「始终减弱」= 不管系统怎么设都减弱。"
          value={ui.reduceMotion ?? CONFIG_DEFAULTS.ui.reduceMotion}
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'always', label: '始终减弱' },
          ]}
          lock={envLock(env, 'ui.reduceMotion')}
          smoke="set-reduceMotion"
        />
      </div>
    </section>
  );
}

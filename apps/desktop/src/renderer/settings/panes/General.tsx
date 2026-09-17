/**
 * 通用 pane —— 影响所有会话的默认值（UX 03 §3.1）。
 *
 * 字段一条不多一条不少，照 MU-3 §4.4 的映射表：
 *   defaultApproval / approvalTimeoutMs / defaultExecutor / defaultCwd
 *   + 角色目录与配置文件位置（只读 ConfigPaths + 打开按钮，走 shell.openPath）
 *
 * 删掉的原型元素（协议无落点，按 UX 03 §0.2「协议给不出就删掉界面元素」）：
 *  - 「在菜单栏中显示」「运行任务时防止系统休眠」：全仓无 Tray / powerSaveBlocker，
 *    也不在配置白名单里（MU-3 §1.2-7，转台账 D-9）。
 *  - 「配置文件位置 › 更改」：`AXON_CONFIG` 在启动时就解析完了，界面上改它只会
 *    造出「显示的和真在用的不是一个」。
 *  - 「默认工作目录 › 更改」（系统目录选择器）：`dialog.showOpenDialog` 不在本片范围
 *    （拍板 P-7），所以这一项做成**可直接编辑的文本框**而不是留一个死按钮。
 *  - 「编排工具豁免人工审批 › 查看清单」整行：那是架构不变量而不是设置项，
 *    原型自己也写了「不提供开关」；一行既不能改又没有落点的说明放在设置页里
 *    只会让人以为这里能配。它的语义写进了「默认审批档」那一行的说明。
 */

import type { ReactElement } from 'react';
import type { ApprovalMode, SessionExecutor } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import { InputField, PathRow, SegField, SelectField, envLock } from '../fields.tsx';

/** 审批超时的预设（毫秒）。协议上限是一天，但设置页给「常用几档 + 不超时」。 */
const TIMEOUTS: Array<{ value: string; label: string }> = [
  { value: '60000', label: '1 分钟' },
  { value: '120000', label: '2 分钟' },
  { value: '300000', label: '5 分钟（默认）' },
  { value: '600000', label: '10 分钟' },
  { value: '1800000', label: '30 分钟' },
  { value: '0', label: '永不超时' },
];

export function GeneralPane(): ReactElement {
  const { config, openPath } = useSettings();
  if (!config) return <div className="empty">读取配置中…</div>;
  const c = config.config;
  const env = config.envOverrides;

  return (
    <section className="st-pane" data-pane="general">
      <h1 className="st-h1">通用</h1>
      <p className="st-lede">
        影响所有会话的默认值。团队与角色级的设置可以覆盖这里的默认，且只能更严、不能更松。
      </p>

      <div className="st-sec">权限</div>
      <div className="grp">
        <SelectField<ApprovalMode>
          path="defaultApproval"
          title="默认审批档"
          desc={
            <>
              角色没写 <code>approval</code> 字段时用它兜底。角色自带的档位优先，且<b>只能更严</b>
              —— 角色只能减能不能越权。⚠️ 档位是「按 Agent」而不是「按工具」的：除六个编排工具
              （它们豁免 HITL，否则一次 delegate 会弹两次确认）外没有风险分级，而且链上任意一个{' '}
              <code>auto</code> / <code>full_access</code> 祖先会静默代批掉全部后代请求。
            </>
          }
          value={c.defaultApproval}
          options={[
            { value: 'always_ask', label: '每次必问（always_ask）' },
            { value: 'auto', label: '自动放行（auto）' },
            { value: 'full_access', label: '完全放手（full_access）' },
          ]}
          clearable
          lock={envLock(env, 'defaultApproval')}
          smoke="set-defaultApproval"
        />

        <SelectField<string>
          path="approvalTimeoutMs"
          title="审批超时"
          desc="超时按「拒绝」处理，并把原因回灌给模型让它换条路。缺省 5 分钟；选「永不超时」等于把分身的这一轮无限期吊住，不推荐。"
          value={c.approvalTimeoutMs === undefined ? undefined : String(c.approvalTimeoutMs)}
          options={TIMEOUTS}
          toStored={(v) => Number(v)}
          clearable
          lock={envLock(env, 'approvalTimeoutMs')}
          smoke="set-approvalTimeout"
        />
      </div>

      <div className="st-sec">常规</div>
      <div className="grp">
        <SegField<SessionExecutor>
          path="defaultExecutor"
          title="默认执行方式"
          desc="新建会话时预选哪张模式卡。缺省「内置引擎」—— 协作是成本不是福利，不是每个任务都值得配一支队伍；「指定团队」用现成编队，「现挑成员」当场组一支临时队。"
          value={c.defaultExecutor}
          options={[
            { value: 'engine', label: '内置引擎' },
            { value: 'team', label: '指定团队' },
            { value: 'adhoc', label: '现挑成员' },
          ]}
          lock={envLock(env, 'defaultExecutor')}
          smoke="set-defaultExecutor"
        />

        <InputField
          path="defaultCwd"
          title="默认工作目录"
          desc="新建会话的起始目录；会话内仍可单独改。直接编辑这个框即可（不开系统目录选择器：本片不做 dialog，留一个「更改」死按钮更糟）。留空 = 跟随应用启动目录。"
          value={c.defaultCwd}
          placeholder="/Users/you/works/project"
          mono
          lock={envLock(env, 'defaultCwd')}
          smoke="set-defaultCwd"
        />

        <PathRow
          title="角色目录"
          desc="角色就是这个目录里的 JSON 文件，改完热重载（防抖 300ms）。用户角色与内置角色同名时覆盖内置。路径由 AXON_ROLES_DIR 决定，只读。"
          path={config.paths.roles}
          action={{ label: '在访达中打开', onClick: () => void openPath('roles') }}
          smoke="set-rolesDir"
        />

        <PathRow
          title="配置文件位置"
          desc="本页所有设置都写进这个文件（原子替换 + 0600 权限，未知字段原样保留）。路径由 AXON_CONFIG 决定，只读；API Key 在 M6 上钥匙串之前是明文存在这里的。"
          path={config.paths.config}
          action={{ label: '在访达中显示', onClick: () => void openPath('config') }}
          smoke="set-configPath"
        />
      </div>
    </section>
  );
}

/**
 * 编排与安全 pane —— 并发闸门、看门狗与协作裁决（UX 03 §3.4）。
 *
 * 字段照 MU-3 §4.4：`maxConcurrent` / `maxDepth` / `idleTimeoutMs`
 * + `agent_wait` 默认超时（**只读常量**）+ 裁决策略与仲裁者
 * （走 `ledger.getAdoptionPolicy` / `setAdoptionPolicy`，**不走 config**：
 * 它是 host 的运行期状态，不是配置文件字段）。
 *
 * 删掉的原型元素：「审批档与穿透规则」那一行（它是一个指回「通用 › 权限」的
 * 跳板，本实现里 pane 切换就在左边一步之遥，多一行只会让人以为这里也能改）。
 */

import type { ReactElement } from 'react';
import type { AdoptionPolicy } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import { InputField, Picker, SettingsRow, envLock } from '../fields.tsx';

/** `agent_wait` 的默认超时：主进程常量（orchestrator.ts 的 DEFAULT_WAIT_TIMEOUT_SEC）。 */
const WAIT_TIMEOUT_SEC = 600;

const isDelegate = (p: AdoptionPolicy | null): boolean => p?.mode === 'delegate';

const arbiterRoleOf = (p: AdoptionPolicy | null): string | undefined =>
  p && p.mode === 'delegate' && 'arbiterRole' in p ? p.arbiterRole : undefined;

const arbiterPathOf = (p: AdoptionPolicy | null): string | undefined =>
  p && p.mode === 'delegate' && 'arbiter' in p ? p.arbiter : undefined;

export function OrchestrationPane(): ReactElement {
  const { config, policy, roles, setPolicy } = useSettings();
  if (!config) return <div className="empty">读取配置中…</div>;
  const c = config.config;
  const env = config.envOverrides;
  const role = arbiterRoleOf(policy);
  const path = arbiterPathOf(policy);

  return (
    <section className="st-pane" data-pane="orchestration">
      <h1 className="st-h1">编排与安全</h1>
      <p className="st-lede">
        并发闸门、看门狗与协作裁决策略。前三项改完立刻热应用到下一次 spawn / prompt，不用重启。
      </p>

      <div className="st-sec">闸门与看门狗</div>
      <div className="grp">
        <InputField
          path="maxConcurrent"
          title="并发上限"
          desc="只有 running 占额度；waiting 不占 —— 排队中的（parked）和「父等后代而退位让额」的（suspended）都不算。所以第 7 个分身在上限 6 时是排队，不是卡死，不用为此调大它。0 = 不限。"
          value={c.maxConcurrent}
          kind="number"
          width="sm"
          suffix="个 running"
          placeholder="6"
          lock={envLock(env, 'maxConcurrent')}
          smoke="set-maxConcurrent"
        />

        <InputField
          path="maxDepth"
          title="最大分身深度"
          desc="会话根算第 0 层；超过这个深度的 spawn 直接失败并把原因回灌给模型。缺省 2 —— 深度是协作成本的主要来源，调大之前先想清楚谁在等谁。"
          value={c.maxDepth}
          kind="number"
          width="sm"
          suffix="层"
          placeholder="2"
          lock={envLock(env, 'maxDepth')}
          smoke="set-maxDepth"
        />

        <InputField
          path="idleTimeoutMs"
          title="空闲看门狗"
          desc="按「空闲」而非总时长计时：running 且这么久没有任何事件就判定卡死并中断。等待人工审批期间豁免（否则你拖五分钟再批，工具刚跑起来就被杀）。缺省 5 分钟；0 = 关闭。"
          value={c.idleTimeoutMs}
          kind="number"
          width="sm"
          suffix="分钟"
          placeholder="5"
          toStored={(n) => Math.round(n * 60_000)}
          fromStored={(ms) => Math.round((ms / 60_000) * 10) / 10}
          lock={envLock(env, 'idleTimeoutMs')}
          smoke="set-idleTimeout"
        />

        <SettingsRow
          title="agent_wait 默认超时"
          desc="父 Agent 等后代的上限。这是常量，不可配置：模型可以在工具参数里按次覆盖（timeoutSec），把它做成全局设置只会多一处互相矛盾的真相。"
          tag={<span className="tag">只读常量</span>}
          smoke="set-waitTimeout"
        >
          <span className="path">{WAIT_TIMEOUT_SEC} 秒</span>
        </SettingsRow>
      </div>

      <div className="st-sec">协作裁决</div>
      <div className="grp">
        <SettingsRow
          title="裁决策略"
          desc="「人工表态」= 每笔 consult / delegate 落账后都要你按采纳或驳回；「委派仲裁」把表态权交给某个角色的存活实例。这是本页唯一会改变「谁有权力」的设置，它不写进 config.json，而是 host 的运行期状态（改完立即生效，重启回到人工表态）。"
          smoke="set-adoptionPolicy"
        >
          <div className="seg sm">
            <button
              type="button"
              className={policy && policy.mode === 'human' ? 'is-on' : ''}
              disabled={policy === null}
              onClick={() => void setPolicy({ mode: 'human' })}
            >
              人工表态
            </button>
            <button
              type="button"
              className={isDelegate(policy) ? 'is-on' : ''}
              disabled={policy === null || roles.length === 0}
              title={roles.length === 0 ? '没有可选角色' : undefined}
              onClick={() => {
                const first = role ?? roles[0]?.role.name;
                if (first) void setPolicy({ mode: 'delegate', arbiterRole: first });
              }}
            >
              委派仲裁
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          title="仲裁者"
          desc="只在「委派仲裁」下生效，按角色指定：裁决时取该角色在本会话里的存活实例，找不到就回落人工表态。硬约束两条 —— 仲裁者不能是被裁决方或其后代（等于自己给自己发合格证），且每次裁决都留署名。"
          smoke="set-arbiter"
        >
          {path ? (
            // 委派给「具体某个 Agent」是协议里的另一条分支，但它只能在会话上下文里选
            // （设置窗没有会话）。已经被设成这种形态时如实显示，不假装能在这里改。
            <span className="path" title={path}>
              指定 Agent：{path}
            </span>
          ) : (
            <Picker<string>
              label={
                roles.length === 0
                  ? '（没有可选角色）'
                  : role
                    ? `按角色：${roles.find((e) => e.role.name === role)?.role.displayName ?? role}`
                    : '未指定'
              }
              options={roles.map((e) => ({
                value: e.role.name,
                label: e.role.displayName ? `${e.role.displayName}（${e.role.name}）` : e.role.name,
              }))}
              value={role}
              disabled={!isDelegate(policy) || roles.length === 0}
              smoke="set-arbiter-sel"
              onPick={(name) => void setPolicy({ mode: 'delegate', arbiterRole: name })}
            />
          )}
        </SettingsRow>
      </div>
    </section>
  );
}

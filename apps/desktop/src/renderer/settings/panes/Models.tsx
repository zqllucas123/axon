/**
 * 模型与网关 pane —— 一个网关 + 一份模型清单 + 一条全局预算（UX 03 §3.3）。
 *
 * 字段照 MU-3 §4.4：`provider.name` / `.baseUrl` / `.apiKey` / `.defaultModel` /
 * `.headers` / `.models` + `budgetUsd` / `budgetSoftUsd`。
 *
 * ── 三处与原型不同，都有出处 ──
 *
 * 1. **软线是可写输入框，不是只读 tag**。原型画的是「自动 = 硬线 × 0.8」的死标签
 *    （因为 MU-1 之前 `budgetSoftUsd` 确实没有入口），但它今天在白名单里
 *    （`packages/protocol/src/config.ts` 的 `budgetSoftUsd`），MU-3 §4.4 明确
 *    「原型把软线画成只读 tag，实现里它可写」。留空才回到 ×0.8。
 * 2. **删掉「测试连接」**：`provider.test` 全仓不存在（拍板 P-7 归 M6），
 *    一个按下去什么都不会发生的按钮比没有按钮糟糕。
 * 3. **删掉「每角色的模型覆盖」整行**：`RoleDefinition.model` 至今没有消费方
 *    （建引擎时写死用网关默认模型），画出来等于承诺一个不存在的能力。
 *
 * ── headers / models 是「整体替换」字段（风险 R-4）──
 * 协议上它们是整块 json，所以编辑面以最近一次 `config.get` / `config.changed`
 * 的快照为基做「读整体 → 改 → 整体写回」；期间另一个窗口改了同一块，会在提交后
 * 被 `config.changed` 重绘覆盖（最后写入者胜）。这句话写进了行内说明。
 */

import { useState, type ReactElement } from 'react';
import type { ModelSpec } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import {
  InputField,
  SecretField,
  SelectField,
  SettingsRow,
  envLock,
  useFieldPatch,
  useJsonDraft,
} from '../fields.tsx';

const fmtInt = (n: number | undefined, fallback: string): string =>
  n === undefined ? fallback : n.toLocaleString('en-US');

const fmtCost = (m: ModelSpec): string => {
  const c = m.cost ?? {};
  if (!c.input && !c.output) return '价格 0（成本不计入预算 ⇒ 熔断永不触发）';
  return `in $${c.input ?? 0} / out $${c.output ?? 0}（每百万 token）`;
};

/** 请求头编辑面：整块 `Record<string,string>` 读改写。 */
function HeadersRow(): ReactElement {
  const { config } = useSettings();
  const headers = config?.config.provider?.headers ?? {};
  const { saving, error, commit } = useFieldPatch('provider.headers');
  const { draft, setDraft, dirty, reset } = useJsonDraft<Array<[string, string]>>(
    Object.entries(headers),
    JSON.stringify(headers),
  );

  const put = (next: Array<[string, string]>): void => setDraft(next);

  return (
    <SettingsRow
      title="自定义请求头"
      desc="给网关带额外 header（网关路由、灰度标记等）。这是整块替换的字段：提交时把下面这张表整体写回；若此刻另一个窗口也在改同一块，后提交的那次胜出。"
      error={error}
      saving={saving}
      col
      top
      smoke="set-headers"
    >
      <div className="kv-editor">
        {draft.length === 0 ? <span className="d">（没有自定义请求头）</span> : null}
        {draft.map(([k, v], i) => (
          <div className="kv-row" key={i}>
            <input
              className="inp mono"
              value={k}
              placeholder="Header-Name"
              onChange={(e) => {
                const next = draft.slice();
                next[i] = [e.target.value, v];
                put(next);
              }}
            />
            <input
              className="inp mono"
              value={v}
              placeholder="value"
              onChange={(e) => {
                const next = draft.slice();
                next[i] = [k, e.target.value];
                put(next);
              }}
            />
            <button
              type="button"
              className="btn sm ghost"
              title="删除这一条"
              onClick={() => put(draft.filter((_, j) => j !== i))}
            >
              删除
            </button>
          </div>
        ))}
        <div className="row-acts">
          <button type="button" className="btn sm" onClick={() => put([...draft, ['', '']])}>
            添加一条
          </button>
          <span className="spacer" />
          {dirty ? (
            <>
              <button type="button" className="btn sm ghost" onClick={reset}>
                放弃改动
              </button>
              <button
                type="button"
                className="btn sm primary"
                disabled={saving}
                onClick={() => {
                  const obj: Record<string, string> = {};
                  for (const [k, v] of draft) if (k.trim() !== '') obj[k.trim()] = v;
                  void commit(Object.keys(obj).length === 0 ? null : obj);
                }}
              >
                写回
              </button>
            </>
          ) : null}
        </div>
      </div>
    </SettingsRow>
  );
}

const EMPTY_MODEL: ModelSpec = { id: '' };

/** 模型清单：整块数组读改写；表头列义照原型（模型 / 推理 / 上下文 / 最大输出 / 价格）。 */
function ModelsGroup(): ReactElement {
  const { config } = useSettings();
  const models = config?.config.provider?.models ?? [];
  const defaultModel = config?.config.provider?.defaultModel;
  const { saving, error, commit } = useFieldPatch('provider.models');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<ModelSpec>(EMPTY_MODEL);

  const write = (next: ModelSpec[]): void => {
    void commit(next.length === 0 ? null : next).then((ok) => {
      if (ok) setEditing(null);
    });
  };

  const openForm = (index: number | 'new'): void => {
    setEditing(index);
    setForm(index === 'new' ? EMPTY_MODEL : (models[index] ?? EMPTY_MODEL));
  };

  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() === '' || !Number.isFinite(n) ? undefined : n;
  };

  return (
    <div className="grp">
      <div className="srow head">
        <div className="txt">
          <div className="t">模型 / 推理 / 上下文 / 最大输出 / 价格（$ / 百万 token）</div>
        </div>
        <div className="ctl">
          <button
            type="button"
            className="btn sm ghost"
            data-smoke="set-models-add"
            onClick={() => openForm('new')}
          >
            添加模型
          </button>
        </div>
      </div>

      {models.length === 0 ? (
        <SettingsRow
          title="清单为空"
          desc="模型清单为空是「静默降级到 faux 假模型」的四种原因之一。至少填一个模型 id，Axon 才会真的去请求网关。"
        />
      ) : null}

      {models.map((m, i) => (
        <SettingsRow
          key={`${m.id}-${i}`}
          title={
            <>
              <code>{m.id}</code>
              {m.id === defaultModel ? <span className="tag">默认</span> : null}
              {m.reasoning === true ? <span className="tag">reasoning</span> : null}
            </>
          }
          desc={
            <>
              {fmtInt(m.contextWindow, '128,000（缺省）')} 上下文 ·{' '}
              {fmtInt(m.maxTokens, '8,192（缺省）')} 最大输出 · {fmtCost(m)}
              {m.reasoning === true ? '。reasoning=true ⇒ 会话流里会多出 thinking 折叠块。' : ''}
            </>
          }
          error={editing === i ? error : null}
          saving={saving}
        >
          <button type="button" className="btn sm ghost" onClick={() => openForm(i)}>
            编辑
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => write(models.filter((_, j) => j !== i))}
          >
            删除
          </button>
        </SettingsRow>
      ))}

      {editing !== null ? (
        <div className="srow col top">
          <div className="txt">
            <div className="t">{editing === 'new' ? '添加模型' : `编辑 ${models[editing]?.id}`}</div>
            <div className="d">
              id 必填且不能重复；上下文/最大输出留空走缺省（128,000 / 8,192）。价格填 0 或留空
              不会报错，但那样这个模型的花费不计入预算 ⇒ 熔断对它永不触发。
              {error ? <span className="field-err">{error}</span> : null}
            </div>
          </div>
          <div className="model-form">
            <label>
              id
              <input
                className="inp mono"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
            </label>
            <label>
              显示名
              <input
                className="inp"
                value={form.name ?? ''}
                onChange={(e) => setForm({ ...form, name: e.target.value || undefined })}
              />
            </label>
            <label>
              上下文
              <input
                className="inp"
                value={form.contextWindow ?? ''}
                onChange={(e) => setForm({ ...form, contextWindow: num(e.target.value) })}
              />
            </label>
            <label>
              最大输出
              <input
                className="inp"
                value={form.maxTokens ?? ''}
                onChange={(e) => setForm({ ...form, maxTokens: num(e.target.value) })}
              />
            </label>
            <label>
              输入价格
              <input
                className="inp"
                value={form.cost?.input ?? ''}
                onChange={(e) =>
                  setForm({ ...form, cost: { ...form.cost, input: num(e.target.value) } })
                }
              />
            </label>
            <label>
              输出价格
              <input
                className="inp"
                value={form.cost?.output ?? ''}
                onChange={(e) =>
                  setForm({ ...form, cost: { ...form.cost, output: num(e.target.value) } })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.reasoning === true}
                onChange={(e) => setForm({ ...form, reasoning: e.target.checked || undefined })}
              />
              会吐 reasoning / thinking 内容
            </label>
          </div>
          <div className="row-acts">
            <span className="spacer" />
            <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={form.id.trim() === '' || saving}
              onClick={() => {
                const clean: ModelSpec = { ...form, id: form.id.trim() };
                const next =
                  editing === 'new'
                    ? [...models, clean]
                    : models.map((m, j) => (j === editing ? clean : m));
                write(next);
              }}
            >
              写回清单
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ModelsPane(): ReactElement {
  const { config } = useSettings();
  if (!config) return <div className="empty">读取配置中…</div>;
  const p = config.config.provider;
  const env = config.envOverrides;
  const models = p?.models ?? [];
  const res = config.resolution;
  const hard = config.config.budgetUsd;

  return (
    <section className="st-pane" data-pane="model">
      <h1 className="st-h1">模型与网关</h1>
      <p className="st-lede">
        Axon 只走 OpenAI 兼容网关（<code>openai-completions</code>）：一个网关 + 一份模型清单 +
        一条全局预算。
      </p>

      <div className="st-sec">当前生效</div>
      <div className="grp">
        <SettingsRow
          title="执行模型"
          desc="配置缺失时 Axon 不崩：静默降级到 faux（脚本化假模型），并把原因同时标在主窗顶栏与这里。四种降级原因：未配 baseUrl / 未配 apiKey / 模型清单为空 / 默认模型不在清单内。这一行与顶栏读的是同一个字段，不会两处不一致。"
          smoke="set-resolution"
        >
          {res.degraded ? (
            <span className="tag err">faux · {res.reason ?? '未配置'}</span>
          ) : (
            <span className="tag ok">
              {res.effectiveModel ?? '已配置'}
              {res.providerId ? ` · ${res.providerId}` : ''}
            </span>
          )}
        </SettingsRow>

        <InputField
          path="provider.name"
          title="网关名称"
          desc="只用于界面显示（顶栏与本页），不参与请求。"
          value={p?.name}
          placeholder="Axon Gateway"
          lock={envLock(env, 'provider.name')}
          smoke="set-providerName"
        />

        <InputField
          path="provider.baseUrl"
          title="Base URL"
          desc="OpenAI 兼容端点的根地址，形如 https://host/path/v1（不含 /chat/completions），末尾斜杠会被自动剥掉。"
          value={p?.baseUrl}
          placeholder="https://api.example.com/v1"
          mono
          lock={envLock(env, 'provider.baseUrl')}
          smoke="set-baseUrl"
        />

        <SecretField
          path="provider.apiKey"
          title="API Key"
          desc="明文存在 config.json 里（0600 权限），钥匙串推迟到 M6 —— 在那之前这一项就是明文，界面上说实话。读回来的永远只有掩码，明文不出主进程。"
          masked={p?.apiKeyMasked}
          isSet={p?.apiKeySet === true}
          lock={envLock(env, 'provider.apiKey')}
          smoke="set-apiKey"
        />

        <SelectField<string>
          path="provider.defaultModel"
          title="默认模型"
          desc="必须是下面清单里的 id；不在清单里会被拒（否则启动时会静默降级到 faux，看起来像「保存成功了但模型没换」）。留空 = 取清单第一项。"
          value={p?.defaultModel}
          options={models.map((m) => ({ value: m.id, label: m.id }))}
          clearable
          lock={envLock(env, 'provider.defaultModel')}
          smoke="set-defaultModel"
        />

        <HeadersRow />
      </div>

      <div className="st-sec">模型清单</div>
      <ModelsGroup />

      <div className="st-sec">预算</div>
      <div className="grp">
        <InputField
          path="budgetUsd"
          title="全局硬线（累计）"
          desc="到线只挡新起点（spawn / prompt），在跑的那一轮不会被杀。是进程内累计口径，不按自然日重置。留空或 0 = 关闭熔断。"
          value={hard}
          kind="number"
          width="sm"
          suffix="美元"
          placeholder="0"
          lock={envLock(env, 'budgetUsd')}
          smoke="set-budgetUsd"
        />

        <InputField
          path="budgetSoftUsd"
          title="软线（预警）"
          desc={
            <>
              到软线只发预警（主窗顶栏变黄），不挡任何东西。
              <b>留空 = 硬线 × 0.8</b>
              {hard ? `（当前 ${(hard * 0.8).toFixed(2)} 美元）` : ''}。填了就以填的为准。
            </>
          }
          value={config.config.budgetSoftUsd}
          kind="number"
          width="sm"
          suffix="美元"
          placeholder={hard ? (hard * 0.8).toFixed(2) : '自动'}
          lock={envLock(env, 'budgetSoftUsd')}
          smoke="set-budgetSoftUsd"
        />
      </div>
    </section>
  );
}

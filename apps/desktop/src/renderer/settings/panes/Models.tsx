/**
 * 模型与网关 pane（重构版）
 *
 * 参照 AIKO ProvidersSection 的 accordion card 风格：
 * - Provider 信息收进可折叠卡片（头部摘要 → 展开内联编辑）
 * - 模型行带内联 caps 面板，不再弹出底部 form
 * - 「拉取模型列表」复用 provider.test IPC（返回 models: string[]）→ 内联勾选面板
 * - 预算区不变
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { ModelSpec } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import {
  InputField,
  SettingsRow,
  envLock,
  useFieldPatch,
} from '../fields.tsx';

// ─── 图标 ────────────────────────────────────────────────────

function ChevronIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      style={{ transition: 'transform 180ms ease', transform: open ? 'rotate(180deg)' : 'none' }}
    >
      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PulseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <polyline points="1,8 4,8 5,4 7,12 9,6 11,10 12,8 15,8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <polyline points="2,4 14,4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v5M10 7v5M3 4l1 9a1 1 0 001 1h6a1 1 0 001-1l1-9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── API Key 行（聚焦即可输入，与原版保持一致） ──────────────

function ApiKeyRow(): ReactElement {
  const { saving, error, commit } = useFieldPatch('provider.apiKey');
  const { config } = useSettings();
  const p = config?.config.provider;
  const env = config?.envOverrides ?? [];
  const lock = envLock(env, 'provider.apiKey');
  const isSet = p?.apiKeySet === true;
  const masked = p?.apiKeyMasked;

  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  const truthKey = `${isSet ? (masked ?? '') : ''}`;
  useEffect(() => { setText(''); }, [truthKey]);

  const submit = useCallback((): void => {
    const val = text.trim();
    if (val === '') return;
    void commit(val).then((ok) => { if (ok) setText(''); });
  }, [text, commit]);

  // 已配置且未在编辑时，用实心圆点展示（像密码框），让「这里存了 key」一眼可见；
  // 聚焦即清空，方便直接粘贴新 key。真实掩码（sk-***xyz）挪到下方 hint 里备查。
  const showDots = isSet && !focused && text === '';

  return (
    <div className="provider-field">
      <label className="provider-field-label">API Key</label>
      <div className="provider-field-row">
        <input
          className="settings-input provider-field-inp"
          type="password"
          autoComplete="new-password"
          value={showDots ? '••••••••••••' : text}
          placeholder={focused || isSet ? '粘贴新的 API Key' : '未配置'}
          disabled={Boolean(lock) || saving}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); submit(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { submit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { setText(''); (e.target as HTMLInputElement).blur(); }
          }}
        />
        {isSet && !lock ? (
          <button
            type="button"
            className="provider-btn ghost"
            disabled={saving}
            onClick={() => void commit(null)}
          >
            清除
          </button>
        ) : null}
      </div>
      {error ? <div className="provider-field-err">{error}</div> : null}
      {lock ? (
        <div className="provider-field-hint">
          被环境变量 <code>{lock.env}</code> 覆盖，改动不会生效
        </div>
      ) : isSet && masked ? (
        <div className="provider-field-hint">
          已配置 <code>{masked}</code>（已加密存储）
        </div>
      ) : null}
    </div>
  );
}

// ─── 每个模型行 ───────────────────────────────────────────────

interface ModelRowProps {
  model: ModelSpec;
  isDefault: boolean;
  onSetDefault: () => void;
  onDelete: () => void;
  onSaveCaps: (patch: Partial<ModelSpec>) => void;
}

type TestState =
  | { tag: 'idle' }
  | { tag: 'testing' }
  | { tag: 'ok'; latencyMs: number }
  | { tag: 'fail'; error: string };

function ModelRow({ model, isDefault, onSetDefault, onDelete, onSaveCaps }: ModelRowProps): ReactElement {
  const [capsOpen, setCapsOpen] = useState(false);
  const [ctxVal, setCtxVal] = useState(String(model.contextWindow ?? ''));
  const [maxVal, setMaxVal] = useState(String(model.maxTokens ?? ''));
  const [test, setTest] = useState<TestState>({ tag: 'idle' });
  const testTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (testTimer.current !== null) clearTimeout(testTimer.current); }, []);

  const runTest = async () => {
    if (testTimer.current !== null) { clearTimeout(testTimer.current); testTimer.current = null; }
    setTest({ tag: 'testing' });
    try {
      // 传 model → 主进程对该模型发一次真 chat/completions 探测（比 /models 靠谱）。
      const res = await window.axon.invoke('provider.test', { model: model.id });
      if (res.ok) {
        setTest({ tag: 'ok', latencyMs: res.latencyMs });
      } else {
        setTest({ tag: 'fail', error: res.error ?? '连接失败' });
      }
    } catch (e) {
      setTest({ tag: 'fail', error: e instanceof Error ? e.message : String(e) });
    }
    testTimer.current = setTimeout(() => setTest({ tag: 'idle' }), 6000);
  };

  // caps 展开时同步真值
  const openCaps = () => {
    setCtxVal(String(model.contextWindow ?? ''));
    setMaxVal(String(model.maxTokens ?? ''));
    setCapsOpen(true);
  };

  const commitCaps = () => {
    const ctx = ctxVal.trim() === '' ? undefined : Number(ctxVal);
    const max = maxVal.trim() === '' ? undefined : Number(maxVal);
    onSaveCaps({
      contextWindow: ctx !== undefined && Number.isFinite(ctx) ? ctx : undefined,
      maxTokens: max !== undefined && Number.isFinite(max) ? max : undefined,
    });
    setCapsOpen(false);
  };

  const hasCaps = model.contextWindow !== undefined || model.maxTokens !== undefined;

  return (
    <Fragment>
      <div className="provider-model-row">
        <div className="provider-model-id">
          <code>{model.id}</code>
          {model.name && model.name !== model.id ? (
            <span className="provider-model-name">{model.name}</span>
          ) : null}
        </div>
        <div className="provider-model-actions">
          <button
            type="button"
            className={`provider-pill ${isDefault ? 'on' : ''}`}
            onClick={onSetDefault}
            title="设为默认模型"
          >
            主对话
          </button>
          {model.reasoning ? (
            <span className="provider-pill on reasoning">推理</span>
          ) : null}
          <button
            type="button"
            className={`provider-icon-btn ${capsOpen ? 'active' : ''} ${hasCaps ? 'has-value' : ''}`}
            title="上下文 / 最大输出"
            onClick={() => (capsOpen ? setCapsOpen(false) : openCaps())}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          {test.tag === 'ok' ? (
            <span
              className="provider-test-badge ok"
              title={`该模型可用（chat/completions 返回 200，${test.latencyMs}ms）`}
            >
              ✓ {test.latencyMs}ms
            </span>
          ) : test.tag === 'fail' ? (
            <span className="provider-test-badge fail" title={test.error}>✗ 失败</span>
          ) : null}
          <button
            type="button"
            className="provider-icon-btn"
            title="测试连通性"
            disabled={test.tag === 'testing'}
            onClick={() => void runTest()}
          >
            {test.tag === 'testing' ? <span className="provider-spinner" /> : <PulseIcon />}
          </button>
          <button
            type="button"
            className="provider-icon-btn danger"
            title="删除"
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      {capsOpen ? (
        <div className="provider-model-caps">
          <label className="provider-field">
            <span className="provider-field-label">上下文窗口（tokens）</span>
            <input
              type="number"
              className="settings-input"
              min={0}
              step={1000}
              placeholder="128000（缺省）"
              value={ctxVal}
              onChange={(e) => setCtxVal(e.target.value)}
              onBlur={commitCaps}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">最大输出（tokens）</span>
            <input
              type="number"
              className="settings-input"
              min={0}
              step={1000}
              placeholder="8192（缺省）"
              value={maxVal}
              onChange={(e) => setMaxVal(e.target.value)}
              onBlur={commitCaps}
            />
          </label>
          <div className="provider-caps-hint">
            留空走缺省；填了之后该模型的花费才能正确计入预算。
          </div>
          <button type="button" className="provider-btn ghost" onClick={() => setCapsOpen(false)}>
            收起
          </button>
        </div>
      ) : null}
    </Fragment>
  );
}

// ─── 手动添加模型行 ───────────────────────────────────────────

function ManualAddRow({ onAdd }: { onAdd: (id: string, name?: string) => void }): ReactElement {
  const [show, setShow] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  const submit = () => {
    if (!id.trim()) return;
    onAdd(id.trim(), name.trim() || undefined);
    setId('');
    setName('');
    setShow(false);
  };

  if (!show) {
    return (
      <button type="button" className="provider-btn ghost provider-manual-trigger" onClick={() => setShow(true)}>
        + 手动添加
      </button>
    );
  }

  return (
    <div className="provider-manual-add">
      <input
        type="text"
        className="settings-input"
        placeholder="模型 ID（必填）"
        value={id}
        autoFocus
        onChange={(e) => setId(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setShow(false); }}
      />
      <input
        type="text"
        className="settings-input"
        placeholder="显示名（选填）"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <button type="button" className="provider-btn ghost" onClick={() => setShow(false)}>取消</button>
      <button type="button" className="provider-btn primary" disabled={!id.trim()} onClick={submit}>添加</button>
    </div>
  );
}

// ─── Provider Card ────────────────────────────────────────────

function ProviderCard(): ReactElement {
  const { config } = useSettings();
  const p = config?.config.provider;
  const env = config?.envOverrides ?? [];
  const models = p?.models ?? [];
  const defaultModel = p?.defaultModel;

  const { saving: modelsSaving, commit: commitModels } = useFieldPatch('provider.models');
  const { commit: commitDefault } = useFieldPatch('provider.defaultModel');

  const [expanded, setExpanded] = useState(true);

  // ── 拉取模型列表 ──
  type ProbePhase =
    | { tag: 'idle' }
    | { tag: 'loading' }
    | { tag: 'pick'; fetched: string[] }
    | { tag: 'err'; error: string }
    | { tag: 'done'; count: number };

  const [probe, setProbe] = useState<ProbePhase>({ tag: 'idle' });
  const [pickSelected, setPickSelected] = useState<Set<string>>(new Set());
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDoneTimer = () => {
    if (doneTimer.current !== null) { clearTimeout(doneTimer.current); doneTimer.current = null; }
  };

  useEffect(() => clearDoneTimer, []);

  const runFetch = async () => {
    setProbe({ tag: 'loading' });
    try {
      const res = await window.axon.invoke('provider.test', {});
      if (!res.ok) {
        setProbe({ tag: 'err', error: res.error ?? '连接失败' });
        return;
      }
      const existingIds = new Set(models.map((m) => m.id.toLowerCase()));
      const fresh = res.models.filter((id) => !existingIds.has(id.toLowerCase()));
      if (fresh.length === 0) {
        setProbe({ tag: 'done', count: 0 });
        doneTimer.current = setTimeout(() => setProbe({ tag: 'idle' }), 4000);
      } else {
        setPickSelected(new Set(fresh));
        setProbe({ tag: 'pick', fetched: fresh });
      }
    } catch (e) {
      setProbe({ tag: 'err', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const confirmPick = async () => {
    if (probe.tag !== 'pick') return;
    const toAdd = probe.fetched.filter((id) => pickSelected.has(id));
    const next = [
      ...models,
      ...toAdd.map((id): ModelSpec => ({ id })),
    ];
    await commitModels(next.length === 0 ? null : next);
    const count = toAdd.length;
    setProbe({ tag: 'done', count });
    setPickSelected(new Set());
    doneTimer.current = setTimeout(() => setProbe({ tag: 'idle' }), 4000);
  };

  const cancelPick = () => {
    setProbe({ tag: 'idle' });
    setPickSelected(new Set());
  };

  // ── 模型操作 ──
  const writeModels = (next: ModelSpec[]) => {
    void commitModels(next.length === 0 ? null : next);
  };

  const handleSetDefault = (modelId: string) => {
    void commitDefault(modelId === defaultModel ? null : modelId);
  };

  const handleDelete = (index: number) => {
    writeModels(models.filter((_, i) => i !== index));
  };

  const handleSaveCaps = (index: number, patch: Partial<ModelSpec>) => {
    writeModels(models.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };

  const handleManualAdd = (id: string, name?: string) => {
    if (models.some((m) => m.id.toLowerCase() === id.toLowerCase())) return;
    writeModels([...models, { id, ...(name ? { name } : {}) }]);
  };

  const protoLabel = 'OpenAI';
  const iconLetter = p?.name?.charAt(0).toUpperCase() ?? 'G';

  return (
    <div className={`provider-card ${expanded ? 'is-expanded' : ''}`}>
      {/* 卡片头部 */}
      <button
        type="button"
        className="provider-card-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="provider-card-title-wrap">
          <span className="provider-icon">{iconLetter}</span>
          <div className="provider-card-title-text">
            <div className="provider-card-name">
              {p?.name || '（未命名网关）'}
            </div>
            <div className="provider-card-sub">
              {protoLabel} · {models.length} 个模型
              {p?.baseUrl ? ` · ${p.baseUrl}` : ''}
            </div>
          </div>
        </div>
        <ChevronIcon open={expanded} />
      </button>

      {/* 展开内容 */}
      {expanded ? (
        <div className="provider-card-body">
          {/* 网关字段 */}
          <div className="provider-fields">
            <div className="provider-field-row-2col">
              <div className="provider-field">
                <label className="provider-field-label">名称</label>
                <ProviderInlineInput path="provider.name" placeholder="My Gateway" lock={envLock(env, 'provider.name')} />
              </div>
              <div className="provider-field">
                <label className="provider-field-label">API 协议</label>
                <div className="settings-input provider-proto-badge">OpenAI (openai-completions)</div>
              </div>
            </div>

            <div className="provider-field">
              <label className="provider-field-label">Base URL</label>
              <ProviderInlineInput
                path="provider.baseUrl"
                placeholder="https://api.example.com/v1"
                mono
                lock={envLock(env, 'provider.baseUrl')}
              />
            </div>

            <ApiKeyRow />


          </div>

          {/* 模型列表 */}
          <div className="provider-models-section">
            <div className="provider-models-header">
              <span className="provider-models-title">已配置模型（{models.length}）</span>
              <div className="provider-models-header-actions">
                <button
                  type="button"
                  className="provider-btn"
                  disabled={probe.tag === 'loading'}
                  onClick={runFetch}
                >
                  {probe.tag === 'loading' ? (
                    <>
                      <span className="provider-spinner" />
                      拉取中…
                    </>
                  ) : (
                    <>
                      <PulseIcon />
                      拉取模型列表
                    </>
                  )}
                </button>
                {probe.tag === 'done' ? (
                  <span className="provider-badge-ok">
                    {probe.count > 0 ? `✓ 已添加 ${probe.count} 个` : '✓ 已是最新'}
                  </span>
                ) : probe.tag === 'err' ? (
                  <span className="provider-badge-fail" title={probe.error}>✗ 连接失败</span>
                ) : null}
              </div>
            </div>

            {/* 拉取选择面板 */}
            {probe.tag === 'pick' ? (
              <div className="provider-pick-panel">
                <div className="provider-pick-header">
                  <span>发现 {probe.fetched.length} 个新模型，选择要添加的：</span>
                  <div className="provider-pick-selall">
                    <button type="button" className="provider-btn ghost sm" onClick={() => setPickSelected(new Set(probe.fetched))}>全选</button>
                    <button type="button" className="provider-btn ghost sm" onClick={() => setPickSelected(new Set())}>全不选</button>
                  </div>
                </div>
                <div className="provider-pick-list">
                  {probe.fetched.map((id) => (
                    <label key={id} className="provider-pick-item">
                      <input
                        type="checkbox"
                        checked={pickSelected.has(id)}
                        onChange={() => {
                          setPickSelected((s) => {
                            const next = new Set(s);
                            if (next.has(id)) next.delete(id); else next.add(id);
                            return next;
                          });
                        }}
                      />
                      <code>{id}</code>
                    </label>
                  ))}
                </div>
                <div className="provider-pick-footer">
                  <button type="button" className="provider-btn ghost" onClick={cancelPick}>取消</button>
                  <button
                    type="button"
                    className="provider-btn primary"
                    disabled={pickSelected.size === 0 || modelsSaving}
                    onClick={confirmPick}
                  >
                    添加所选（{pickSelected.size}）
                  </button>
                </div>
              </div>
            ) : null}

            {/* 模型行 */}
            <div className="provider-model-list">
              {models.length === 0 ? (
                <div className="provider-models-empty">
                  清单为空 —— 模型列表为空是静默降级到 faux 的原因之一
                </div>
              ) : null}
              {models.map((m, i) => (
                <ModelRow
                  key={`${m.id}-${i}`}
                  model={m}
                  isDefault={m.id === defaultModel}
                  onSetDefault={() => handleSetDefault(m.id)}
                  onDelete={() => handleDelete(i)}
                  onSaveCaps={(patch) => handleSaveCaps(i, patch)}
                />
              ))}
              <ManualAddRow onAdd={handleManualAdd} />
            </div>
          </div>

          {/* 删除整个 provider（危险区，清空配置） */}
        </div>
      ) : null}
    </div>
  );
}

// ─── 内联输入（复用 useFieldPatch，不用 SettingsRow 包装） ───

function ProviderInlineInput({
  path,
  placeholder,
  mono,
  lock,
}: {
  path: Parameters<typeof useFieldPatch>[0];
  placeholder?: string;
  mono?: boolean;
  lock?: ReturnType<typeof envLock>;
}): ReactElement {
  const { saving, error, commit } = useFieldPatch(path);
  const { config } = useSettings();

  const getVal = (): string => {
    if (!config) return '';
    const p = config.config.provider;
    if (path === 'provider.name') return p?.name ?? '';
    if (path === 'provider.baseUrl') return p?.baseUrl ?? '';
    return '';
  };

  const truth = lock ? (lock.value ?? '') : getVal();
  const [text, setText] = useState(truth);
  useEffect(() => setText(truth), [truth]);

  const submit = () => {
    const raw = text.trim();
    if (raw === truth) return;
    void commit(raw === '' ? null : raw).then((ok) => { if (!ok) setText(truth); });
  };

  return (
    <>
      <input
        className={['settings-input', mono ? 'mono' : ''].filter(Boolean).join(' ')}
        value={text}
        placeholder={placeholder}
        disabled={Boolean(lock) || saving}
        onChange={(e) => setText(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setText(truth); }}
      />
      {error ? <div className="provider-field-err">{error}</div> : null}
    </>
  );
}

// ─── 主 Pane ─────────────────────────────────────────────────

export function ModelsPane(): ReactElement {
  const { config } = useSettings();
  if (!config) return <div className="empty">读取配置中…</div>;

  const env = config.envOverrides;
  const hard = config.config.budgetUsd;
  const res = config.resolution;

  return (
    <section className="st-pane" data-pane="model">
      <h1 className="st-h1">模型与网关</h1>
      <p className="st-lede">
        Axon 只走 OpenAI 兼容网关（<code>openai-completions</code>）：一个网关 + 一份模型清单 +
        一条全局预算。
      </p>

      {/* 当前生效状态 */}
      <div className="st-sec">当前生效</div>
      <div className="grp">
        <SettingsRow
          title="执行模型"
          desc="配置缺失时 Axon 不崩：静默降级到 faux（脚本化假模型）。四种降级原因：未配 baseUrl / 未配 apiKey / 模型清单为空 / 默认模型不在清单内。"
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
      </div>

      {/* Provider Card */}
      <div className="st-sec">网关与模型</div>
      <ProviderCard />

      {/* 预算 */}
      <div className="st-sec">预算</div>
      <div className="grp">
        <InputField
          path="budgetUsd"
          title="全局硬线（累计）"
          desc="到线只挡新起点（spawn / prompt），在跑的那一轮不会被杀。进程内累计，不按自然日重置。留空或 0 = 关闭熔断。"
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

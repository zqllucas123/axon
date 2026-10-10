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
import { formatModelRef, type ModelSpec, type ProviderConfigView } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import {
  SettingsRow,
  envLock,
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

function ApiKeyRow({
  p,
  env,
  onSave,
}: {
  p: ProviderConfigView | undefined;
  env: readonly import('@axon/protocol').EnvOverride[];
  onSave: (apiKey: string | null) => void;
}): ReactElement {
  const lock = envLock(env, `providers.${p?.id ?? ''}.apiKey`);
  const isSet = p?.apiKeySet === true;
  const masked = p?.apiKeyMasked;

  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  const truthKey = `${isSet ? (masked ?? '') : ''}`;
  useEffect(() => { setText(''); }, [truthKey]);

  const submit = useCallback((): void => {
    const val = text.trim();
    if (val === '') return;
    onSave(val);
    setText('');
  }, [text, onSave]);

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
          disabled={Boolean(lock)}
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
            onClick={() => onSave(null)}
          >
            清除
          </button>
        ) : null}
      </div>
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
  /** 探测要打到哪个网关 —— 多 provider 下不能让它默认落到第一个。 */
  providerId: string;
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

/** 向量模型不参与对话：它没有 /chat/completions，被选成会话模型一发就 400。 */
const isEmbedding = (m: ModelSpec): boolean => m.kind === 'embedding';

function ModelRow({ model, providerId, isDefault, onSetDefault, onDelete, onSaveCaps }: ModelRowProps): ReactElement {
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
      // 传 model → 主进程对该模型发一次真探测（比 /models 靠谱）。
      // kind 必须传：向量模型要打 /embeddings，走 chat/completions 恒 400。
      const res = await window.axon.invoke('provider.test', {
        model: model.id,
        providerId,
        kind: isEmbedding(model) ? 'embedding' : 'chat',
      });
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
          {/* 向量模型不给「主对话」：它没有 /chat/completions，选了会话一发就 400。 */}
          {isEmbedding(model) ? null : (
            <button
              type="button"
              className={`provider-pill ${isDefault ? 'on' : ''}`}
              onClick={onSetDefault}
              title="设为默认模型"
            >
              主对话
            </button>
          )}
          <button
            type="button"
            className={`provider-pill ${isEmbedding(model) ? 'on embedding' : ''}`}
            onClick={() => onSaveCaps({ kind: isEmbedding(model) ? undefined : 'embedding' })}
            title={
              isEmbedding(model)
                ? '向量模型（点击取消标记）：不出现在会话模型选择里，供知识库检索用'
                : '标记为向量模型：打 /embeddings 探测，并进知识库的「向量模型」下拉'
            }
          >
            向量
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
              title={`该模型可用（${isEmbedding(model) ? '/embeddings' : '/chat/completions'} 返回 200，${test.latencyMs}ms）`}
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
      {/* 失败详情摆到行下而不是只塞 title：这条文案（HTTP 码 + 响应体片段）是
          「模型名错 / 鉴权失败 / 端点不存在」的唯一线索，藏在 tooltip 里等于没有。 */}
      {test.tag === 'fail' ? <div className="provider-test-error">{test.error}</div> : null}
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

function ProviderCard({
  p,
  defaultRef,
  initialExpanded,
}: {
  p: ProviderConfigView;
  /** 全局默认模型（`providerId:modelId`）—— 「主对话」胶囊全局只亮一个。 */
  defaultRef: string | undefined;
  initialExpanded: boolean;
}): ReactElement {
  const { config, saveProvider, deleteProvider, patch: patchConfig } = useSettings();
  const env = config?.envOverrides ?? [];
  const models = p.models ?? [];

  const [expanded, setExpanded] = useState(initialExpanded);
  const [confirmDel, setConfirmDel] = useState(false);

  // Convenience: build a minimal ProviderConfig for saveProvider.
  // p is ProviderConfigView (masked), so apiKey must be provided only when changed.
  const providerBase = () => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models as ModelSpec[] | undefined,
    defaultModel: p.defaultModel,
    headers: p.headers,
  });

  /**
   * 提交模型清单（`null` = 清空），必要时同一笔里清掉默认模型的指向。
   *
   * 必须**一次** saveProvider 落盘：provider 的写侧是「整体覆盖」，而
   * `providerBase()` 读的是上一次渲染的 props —— 拆成两次提交，后发的那次会拿
   * 旧 models 把前一次的改动抹掉。所以 clearDefault 只能在这一笔里一起写。
   */
  const commitModels = async (next: ModelSpec[] | null, clearDefault = false): Promise<void> => {
    const ok = await saveProvider({
      ...providerBase(),
      models: next ?? undefined,
      defaultModel: clearDefault ? undefined : p.defaultModel,
    });
    // 顺序不能反：defaultModelRef 的校验要拿 providers 解引用，provider 得先落盘。
    if (ok && clearDefault) await patchConfig({ defaultModelRef: null });
  };

  /**
   * 「主对话」= 全局默认模型，所以要同时写两处：provider 自己的 defaultModel
   * （让这张卡自洽）和顶层 defaultModelRef（resolveModelChoice 真正读的那个）。
   * 顺序不能反：defaultModelRef 的校验会拿 providers 解引用，provider 没先落盘
   * 就会被判 invalid-value 整批退回。
   */
  const commitDefault = async (model: string | null) => {
    const ok = await saveProvider({ ...providerBase(), defaultModel: model ?? undefined });
    if (!ok) return;
    await patchConfig({ defaultModelRef: model ? formatModelRef(p.id, model) : null });
  };

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
      const res = await window.axon.invoke('provider.test', { providerId: p.id });
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

  // 「主对话」比的是全局 ref，不是本卡的 defaultModel —— 否则多个网关会各自亮一个胶囊。
  const isDefaultModel = (modelId: string) => defaultRef === formatModelRef(p.id, modelId);

  const handleSetDefault = (modelId: string) => {
    void commitDefault(isDefaultModel(modelId) ? null : modelId);
  };

  const handleDelete = (index: number) => {
    const row = models[index];
    // 删掉「当前主对话」是同一个悬空问题，而且不止是难看：不带 clearDefault 的话
    // defaultModel 会指向一个已删的模型，saveProvider 的校验判它「不在清单里」
    // → 整批退回，用户点了删除却什么都没发生（静默失败）。
    const clearDefault = !!row && isDefaultModel(row.id);
    void commitModels(models.filter((_, i) => i !== index), clearDefault);
  };

  const handleSaveCaps = (index: number, patch: Partial<ModelSpec>) => {
    const row = models[index];
    const next = models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    // 把「当前主对话」标成向量模型 = defaultModelRef 悬空。同一笔里顺手清掉，
    // 而不是留一个指不到实体的 ref —— 那会让下次启动静默回落到别的模型，
    // 而设置页上什么都看不出来。
    const clearDefault = patch.kind === 'embedding' && !!row && isDefaultModel(row.id);
    void commitModels(next, clearDefault);
  };

  const handleManualAdd = (id: string, name?: string) => {
    if (models.some((m) => m.id.toLowerCase() === id.toLowerCase())) return;
    void commitModels([...models, { id, ...(name ? { name } : {}) }]);
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
                <ProviderInlineInput
                  value={p.name ?? ''}
                  placeholder="My Gateway"
                  lock={envLock(env, `providers.${p.id}.name`)}
                  onSave={(v) => void saveProvider({ ...providerBase(), name: v || undefined })}
                />
              </div>
              <div className="provider-field">
                <label className="provider-field-label">API 协议</label>
                <div className="settings-input provider-proto-badge">OpenAI (openai-completions)</div>
              </div>
            </div>

            <div className="provider-field">
              <label className="provider-field-label">Base URL</label>
              <ProviderInlineInput
                value={p.baseUrl ?? ''}
                placeholder="https://api.example.com/v1"
                mono
                lock={envLock(env, `providers.${p.id}.baseUrl`)}
                onSave={(v) => void saveProvider({ ...providerBase(), baseUrl: v || undefined })}
              />
            </div>

            <ApiKeyRow p={p} env={env} onSave={(key) => void saveProvider({ ...providerBase(), apiKey: key ?? '' })} />


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

            {/* 拉取失败详情（同模型行：HTTP 码 + 响应体片段不能只躺在 tooltip 里） */}
            {probe.tag === 'err' ? <div className="provider-test-error">{probe.error}</div> : null}

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
                    disabled={pickSelected.size === 0}
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
                  providerId={p.id}
                  isDefault={isDefaultModel(m.id)}
                  onSetDefault={() => handleSetDefault(m.id)}
                  onDelete={() => handleDelete(i)}
                  onSaveCaps={(patch) => handleSaveCaps(i, patch)}
                />
              ))}
              <ManualAddRow onAdd={handleManualAdd} />
            </div>
          </div>

          {/* 删除整个网关 */}
          <div className="provider-card-danger">
            {confirmDel ? (
              <>
                <span className="provider-field-hint">
                  删除「{p.name || p.id}」及其 {models.length} 个模型？API Key 会一并从加密存储移除。
                </span>
                <button type="button" className="provider-btn ghost" onClick={() => setConfirmDel(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="provider-btn danger"
                  onClick={() => void deleteProvider(p.id)}
                >
                  确认删除
                </button>
              </>
            ) : (
              <button type="button" className="provider-btn ghost danger" onClick={() => setConfirmDel(true)}>
                <TrashIcon />
                删除此网关
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── 内联输入（受控，字段失焦时回调 onSave） ───────────────────

function ProviderInlineInput({
  value,
  placeholder,
  mono,
  lock,
  onSave,
}: {
  value: string;
  placeholder?: string;
  mono?: boolean;
  lock?: ReturnType<typeof envLock>;
  onSave: (next: string) => void;
}): ReactElement {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const submit = () => {
    const raw = text.trim();
    if (raw === value) return;
    onSave(raw);
  };

  return (
    <>
      <input
        className={['settings-input', mono ? 'mono' : ''].filter(Boolean).join(' ')}
        value={text}
        placeholder={placeholder}
        disabled={Boolean(lock)}
        onChange={(e) => setText(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setText(value); }}
      />
    </>
  );
}

// ─── 主 Pane ─────────────────────────────────────────────────

/** 在已有 id 里挑一个不冲突的 `gatewayN`。 */
function nextProviderId(taken: readonly string[]): string {
  const set = new Set(taken);
  for (let i = 2; ; i += 1) {
    const id = `gateway${i}`;
    if (!set.has(id)) return id;
  }
}

export function ModelsPane(): ReactElement {
  const { config, saveProvider } = useSettings();
  if (!config) return <div className="empty">读取配置中…</div>;

  const env = config.envOverrides;
  const res = config.resolution;

  // legacy 单 provider 的兜底：迁移后 providers[] 恒有值，但 config.json 是用户
  // 可手改的文件，空数组时还得能加出第一张卡。
  const providers = config.config.providers?.length
    ? config.config.providers
    : config.config.provider
      ? [config.config.provider]
      : [];

  const addProvider = () => {
    const id = nextProviderId(providers.map((p) => p.id));
    // 空壳卡片：baseUrl / apiKey 留给用户在卡里填。saveProvider 按 id upsert，
    // 所以这一下就是「新增」。
    void saveProvider({ id, name: `网关 ${providers.length + 1}` });
  };

  return (
    <section className="st-pane" data-pane="model">
      <h1 className="st-h1">模型与网关</h1>
      <p className="st-lede">
        Axon 只走 OpenAI 兼容网关（<code>openai-completions</code>）：想接几个网关就配几个，
        每个网关自带一份模型清单。
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

      {/* 网关列表：一张卡一个 provider */}
      <div className="st-sec">网关与模型</div>
      {providers.length === 0 ? (
        <div className="provider-list-empty">
          还没有网关 —— 添加一个 OpenAI 兼容网关，填入 Base URL 与 API Key。
        </div>
      ) : (
        providers.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            defaultRef={config.config.defaultModelRef ?? undefined}
            initialExpanded={providers.length === 1}
          />
        ))
      )}
      <button type="button" className="provider-add-btn" onClick={addProvider} data-smoke="add-provider">
        <span className="provider-add-plus">+</span>
        <span>添加网关</span>
      </button>

    </section>
  );
}

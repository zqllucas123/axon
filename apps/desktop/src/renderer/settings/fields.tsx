/**
 * S8 受控件 —— 设置窗里所有「能改的东西」都从这里出（MU-3 切片 3，W-D）。
 *
 * ── 三条语义写死在这一层，pane 里不许各写一遍 ──
 *
 * 1. **没有保存按钮**（UX `03-设置界面设计.md` §4.1）：改完即 `config.patch`。
 * 2. **失败即回滚**（同 §4.1 原文「而不是假装成功」）：乐观置值 → 若
 *    `accepted=false`，控件回落到**快照真值**并在行内标红显示 `errors[].message`。
 *    实现上靠一个不变量做到：提交结束后一律丢掉本地 draft ——
 *    成功时快照已经是新值，失败时快照还是旧值，两种情况都等于「显示真值」。
 * 3. **env 三态**（§4.2，本屏最重要的设计点）：`config.get` 的 `envOverrides`
 *    里出现的 path ⇒ 控件 disabled + 显示 env 的值 + 说明「被 AXON_* 覆盖，
 *    改动不会生效」。UI 因此**根本不发**该字段，主进程的 `env-locked` 只作兜底。
 *
 * 还有一条排版硬规矩（§2.3）：**每一行必须有一句灰字说明**。Axon 的设置项
 * 几乎全都改变安全边界（审批档、并发、预算、裁决权），所以 `SettingsRow`
 * 的 `desc` 是**必填 prop** —— 想省说明的话类型检查就会先拦下来。
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ConfigPatchPath, EnvOverride } from '@axon/protocol';
import { Icon } from '../icons.tsx';
import { useSettings } from './SettingsStore.tsx';

// ─────────────────────────────────────────────────────────────
// 公共：env 锁与字段级提交
// ─────────────────────────────────────────────────────────────

/** 该路径是否被环境变量锁定；锁定则返回那条覆盖记录（含 env 名与生效值）。 */
export function envLock(
  overrides: readonly EnvOverride[],
  path: ConfigPatchPath,
): EnvOverride | undefined {
  return overrides.find((o) => o.path === path);
}

interface FieldPatch {
  /** 正在提交（乐观值已经在屏上，真值还没回来）。 */
  saving: boolean;
  /** 上一次被拒的原因（来自主进程 `ConfigIssue.message`）；成功后清空。 */
  error: string | null;
  /** 提交一个值；`null` = 清除该字段（回到缺省）。返回是否被接受。 */
  commit: (value: unknown) => Promise<boolean>;
}

/**
 * 一个字段的写路径。json 整体替换字段（headers / models）的编辑面直接用它。
 *
 * 为什么错误从 store 的 `issues` 里捞而不是各自存：`config.patch` 的校验是
 * **整批**的（任一非 env-locked 错误 ⇒ 整批不落盘），所以「我这一行为什么没写进去」
 * 有可能是别的字段的锅 —— 按 path 过滤能如实显示到底是谁被拒。
 */
export function useFieldPatch(path: ConfigPatchPath): FieldPatch {
  const { patch, issues } = useSettings();
  const [saving, setSaving] = useState(false);
  const own = issues.find((i) => i.path === path);

  return {
    saving,
    error: own ? own.message : null,
    commit: async (value: unknown): Promise<boolean> => {
      setSaving(true);
      try {
        // 只发自己这一个字段：一次 patch 携带多字段会让「谁把整批拖挂了」
        // 无法归因（config-store 是整批不落盘的语义）。
        return await patch({ [path]: value });
      } finally {
        setSaving(false);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 行壳（.srow）
// ─────────────────────────────────────────────────────────────

export interface SettingsRowProps {
  /** 行标题。 */
  title: ReactNode;
  /**
   * 一句说明（**必填**，UX 03 §2.3）：默认值、被谁覆盖、边界语义。
   * 实现细节不写这里 —— 那是标注（`ui.annotations`）的活。
   */
  desc: ReactNode;
  /** 标题右侧的小标签（「架构不变量」「只读」…）。 */
  tag?: ReactNode;
  /** 右侧控件。 */
  children?: ReactNode;
  /** 被环境变量锁定时的那条覆盖记录（置灰 + 说明的唯一来源）。 */
  lock?: EnvOverride | undefined;
  /** 行内错误（写入被拒的真实原因）。 */
  error?: string | null;
  saving?: boolean;
  /** 控件比文案高时（多行编辑面）顶部对齐。 */
  top?: boolean;
  /** 控件占满整行宽度（json 编辑面）。 */
  col?: boolean;
  smoke?: string;
}

export function SettingsRow({
  title,
  desc,
  tag,
  children,
  lock,
  error,
  saving,
  top,
  col,
  smoke,
}: SettingsRowProps): ReactElement {
  const cls = [
    'srow',
    top ? 'top' : '',
    col ? 'col' : '',
    lock ? 'is-locked' : '',
    error ? 'is-err' : '',
    saving ? 'is-saving' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} {...(smoke ? { 'data-smoke': smoke } : {})}>
      <div className="txt">
        <div className="t">
          {title}
          {tag}
        </div>
        <div className="d">
          {desc}
          {lock ? (
            <span className="env-note">
              被环境变量 <code>{lock.env}</code> 覆盖（当前生效值
              {lock.value ? (
                <>
                  ：<code>{lock.value}</code>
                </>
              ) : null}
              ），在这里改动不会生效 —— 要改先去掉该变量再重启。
            </span>
          ) : null}
          {error ? <span className="field-err">{error}</span> : null}
        </div>
      </div>
      {children ? <div className="ctl">{children}</div> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 1. 开关（.tgl）
// ─────────────────────────────────────────────────────────────

export function ToggleField({
  path,
  title,
  desc,
  value,
  lock,
  smoke,
}: {
  path: ConfigPatchPath;
  title: ReactNode;
  desc: ReactNode;
  /** 快照真值。 */
  value: boolean;
  lock?: EnvOverride | undefined;
  smoke?: string;
}): ReactElement {
  const { saving, error, commit } = useFieldPatch(path);
  const [draft, setDraft] = useState<boolean | null>(null);
  const shown = draft ?? value;

  return (
    <SettingsRow
      title={title}
      desc={desc}
      lock={lock}
      error={error}
      saving={saving}
      {...(smoke ? { smoke } : {})}
    >
      <button
        type="button"
        className={`tgl${shown ? ' on' : ''}`}
        aria-pressed={shown}
        disabled={Boolean(lock) || saving}
        data-smoke={smoke ? `${smoke}-tgl` : undefined}
        onClick={() => {
          const next = !shown;
          setDraft(next); // 乐观：开关必须立刻动，否则像没点上
          void commit(next).finally(() => setDraft(null)); // 回落真值（成功=新值，失败=旧值）
        }}
      />
    </SettingsRow>
  );
}

// ─────────────────────────────────────────────────────────────
// 2. 下拉（.sel —— 外观是按钮，不是原生 <select>）
// ─────────────────────────────────────────────────────────────

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** 置灰项（本片未实现的枚举值，如暗色主题）。 */
  disabled?: boolean;
  /** 置灰原因，跟在标签后面。 */
  note?: string;
}

/**
 * 按钮形下拉的**展现层**（不绑配置字段）。
 *
 * 原型 §2.2 明确写了「<b>外观是按钮，不是原生 select</b>」：原生 select 在 macOS
 * 上是系统蓝 + 系统字，与暖灰风格对不齐。浮层复用主窗的 `.menu` / `.menu-item`
 * （components.css），不另造一套。
 *
 * 单抽出来是因为「仲裁者」那一行不走 config（它是 `ledger.setAdoptionPolicy`），
 * 但外观必须与其他下拉完全一致——同一个控件长两个样子是最便宜的不一致。
 */
export function Picker<T extends string>({
  label,
  options,
  value,
  onPick,
  disabled,
  smoke,
  extra,
}: {
  /** 按钮上显示的文案。 */
  label: string;
  options: ReadonlyArray<SelectOption<T>>;
  value?: T | undefined;
  onPick: (value: T) => void;
  disabled?: boolean;
  smoke?: string;
  /** 菜单顶部的额外一项（如「跟随缺省」）。 */
  extra?: { label: string; current: boolean; onPick: () => void };
}): ReactElement {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // 点外面关：浮层没有遮罩（遮罩会挡住旁边那行的说明，而设置页是要对照着读的）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button
        type="button"
        className="sel"
        disabled={disabled === true}
        {...(smoke ? { 'data-smoke': smoke } : {})}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <Icon name="chevD" size={14} />
      </button>
      {open ? (
        <div className="menu" style={{ top: '34px', right: 0, minWidth: '190px' }}>
          {extra ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                extra.onPick();
              }}
            >
              {extra.label}
              {extra.current ? <span className="mk">当前</span> : null}
            </button>
          ) : null}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="menu-item"
              disabled={o.disabled === true}
              style={o.disabled === true ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              onClick={() => {
                if (o.disabled === true) return;
                setOpen(false);
                onPick(o.value);
              }}
            >
              {o.label}
              {o.note ? <span className="mk">{o.note}</span> : null}
              {!o.note && o.value === value ? <span className="mk">当前</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 绑配置字段的下拉（外观同 `Picker`，多一层 patch/回滚/env 三态）。 */
export function SelectField<T extends string>({
  path,
  title,
  desc,
  value,
  options,
  lock,
  clearable,
  smoke,
  toStored,
}: {
  path: ConfigPatchPath;
  title: ReactNode;
  desc: ReactNode;
  value: T | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  lock?: EnvOverride | undefined;
  /** 允许「跟随缺省」（写 null 清字段）。 */
  clearable?: boolean;
  smoke?: string;
  /**
   * 选项值 → 存储值。选项值必须是字符串（React key 与比较都靠它），而
   * `approvalTimeoutMs` / `ui.fontSize` 这类字段在协议里是 **number** ——
   * 不转一下就会被 `config-store` 以 invalid-type 整批拒掉。
   */
  toStored?: (value: T) => unknown;
}): ReactElement {
  const { saving, error, commit } = useFieldPatch(path);

  const shownLabel = lock
    ? (lock.value ?? '（由环境变量提供）')
    : (options.find((o) => o.value === value)?.label ?? '跟随缺省');

  return (
    <SettingsRow
      title={title}
      desc={desc}
      lock={lock}
      error={error}
      saving={saving}
      {...(smoke ? { smoke } : {})}
    >
      <Picker<T>
        label={shownLabel}
        options={options}
        value={value}
        disabled={Boolean(lock) || saving}
        {...(smoke ? { smoke: `${smoke}-sel` } : {})}
        {...(clearable
          ? {
              extra: {
                label: '跟随缺省',
                current: value === undefined,
                onPick: () => void commit(null),
              },
            }
          : {})}
        onPick={(next) => {
          if (next !== value) void commit(toStored ? toStored(next) : next);
        }}
      />
    </SettingsRow>
  );
}

// ─────────────────────────────────────────────────────────────
// 3. 分段控件（.seg.sm —— 二/三选一，比下拉少一次点击）
// ─────────────────────────────────────────────────────────────

export function SegField<T extends string>({
  path,
  title,
  desc,
  value,
  options,
  lock,
  smoke,
}: {
  path: ConfigPatchPath;
  title: ReactNode;
  desc: ReactNode;
  value: T | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  lock?: EnvOverride | undefined;
  smoke?: string;
}): ReactElement {
  const { saving, error, commit } = useFieldPatch(path);
  const [draft, setDraft] = useState<T | null>(null);
  const shown = draft ?? value;

  return (
    <SettingsRow
      title={title}
      desc={desc}
      lock={lock}
      error={error}
      saving={saving}
      {...(smoke ? { smoke } : {})}
    >
      <div className="seg sm" data-smoke={smoke ? `${smoke}-seg` : undefined}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={shown === o.value ? 'is-on' : ''}
            disabled={o.disabled === true || Boolean(lock) || saving}
            title={o.note}
            onClick={() => {
              if (o.value === shown) return;
              setDraft(o.value);
              void commit(o.value).finally(() => setDraft(null));
            }}
          >
            {o.label}
            {o.note ? <span className="n">（{o.note}）</span> : null}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. 输入框（.inp）
// ─────────────────────────────────────────────────────────────

/**
 * 文本 / 数字输入。提交时机是 **blur 或 Enter**（不是每敲一个字母就写盘：
 * 那会把半截 URL 写进配置，还会让校验错误在打字途中闪烁）。
 *
 * 数字字段走同一个组件：`kind='number'` 时空串 = 清除字段（回到缺省），
 * 非数字在本地就拦下来，不浪费一次 IPC。
 */
export function InputField({
  path,
  title,
  desc,
  value,
  kind = 'text',
  placeholder,
  suffix,
  width = 'md',
  mono,
  lock,
  smoke,
  /** 值 → 存储值的换算（如「分钟 → 毫秒」）；不给则原样。 */
  toStored,
  /** 存储值 → 显示值（与 toStored 互逆）。 */
  fromStored,
}: {
  path: ConfigPatchPath;
  title: ReactNode;
  desc: ReactNode;
  value: string | number | undefined;
  kind?: 'text' | 'number';
  placeholder?: string;
  suffix?: ReactNode;
  width?: 'md' | 'sm';
  mono?: boolean;
  lock?: EnvOverride | undefined;
  smoke?: string;
  toStored?: (n: number) => number;
  fromStored?: (n: number) => number;
}): ReactElement {
  const { saving, error, commit } = useFieldPatch(path);

  const truth = ((): string => {
    if (lock) return lock.value ?? '';
    if (value === undefined || value === '') return '';
    if (kind === 'number' && typeof value === 'number') {
      return String(fromStored ? fromStored(value) : value);
    }
    return String(value);
  })();

  const [text, setText] = useState(truth);
  const [local, setLocal] = useState<string | null>(null);
  // 真值变了就跟随（另一个窗口改了同一项、或 config.changed 带回归一化后的值）。
  useEffect(() => {
    setText(truth);
    setLocal(null);
  }, [truth]);

  const submit = (): void => {
    const raw = text.trim();
    if (raw === truth) return; // 没改就别写盘（也别刷一次 config.changed）
    if (kind === 'number') {
      if (raw === '') {
        void commit(null); // 清空 = 回到缺省
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setLocal('请输入数字'); // 本地拦住，不浪费一次 IPC
        return;
      }
      setLocal(null);
      void commit(toStored ? toStored(n) : n).then((ok) => {
        if (!ok) setText(truth); // 回滚到快照真值（03 §4.1）
      });
      return;
    }
    setLocal(null);
    void commit(raw === '' ? null : raw).then((ok) => {
      if (!ok) setText(truth);
    });
  };

  return (
    <SettingsRow
      title={title}
      desc={desc}
      lock={lock}
      error={local ?? error}
      saving={saving}
      {...(smoke ? { smoke } : {})}
    >
      <input
        className={['inp', mono ? 'mono' : '', width === 'sm' ? 'w-sm' : 'w-md']
          .filter(Boolean)
          .join(' ')}
        value={text}
        placeholder={placeholder}
        disabled={Boolean(lock) || saving}
        data-smoke={smoke ? `${smoke}-inp` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setText(truth);
        }}
      />
      {suffix ? <span className="tag">{suffix}</span> : null}
    </SettingsRow>
  );
}

/**
 * 密钥输入（`provider.apiKey`）。
 *
 * 与 InputField 的差别只有一个，但很要紧：**读侧永远只有掩码**
 * （`AxonConfigView.apiKeyMasked`，明文在类型上就到不了渲染层）。所以它
 * 不是「显示当前值的输入框」，而是「显示掩码 + 输入新值」两态。
 */
export function SecretField({
  path,
  title,
  desc,
  masked,
  isSet,
  lock,
  smoke,
}: {
  path: ConfigPatchPath;
  title: ReactNode;
  desc: ReactNode;
  masked: string | undefined;
  isSet: boolean;
  lock?: EnvOverride | undefined;
  smoke?: string;
}): ReactElement {
  const { saving, error, commit } = useFieldPatch(path);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  return (
    <SettingsRow
      title={title}
      desc={desc}
      lock={lock}
      error={error}
      saving={saving}
      {...(smoke ? { smoke } : {})}
    >
      {editing && !lock ? (
        <>
          <input
            className="inp mono w-md"
            value={text}
            autoFocus
            placeholder="粘贴新的 API Key"
            disabled={saving}
            data-smoke={smoke ? `${smoke}-inp` : undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                setText('');
              }
            }}
          />
          <button
            type="button"
            className="btn sm primary"
            disabled={text.trim() === '' || saving}
            onClick={() => {
              void commit(text.trim()).then((ok) => {
                if (ok) {
                  setEditing(false);
                  setText('');
                }
              });
            }}
          >
            保存
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setEditing(false);
              setText('');
            }}
          >
            取消
          </button>
        </>
      ) : (
        <>
          <span className="path">
            {lock ? (lock.value ?? '（环境变量提供）') : isSet ? (masked ?? 'sk-***') : '未配置'}
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={Boolean(lock)}
            data-smoke={smoke ? `${smoke}-edit` : undefined}
            onClick={() => setEditing(true)}
          >
            {isSet ? '更换' : '填写'}
          </button>
          {isSet && !lock ? (
            <button type="button" className="btn sm ghost" onClick={() => void commit(null)}>
              清除
            </button>
          ) : null}
        </>
      )}
    </SettingsRow>
  );
}

// ─────────────────────────────────────────────────────────────
// 5. 只读路径 + 动作（.path）
// ─────────────────────────────────────────────────────────────

/**
 * 只读路径胶囊 + 一个动作按钮（打开目录 / 在访达中显示）。
 *
 * 为什么路径不可编辑：`AXON_CONFIG` / `AXON_ROLES_DIR` 决定的是「读哪个文件」，
 * 不是某个字段的值 —— 它们在启动时就被解析完了，界面上改它只会造出
 * 「显示的和真在用的不是一个」这种最难排查的状态。原型那两个「更改」按钮
 * 因此删掉（MU-3 §4.4 的删除清单）。
 */
export function PathRow({
  title,
  desc,
  path,
  action,
  smoke,
}: {
  title: ReactNode;
  desc: ReactNode;
  /** 真实路径（来自 `ConfigSnapshot.paths` / `storage.status.root`）。 */
  path: string;
  /** 右侧动作；不给就是纯只读行。 */
  action?: { label: string; onClick: () => void };
  smoke?: string;
}): ReactElement {
  return (
    <SettingsRow title={title} desc={desc} {...(smoke ? { smoke } : {})}>
      <span className="path" title={path}>
        {path}
      </span>
      {action ? (
        <button
          type="button"
          className="btn sm"
          data-smoke={smoke ? `${smoke}-act` : undefined}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </SettingsRow>
  );
}

// ─────────────────────────────────────────────────────────────
// 附：json 整体替换字段的编辑面（headers / models）
// ─────────────────────────────────────────────────────────────

/**
 * 「读整体 → 改 → 整体写回」的编辑面（R-4）。
 *
 * `provider.headers` / `provider.models` 在协议里是**整体替换**的 json 字段，
 * 所以这里以「最近一次 `config.get` / `config.changed` 的快照」为基编辑：
 * 展开时从真值拷一份 draft，提交时整体写回；收到新快照（另一窗口也在改）
 * 且自己没在编辑时，直接跟随重绘 —— 最后写入者胜，这条写在行内说明里。
 */
export function useJsonDraft<T>(truth: T, key: string): {
  draft: T;
  setDraft: (next: T) => void;
  dirty: boolean;
  reset: () => void;
} {
  const [state, setState] = useState<{ key: string; value: T; dirty: boolean }>({
    key,
    value: truth,
    dirty: false,
  });
  // 真值换了（另一窗口写了 / 自己提交成功）且本地没有未提交改动 ⇒ 跟随真值。
  useEffect(() => {
    setState((s) => (s.dirty ? s : { key, value: truth, dirty: false }));
  }, [truth, key]);

  return {
    draft: state.value,
    setDraft: (next: T) => setState({ key, value: next, dirty: true }),
    dirty: state.dirty,
    reset: () => setState({ key, value: truth, dirty: false }),
  };
}

/** 危险动作的二次确认（UX 03 §4.5：整组红描边 + 二次确认 + 写清不动什么）。 */
export function DangerAction({
  label,
  confirmText,
  onConfirm,
  smoke,
}: {
  label: string;
  confirmText: string;
  onConfirm: () => void;
  smoke?: string;
}): ReactElement {
  const [armed, setArmed] = useState(false);
  const id = useId();

  if (!armed) {
    return (
      <button
        type="button"
        className="btn sm danger"
        data-smoke={smoke}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" aria-describedby={id}>
      <span className="q" id={id}>
        {confirmText}
      </span>
      <button
        type="button"
        className="btn sm danger"
        data-smoke={smoke ? `${smoke}-confirm` : undefined}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        确认
      </button>
      <button type="button" className="btn sm ghost" onClick={() => setArmed(false)}>
        取消
      </button>
    </div>
  );
}

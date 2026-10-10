/**
 * S0 新建会话 —— 应用启动的落地屏（逐值对齐 docs/new_ux/01-home.html）。
 *
 * 形态是「空态 + 底部固定输入区」，不是一页表单：大片留白放四张建议卡，
 * 输入区钉在底部，工作区上下文收敛成它上方的三个 chip。骨架直接沿用
 * S2 会话屏的 `body > col > [canvas + composer-wrap]`（全仓既有的
 * 「底部固定输入区」模式），不另造一套。
 *
 * 为什么没有「标题」输入框：会话的题目就是**任务本身的第一行**。
 * 让人为起名再写一遍是多余的；题目仍可事后改（S2 会话条、S6 列表）。
 *
 * 三处与旧版不同，都需要知道「为什么」：
 *
 *   1. **工作区默认是临时目录**（`workspace.newTemp`），不是 config.defaultCwd。
 *      普通会话 => 不归属任何项目 => 不该在用户的项目目录里乱跑。主进程为每次
 *      会话分配一个独立的 `<tmpdir>/axon-xxxx`，退出时清掉（见 main/workspace.ts）。
 *
 *   2. **「怎么执行」从三张卡折叠进工具栏的 popover**。卡片占掉了半屏，
 *      而九成会话用默认档 —— 多数人不需要每次都被问一遍「要不要组队」。
 *
 *   3. **执行模式（Single / 指定团队）与执行引擎（Axon / Claude / …）是两回事**。
 *      设计稿的引擎 popover 在协议里**没有对应物**（`SessionExecutor` 只有
 *      engine/team/adhoc，那是模式维度）。引擎是另一条正交的维度：`engineId`（M9）。
 *      popover 里能选的是 Axon 与「已安装且已接入」的外部工具（目前是 Claude Code），
 *      其余置灰写明原因 —— 标出位置的存在，但不撒谎。外部引擎只支持单兵模式，
 *      所以两个 popover 互斥联动：选外部引擎回 Single，选团队回 Axon。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import { ComposerBar } from './ComposerBar.tsx';
import { EnginePicker } from './EnginePicker.tsx';
import { ModelSelect } from './ModelPicker.tsx';
import type { SessionExecutor } from '@axon/protocol';

/** 工作区元信息（`workspace.inspect` 的结果形状）。 */
interface WorkspaceInfo {
  path: string;
  folderName: string;
  branch: string | null;
  isGit: boolean;
}

/**
 * 空态四张建议卡 —— 点一下把模板文案预填进输入框（光标留末尾），**不自动发**。
 * 预填而不是直发：用户点的是「我要做这类事」，不是「就照这句话执行」。
 */
const SUGGESTS: Array<{ title: string; desc: string; seed: string }> = [
  { title: '修复 Bug', desc: '定位并修复代码中的问题', seed: '修复 Bug：' },
  { title: '开发新功能', desc: '从需求到可运行代码', seed: '开发新功能：' },
  { title: '代码审查', desc: '分析质量、安全与性能', seed: '代码审查：' },
  { title: '重构优化', desc: '改善结构不改变行为', seed: '重构优化：' },
];

/**
 * 执行模式两档（`SessionExecutor` 的 `adhoc` 不在列：当场挑成员属 M4 之后的
 * 协作动作，本次不做 —— 缺席而不是置灰，因为它在新版信息架构里没有位置）。
 */
const MODES: Array<{ id: SessionExecutor; label: string; desc: string }> = [
  { id: 'engine', label: 'Single', desc: '不组队，Axon 自己干' },
  { id: 'team', label: '指定团队', desc: '按既有编队开工，lead 拆解后分派' },
];

/** 会话标题 = 任务第一行，裁到 30 字（没有标题输入框，题目就是任务）。 */
function titleOfTask(task: string): string {
  const first = (task.trim().split('\n')[0] ?? '').trim();
  return first.length > 30 ? `${first.slice(0, 30)}…` : first;
}

export function S0NewSession(): ReactElement {
  const { config, teams, projects, projectContext, clearProjectContext, createSession, pickProjectWorkspace, pickFiles, go } =
    useApp();
  const [task, setTask] = useState('');
  const [picked, setPicked] = useState<SessionExecutor | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  // 执行引擎：null = Axon 内置；否则是外部 Agent 工具的 id（随 session.create 下发）。
  const [engineId, setEngineId] = useState<string | null>(null);
  // 本会话模型（`providerId:modelId`）：null = 跟全局默认。外部引擎自带模型配置，
  // 这个值只对 Axon 内置引擎有意义，所以选外部引擎时清掉（与 teamId 同一条联动规则）。
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  // 这次会话的工作目录。普通会话由下面的 effect 向主进程要一个临时目录；
  // 项目会话不用它 —— 目录锁在项目上（用户手选的路径也落在这里）。
  const [pickedCwd, setPickedCwd] = useState<string | null>(null);
  const [cwdInfo, setCwdInfo] = useState<WorkspaceInfo | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // 默认选中项来自配置（defaultExecutor）—— S8 改配置要立刻反映到这张屏，不许写死 engine。
  const executor = picked ?? config?.config.defaultExecutor ?? 'engine';
  const project = projectContext
    ? (projects.entries.find((p) => p.id === projectContext.projectId) ?? null)
    : null;
  const cwd = project ? project.cwd : pickedCwd;

  /**
   * 普通会话进屏时领一个临时工作目录。
   *
   * 两个判断都别换：**判据用 `projectContext` 不是 `project`** —— `projects` 是
   * 异步加载的，从项目入口刚进屏那一刻 `project` 可能还没找到，按它判就会白领一个
   * 临时目录（虽然退出时会清，但它根本不会被用上）；`projectContext` 是进屏时就
   * 置好的，不会晚到。
   *
   * 依赖用 `projectContext?.projectId` 而不是对象本身：对象每次 render 都是新引用。
   */
  useEffect(() => {
    if (projectContext) return;
    let alive = true;
    void window.axon
      .invoke('workspace.newTemp', {})
      .then((t) => {
        if (!alive) return;
        setPickedCwd(t.path);
        // 临时目录必然不是 git 仓库，先把已知部分填上，省一次 IPC 往返与一次闪烁。
        setCwdInfo({ path: t.path, folderName: t.folderName, branch: null, isGit: false });
      })
      .catch(() => {
        /* 拿不到就保持空态（chip 显示占位），不编一个假路径出来。 */
      });
    return () => {
      alive = false;
    };
  }, [projectContext?.projectId]);

  /**
   * 工作目录一变就重新探测元信息（文件夹名 + git 分支）。
   * 未授权路径会被主进程拒绝（安全边界见 main/workspace.ts）—— 这里静默降级成
   * 「没有分支可显示」，因为 chip 本身(still)有目录名可展示，不是致命缺口。
   */
  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    void window.axon
      .invoke('workspace.inspect', { path: cwd })
      .then((info) => {
        if (alive) setCwdInfo(info);
      })
      .catch(() => {
        if (alive) setCwdInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

  // 点 popover 外面收起。用 mousedown 而不是 click：click 会先冒泡到这里，
  // 把「点选项」当成「点外面」，选项永远选不中。
  useEffect(() => {
    if (!modeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.s0-mode')) setModeOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [modeOpen]);

  const chooseWorkspace = async () => {
    const path = await pickProjectWorkspace();
    if (path) setPickedCwd(path); // inspect 由上面的 effect 接住，不在这里重复写一遍
  };

  const addAttachments = async () => {
    const paths = await pickFiles();
    if (paths.length > 0) setAttachments((prev) => {
      const existing = new Set(prev);
      return [...prev, ...paths.filter((p) => !existing.has(p))];
    });
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  const fillSuggestion = (seed: string) => {
    setTask(seed);
    const el = textRef.current;
    if (!el) return;
    el.focus();
    // 光标留在模板之后，用户接着写就行（不 select 全选，否则一敲字模板就没了）。
    requestAnimationFrame(() => el.setSelectionRange(seed.length, seed.length));
  };

  const needTeam = executor === 'team';
  const ready = task.trim().length > 0 && (!needTeam || teamId !== null) && !busy;

  const start = async () => {
    if (!ready) return;
    setBusy(true);
    const s = await createSession({
      title: titleOfTask(task),
      // 项目会话只传 projectId，cwd 由主进程从项目解析（防伪造归属）；否则用这次的工作目录。
      ...(project ? { projectId: project.id } : cwd ? { cwd } : {}),
      executor,
      ...(needTeam && teamId ? { teamId } : {}),
      ...(engineId ? { engineId } : {}),
      // 外部引擎自带模型配置，modelRef 对它没意义（联动里已清，这里兜一道）。
      ...(modelRef && !engineId ? { modelRef } : {}),
      initialPrompt: task.trim(),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    setBusy(false);
    if (s) { setTask(''); setAttachments([]); }
  };

  // 第三枚 chip（分支）显不显示：项目会话由**项目类别**决定（local 项目建的时候
  // 就声明了它不是版本控制目录），普通会话按实际探测结果。
  const showBranch = !!cwdInfo?.branch && (!project || project.kind === 'git');

  return (
    <div className="body">
      <div className="col">
        <section className="canvas">
          <div className="s0-empty">
            <svg
              className="s0-mark"
              viewBox="0 0 64 64"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 44c-4-2-8-7-8-14a20 20 0 0 1 40 0c0 7-4 12-8 14" />
              <path d="M24 52h16M32 44v8" />
              <circle cx="25" cy="30" r="2" fill="currentColor" stroke="none" />
              <circle cx="39" cy="30" r="2" fill="currentColor" stroke="none" />
            </svg>
            <div className="s0-headline">你想让 Axon 做什么？</div>
            <div className="s0-sub">描述任务，选择执行方式，让 Agent 团队开始工作</div>
            <div className="suggest-grid">
              {SUGGESTS.map((s) => (
                <button
                  key={s.title}
                  className="suggest-pill"
                  data-smoke={`suggest-${s.title}`}
                  onClick={() => fillSuggestion(s.seed)}
                >
                  <strong>{s.title}</strong>
                  {s.desc}
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="composer-wrap">
          {/* 项目上下文横幅：从项目入口进来时才有（smoke 的 project-context 断言靠它）。 */}
          {project ? (
            <div className="proj-banner" data-smoke="project-context">
              <Icon name="folder" size={14} />
              <span className="pb-text">
                正在 <b>{project.name}</b> 项目下新建会话
              </span>
              <span className="spacer" />
              <button className="act" onClick={clearProjectContext} data-smoke="project-context-exit">
                退出项目
              </button>
            </div>
          ) : null}

          {/* 工作区上下文条：文件夹名 + 本地 + git 分支，与输入框连成一体。
              点条上的目录名或右侧「+」都能换目录；项目会话下目录锁在项目上，不给切换入口。 */}
          <div className="cwd-bar attached" data-smoke="session-cwd" title={cwd ?? ''}>
            <div className="cwd-pill">
              <button
                className="cwd-item"
                onClick={() => void chooseWorkspace()}
                disabled={!!project}
                data-smoke="session-cwd-pick"
                title={project ? '项目会话的工作目录锁在项目上' : '点击切换这次会话的工作目录'}
              >
                <Icon name="folder" size={14} />
                <span className="context-label">{cwdInfo?.folderName ?? '…'}</span>
              </button>
              <span className="cwd-item">
                <Icon name="monitor" size={14} />
                <span className="context-label">本地</span>
              </span>
              {showBranch ? (
                <span className="cwd-item">
                  <Icon name="branch" size={14} />
                  <span className="context-label">{cwdInfo!.branch}</span>
                  <span className="context-detail">工作分支</span>
                </span>
              ) : null}
              {/* 已选团队：和目录/分支同处一枚胶囊，复用 .cwd-item 的竖分隔线。
                  点 × 清除时把模式拨回 engine —— 否则会留下「team 模式但没有团队」的
                  卡死态（ready 恒为 false，发送按钮禁用且没有说明）。 */}
              {needTeam && teamId ? (
                <span className="cwd-item" data-smoke="selected-team">
                  <Icon name="users" size={14} />
                  <span className="context-label">{teamId}</span>
                  <button
                    className="icon-btn"
                    onClick={() => { setTeamId(null); setPicked('engine'); }}
                    title="取消选择团队"
                    aria-label={`取消选择团队 ${teamId}`}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </span>
              ) : null}
            </div>
          </div>

          {/* 附件列表：有选中文件时才显示，每个 chip 可单独移除。 */}
          {attachments.length > 0 ? (
            <div className="cwd-bar attached" data-smoke="attachments-bar">
              <div className="cwd-pill">
                {attachments.map((p) => {
                  const name = p.replace(/\\/g, '/').split('/').pop() ?? p;
                  return (
                    <span key={p} className="cwd-item">
                      <Icon name="paperclip" size={14} />
                      <span className="context-label" title={p}>{name}</span>
                      <button
                        className="icon-btn"
                        onClick={() => removeAttachment(p)}
                        title="移除此附件"
                        aria-label={`移除 ${name}`}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 外壳（容器 / textarea / 工具栏三段式布局）由 ComposerBar 收口，与 S2 共用一份；
              这里只给出本屏的控件行为：附件可加、引擎可选、模式是 popover。 */}
          <ComposerBar
            value={task}
            onChange={setTask}
            onSubmit={() => void start()}
            placeholder="描述你的任务…（Enter 开始，Shift+Enter 换行）"
            textareaRef={textRef}
            textareaSmoke="session-task"
            rows={2}
            left={
              <>
              {/* 引擎 popover：Axon + 本机已安装且已接入的外部工具（见文件头注释 3 与 EnginePicker）。 */}
              <button
                className={`tool-btn${attachments.length > 0 ? ' is-on' : ''}`}
                onClick={() => void addAttachments()}
                title="添加附件（文件将复制到本次会话工作目录）"
                data-smoke="attach-files"
              >
                <Icon name="paperclip" size={16} />
              </button>
              <EnginePicker
                value={engineId}
                onChange={(id) => {
                  setEngineId(id);
                  // 外部引擎只支持单兵（它有自己的子代理机制，与 Axon 的编排还没打通）：
                  // 选了它就把模式拨回 Single，免得用户发出去才被主进程拒。
                  if (id) {
                    setPicked('engine');
                    setTeamId(null);
                    // 外部引擎的模型由它自己的配置决定，Axon 的 modelRef 管不到它 ——
                    // 留着会在工具栏显示一个不生效的选择，所以清掉。
                    setModelRef(null);
                  }
                }}
              />
              <div className="s0-mode">
                <button
                  className={`tool-btn${modeOpen ? ' is-on' : ''}`}
                  onClick={() => setModeOpen((v) => !v)}
                  aria-expanded={modeOpen}
                  aria-haspopup="menu"
                  data-smoke="mode-trigger"
                  title={`执行模式：${MODES.find((m) => m.id === executor)?.label ?? 'Single'}`}
                >
                  <Icon name="users" size={16} />
                </button>
                {modeOpen ? (
                  <div className="menu s0-mode-menu" role="menu" data-smoke="mode-popover">
                    <div className="s0-menu-title">选择执行模式</div>
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        className="menu-item"
                        role="menuitemradio"
                        aria-checked={executor === m.id}
                        data-smoke={`mode-${m.id}`}
                        onClick={() => {
                          setPicked(m.id);
                          if (m.id !== 'team') setTeamId(null);
                          // 反过来也一样：要组队就回到 Axon 内置引擎。
                          else setEngineId(null);
                          setModeOpen(false);
                        }}
                      >
                        <span>{m.label}</span>
                        <span className="mk">{executor === m.id ? '✓ 已选' : m.desc}</span>
                      </button>
                    ))}
                    <div className="menu-sep" />
                    <div className="s0-menu-title">已有团队</div>
                    {teams.entries.length === 0 ? (
                      <button className="menu-item" onClick={() => go('s3')}>
                        <span>还没有团队</span>
                        <span className="mk">去建一个 →</span>
                      </button>
                    ) : (
                      // 团队条目的钩子是 mode-team-pick，与上面「指定团队」那项的
                      // mode-team 分开 —— 两个同名的话 querySelector 会随机命中一个。
                      teams.entries.map((t) => (
                        <button
                          key={t.team.name}
                          className="menu-item"
                          role="menuitemradio"
                          aria-checked={needTeam && teamId === t.team.name}
                          data-smoke="mode-team-pick"
                          data-team={t.team.name}
                          onClick={() => {
                            setPicked('team');
                            setTeamId(t.team.name);
                            setEngineId(null);
                            setModeOpen(false);
                          }}
                        >
                          <span>{t.team.name}</span>
                          <span className="mk">
                            {t.team.members.length} 成员{needTeam && teamId === t.team.name ? ' · 已选' : ''}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              </>
            }
            /* 外部引擎自带模型配置，Axon 的模型表对它没意义 —— 不渲染。 */
            right={
              engineId ? null : (
                <ModelSelect
                  {...(modelRef !== null ? { value: modelRef } : {})}
                  onChange={(ref) => setModelRef(ref ?? null)}
                />
              )
            }
            send={{
              icon: busy ? 'clock' : 'arrowUp',
              onClick: () => void start(),
              disabled: !ready,
              smoke: 'start-session',
              title: needTeam && !teamId ? '先选一个团队' : '开始（⌘/Ctrl + Enter）',
            }}
          />
        </div>
      </div>
    </div>
  );
}
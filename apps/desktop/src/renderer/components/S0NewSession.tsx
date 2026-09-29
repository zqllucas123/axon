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
 *      engine/team/adhoc，那是模式维度），所以那个按钮置灰占位而不假装能用 ——
 *      这与「临时编队」卡片此前置灰是同一条纪律：标出位置的存在，但不撒谎。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
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
  const { config, teams, projects, projectContext, clearProjectContext, createSession, pickProjectWorkspace, go } =
    useApp();
  const [task, setTask] = useState('');
  const [picked, setPicked] = useState<SessionExecutor | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
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
      initialPrompt: task.trim(),
    });
    setBusy(false);
    if (s) setTask('');
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
              {project ? null : (
                <button
                  className="icon-btn"
                  onClick={() => void chooseWorkspace()}
                  title="切换工作目录"
                  aria-label="切换工作目录"
                  data-smoke="session-cwd-add"
                >
                  <Icon name="plus" size={14} />
                </button>
              )}
            </div>
          </div>

          <div className="composer">
            <textarea
              ref={textRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder="描述你的任务…（⌘/Ctrl + Enter 开始）"
              data-smoke="session-task"
              rows={2}
            />
            <div className="row">
              {/* 附件与引擎都是**置灰占位**，不是能用的功能：
                  协议没有附件面，也没有「引擎」这个维度（见文件头注释 3）。
                  不删是因为它们在信息架构里有位置 —— 删了下次加回来要重新想一遍。 */}
              <button className="tool-btn" disabled title="尚未支持：协议里没有附件面">
                <Icon name="paperclip" size={16} />
              </button>
              <button className="tool-btn" disabled title="尚未支持：协议里还没有「引擎」这个维度">
                <Icon name="spark" size={16} />
              </button>

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

              <span className="spacer" />
              <button
                className="send"
                onClick={() => void start()}
                disabled={!ready}
                data-smoke="start-session"
                title={needTeam && !teamId ? '先选一个团队' : '开始（⌘/Ctrl + Enter）'}
              >
                <Icon name={busy ? 'clock' : 'arrowUp'} size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
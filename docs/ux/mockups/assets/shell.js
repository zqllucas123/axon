/* =========================================================================
   Axon 原型共享外壳：图标表 + 侧栏/顶栏渲染 + 数据标注开关
   用法：页面里放 <body data-screen="s2"> ... <div data-shell="sidebar"></div>
   ========================================================================= */

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5"/><path d="M10.4 20.5a1.9 1.9 0 0 0 3.2 0"/>',
  folder:
    '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.66.9l.68 1a2 2 0 0 0 1.66.9H19a2 2 0 0 1 2 2v6.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pen: '<path d="M12 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V12"/><path d="M18.1 2.9a1.9 1.9 0 0 1 2.7 2.7L12.3 14l-3.8 1.1L9.6 11.3z"/>',
  users:
    '<path d="M15.5 20.5v-1.7a3.5 3.5 0 0 0-3.5-3.5H6.5A3.5 3.5 0 0 0 3 18.8v1.7"/><circle cx="9.2" cy="7.6" r="3.4"/><path d="M21 20.5v-1.7a3.5 3.5 0 0 0-2.6-3.4"/><path d="M15.6 4.4a3.4 3.4 0 0 1 0 6.6"/>',
  inbox:
    '<path d="M21 12.5h-4.6l-1.6 2.6H9.2l-1.6-2.6H3"/><path d="M6.6 4.9 3 12.5v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-3.6-7.6a2 2 0 0 0-1.8-1.1H8.4a2 2 0 0 0-1.8 1.1z"/>',
  book: '<path d="M12 7.4v13.1"/><path d="M3 18.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1h5a4 4 0 0 1 4 3.6 4 4 0 0 1 4-3.6h5a1 1 0 0 1 1 1v12.8a1 1 0 0 1-1 1h-5.6a3.4 3.4 0 0 0-3.4 2.4 3.4 3.4 0 0 0-3.4-2.4z"/>',
  wallet:
    '<path d="M19 7.5v-2a2 2 0 0 0-2-2H5.4a2.4 2.4 0 0 0 0 4.8H19a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2H5.4a2.4 2.4 0 0 1-2.4-2.4V5.9"/><path d="M17 13.4h.01"/>',
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.2 8.6"/><path d="M3 4.4v4.4h4.4"/><path d="M12 7.8V12l3 1.9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3 1.9"/>',
  settings:
    '<circle cx="12" cy="12" r="2.8"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.4a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.8-.9 1.5v.4"/><path d="M12 16.8h.01"/>',
  chevD: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  minus: '<path d="M5.2 12h13.6"/>',
  dots: '<circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/>',
  arrowUp: '<path d="M12 19.2V5.2"/><path d="m5.6 11.6 6.4-6.4 6.4 6.4"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.4"/><path d="M5.5 15h-.9a2 2 0 0 1-2-2V5.4a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2V6"/>',
  branch:
    '<path d="M6.5 4v11.6"/><circle cx="17.5" cy="6.4" r="2.6"/><circle cx="6.5" cy="18" r="2.6"/><path d="M17.5 9a8.6 8.6 0 0 1-8.6 8.6"/>',
  commit: '<circle cx="12" cy="12" r="3"/><path d="M3.5 12H9M15 12h5.5"/>',
  monitor: '<rect x="2.8" y="4" width="18.4" height="12.8" rx="2"/><path d="M8.5 20.4h7M12 16.8v3.6"/>',
  terminal: '<path d="m4.6 17 5.4-5-5.4-5"/><path d="M12.4 18.6h7"/>',
  file: '<path d="M14.4 3H6.8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2V7.8z"/><path d="M14.2 3v5h5"/><path d="M8.4 13.4h7M8.4 17h4.6"/>',
  check: '<path d="m5.2 12.8 4.4 4.4 9.2-10"/>',
  x: '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v4.8M12 16.2h.01"/>',
  shield: '<path d="M12 21.2s7.4-3.6 7.4-9.2V5.6L12 2.8 4.6 5.6V12c0 5.6 7.4 9.2 7.4 9.2z"/>',
  hand: '<path d="M17.6 11V7.4a1.6 1.6 0 0 0-3.2 0"/><path d="M14.4 10.6V5.6a1.6 1.6 0 0 0-3.2 0v5"/><path d="M11.2 10.6V6.8a1.6 1.6 0 1 0-3.2 0v8.4l-1.8-2a1.7 1.7 0 0 0-2.4 2.4l3.4 4.2a4 4 0 0 0 3.1 1.4h3.1a4.2 4.2 0 0 0 4.2-4.2v-4.4a1.6 1.6 0 0 0-3.2 0"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="M9.2 4v16"/>',
  panelR: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="M14.8 4v16"/>',
  list: '<path d="M10.4 6.4h10M10.4 12h10M10.4 17.6h10"/><path d="m3.4 6.4 1.4 1.4 2.6-2.6"/><path d="m3.4 12 1.4 1.4 2.6-2.6"/><path d="m3.4 17.6 1.4 1.4 2.6-2.6"/>',
  spark:
    '<path d="m11 3.6 1.9 4.5 4.5 1.9-4.5 1.9L11 16.4 9.1 11.9 4.6 10l4.5-1.9z"/><path d="m17.8 15.2.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  link: '<path d="m9.4 14.6 5.2-5.2"/><path d="m11.6 6.6 1.2-1.2a3.9 3.9 0 0 1 5.5 5.5l-1.2 1.2"/><path d="m12.4 17.4-1.2 1.2a3.9 3.9 0 0 1-5.5-5.5l1.2-1.2"/>',
  reply: '<path d="m14.6 9.6 4.4 4.4-4.4 4.4"/><path d="M4.6 4.6v5.4a4 4 0 0 0 4 4H19"/>',
  play: '<path d="M8 5.4 18.6 12 8 18.6z"/>',
  pause: '<path d="M9.4 5.6v12.8M14.6 5.6v12.8"/>',
  trash: '<path d="M4.6 6.4h14.8"/><path d="M9 6.4V4.8a1.4 1.4 0 0 1 1.4-1.4h3.2A1.4 1.4 0 0 1 15 4.8v1.6"/><path d="M6.4 6.4 7.2 19a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.8-12.6"/>',
  filter: '<path d="M3.6 5.2h16.8l-6.6 7.8v5.8l-3.6 2v-7.8z"/>',
  eye: '<path d="M2.6 12s3.6-6.4 9.4-6.4S21.4 12 21.4 12s-3.6 6.4-9.4 6.4S2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
  layers: '<path d="m12 3.2 9 4.6-9 4.6-9-4.6z"/><path d="m3 16.2 9 4.6 9-4.6"/><path d="m3 12 9 4.6 9-4.6"/>',
  db: '<ellipse cx="12" cy="6" rx="7.6" ry="3"/><path d="M4.4 6v12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3V6"/><path d="M4.4 12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3"/>',
};

function icon(name, cls = '') {
  const p = ICONS[name] || ICONS.dots;
  return `<span class="i ${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg></span>`;
}

/* ---------- 侧栏数据（原型固定数据） ---------- */
const NAV = [
  { id: 's0', icon: 'pen', label: '新建会话', href: 's0-new-session.html' },
  { id: 's1', icon: 'layers', label: '会话总览', href: 's1-workbench.html' },
  { id: 's5', icon: 'inbox', label: '收件箱', href: 's5-inbox.html', badge: '2' },
  { id: 's6', icon: 'wallet', label: '预算与用量', href: 's6-budget.html' },
  { id: 's3', icon: 'users', label: '团队管理', href: 's3-teams.html' },
  { id: 's7', icon: 'history', label: '会话恢复', href: 's7-sessions.html', badge: 'M5', quiet: true },
];

/* 团队会话：成员被实例化成的分身树（lead 为根）
   ⚠️ IA 规则（用户 2026-09-14 拍板）：分身树是**会话内**状态，只渲染在右侧检视栏，
   左侧边栏一律不出现会话内部结构（左=会话之间，右=会话之内）。 */
const TREE = [
  { lv: 0, name: 'Axon5 · 主控', path: '/0', st: 'run', meta: 'lead', screen: 's1' },
  { lv: 1, name: '架构师 #1', path: '/0/1', st: 'run', meta: '', screen: 's2' },
  { lv: 2, name: '后端实现 #2', path: '/0/1/2', st: 'run', meta: '', screen: 's2', active: true },
  { lv: 2, name: '测试工程师 #3', path: '/0/1/3', st: 'wait', meta: '排队 1' },
  { lv: 1, name: '文档 #4', path: '/0/4', st: 'idle', meta: '临时' },
  { lv: 1, name: '数据迁移 #5', path: '/0/5', st: 'err', meta: '临时' },
];

/* 单兵会话：只有内置引擎一个执行体，没有分身树 */
const SOLO_TREE = [{ lv: 0, name: '内置引擎', path: '/0', st: 'run', meta: '', active: true }];

/* 左栏只列「会话」这一种粒度：活跃 3 + 最近 2（与 s1-workbench「活跃会话 3」同源） */
const SESSIONS = [
  { t: '支付回调幂等改造', team: '全栈小队', solo: false, st: 'run', meta: '6 分身' },
  { t: '查一下 bun 的 workspace 协议', team: '', solo: true, st: 'run', meta: '单兵' },
  { t: '把 orchestrator 的六工具补测', team: '测试双人', solo: false, st: 'idle', meta: '3 分身' },
];
const SESSIONS_DONE = [
  { t: 'M4 账本 schema 评审', team: '评审小队', solo: false, st: 'done', meta: '昨天' },
  { t: '改个 README 错别字', team: '', solo: true, st: 'done', meta: '昨天' },
];

function sidebarHTML(screen, mode) {
  const solo = mode === 'solo';
  const nav = NAV.map(
    (n) => `
      <a class="nav-item ${n.id === screen ? 'is-active' : ''}" href="${n.href}">
        ${icon(n.icon)}<span>${n.label}</span>
        ${n.badge ? `<span class="badge ${n.quiet ? 'quiet' : ''}">${n.badge}</span>` : ''}
      </a>`
  ).join('');

  // 当前会话只在会话屏（s2 系）高亮；全局屏没有「当前会话」
  const activeTitle = screen !== 's2' ? '' : solo ? '查一下 bun 的 workspace 协议' : '支付回调幂等改造';
  const row = (s) => `
      <a class="side-row ${s.t === activeTitle ? 'is-active' : ''}" href="${s.solo ? 's2-solo.html' : 's2-session.html'}">
        <span class="sdot ${s.st}"></span>
        <span class="label">${s.t}</span>
        <span class="meta">${s.solo ? '单兵' : s.team}</span>
      </a>`;
  const active = SESSIONS.map(row).join('');
  const done = SESSIONS_DONE.map(row).join('');

  return `
  <div class="traffic">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span style="width:10px"></span>
    <button class="chrome-btn">${icon('panel', 'i-16')}</button>
    <span class="spacer"></span>
    <button class="chrome-btn">${icon('chevL', 'i-16')}</button>
    <button class="chrome-btn">${icon('chevR', 'i-16')}</button>
  </div>

  <div class="brand">
    <span class="name">Axon</span>
    ${icon('chevD', 'i-16 chev')}
    <span class="spacer"></span>
    <button class="act">${icon('search', 'i-16')}</button>
    <button class="act">${icon('bell', 'i-16')}</button>
  </div>

  <nav class="nav">${nav}</nav>

  <div class="side-scroll">
    <div class="side-section">
      <span>进行中</span><span class="ann gap">G10.3 session.list</span>
      <span class="spacer"></span>
      <a class="act" href="s0-new-session.html" title="新建会话">${icon('plus', 'i-14')}</a>
    </div>
    ${active}

    <div class="side-section"><span>最近</span><span class="ann gap">G10.3 session.list(status=done)</span></div>
    ${done}
  </div>

  <div class="menu menu-up" data-user-menu hidden>
    <a class="menu-item" href="s8-settings.html">${icon('settings', 'i-16')}<span>设置…</span><span class="mk">⌘,</span></a>
    <button class="menu-item">${icon('folder', 'i-16')}<span>打开配置目录</span><span class="mk mono">~/.axon</span></button>
    <div class="menu-sep"></div>
    <a class="menu-item" href="s8-settings.html#about">${icon('help', 'i-16')}<span>关于 Axon</span></a>
  </div>

  <div class="side-foot">
    <button class="user-btn" data-user-toggle aria-haspopup="menu" aria-expanded="false">
      <span class="ava user">L</span>
      <span class="who">lucaszhou</span>
      ${icon('chevD', 'i-14 caret')}
    </button>
  </div>`;
}

/* ---------- 右栏：本会话成员树（会话粒度，随会话切换） ----------
   从左栏搬过来：分身树 = 「这个任务里谁在干」，属于会话内部状态。 */
function membersPanelHTML(mode) {
  const solo = mode === 'solo';
  const rows = (solo ? SOLO_TREE : TREE).map(
    (t) => `
      <a class="side-row lv${t.lv} ${t.active ? 'is-active' : ''}" href="${solo ? 's2-solo.html' : 's2-session.html'}">
        <span class="sdot ${t.st}"></span>
        <span class="label">${t.name}</span>
        ${t.meta ? `<span class="meta">${t.meta}</span>` : `<span class="meta mono">${t.path}</span>`}
      </a>`
  ).join('');
  if (solo) {
    return `
  <div class="panel">
    <div class="panel-title"><span>本会话成员</span><span class="tag">单兵</span><span class="spacer"></span><span class="ann">G10.3 session.get</span></div>
    <div class="team-strip">${icon('spark', 'i-14')}<span>未组队 · 内置引擎</span><span class="spacer"></span><a class="link" href="s3-teams.html">叫人 →</a></div>
    <div class="tree">${rows}</div>
    <div class="hint" style="padding:6px 10px 4px">单兵会话没有分身树。要并行 / 要评审时再叫人。</div>
  </div>`;
  }
  return `
  <div class="panel">
    <div class="panel-title">
      <span>本会话成员</span><span class="tag">4 + 2 临时</span>
      <span class="spacer"></span>
      <span class="ann">G10.3 session.get</span>
      <button class="act" title="临时加人">${icon('plus', 'i-14')}</button>
    </div>
    <div class="team-strip">${icon('users', 'i-14')}<span>全栈小队 · 4 成员</span><span class="spacer"></span><a class="link" href="s3-teams.html">编队 →</a></div>
    <div class="tree">${rows}</div>
    <div class="hint" style="padding:6px 10px 4px">点成员切焦点；下方面板始终跟随选中的那一个。</div>
  </div>`;
}

/* ---------- 会话内视图切换（会话条） ----------
   账本 / 用量 都是会话粒度的，不应该存在于全局导航里。 */
const VIEWS = [
  { id: 'chat', label: '对话', href: 's2-session.html', soloHref: 's2-solo.html' },
  { id: 'ledger', label: '账本', n: '12', href: 's4-ledger.html', team: true },
  { id: 'usage', label: '用量', n: '$1.13', href: 's2-usage.html', soloHref: 's2-usage.html' },
];

function sessionBarHTML(view, mode) {
  const solo = mode === 'solo';
  const tabs = VIEWS.map((v) => {
    const on = v.id === view;
    const dead = solo && v.team;
    const inner = `${v.label}${v.n && !dead ? `<span class="n">${solo && v.id === 'usage' ? '$0.02' : v.n}</span>` : ''}`;
    if (dead) return `<button disabled title="单兵会话没有协作，自然没有账本">${v.label}<span class="n">—</span></button>`;
    return `<a class="seg-a ${on ? 'is-on' : ''}" href="${solo ? v.soloHref : v.href}"><button class="${on ? 'is-on' : ''}">${inner}</button></a>`;
  }).join('');

  const ident = solo
    ? `${icon('spark', 'i-14')}<span>未组队 · 由 <b style="color:var(--text)">Axon 内置引擎</b> 直接执行</span>`
    : `${icon('users', 'i-14')}<span>团队 <b style="color:var(--text)">全栈小队</b> · 4 成员已实例化 +2 临时</span>`;

  const act = solo
    ? `<button class="btn sm">${icon('users', 'i-14')}叫人（升级为团队会话）<span class="ann gap">G10.5 session.escalate</span></button>`
    : `<button class="btn sm ghost">${icon('plus', 'i-14')}临时加人</button>`;

  return `${ident}
    <span class="seg" style="margin-left:6px">${tabs}</span>
    <span class="ann gap">G10.3 session.get</span>
    <span class="spacer"></span>
    ${act}`;
}

/* ---------- S0 全局状态条（顶栏右侧） ---------- */
function statusChipsHTML(opts = {}, mode = '', screen = '') {
  const solo = mode === 'solo';
  // 会话屏（s2 系）的 chip 是本会话口径；全局屏是跨会话口径。两者不得混用。
  const inSession = screen === 's2';
  const budget = inSession
    ? (solo
        ? { used: '0.02', hard: '1.50', state: 'ok', label: '本会话' }
        : { used: '1.13', hard: '1.50', state: 'warning', label: '本会话' })
    : { used: '1.49', hard: '5.00', state: 'ok', label: '今日' };
  const pending = opts.pending ?? (inSession ? (solo ? 0 : 2) : 2);

  const ledgerChip = inSession
    ? (solo
        ? `<span class="chip plain" style="opacity:.45" title="单兵会话没有协作，自然没有账本">${icon('book', 'i-14')}<span>本会话账本 —</span></span>`
        : `<a class="chip plain" href="s4-ledger.html">${icon('book', 'i-14')}<span>本会话账本 12</span><span class="ann gap">G8.1 ledger.recorded</span></a>`)
    : `<a class="chip plain" href="s1-workbench.html">${icon('layers', 'i-14')}<span>活跃会话 3</span><span class="ann gap">G10.3 session.list</span></a>`;

  return `
    <div class="status-chips">
      <a class="chip ${budget.state === 'frozen' ? 'danger' : budget.state === 'warning' ? 'warn' : ''}" href="${inSession ? 's2-usage.html' : 's6-budget.html'}">
        ${icon('wallet', 'i-14')}<span>${budget.label} $${budget.used} / $${budget.hard}</span>
        <span class="ann gap">G7.3 budget.get</span>
      </a>
      <a class="chip ${pending ? 'danger' : ''}" href="s5-inbox.html">
        ${icon('shield', 'i-14')}<span>待批 ${pending}${inSession ? '' : '（全部会话）'}</span>
        <span class="ann gap">G1.3 pending.list</span>
      </a>
      ${ledgerChip}
    </div>`;
}

/* <i data-icon="folder" class="i-16"></i> → SVG，可重复调用 */
function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const wrap = document.createElement('span');
    wrap.innerHTML = icon(el.dataset.icon, el.className);
    el.replaceWith(wrap.firstElementChild);
  });
}

/* ---------- 启动 ---------- */
function mountShell() {
  const screen = document.body.dataset.screen || '';
  const mode = document.body.dataset.mode || '';
  const side = document.querySelector('[data-shell="sidebar"]');
  if (side) side.innerHTML = sidebarHTML(screen, mode);

  document.querySelectorAll('[data-shell="session-bar"]').forEach((el) => {
    el.innerHTML = sessionBarHTML(el.dataset.view || 'chat', mode);
  });

  document.querySelectorAll('[data-shell="members"]').forEach((el) => {
    el.outerHTML = membersPanelHTML(mode);
  });

  document.querySelectorAll('[data-shell="status"]').forEach((el) => {
    el.innerHTML = statusChipsHTML(el.dataset.opts ? JSON.parse(el.dataset.opts) : {}, mode, screen);
  });

  mountIcons();

  // 数据标注开关（顶栏按钮 or ⌘/ 键）
  const toggle = () => document.body.classList.toggle('show-ann');
  document.querySelectorAll('[data-ann-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      toggle();
      b.classList.toggle('is-on');
    })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggle(); }
    // 设置：⌘,（全局，与 macOS 惯例一致）。实现里应是「聚焦已开的设置窗或新开一个」，不是导航。
    if (e.key === ',' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); location.href = 's8-settings.html'; }
  });

  /* 账号菜单（左下角头像 → 上弹）—— 设置的唯一鼠标入口。
     用户拍板 2026-09-15：不在左栏导航里给设置留位，也不把齿轮做成裸链接。 */
  const userBtn = document.querySelector('[data-user-toggle]');
  const userMenu = document.querySelector('[data-user-menu]');
  if (userBtn && userMenu) {
    const setOpen = (on) => {
      userMenu.hidden = !on;
      userBtn.setAttribute('aria-expanded', String(on));
      userBtn.classList.toggle('is-on', on);
    };
    userBtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(userMenu.hidden); });
    userMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }
  if (new URLSearchParams(location.search).get('ann') === '1') document.body.classList.add('show-ann');
}

window.AxonShell = { ICONS, icon, mountIcons };
document.addEventListener('DOMContentLoaded', mountShell);

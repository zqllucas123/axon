/**
 * 渲染进程 —— 刻意保持成"薄壳"。
 *
 * 它只做三件事：发意图、渲染快照、显示事件流。
 * **不持有任何 Agent 状态的真相** —— 所有状态都从主进程的事件流同步过来。
 *
 * 这条约束来自 kalo 的教训：它的 `chat-store.ts` 长到 1405 行（全仓最大，
 * 被列入质量棘轮基线），因为渲染层同时扛了运行时池、代际守卫、崩溃恢复、
 * 批渲染和事件分发。那些职责属于主进程。
 *
 * 目前是原生 DOM 而非 React —— 骨架阶段先验证 IPC 链路，
 * 框架等 UI 真正复杂起来再上，避免过早引入构建复杂度。
 */

import type { AgentSnapshot, AxonBridge, RoleDefinition } from '@axon/protocol';

declare global {
  interface Window {
    axon: AxonBridge;
  }
}

const axon = window.axon;
const $ = (id: string) => document.getElementById(id)!;
const rolesEl = $('roles');
const treeEl = $('tree');
const logEl = $('log');
const inputEl = $('input') as HTMLInputElement;

let selected = '/root';

function log(text: string, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `${at}  ${text}`;
  logEl.appendChild(line);
  // 只在已经贴底时才自动滚动，否则用户往回翻会被不停拽回来。
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function renderRoles() {
  const roles: RoleDefinition[] = await axon.invoke('role.list', {});
  rolesEl.replaceChildren();
  for (const role of roles) {
    const el = document.createElement('div');
    el.className = 'role';
    const mode = String(role.defaultForkMode ?? 'none');
    el.innerHTML = `
      <div class="meta">
        <div class="name"></div>
        <div class="desc"></div>
      </div>
      <span class="fork" data-mode="${mode}">${mode}</span>`;
    el.querySelector('.name')!.textContent = role.displayName;
    el.querySelector('.desc')!.textContent = role.description;
    el.title = `在 ${selected} 下创建（上下文：${mode}）`;
    el.onclick = async () => {
      try {
        const snap = await axon.invoke('agent.spawn', {
          role: role.name,
          parent: selected,
        });
        log(`+ 创建 ${snap.displayName} → ${snap.path}（上下文 ${mode}）`, 'k');
      } catch (err) {
        log(`✗ ${(err as Error).message}`, 'e');
      }
    };
    rolesEl.appendChild(el);
  }
}

async function renderTree() {
  const list: AgentSnapshot[] = await axon.invoke('agent.list', {});
  const byPath = new Map(list.map((s) => [s.path, s]));
  treeEl.replaceChildren();

  const draw = (path: string, depth: number) => {
    const snap = byPath.get(path);
    if (!snap) return;
    const el = document.createElement('div');
    el.className = `node${path === selected ? ' sel' : ''}`;
    el.style.paddingLeft = `${8 + depth * 14}px`;
    el.innerHTML = `<span class="dot" data-s="${snap.status}"></span><span class="lbl"></span>`;
    el.querySelector('.lbl')!.textContent = snap.displayName;
    el.title = `${snap.path} · ${snap.status} · ${snap.usage.inputTokens}/${snap.usage.outputTokens} tok`;
    el.onclick = () => {
      selected = path;
      void renderTree();
      void renderRoles(); // 刷新 title 里的父节点提示
    };
    treeEl.appendChild(el);
    for (const child of snap.children) draw(child, depth + 1);
  };
  draw('/root', 0);
}

// ── 事件订阅：主进程是唯一真相源，UI 被动同步 ──────────────

axon.subscribe('agent.created', ({ snapshot }) => {
  log(`  ${snapshot.path} 已就绪`);
  void renderTree();
});

axon.subscribe('agent.status', ({ path, status, error }) => {
  log(`  ${path} → ${status}${error ? `：${error}` : ''}`, error ? 'e' : 't');
  void renderTree();
});

axon.subscribe('agent.removed', ({ paths }) => {
  log(`- 已移除 ${paths.length} 个 Agent`);
  if (paths.includes(selected)) selected = '/root';
  void renderTree();
});

axon.subscribe('agent.tool.start', ({ tool }, meta) => {
  log(`  [${meta.source}] 工具 ${tool}`, 't');
});

axon.subscribe('agent.message.end', ({ message }, meta) => {
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
  if (text.trim()) log(`[${meta.source}] ${text}`);
});

axon.subscribe('agent.turn.end', ({ usage }, meta) => {
  log(`  [${meta.source}] 本轮 ${usage.inputTokens}/${usage.outputTokens} tok`, 't');
  void renderTree();
});

// ── 交互 ────────────────────────────────────────────────

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  log(`> ${text}`, 'k');
  try {
    await axon.invoke('agent.prompt', { path: selected, text });
  } catch (err) {
    log(`✗ ${(err as Error).message}`, 'e');
  }
}

$('send').onclick = () => void send();
$('stop').onclick = () => void axon.invoke('agent.interrupt', { path: selected });
inputEl.onkeydown = (e) => {
  if (e.key === 'Enter') void send();
};

// ── 启动 ──────────────────────────────────────────────

async function boot() {
  try {
    await Promise.all([renderRoles(), renderTree()]);
    const agents = await axon.invoke('agent.list', {});
    log('Axon 已启动。点击左侧角色创建分身。', 'k');
    // 链路的直接证据：role.list + agent.list 两轮 invoke 都成功后才会到这行。
    console.log(`[renderer] boot ok: ${agents.length} agents`);
  } catch (err) {
    // 启动即黑屏是最糟的第一印象 —— 至少让用户看到原因。
    console.error('[boot]', err);
    log(`✗ 启动失败：${(err as Error).message}（见 devtools console）`, 'e');
  }
}

void boot();

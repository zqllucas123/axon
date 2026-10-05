#!/usr/bin/env bun
/**
 * 知识库 web 来源端到端验证 —— CDP 驱动真实 Electron，走完整链路：
 *   window.axon.invoke('kb.create') → IPC → KnowledgeManager
 *   → kb.addSource(web) → fetchWebPage 真抓取 → ingestHtml 提纯
 *   → chunker 切块 → 真实 embedding 网关 → LanceDB 落盘
 *   → kb.query 向量检索 → 命中原文
 *
 * 与 ui-smoke 的区别：这里**故意用真实 provider**（真网关、真 embedding），
 * 因为要验的就是「真实网页 + 真实向量」这条链路；faux embedder 下检索必然
 * 能过，是假绿。但知识库目录隔离到临时目录，不碰 ~/.axon/knowledge。
 *
 * 用法：bun scripts/kb-e2e.mjs [URL]
 */
import { execSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const useReal = args.includes('--real');
const url = args.find((a) => !a.startsWith('--')) || 'https://mp.weixin.qq.com/s/ChxmL1tUZ3tnDLMZmFX9CQ';
const port = '9224'; // 错开 ui-smoke 的 9223，免得两边互相连错窗口
const STUB_PORT = 8799;

const kbDir = await mkdtemp(join(tmpdir(), 'axon-kb-e2e-'));
const rolesDir = await mkdtemp(join(tmpdir(), 'axon-kb-roles-'));
const sessionsDir = await mkdtemp(join(tmpdir(), 'axon-kb-sessions-'));
const projectsDir = await mkdtemp(join(tmpdir(), 'axon-kb-projects-'));

let proc = null;
let stub = null;
const log = (ok, msg) => console.log(`${ok ? '✓' : '✗'} ${msg}`);
const info = (msg) => console.log(`  ${msg}`);

/** 起本地 embedding 桩（生产网关当前 403，见 scripts/kb-embed-stub.mjs 头注释）。 */
async function launchStub() {
  stub = spawn('node', [join(import.meta.dirname, 'kb-embed-stub.mjs'), String(STUB_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stub.stdout.on('data', () => {});
  stub.stderr.on('data', () => {});
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${STUB_PORT}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'stub', input: ['ping'] }),
      });
      if (r.ok) return;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('embedding 桩起不来');
}

function launchApp() {
  const electron = join(
    import.meta.dirname,
    process.platform === 'win32' ? '../node_modules/.bin/electron.exe' : '../node_modules/.bin/electron',
  );
  proc = spawn(electron, [`--remote-debugging-port=${port}`, 'apps/desktop/dist/main.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_ENABLE_LOGGING: '1',
      AXON_KNOWLEDGE_DIR: kbDir,
      AXON_ROLES_DIR: rolesDir,
      AXON_SESSIONS_DIR: sessionsDir,
      AXON_PROJECTS_DIR: projectsDir,
      // 这里**不设** AXON_PROVIDER=faux：抓取与落盘要的就是真实链路。
      // embedding 默认走本地桩：生产网关对本 key 的 /embeddings 返回 403，
      // 不隔开的话整条链路卡在第一步，后面的切块/落盘/检索一行都验不到。
      // 带 --real 时不注入，回到真网关（等权限开通后用它复验）。
      ...(useReal
        ? {}
        : {
            AXON_KB_EMBED_ENDPOINT: `http://127.0.0.1:${STUB_PORT}/v1`,
            AXON_KB_EMBED_KEY: 'stub-key',
            AXON_KB_EMBED_MODEL: 'stub-embed',
          }),
    },
  });
  proc.on('error', (e) => {
    console.error(`[kb-e2e] 启动失败：${e.message}`);
    process.exit(1);
  });
  // stderr 必须有人读，否则缓冲区满了会把子进程堵死。顺带留存最后几行，
  // 失败时是唯一的主进程线索。
  const tail = [];
  proc.stderr.on('data', (d) => {
    tail.push(String(d));
    if (tail.length > 40) tail.shift();
  });
  proc._tail = tail;
}

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const page = (await res.json()).find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('等不到 CDP 页面目标');
}

let ws, nextId = 1, pending = new Map(), evalJs;

async function connect() {
  const page = await getPageTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常: ' + JSON.stringify(r.exceptionDetails.exception?.description));
    }
    return r.result.value;
  };
}

async function cleanup(code) {
  try { ws?.close(); } catch { /* ignore */ }
  try { execSync('pkill -9 -f "apps/desktop/dist/main.mjs"', { stdio: 'ignore' }); } catch { /* ignore */ }
  if (proc) proc.kill('SIGKILL');
  try { stub?.kill('SIGKILL'); } catch { /* ignore */ }
  for (const d of [kbDir, rolesDir, sessionsDir, projectsDir]) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  console.log(code === 0 ? '\n✓ 知识库 web 来源端到端通过' : '\n✗ 知识库 web 来源端到端失败');
  process.exit(code);
}

if (!useReal) {
  await launchStub();
  info(`embedding：本地桩 http://127.0.0.1:${STUB_PORT}/v1（真网关 /embeddings 当前 403）`);
} else {
  info('embedding：真实网关（--real）');
}

launchApp();

try {
  await connect();

  // ── 0. 等桥接就绪
  let ready = null;
  for (let i = 0; i < 40; i++) {
    ready = await evalJs(`typeof window.axon?.invoke === 'function'`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) { log(false, 'window.axon 桥接不可用'); await cleanup(1); }
  log(true, 'window.axon 桥接可用');

  // 订阅摄入事件。manager.addSource 内部是 `.catch(() => {})`，真因只会
  // 从 kb.indexing.error 事件出来 —— 不订阅就只能看到「0 块」这个症状。
  await evalJs(`(() => {
    window.__kbErrors = [];
    window.__kbProgress = [];
    const on = window.axon.on ?? window.axon.subscribe;
    if (typeof on !== 'function') return 'no-listener-api';
    on('kb.indexing.error', (p) => window.__kbErrors.push(p));
    on('kb.indexing.progress', (p) => window.__kbProgress.push(p));
    on('kb.indexing.done', (p) => window.__kbProgress.push({ done: true, ...p }));
    return 'ok';
  })()`).then((r) => info(`事件订阅：${r}`));

  // ── 1. 建知识库
  const kb = await evalJs(`window.axon.invoke('kb.create', { name: 'E2E 微信文章' })`);
  const kbId = kb?.id ?? kb?.kb?.id;
  if (!kbId) { log(false, `kb.create 没返回 id：${JSON.stringify(kb)}`); await cleanup(1); }
  log(true, `知识库已创建 id=${kbId}`);

  // ── 2. 加 web 源（真抓取 + 真 embedding，这一步最慢）
  const added = await evalJs(
    `window.axon.invoke('kb.addSource', { kbId: ${JSON.stringify(kbId)}, sourceType: 'web', sourceRef: ${JSON.stringify(url)} })`,
  );
  info(`kb.addSource 返回：${JSON.stringify(added).slice(0, 200)}`);

  // 摄入是异步 job，轮询 stats 直到 chunk 落库（或超时）
  let stats = null;
  let lastErr = null;
  for (let i = 0; i < 120; i++) {
    stats = await evalJs(`window.axon.invoke('kb.getStats', { kbId: ${JSON.stringify(kbId)} })`);
    if ((stats?.chunkCount ?? 0) > 0) break;
    lastErr = await evalJs(
      `window.__kbErrors.length ? JSON.stringify(window.__kbErrors) : null`,
    ).catch(() => null);
    if (lastErr) break;
    if (i % 5 === 4) {
      const prog = await evalJs(
        `window.__kbProgress.length ? JSON.stringify(window.__kbProgress[window.__kbProgress.length - 1]) : null`,
      ).catch(() => null);
      if (prog) info(`进度：${prog}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (lastErr) { log(false, `摄入报错：${lastErr}`); }
  if (!stats || (stats.chunkCount ?? 0) === 0) {
    log(false, `摄入未产出向量块：${JSON.stringify(stats)}`);
    info('主进程 stderr 尾部：');
    for (const l of (proc._tail ?? []).slice(-15)) process.stdout.write('    ' + l);
    await cleanup(1);
  }
  log(true, `摄入完成：${stats.docCount} 篇 / ${stats.chunkCount} 块，模型 ${stats.embeddingModel}`);

  // ── 3. 文档元信息（标题应是文章标题，不是 URL）
  const docs = await evalJs(`window.axon.invoke('kb.listDocs', { kbId: ${JSON.stringify(kbId)} })`);
  const doc = (docs?.docs ?? docs ?? [])[0];
  info(`文档标题：${doc?.title}`);
  info(`来源类型：${doc?.sourceType} | ref：${String(doc?.sourceRef).slice(0, 60)}`);
  log(doc?.sourceType === 'web', `来源类型记为 web`);
  log(
    typeof doc?.title === 'string' && doc.title.length > 5 && !doc.title.startsWith('http'),
    `标题取到了文章标题而非 URL`,
  );

  // ── 4. 向量检索：问文章里真实存在的内容
  const queries = ['什么是 tool search 机制', 'MCP 工具和普通工具的区别', '工具太多占满上下文怎么办'];
  let allHit = true;
  for (const q of queries) {
    const res = await evalJs(
      `window.axon.invoke('kb.query', { kbId: ${JSON.stringify(kbId)}, query: ${JSON.stringify(q)}, topK: 3 })`,
    );
    // kb.query 直接返回 KnowledgeChunk[]，正文字段是 content（见 packages/protocol/src/knowledge.ts:41）
    const hits = Array.isArray(res) ? res : (res?.results ?? res?.hits ?? []);
    const top = hits[0];
    const ok = hits.length > 0 && typeof top?.content === 'string' && top.content.length > 20;
    log(ok, `检索「${q}」→ ${hits.length} 条命中`);
    if (ok) {
      info(`相似度 ${top.score?.toFixed?.(3) ?? top.score} | 出处「${top.title?.slice(0, 20)}」`);
      info(`正文：${top.content.replace(/\s+/g, ' ').slice(0, 110)}…`);
    } else {
      info(`原始返回：${JSON.stringify(res).slice(0, 250)}`);
    }
    allHit = allHit && ok;
  }

  await cleanup(allHit ? 0 : 1);
} catch (e) {
  log(false, `异常：${e.message}`);
  info('主进程 stderr 尾部：');
  for (const l of (proc?._tail ?? []).slice(-15)) process.stdout.write('    ' + l);
  await cleanup(1);
}

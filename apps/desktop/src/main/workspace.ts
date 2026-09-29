/**
 * 工作区（会话运行目录）的分配与元信息探测。
 *
 * 这个模块只在主进程跑，管两件事：
 *
 *   1. **临时工作目录**：普通会话（不归属项目）的默认工作区。由主进程 `mkdtemp`
 *      分配，会话之间互不干扰，应用退出时整个清掉。渲染层零 Node，拼不出这个路径，
 *      也管不了它的生命周期 —— 所以分配入口必须在这里。
 *
 *   2. **工作区元信息**：文件夹名 + git 分支，给新建会话页的工作区 chip 用。
 *      这正是「可信路径集合」存在的理由，见下。
 *
 * ── 可信路径集合：一条安全边界，不是缓存 ──
 *
 * `workspace.inspect` 要按路径探测 git 分支，而渲染进程零 Node。如果这条命令
 * 接受**任意**路径，界面层（以及任何能触达它的注入代码）就等于拿到了一个
 * 「这个目录是不是 git 仓库、在哪个分支」的文件系统探测器 —— 与
 * `fs.listDir` 只认 sessionId、`shell.openPath` 只认枚举同一条原则。
 *
 * 所以只有四种路径会被 `trustPath` 收进来，其余一律拒绝：
 *   - 项目的 cwd（用户在创建项目时选的目录）
 *   - `config.defaultCwd`（用户在设置里填的目录）
 *   - `project.pickWorkspace` 返回过的路径（用户亲手在系统对话框里选的）
 *   - 本运行期分配的临时工作目录
 *
 * 共同点：**每一个都源自用户本人的明确选择**，没有一个是渲染层自己编的。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** 本运行期分配的临时工作目录 —— 只在这里增，退出时统一清。 */
const tempWorkspaces = new Set<string>();

/** 可以被探测元信息的工作区路径（见文件头注释：这是安全边界）。 */
const trustedPaths = new Set<string>();

/** 把一个路径收进可信集合。重复调用幂等。 */
export function trustPath(path: string | undefined): void {
  if (path) trustedPaths.add(path);
}

export function isTrustedPath(path: string): boolean {
  return trustedPaths.has(path);
}

/** 仅供测试：清空两个集合，避免用例之间互相污染。 */
export function resetWorkspaceState(): void {
  tempWorkspaces.clear();
  trustedPaths.clear();
}

/** 工作区展示元信息（`workspace.inspect` 的结果形状）。 */
export interface WorkspaceInfo {
  path: string;
  folderName: string;
  /** 不在 git 仓库、没装 git、或探测超时 —— 一律 null，调用方自行降级。 */
  branch: string | null;
  /** 是否是 git 仓库（按 `.git` 是否存在判断，与分支探测成败解耦）。 */
  isGit: boolean;
}

/**
 * 分配一个临时工作目录，作普通会话的默认工作区。
 *
 * `mkdtemp` 保证目录真实存在且独占（后缀随机），所以并发多次调用不会撞车。
 * 分配即入可信集合 —— 它马上就会被 `workspace.inspect` 查。
 */
export async function newTempWorkspace(): Promise<{ path: string; folderName: string }> {
  const path = await mkdtemp(join(tmpdir(), 'axon-'));
  tempWorkspaces.add(path);
  trustPath(path);
  return { path, folderName: basename(path) };
}

/**
 * 探测 git 分支。
 *
 * 三种失败都归到 `null`（不在仓库、没装 git、超时）—— chip 上少一枚而已，
 * 不该因此让整个新建会话页报错。2s 超时是防大仓库挂死 UI。
 */
function detectBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 2000,
      encoding: 'utf8',
    }).trim();
    // 空仓库（还没有首个提交）会回显字面量 "HEAD"，那不是分支名，不要展示。
    return out === '' || out === 'HEAD' ? null : out;
  } catch {
    return null;
  }
}

/**
 * 纯探测：路径 → 工作区元信息。**不做任何授权判断**，只给内部调用方用。
 *
 * 对外必须走 `inspectWorkspace`。分开的理由是有两条不同的授权通道：
 *   - `workspace.inspect` 拿路径当凭据 ⇒ 必须查可信集合；
 *   - `session.cwdInfo` 拿 sessionId 当凭据 ⇒ 主进程自己解出 cwd，
 *     路径可不可信已经在「会话存在」这一步判过了（与 `fs.listDir` 同一条原则）。
 * 后者如果用带校验的版本，升级前建的老会话（cwd 可能是任意目录）会直接报错。
 */
export function describeWorkspace(path: string): WorkspaceInfo {
  // `.git` 可能是目录（普通仓库）也可能是文件（worktree / submodule），
  // existsSync 两种情况都认 —— 这正是它比 `stat().isDirectory()` 合适的地方。
  const isGit = existsSync(join(path, '.git'));
  return {
    path,
    folderName: basename(path),
    branch: isGit ? detectBranch(path) : null,
    isGit,
  };
}

/**
 * 探测一个**已授权**路径的工作区元信息（`workspace.inspect` 的实现）。
 *
 * 未授权的路径直接抛错而不是静默返回 —— 这不是「拿不到就不渲染」那种可降级的
 * 缺口，而是调用方越界了（见文件头注释）。静默降级会让越界看起来像正常空态。
 */
export function inspectWorkspace(path: string): WorkspaceInfo {
  if (!isTrustedPath(path)) {
    throw new Error(`未授权的工作区路径：${path}`);
  }
  return describeWorkspace(path);
}

/**
 * 清掉本运行期分配的所有临时工作目录。**应用退出时调用。**
 *
 * 逐个容错：某个目录被外部占用删不掉，不能让退出流程卡住（其余照删）。
 * 注意这是**真删**，普通会话在 temp 目录里产出的文件会一并消失 —— 这是
 * 「每次会话独立临时目录」的既定语义，不是 bug。想留住产物就别调这里。
 */
export async function disposeTempWorkspaces(): Promise<void> {
  const dirs = [...tempWorkspaces];
  tempWorkspaces.clear();
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
}
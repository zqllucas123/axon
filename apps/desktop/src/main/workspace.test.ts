/**
 * workspace 单测 —— 临时目录分配 / 元信息探测 / 可信路径边界。
 *
 * 用**真盘**（真 mkdtemp、真 git 子进程），不上内存 IO：这个模块的职责就是跟
 * 真实文件系统打交道，把它 mock 掉等于把「目录到底建出来没有」「git 真跑没跑」
 * 这两条最该验的东西一起 mock 掉了。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  describeWorkspace,
  disposeTempWorkspaces,
  inspectWorkspace,
  isTrustedPath,
  newTempWorkspace,
  resetWorkspaceState,
  trustPath,
} from './workspace.ts';

/**
 * 用例自建的目录，跑完删掉。
 *
 * 为什么要单独收着：`resetWorkspaceState()` 只清模块级的两个 Set，**不删盘**——
 * 被它清掉名单的临时目录就成了孤儿，只能靠这里兜住。
 */
const madeDirs: string[] = [];

afterEach(async () => {
  resetWorkspaceState();
  await Promise.all(madeDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 造一个真目录（临时目录之外的，用于「不受管的路径」这类用例）。 */
async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

/** git 是否可用 —— 不可用就跳过依赖它的用例，而不是让整套测试红掉。 */
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** 造一个有首个提交的真 git 仓库（分支名固定 test-branch，避免 master/main 之争）。 */
async function makeGitRepo(): Promise<string> {
  const dir = await makeDir('axon-test-git-');
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      // 显式带身份：不依赖开发机的全局 git 配置（CI 上通常没有）。
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  git(['init']);
  // init 之后立刻定分支名：不同 git 版本的默认分支名不一致（master / main），
  // 不钉死的话断言就得跟着环境变。
  git(['symbolic-ref', 'HEAD', 'refs/heads/test-branch']);
  await writeFile(join(dir, 'a.txt'), 'x');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return dir;
}

describe('workspace · 临时目录', () => {
  it('分配的是真实存在、独占的目录，并自动入可信集合', async () => {
    const a = await newTempWorkspace();
    const b = await newTempWorkspace();
    madeDirs.push(a.path, b.path);

    expect(existsSync(a.path)).toBe(true);
    // 目录名形如 axon-xxxxxx，所以 chip 上显示的就是它（folderName = basename）。
    expect(a.path).toContain('axon-');
    expect(a.folderName).toBe(basename(a.path));
    // 独占：两次分配不撞车，会话之间的产物才不会互相覆盖。
    expect(a.path).not.toBe(b.path);
    // 领完就能被 inspect —— 否则 S0 拿到路径后第一次探测就会被安全边界挡回来。
    expect(isTrustedPath(a.path)).toBe(true);
  });

  it('disposeTempWorkspaces 真把目录删掉', async () => {
    const { path } = await newTempWorkspace();
    expect(existsSync(path)).toBe(true);
    await disposeTempWorkspaces();
    expect(existsSync(path)).toBe(false);
  });

  it('dispose 后名单清空：重复调用不出错（退出路径可能被走两次）', async () => {
    await newTempWorkspace();
    await disposeTempWorkspaces();
    await expect(disposeTempWorkspaces()).resolves.toBeUndefined();
  });
});

describe('workspace · 元信息探测', () => {
  it('非 git 目录：isGit=false 且 branch=null', async () => {
    const dir = await makeDir('axon-test-plain-');
    const info = describeWorkspace(dir);
    expect(info.folderName).toBe(basename(dir));
    expect(info.isGit).toBe(false);
    expect(info.branch).toBeNull();
  });

  it.skipIf(!gitAvailable)('git 仓库：isGit=true 且返回当前分支名', async () => {
    const dir = await makeGitRepo();
    const info = describeWorkspace(dir);
    expect(info.isGit).toBe(true);
    expect(info.branch).toBe('test-branch');
  });

  it.skipIf(!gitAvailable)('空仓库（还没有首个提交）不算分支：branch=null 而不是字面量 HEAD', async () => {
    const dir = await makeDir('axon-test-empty-');
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    // 这种仓库 `rev-parse --abbrev-ref HEAD` 会回显 "HEAD" —— 那不是分支名，
    // 直接展示会在 chip 上写一个假的「工作分支 HEAD」。
    expect(describeWorkspace(dir).branch).toBeNull();
    // 但 .git 在，它确实是 git 仓库 —— 两个判断是解耦的。
    expect(describeWorkspace(dir).isGit).toBe(true);
  });
});

describe('workspace · 可信路径边界', () => {
  it('未授权的路径直接抛错，不静默降级', async () => {
    const dir = await makeDir('axon-test-untrusted-');
    // 静默返回会把「调用方越界」伪装成「这个目录没有分支」——两种情况的处理完全不同。
    expect(() => inspectWorkspace(dir)).toThrow(/未授权的工作区路径/);
  });

  it('trustPath 之后才放行，且幂等', async () => {
    const dir = await makeDir('axon-test-trusted-');
    trustPath(dir);
    trustPath(dir); // 重复入集合不该出问题（启动时项目与默认目录可能重合）
    expect(inspectWorkspace(dir).folderName).toBe(basename(dir));
  });

  it('trustPath(undefined) 不会把 undefined 塞进集合', () => {
    // config.defaultCwd 是可选的，未配置时就是 undefined —— 真塞进去，
    // 之后任何一次 undefined 查询都会被判为「已授权」。
    trustPath(undefined);
    expect(isTrustedPath('undefined')).toBe(false);
    expect(isTrustedPath(undefined as unknown as string)).toBe(false);
  });
});
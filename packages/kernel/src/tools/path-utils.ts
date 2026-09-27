/**
 * cwd 收敛 —— 叶子工具越权防护的第一道闸（M8 §4.3）。
 *
 * 所有叶子工具拿到的 path 都必须过这里：相对路径相对会话 cwd 解析，
 * 解析结果若逃出 cwd 子树（`../` 越界、绝对路径指向别处）一律拒绝。
 * 参照 pi 的 `path-utils.ts:resolveToCwd`，去掉了它对 NFD/窄空格的
 * 平台细节（axon 本期只保方向性防护，健壮性细节留待后续）。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 路径逃逸时抛这个；调用方 catch 后回灌为 error toolResult。 */
export class PathEscapeError extends Error {
  constructor(readonly requested: string) {
    super(`path escapes session working directory: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * 把 filePath 解析为绝对路径，并断言它落在 cwd 子树内（含 cwd 自身）。
 * 逃逸则抛 PathEscapeError。
 */
export function resolveWithinCwd(filePath: string, cwd: string): string {
  const base = resolve(cwd);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath);
  const rel = relative(base, abs);
  // rel 为空 = 就是 cwd 本身（允许）；以 .. 开头或绝对 = 逃出子树。
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(filePath);
  }
  return abs;
}

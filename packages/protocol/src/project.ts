/** 用户项目：可命名的单工作空间容器，独立于会话生命周期持久化。 */

/**
 * 项目类别 —— 用户建项目时手选，决定「新建会话」页工作区 chip 的第三枚显不显示。
 *
 * 与工作区 chip 上的「本地」（执行位置：本地机器）**不是一回事**，别合并：
 * 那个是 monitor 图标的执行位置维度，这个是版本控制维度。
 *
 * `'local'`：普通目录，没有版本控制语义，chip 不显示分支。
 * `'git'`  ：目录必须是已存在的 git 仓库（创建时校验），chip 显示当前分支。
 */
export type ProjectKind = 'local' | 'git';

export const PROJECT_KINDS: readonly ProjectKind[] = Object.freeze(['local', 'git']);

export function isProjectKind(value: unknown): value is ProjectKind {
  return value === 'local' || value === 'git';
}

export interface ProjectRecord {
  id: string;
  name: string;
  /** 项目唯一工作空间；项目会话由主进程从这里解析 cwd。 */
  cwd: string;
  /** 项目类别；老项目文件没有这个字段时按 `'local'` 补齐（见 project-store）。 */
  kind: ProjectKind;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectIssue {
  level: 'error' | 'warn';
  code: 'invalid-project' | 'parse-error' | 'io-error';
  message: string;
  filePath?: string;
}

export const PROJECT_NAME_PATTERN = /^[^/\\:*?"<>|]{1,80}$/;

export function validateProject(input: unknown): ProjectIssue[] {
  if (typeof input !== 'object' || input === null) {
    return [{ level: 'error', code: 'invalid-project', message: '项目定义必须是对象' }];
  }
  const value = input as Record<string, unknown>;
  const issues: ProjectIssue[] = [];
  if (typeof value.name !== 'string' || !PROJECT_NAME_PATTERN.test(value.name.trim())) {
    issues.push({ level: 'error', code: 'invalid-project', message: '项目名称不能为空，且不得含路径字符（/ \\ : * ? " < > |）' });
  }
  if (typeof value.cwd !== 'string' || value.cwd.trim() === '') {
    issues.push({ level: 'error', code: 'invalid-project', message: '工作空间不能为空' });
  }
  // kind **缺省合法**（按 'local' 处理）：老项目文件没有这个字段，报错会让
  // 升级后的用户整个项目列表变空 —— 缺省是补默认值，不是校验失败。
  // 只有「写了但写了别的」才是坏数据。
  if (value.kind !== undefined && !isProjectKind(value.kind)) {
    issues.push({ level: 'error', code: 'invalid-project', message: `项目类别只能是 ${PROJECT_KINDS.join(' 或 ')}` });
  }
  return issues;
}

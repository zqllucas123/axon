/** 用户项目：可命名的单工作空间容器，独立于会话生命周期持久化。 */

export interface ProjectRecord {
  id: string;
  name: string;
  /** 项目唯一工作空间；项目会话由主进程从这里解析 cwd。 */
  cwd: string;
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
  return issues;
}

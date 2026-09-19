/**
 * 新建项目弹窗（左栏「项目」模块的「+」）。
 *
 * L3 薄壳：只做「渲染 + 发意图」。校验错误来自主进程（project.create 返回的
 * ProjectIssue），这里只做「必填非空」的即时提示；工作空间既可手输绝对路径，
 * 也可点「浏览…」走原生目录选择器（project.pickWorkspace）。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';

export function ProjectCreateDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { createProject, pickProjectWorkspace } = useApp();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ready = name.trim().length > 0 && cwd.trim().length > 0 && !busy;

  const browse = async () => {
    const picked = await pickProjectWorkspace();
    if (picked) setCwd(picked);
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setErrors([]);
    const res = await createProject({ name: name.trim(), cwd: cwd.trim() });
    setBusy(false);
    if (res.accepted) {
      onClose();
      return;
    }
    setErrors(res.errors.map((e) => e.message));
  };

  return (
    <div
      className="dialog-scrim"
      data-smoke="project-dialog"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新建项目"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <Icon name="folder" size={16} />
          <span className="name">新建项目</span>
          <span className="spacer" />
          <button className="act" title="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="dialog-body">
          <label className="dialog-field">
            <span className="dialog-label">项目名称</span>
            <input
              ref={nameRef}
              className="dialog-input"
              value={name}
              placeholder="例如：Axon 桌面端"
              data-smoke="project-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </label>

          <label className="dialog-field">
            <span className="dialog-label">工作空间</span>
            <div className="dialog-field-row">
              <input
                className="dialog-input mono"
                value={cwd}
                placeholder="/Users/you/works/project"
                data-smoke="project-cwd"
                onChange={(e) => setCwd(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              />
              <button className="btn sm" onClick={() => void browse()} data-smoke="project-browse">
                浏览…
              </button>
            </div>
            <span className="dialog-hint">该项目下新建的会话都会在这个目录里执行。</span>
          </label>

          {errors.length > 0 ? (
            <div className="dialog-errors">
              {errors.map((msg, i) => (
                <div key={i} className="dialog-err">{msg}</div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="dialog-foot">
          <button className="btn sm" onClick={onClose}>取消</button>
          <button
            className="btn sm primary"
            disabled={!ready}
            data-smoke="project-create"
            onClick={() => void submit()}
          >
            {busy ? '正在建…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  );
}

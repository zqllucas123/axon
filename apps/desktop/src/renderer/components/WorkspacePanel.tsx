/**
 * 右栏「打开文件」面板（对标 codex：顶栏按钮点开，从工作区目录树选文件预览）。
 *
 * 安全边界全在主进程：渲染层只发 `sessionId + relPath`，绝不碰真实路径，
 * 也没有 Node API。目录树按需展开（点一层拉一层），不预取整棵树——
 * 大仓库一次 readdir 到底会把 IPC 和内存都打爆。
 *
 * 预览：文本经 marked→hljs 渲染 md，其余文本纯文本；图片走 base64 <img>；
 * 过大 / 二进制回占位，不塞进 IPC（见 ipc.ts `fs.readFile`）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import hljs from 'highlight.js';
import { marked } from 'marked';
import type { FsEntry } from '@axon/protocol';
import { useApp, type FsFile } from '../state/store.tsx';
import { Icon } from '../icons.tsx';

/** 已展开目录的 rel → 其子项；根为 ''。 */
type DirCache = Record<string, FsEntry[]>;

const MD_EXT = /\.(md|markdown|mdx)$/i;
const IMG_MIME = /^image\//;

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

function highlight(code: string): string {
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return code;
  }
}

export function WorkspacePanel(): ReactElement {
  const { sessionId, current, listDir, readWorkspaceFile } = useApp();
  const [cache, setCache] = useState<DirCache>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [loading, setLoading] = useState(false);

  // 换会话：清空全部本地态，从根重新拉。
  useEffect(() => {
    setCache({});
    setOpen(new Set());
    setSel(null);
    setFile(null);
    if (!sessionId) return;
    let live = true;
    void listDir('').then((entries) => {
      if (live && entries) setCache({ '': entries });
    });
    return () => {
      live = false;
    };
  }, [sessionId, listDir]);

  const toggleDir = useCallback(
    async (rel: string): Promise<void> => {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else next.add(rel);
        return next;
      });
      if (!cache[rel]) {
        const entries = await listDir(rel);
        if (entries) setCache((prev) => ({ ...prev, [rel]: entries }));
      }
    },
    [cache, listDir],
  );

  const openFile = useCallback(
    async (rel: string): Promise<void> => {
      setSel(rel);
      setLoading(true);
      setFile(null);
      const f = await readWorkspaceFile(rel);
      setFile(f);
      setLoading(false);
    },
    [readWorkspaceFile],
  );

  if (!sessionId) {
    return (
      <div className="ws-panel">
        <div className="ws-empty">
          <Icon name="folder" />
          <b>打开文件</b>
          <span>进入会话后从工作区目录树选择文件</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ws-panel">
      <header className="ws-head">
        <Icon name="folder" />
        <span className="ws-root mono" title={current?.record.cwd ?? ''}>
          {current?.record.cwd ?? '工作区'}
        </span>
      </header>
      <div className="ws-body">
        <div className="ws-tree tree">
          <FsList
            dir=""
            depth={0}
            cache={cache}
            open={open}
            sel={sel}
            onToggle={toggleDir}
            onOpen={openFile}
          />
        </div>
        <FilePreview rel={sel} file={file} loading={loading} />
      </div>
    </div>
  );
}

interface FsListProps {
  dir: string;
  depth: number;
  cache: DirCache;
  open: Set<string>;
  sel: string | null;
  onToggle: (rel: string) => void;
  onOpen: (rel: string) => void;
}

function FsList(props: FsListProps): ReactElement | null {
  const { dir, depth, cache, open, sel, onToggle, onOpen } = props;
  const entries = cache[dir];
  if (!entries) return null;
  return (
    <>
      {entries.map((e) => {
        const rel = joinRel(dir, e.name);
        const lv = depth === 0 ? '' : depth === 1 ? 'lv1' : 'lv2';
        if (e.kind === 'dir') {
          const isOpen = open.has(rel);
          return (
            <div key={rel}>
              <button className={`side-row ${lv}`} onClick={() => onToggle(rel)}>
                <Icon name={isOpen ? 'chevD' : 'chevR'} />
                <span className="label">{e.name}</span>
              </button>
              {isOpen ? (
                <FsList
                  dir={rel}
                  depth={depth + 1}
                  cache={cache}
                  open={open}
                  sel={sel}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ) : null}
            </div>
          );
        }
        return (
          <button
            key={rel}
            className={`side-row ${lv}${sel === rel ? ' is-active' : ''}`}
            onClick={() => onOpen(rel)}
          >
            <Icon name="file" />
            <span className="label">{e.name}</span>
          </button>
        );
      })}
    </>
  );
}

interface FilePreviewProps {
  rel: string | null;
  file: FsFile | null;
  loading: boolean;
}

function FilePreview({ rel, file, loading }: FilePreviewProps): ReactElement {
  if (!rel) {
    return (
      <div className="ws-preview ws-preview-empty">
        <Icon name="file" />
        <span>从左侧目录树选择文件预览</span>
      </div>
    );
  }
  if (loading) return <div className="ws-preview ws-preview-empty">加载中…</div>;
  if (!file) return <div className="ws-preview ws-preview-empty">无法读取该文件</div>;
  if (file.tooLarge) {
    return (
      <div className="ws-preview ws-preview-empty">
        文件过大（{(file.size / 1024 / 1024).toFixed(1)} MB），不预览
      </div>
    );
  }
  if (file.encoding === 'base64' && file.mime && IMG_MIME.test(file.mime)) {
    return (
      <div className="ws-preview">
        <img src={`data:${file.mime};base64,${file.content}`} alt={rel} />
      </div>
    );
  }
  if (file.encoding === 'base64') {
    return <div className="ws-preview ws-preview-empty">二进制文件，不预览</div>;
  }
  if (MD_EXT.test(rel)) {
    return (
      <div
        className="ws-preview md"
        // marked 输出；源是本地工作区文件，非远端不可信内容。
        dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content) }}
      />
    );
  }
  return (
    <div className="ws-preview">
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlight(file.content) }} />
      </pre>
    </div>
  );
}

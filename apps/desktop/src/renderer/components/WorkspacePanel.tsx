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

import { useCallback, useEffect, useRef, useState } from 'react';
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

export function WorkspacePanel({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}): ReactElement {
  const { sessionId, current, listDir, readWorkspaceFile } = useApp();
  const [cache, setCache] = useState<DirCache>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [loading, setLoading] = useState(false);

  // 树区域宽度（像素），初始值与 CSS 的 168px 对齐。
  const [treeWidth, setTreeWidth] = useState(168);
  // 面板宽度属于 Shell 的共享右列；树宽仍是文件浏览器内部状态。
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  // 通用拖拽：按下记起点，move 按增量更新宽度，up 清理监听。
  // dir=1 表示往右拖变宽（树的右侧手柄）；dir=-1 表示往左拖变宽（面板的左边界）。
  const startDrag = useCallback(
    (
      e: React.MouseEvent,
      startWidth: number,
      dir: 1 | -1,
      min: number,
      max: number,
      apply: (w: number) => void,
    ) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth };
      // 拖拽期间禁用整页文本选择（否则手柄和周边内容会被选中，显示成深色高亮条），
      // 并把光标锁成左右箭头，避免掠过文字时变回文本光标。
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const delta = (ev.clientX - dragState.current.startX) * dir;
        apply(Math.max(min, Math.min(max, dragState.current.startWidth + delta)));
      };
      const onUp = () => {
        dragState.current = null;
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [],
  );

  const onTreeHandleMouseDown = useCallback(
    (e: React.MouseEvent) => startDrag(e, treeWidth, -1, 100, 400, setTreeWidth),
    [startDrag, treeWidth],
  );
  const onPanelHandleMouseDown = useCallback(
    (e: React.MouseEvent) => startDrag(e, width, -1, 280, 900, onWidthChange),
    [onWidthChange, startDrag, width],
  );

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
        <div className="ws-resize-edge" title="拖拽调整面板宽度" onMouseDown={onPanelHandleMouseDown} />
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
      <div className="ws-resize-edge" title="拖拽调整面板宽度" onMouseDown={onPanelHandleMouseDown} />
      <div className="ws-body">
        <FilePreview rel={sel} file={file} loading={loading} />
        <div
          className="ws-resize-handle"
          title="拖拽调整宽度"
          onMouseDown={onTreeHandleMouseDown}
        />
        <div className="ws-tree tree" style={{ width: treeWidth }}>
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
        <span>从右侧目录树选择文件预览</span>
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

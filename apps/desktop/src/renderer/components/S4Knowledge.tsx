/**
 * S4 知识库管理屏 —— AI 时代的笔记本。
 *
 * 功能：创建知识库、添加来源（HTML/DOCX/MD/代码仓库）、
 *       查看摄入进度、删除知识库/文档、向量搜索测试。
 *
 * 数据纪律：读 store.kbs / store.kbJobs；
 * 意图：createKb / deleteKb / addKbSource / removeKbDoc / queryKb / listKbDocs。
 */

import React, { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useApp } from '../state/store.tsx';
import { Icon } from '../icons.tsx';
import type { KnowledgeBase, KnowledgeChunk, KnowledgeDoc } from '@axon/protocol';

// ── 向量模型选择器 ─────────────────────────────────────────────

/**
 * 常见的 OpenAI-compat embedding 模型候选列表。
 * 用户也可以直接输入自定义模型名。
 */
const PRESET_MODELS = [
  'qwen3.7-text-embedding',
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002',
];

function ModelSelector({
  kbId,
  current,
  onChange,
}: {
  kbId: string;
  current: string;
  onChange: (model: string) => void;
}): ReactElement {
  const { updateKbModel } = useApp();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const apply = useCallback(async (model: string) => {
    if (!model.trim() || model === current) { setOpen(false); return; }
    setSaving(true);
    setErr('');
    try {
      await updateKbModel(kbId, model.trim());
      onChange(model.trim());
      setOpen(false);
      setCustom('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [kbId, current, updateKbModel, onChange]);

  return (
    <div className="s4-model-selector" ref={ref}>
      <button
        className="tag s4-model-tag"
        onClick={() => setOpen((v) => !v)}
        title="点击切换向量模型"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current}
        <Icon name="chevD" size={14} />
      </button>
      {open ? (
        <div className="s4-model-popover" role="listbox" aria-label="选择向量模型">
          <div className="s4-model-popover-head">向量模型</div>
          {PRESET_MODELS.map((m) => (
            <button
              key={m}
              role="option"
              aria-selected={m === current}
              className={`s4-model-option${m === current ? ' is-current' : ''}`}
              onClick={() => void apply(m)}
              disabled={saving}
            >
              {m === current ? <Icon name="check" size={14} /> : <span className="s4-model-opt-gap" />}
              {m}
            </button>
          ))}
          <div className="s4-model-custom-row">
            <input
              className="field-input s4-model-custom-input"
              placeholder="自定义模型名…"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void apply(custom); }}
            />
            <button
              className="btn btn-small"
              onClick={() => void apply(custom)}
              disabled={saving || !custom.trim()}
            >
              确认
            </button>
          </div>
          {err ? <div className="field-err">{err}</div> : null}
          <div className="s4-model-warn">
            切换模型后，已有向量块不会自动重新摄入，需手动删除并重新添加来源。
          </div>
        </div>
      ) : null}
    </div>
  );
}

type SourceType = 'web' | 'docx' | 'md' | 'repo';

const SOURCE_LABELS: Record<SourceType, string> = {
  web: '网页（粘贴网址，自动抓取正文）',
  docx: 'Word 文档（.docx）',
  md: 'Markdown 文件（.md）',
  repo: '代码仓库（目录路径）',
};

// ── 创建知识库对话框 ──────────────────────────────────────────

function CreateKbDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { createKb } = useApp();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = useCallback(async () => {
    if (!name.trim()) { setErr('请输入知识库名称'); return; }
    setSaving(true);
    setErr('');
    try {
      await createKb(name.trim(), desc.trim());
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [createKb, name, desc, onClose]);

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="kb-dialog-title">
      <div className="dialog">
        <div className="dialog-head">
          <span id="kb-dialog-title" className="name">新建知识库</span>
          <button className="act" onClick={onClose} title="取消"><Icon name="x" size={14} /></button>
        </div>
        <div className="dialog-body">
          <label className="field-label">名称 <span className="req">*</span></label>
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：产品文档"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <label className="field-label" style={{ marginTop: 12 }}>描述</label>
          <input
            className="field-input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="可选"
          />
          {err ? <div className="field-err" role="alert">{err}</div> : null}
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 添加来源对话框 ──────────────────────────────────────────

function AddSourceDialog({ kbId, onClose }: { kbId: string; onClose: () => void }): ReactElement {
  const { addKbSource } = useApp();
  const [sourceType, setSourceType] = useState<SourceType>('md');
  const [sourceRef, setSourceRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = useCallback(async () => {
    if (!sourceRef.trim()) { setErr('请输入路径或 URL'); return; }
    setSubmitting(true);
    setErr('');
    try {
      await addKbSource(kbId, sourceType, sourceRef.trim());
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [addKbSource, kbId, sourceType, sourceRef, onClose]);

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="src-dialog-title">
      <div className="dialog">
        <div className="dialog-head">
          <span id="src-dialog-title" className="name">添加来源</span>
          <button className="act" onClick={onClose} title="取消"><Icon name="x" size={14} /></button>
        </div>
        <div className="dialog-body">
          <label className="field-label">来源类型</label>
          <div className="s4-type-grid">
            {(Object.keys(SOURCE_LABELS) as SourceType[]).map((t) => (
              <button
                key={t}
                className={`s4-type-btn${sourceType === t ? ' is-active' : ''}`}
                onClick={() => setSourceType(t)}
              >
                {t === 'web' ? <Icon name="link" size={16} /> : t === 'repo' ? <Icon name="branch" size={16} /> : <Icon name="file" size={16} />}
                <span>{t}</span>
              </button>
            ))}
          </div>
          <div className="s4-type-hint">{SOURCE_LABELS[sourceType]}</div>

          <label className="field-label" style={{ marginTop: 12 }}>
            {sourceType === 'web' ? '网页地址' : '文件或目录绝对路径'}
          </label>
          <input
            className="field-input"
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            placeholder={sourceType === 'web' ? 'https://example.com/article' : '/absolute/path/to/…'}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          {sourceType === 'web' ? (
            <div className="s4-type-hint" style={{ marginTop: 6 }}>
              抓取页面正文后嵌入；也可填本地 .html 文件路径。
            </div>
          ) : null}
          {err ? <div className="field-err" role="alert">{err}</div> : null}
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? '提交中…' : '开始摄入'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 知识库详情面板 ─────────────────────────────────────────────

function KbDetail({ kb: initialKb, onBack }: { kb: KnowledgeBase; onBack: () => void }): ReactElement {
  const { kbJobs, removeKbDoc, queryKb, listKbDocs } = useApp();
  const [kb, setKb] = useState<KnowledgeBase>(initialKb);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeChunk[]>([]);
  const [searching, setSearching] = useState(false);

  const loadDocs = useCallback(async () => {
    const d = await listKbDocs(kb.id);
    setDocs(d);
  }, [kb.id, listKbDocs]);

  useEffect(() => { void loadDocs(); }, [loadDocs, kbJobs]);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    const r = await queryKb(kb.id, query.trim(), 5);
    setResults(r);
    setSearching(false);
  }, [kb.id, query, queryKb]);

  const handleRemoveDoc = useCallback(async (docId: string) => {
    await removeKbDoc(kb.id, docId);
    await loadDocs();
  }, [kb.id, removeKbDoc, loadDocs]);

  // 正在进行中的 job（属于本 kb）
  const activeJobs = Object.entries(kbJobs).filter(([, j]) => !j.error);
  const errorJobs = Object.entries(kbJobs).filter(([, j]) => !!j.error);

  return (
    <div className="s4-detail" data-screen="s4">
      <div className="s4-detail-head">
        <button className="act" onClick={onBack} title="返回列表">
          <Icon name="chevL" size={16} />
        </button>
        <Icon name="book" size={18} />
        <span className="s4-kb-name">{kb.name}</span>
        {kb.description ? <span className="s4-kb-desc">{kb.description}</span> : null}
        <span className="spacer" />
        <span className="tag">{kb.docCount} 篇 · {kb.chunkCount} 块</span>
        <ModelSelector
          kbId={kb.id}
          current={kb.embeddingModel}
          onChange={(model) => setKb((prev) => ({ ...prev, embeddingModel: model }))}
        />
      </div>

      {/* 摄入进度 */}
      {activeJobs.length > 0 ? (
        <div className="s4-jobs">
          {activeJobs.map(([jobId, j]) => (
            <div key={jobId} className="s4-job-row">
              <Icon name="spark" size={14} />
              <span className="s4-job-ref" title={j.sourceRef}>{j.sourceRef.split('/').pop() ?? j.sourceRef}</span>
              <span className="s4-job-prog">{j.total > 0 ? `${j.processed}/${j.total}` : '处理中…'}</span>
              <div className="s4-prog-bar">
                <div
                  className="s4-prog-fill"
                  style={{ width: j.total > 0 ? `${Math.round(j.processed / j.total * 100)}%` : '0%' }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {errorJobs.length > 0 ? (
        <div className="card err" style={{ margin: '0 0 12px' }}>
          {errorJobs.map(([jobId, j]) => (
            <div key={jobId} className="card-body">
              <Icon name="alert" size={14} /> {j.sourceRef}：{j.error}
            </div>
          ))}
        </div>
      ) : null}

      {/* 来源文档列表 */}
      <div className="s4-section-head">
        <span>已摄入的来源</span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => setAddOpen(true)}>
          <Icon name="plus" size={14} /> 添加来源
        </button>
      </div>

      {docs.length === 0 ? (
        <div className="empty">
          <span className="k">还没有内容</span>
          点击「添加来源」开始摄入网页、文档或代码仓库。
        </div>
      ) : (
        <div className="s4-doc-list">
          {docs.map((doc) => (
            <div key={doc.id} className="s4-doc-row">
              <Icon name={doc.sourceType === 'web' ? 'link' : doc.sourceType === 'repo' ? 'branch' : 'file'} size={14} />
              <div className="s4-doc-info">
                <span className="s4-doc-title">{doc.title}</span>
                <span className="s4-doc-meta">{doc.sourceRef} · {doc.chunkCount} 块 · {new Date(doc.indexedAt).toLocaleDateString()}</span>
              </div>
              <button
                className="act s4-doc-del"
                title="删除此文档"
                onClick={() => void handleRemoveDoc(doc.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 搜索测试区 */}
      <div className="s4-section-head" style={{ marginTop: 20 }}>
        <span>搜索测试</span>
      </div>
      <div className="s4-search-row">
        <input
          className="field-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入问题或关键词…"
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
        />
        <button className="btn" onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
          {searching ? <Icon name="clock" size={14} /> : <Icon name="search" size={14} />}
        </button>
      </div>

      {results.length > 0 ? (
        <div className="s4-results">
          {results.map((r) => (
            <div key={r.chunkId} className="s4-result-card card">
              <div className="card-head">
                <span className="name s4-result-title" title={r.sourceRef}>{r.title}</span>
                <span className="tag">{(r.score * 100).toFixed(0)}%</span>
              </div>
              <div className="card-body s4-result-body">{r.content}</div>
            </div>
          ))}
        </div>
      ) : null}

      {addOpen ? <AddSourceDialog kbId={kb.id} onClose={() => { setAddOpen(false); void loadDocs(); }} /> : null}
    </div>
  );
}

// ── 知识库列表 ────────────────────────────────────────────────

function KbList({ onOpen }: { onOpen: (kb: KnowledgeBase) => void }): ReactElement {
  const { kbs, deleteKb } = useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = useCallback(async (kb: KnowledgeBase) => {
    if (!confirm(`确认删除知识库「${kb.name}」？此操作不可撤销。`)) return;
    setDeleting(kb.id);
    await deleteKb(kb.id);
    setDeleting(null);
  }, [deleteKb]);

  return (
    <div className="s4-screen" data-screen="s4">
      <div className="s4-header">
        <Icon name="book" size={20} />
        <h1 className="s4-title">知识库</h1>
        <span className="s4-subtitle">本地向量知识库，用于 Agent 问答</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" size={14} /> 新建知识库
        </button>
      </div>

      {kbs.length === 0 ? (
        <div className="empty" style={{ padding: '32px 0' }}>
          <span className="k">还没有知识库</span>
          创建第一个知识库，将网页、文档或代码仓库变成可问答的 AI 笔记本。
        </div>
      ) : (
        <div className="s4-kb-grid">
          {kbs.map((kb) => (
            <div
              key={kb.id}
              className="s4-kb-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(kb)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(kb); }}
            >
              <div className="s4-card-body">
                <div className="s4-card-icon">
                  <Icon name="book" size={16} />
                </div>
                <div className="s4-card-content">
                  <span className="s4-card-name">{kb.name}</span>
                  {kb.description ? <span className="s4-card-desc">{kb.description}</span> : null}
                </div>
                <button
                  className="act s4-del-btn"
                  title="删除知识库"
                  disabled={deleting === kb.id}
                  onClick={(e) => { e.stopPropagation(); void handleDelete(kb); }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              <div className="s4-card-stats">
                <div className="s4-stat">
                  <span className="s4-stat-num">{kb.docCount}</span>
                  <span className="s4-stat-label">篇文档</span>
                </div>
                <div className="s4-stat-sep" />
                <div className="s4-stat">
                  <span className="s4-stat-num">{kb.chunkCount}</span>
                  <span className="s4-stat-label">向量块</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen ? <CreateKbDialog onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

// ── 主屏 ──────────────────────────────────────────────────────

export function S4Knowledge(): ReactElement {
  const [openKb, setOpenKb] = useState<KnowledgeBase | null>(null);

  if (openKb) return <KbDetail kb={openKb} onBack={() => setOpenKb(null)} />;
  return <KbList onOpen={setOpenKb} />;
}

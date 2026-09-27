/**
 * 工具输出截断（M8 §六 B3）—— 防止大输出撑爆 transcript。
 *
 * 两条独立上限，先到先截：行数（默认 2000）与字节（默认 50KB）。
 * 参照 pi 的 `truncate.ts`，保留 head 截断（读文件看开头）与
 * 结构化的 TruncationResult（details 里回给下游）。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  /** 截断后的内容。 */
  content: string;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** 命中哪条上限。 */
  truncatedBy: 'lines' | 'bytes' | null;
  /** 原始总行数。 */
  totalLines: number;
  /** 原始总字节。 */
  totalBytes: number;
  /** 输出的完整行数。 */
  outputLines: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

function countLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** 人类可读的字节数。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 从头截断（保留前 N 行/字节），绝不返回半行。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = countLines(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let by: 'lines' | 'bytes' = 'lines';
  for (const line of lines) {
    if (kept.length >= maxLines) {
      by = 'lines';
      break;
    }
    const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
    if (bytes + lineBytes > maxBytes) {
      by = 'bytes';
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }

  return {
    content: kept.join('\n'),
    truncated: true,
    truncatedBy: by,
    totalLines,
    totalBytes,
    outputLines: kept.length,
  };
}

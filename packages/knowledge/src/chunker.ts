/**
 * 文本切块器。
 *
 * 按层级分隔符递归切分：先尝试段落边界，再降级到句子、单词、字符。
 * 每块之间保留 overlap 个字符的重叠，让上下文不在边界处断裂。
 */

export interface ChunkConfig {
  /** 每块目标字符数，默认 800 */
  chunkSize?: number;
  /** 相邻块之间的重叠字符数，默认 100 */
  chunkOverlap?: number;
}

export interface Chunk {
  text: string;
  /** 该块在原文中的起始字符偏移（近似值，仅供参考） */
  index: number;
}

const SEPARATORS = ['\n\n', '\n', ' ', ''];

/**
 * 将 text 切成若干 Chunk。
 * 空字符串或全空白直接返回空数组。
 */
export function split(text: string, config: ChunkConfig = {}): Chunk[] {
  const chunkSize = config.chunkSize ?? 800;
  const chunkOverlap = config.chunkOverlap ?? 100;

  if (!text || !text.trim()) return [];

  const pieces = recursiveSplit(text, SEPARATORS, chunkSize);
  return mergeWithOverlap(pieces, chunkSize, chunkOverlap);
}

// ── 内部实现 ──────────────────────────────────────────────────

function recursiveSplit(text: string, separators: string[], chunkSize: number): string[] {
  const sep = separators[0] ?? '';
  const nextSeps = separators.slice(1);

  if (sep === '') {
    // 字符级：直接按 chunkSize 切
    const result: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      result.push(text.slice(i, i + chunkSize));
    }
    return result;
  }

  const parts = text.split(sep).filter((p) => p.length > 0);
  const result: string[] = [];

  for (const part of parts) {
    if (part.length <= chunkSize) {
      result.push(part);
    } else if (nextSeps.length > 0) {
      result.push(...recursiveSplit(part, nextSeps, chunkSize));
    } else {
      // 没有更细的分隔符了，硬切
      for (let i = 0; i < part.length; i += chunkSize) {
        result.push(part.slice(i, i + chunkSize));
      }
    }
  }

  return result;
}

function mergeWithOverlap(pieces: string[], chunkSize: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current = '';
  let currentOffset = 0;
  let offset = 0;

  for (const piece of pieces) {
    // piece 本身就超过 chunkSize（来自字符级切分）——直接 flush，不拼合
    if (piece.length >= chunkSize) {
      if (current.trim()) {
        chunks.push({ text: current.trim(), index: currentOffset });
        current = '';
      }
      chunks.push({ text: piece.trim(), index: offset });
      offset += piece.length + 1;
      currentOffset = offset;
      continue;
    }

    const separator = current.length > 0 ? '\n' : '';
    const candidate = current + separator + piece;

    if (candidate.length > chunkSize && current.length > 0) {
      // 当前块已满，先 flush
      chunks.push({ text: current.trim(), index: currentOffset });
      // 保留尾部 overlap 字符作为新块开头
      const tail = current.slice(-Math.min(overlap, chunkSize)).trimStart();
      currentOffset = offset - tail.length;
      current = tail ? tail + '\n' + piece : piece;
    } else {
      current = candidate;
    }

    offset += piece.length + 1;
  }

  if (current.trim()) {
    chunks.push({ text: current.trim(), index: currentOffset });
  }

  return chunks;
}

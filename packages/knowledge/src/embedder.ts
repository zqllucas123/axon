/**
 * Embedder 接口与实现。
 *
 * OpenAICompatEmbedder：调用 OpenAI-compat /v1/embeddings（复用 config-store 的端点）。
 * FauxEmbedder：测试用，返回确定性的随机向量（不发 HTTP）。
 */

export interface Embedder {
  /** embed 一批文本，返回每条文本的向量（维度与 dimensions 一致）。 */
  embed(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly dimensions: number;
}

// ── OpenAI-compat 实现 ────────────────────────────────────────

export interface OpenAICompatConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 每次请求最多发送的文本条数，默认 512 */
  batchSize?: number;
}

export class OpenAICompatEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly cfg: Required<OpenAICompatConfig>;

  constructor(config: OpenAICompatConfig, dimensions = 1536) {
    this.cfg = { batchSize: 512, ...config };
    this.model = config.model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { endpoint, apiKey, model, batchSize } = this.cfg;
    const url = endpoint.replace(/\/$/, '') + '/v1/embeddings';

    const result: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: batch }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Embedding API error ${resp.status}: ${body}`);
      }

      const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
      for (const item of json.data) {
        result.push(item.embedding);
      }
    }
    return result;
  }
}

// ── Faux 实现（测试用）────────────────────────────────────────

/**
 * 测试用 embedder：返回基于文本哈希的确定性向量，不发 HTTP。
 */
export class FauxEmbedder implements Embedder {
  readonly model = 'faux-embedder';
  readonly dimensions: number;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this._deterministicVector(t));
  }

  private _deterministicVector(text: string): number[] {
    // 用简单哈希生成确定性向量并归一化
    let seed = 0;
    for (let i = 0; i < text.length; i++) {
      seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    }
    const vec: number[] = [];
    let s = seed;
    for (let i = 0; i < this.dimensions; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      vec.push(((s >>> 16) / 32768) - 1); // [-1, 1]
    }
    // L2 归一化
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

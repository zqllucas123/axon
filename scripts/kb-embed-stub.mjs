/**
 * 本地 OpenAI-compat /embeddings 桩服务 —— 知识库端到端测试用。
 *
 * 为什么需要它：生产网关（kotei）当前没给 key 开 embeddings 权限（403），
 * 但「切块 → 入库 → 检索」这段链路必须验证。这里用确定性哈希向量代替真模型：
 * 同一文本永远得到同一向量，且词面重叠越多向量越接近，足以验证检索排序不是乱的。
 *
 * 用法：node scripts/kb-embed-stub.mjs [port]（默认 8799）
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8799);
const DIM = 1536;

/** 把文本切成 2-gram 词面特征，散列到固定维度后 L2 归一化。 */
function embed(text) {
  const v = new Float64Array(DIM);
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ');
  const grams = [];
  for (const w of norm.split(' ')) if (w) grams.push(w);
  for (let i = 0; i < norm.length - 1; i++) grams.push(norm.slice(i, i + 2));
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % DIM] += 1;
  }
  let mag = 0;
  for (let i = 0; i < DIM; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag) || 1;
  return Array.from(v, (x) => x / mag);
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.endsWith('/embeddings')) {
      res.writeHead(404).end('{}');
      return;
    }
    let input = [];
    try {
      const parsed = JSON.parse(body || '{}');
      input = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    } catch {
      res.writeHead(400).end('{"error":"bad json"}');
      return;
    }
    const data = input.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data, model: 'stub-embed', usage: {} }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[kb-embed-stub] listening on http://127.0.0.1:${PORT}/v1 (dim=${DIM})`);
});

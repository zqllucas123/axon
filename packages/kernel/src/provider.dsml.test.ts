import { describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { withDsmlParsing, type ModelSource } from './provider.ts';

// ─────────────────────────────────────────────────────────────
// DeepSeek DSML 工具调用兼容层回归测试
//
// 关键约束：下面的输入字节是从真实落盘会话 (agents/*.jsonl) 里逐字拷出的，
// 不是手打的示意串。历史上正则漏掉了分隔符后的空格 `<｜DSML｜ calls>`，
// 手写测试串同样漏了空格，于是「测试通过」却与线上不符。所以这里坚持用
// 模型实际吐出的原始字节，包括：
//   1. 每个 `<｜DSML｜` 分隔符后有一个空格；
//   2. invoke 闭合标签是畸形的 `</｜DSML｜<｜DSML｜ invoke>`；
//   3. 工具名大小写不稳定（`bash` / `Bash` 都出现过）。
// `｜` 为 U+FF5C 全角竖线（DeepSeek tokenizer 的 special token 边界符）。
// ─────────────────────────────────────────────────────────────

/** 真实落盘字节：畸形 invoke 闭合 + 分隔符后空格 + 小写工具名。 */
const GROUND_TRUTH_MALFORMED =
  '<｜DSML｜ calls><｜DSML｜ invoke name="bash">' +
  '<｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter>' +
  '<｜DSML｜ parameter name="description" string="true">显示当前工作目录</｜DSML｜ parameter>' +
  '</｜DSML｜<｜DSML｜ invoke></｜DSML｜ calls>';

/** 良构变体 + 大写工具名，验证大小写规范化与干净闭合都能解析。 */
const WELL_FORMED_CAPITAL =
  '<｜DSML｜calls><｜DSML｜invoke name="Bash">' +
  '<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>' +
  '</｜DSML｜invoke></｜DSML｜calls>';

/** 把一条 assistant 消息包成只发 done+end 的内层 ModelSource。 */
function innerSourceEmitting(message: AssistantMessage): ModelSource {
  return {
    model: { id: 'fake' } as ModelSource['model'],
    streamFn: (async () => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      })();
      return stream;
    }) as ModelSource['streamFn'],
  };
}

function assistantWithText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
  } as AssistantMessage;
}

/** 驱动 withDsmlParsing 并取回最终 done 消息。 */
async function runShim(message: AssistantMessage): Promise<AssistantMessage> {
  const shimmed = withDsmlParsing(innerSourceEmitting(message));
  const stream = await shimmed.streamFn(
    shimmed.model,
    { messages: [] } as never,
    {} as never,
  );
  let done: AssistantMessage | undefined;
  for await (const ev of stream) {
    if (ev.type === 'done') done = ev.message;
  }
  return done!;
}

describe('withDsmlParsing — 真实落盘字节', () => {
  it('从畸形闭合 + 分隔符空格的字节里重建出 toolCall', async () => {
    const out = await runShim(assistantWithText(GROUND_TRUTH_MALFORMED));
    const calls = out.content.filter((b) => b.type === 'toolCall');
    expect(calls).toHaveLength(1);
    const call = calls[0] as { name: string; arguments: Record<string, unknown> };
    expect(call.name).toBe('bash');
    expect(call.arguments.command).toBe('pwd');
    expect(call.arguments.description).toBe('显示当前工作目录');
    // agent-loop 靠 stopReason=toolUse 才会真正执行工具。
    expect(out.stopReason).toBe('toolUse');
    // 原始 DSML 文本不应再作为正文残留。
    expect(out.content.some((b) => b.type === 'text')).toBe(false);
  });

  it('大写工具名被规范化为小写以匹配注册 id', async () => {
    const out = await runShim(assistantWithText(WELL_FORMED_CAPITAL));
    const call = out.content.find((b) => b.type === 'toolCall') as
      | { name: string }
      | undefined;
    expect(call?.name).toBe('bash');
  });

  it('无 DSML 标记的纯文本原样透传，stopReason 不变', async () => {
    const out = await runShim(assistantWithText('当前工作目录是 /tmp。'));
    expect(out.stopReason).toBe('stop');
    expect(out.content).toHaveLength(1);
    expect((out.content[0] as { text: string }).text).toBe('当前工作目录是 /tmp。');
  });

  it('带 DSML 开标记但无法解析出调用时，保留原文且不误设 toolUse', async () => {
    const out = await runShim(assistantWithText('<｜DSML｜ calls>（被截断，没有 invoke）'));
    expect(out.stopReason).toBe('stop');
    expect(out.content.some((b) => b.type === 'toolCall')).toBe(false);
    expect(out.content.some((b) => b.type === 'text')).toBe(true);
  });
});

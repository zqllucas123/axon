import { describe, expect, it } from 'vitest';
import {
  FORK_ALL,
  FORK_NONE,
  forkLastRounds,
  parseForkMode,
  type MessageLike,
} from '@axon/protocol';
import {
  forkMessages,
  groupIntoRounds,
  intersectTools,
  repairMessages,
} from './fork.ts';

// ─────────────────────────────────────────────────────────────
// 构造辅助
//
// 这些形状**必须**与 pi 0.85.1 运行时产出的 transcript 一致，否则测试会
// 验证一个错误的前提然后全绿。真实结构由 faux provider 实测得到：
//   toolCall   → assistant.content 里的块，id 字段名是 `id`
//   toolResult → 独立消息，role:'toolResult'，id 在顶层 `toolCallId`，
//                content 里只有普通 text 块
// 契约由 engine.contract.test.ts 用真实 pi 运行结果锁定。
// ─────────────────────────────────────────────────────────────

const user = (text: string): MessageLike => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const text = (t: string): MessageLike => ({
  role: 'assistant',
  content: [{ type: 'text', text: t }],
});

/** assistant 发起若干工具调用，可附带文本。 */
const calls = (ids: string[], prefix?: string): MessageLike => ({
  role: 'assistant',
  content: [
    ...(prefix ? [{ type: 'text' as const, text: prefix }] : []),
    ...ids.map((id) => ({ type: 'toolCall' as const, id, name: 'sh', arguments: {} })),
  ],
});

/** 一个 toolCall 对应一条独立的 toolResult 消息。 */
const result = (id: string): MessageLike => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'sh',
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
});

const results = (ids: string[]): MessageLike[] => ids.map(result);

/** 一个完整 round：user → assistant(call) → result → assistant(text) */
const fullRound = (n: number): MessageLike[] => [
  user(`u${n}`),
  calls([`c${n}`]),
  result(`c${n}`),
  text(`a${n}`),
];

const callIdsIn = (msgs: readonly MessageLike[]): string[] =>
  msgs.flatMap((m) =>
    (m.content ?? [])
      .filter((b) => b.type === 'toolCall')
      .map((b) => String((b as { id?: unknown }).id)),
  );

const resultIdsIn = (msgs: readonly MessageLike[]): string[] =>
  msgs.filter((m) => m.role === 'toolResult').map((m) => String(m.toolCallId));

// ── ① 模式语义 ──────────────────────────────────────────────

describe('forkMessages —— 分身模式语义', () => {
  const history = [...fullRound(1), ...fullRound(2), ...fullRound(3)];

  it('none：纯净上下文，不带任何历史', () => {
    expect(forkMessages(history, FORK_NONE)).toEqual([]);
  });

  it('all：内容等价于父，但不是同一批引用', () => {
    const forked = forkMessages(history, FORK_ALL);
    expect(forked).toEqual(history);
    forked.forEach((msg, i) => expect(msg).not.toBe(history[i]));
  });

  it('all：修改子上下文不污染父（深拷贝而非浅拷贝）', () => {
    const forked = forkMessages(history, FORK_ALL);
    (forked[0]!.content[0] as { text: string }).text = '被子 agent 改了';
    forked.push(user('子的新消息'));

    expect((history[0]!.content[0] as { text: string }).text).toBe('u1');
    expect(history).toHaveLength(12);
  });

  it('lastRounds：N ≥ 总轮数时等价于 all', () => {
    expect(forkMessages(history, forkLastRounds(3))).toEqual(history);
    expect(forkMessages(history, forkLastRounds(99))).toEqual(history);
  });

  it('lastRounds：N=1 只保留最后一个 round', () => {
    expect(forkMessages(history, forkLastRounds(1))).toEqual(fullRound(3));
  });

  it('lastRounds：N=2 保留最后两个 round', () => {
    expect(forkMessages(history, forkLastRounds(2))).toEqual([
      ...fullRound(2),
      ...fullRound(3),
    ]);
  });

  it('lastRounds：非正整数直接抛错，不静默降级', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => forkMessages(history, { kind: 'lastRounds', rounds: bad })).toThrow(
        RangeError,
      );
    }
  });

  it('空历史在任何模式下都得到空结果', () => {
    expect(forkMessages([], FORK_ALL)).toEqual([]);
    expect(forkMessages([], FORK_NONE)).toEqual([]);
    expect(forkMessages([], forkLastRounds(5))).toEqual([]);
  });
});

// ── ② round 分组 ────────────────────────────────────────────

describe('groupIntoRounds —— 轮次边界', () => {
  it('空历史 → 空分组', () => {
    expect(groupIntoRounds([])).toEqual([]);
  });

  it('仅一条 user → 单个 round', () => {
    expect(groupIntoRounds([user('hi')])).toEqual([[user('hi')]]);
  });

  it('不以 user 开头时，开头那段自成 round 0', () => {
    const msgs = [text('继承来的开场'), user('u1'), text('a1')];
    expect(groupIntoRounds(msgs)).toEqual([
      [text('继承来的开场')],
      [user('u1'), text('a1')],
    ]);
  });

  it('连续多条 user 各自起一个 round', () => {
    const msgs = [user('u1'), user('u2'), user('u3')];
    expect(groupIntoRounds(msgs)).toEqual([[user('u1')], [user('u2')], [user('u3')]]);
  });

  it('一个 round 内的多轮工具循环不被拆开', () => {
    const msgs = [
      user('u1'),
      calls(['c1']),
      result('c1'),
      calls(['c2']),
      result('c2'),
      text('done'),
    ];
    const rounds = groupIntoRounds(msgs);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toHaveLength(6);
  });

  it('并行调用的多条 toolResult 同属一个 round', () => {
    const msgs = [user('u1'), calls(['a', 'b', 'c']), ...results(['a', 'b', 'c'])];
    expect(groupIntoRounds(msgs)).toHaveLength(1);
  });

  it('分组是原历史的完整划分，不增不减不乱序', () => {
    const msgs = [...fullRound(1), ...fullRound(2)];
    expect(groupIntoRounds(msgs).flat()).toEqual(msgs);
  });
});

// ── ③ toolCall 完整性 ───────────────────────────────────────

describe('repairMessages —— toolCall/toolResult 配对修复', () => {
  it('整条丢弃没有对应 toolCall 的孤儿 toolResult 消息', () => {
    const msgs = [result('ghost'), user('u1'), text('a1')];
    const fixed = repairMessages(msgs);
    expect(resultIdsIn(fixed)).toEqual([]);
    expect(fixed).toEqual([user('u1'), text('a1')]);
  });

  it('剥掉结尾未被应答的 toolCall 块，保留同条消息里的文本', () => {
    const msgs = [user('u1'), calls(['pending'], '我来查一下')];
    const fixed = repairMessages(msgs);
    expect(callIdsIn(fixed)).toEqual([]);
    expect(fixed).toEqual([user('u1'), text('我来查一下')]);
  });

  it('只含一个未应答 toolCall 的 assistant 整条删除（不留空 content）', () => {
    const msgs = [user('u1'), calls(['pending'])];
    expect(repairMessages(msgs)).toEqual([user('u1')]);
    expect(repairMessages(msgs).every((m) => m.content.length > 0)).toBe(true);
  });

  it('并行 3 个调用只回了 2 个 → 剥掉 1 个，保留 2 个', () => {
    const msgs = [user('u1'), calls(['a', 'b', 'c']), ...results(['a', 'b'])];
    const fixed = repairMessages(msgs);
    expect(callIdsIn(fixed).sort()).toEqual(['a', 'b']);
    expect(resultIdsIn(fixed).sort()).toEqual(['a', 'b']);
  });

  it('完整的多轮工具循环原样保留', () => {
    const msgs = [
      user('u1'),
      calls(['c1', 'c2']),
      ...results(['c1', 'c2']),
      calls(['c3']),
      result('c3'),
      text('done'),
    ];
    expect(repairMessages(msgs)).toEqual(msgs);
  });

  it('跨消息配对也算数（result 出现在很靠后的位置）', () => {
    const msgs = [calls(['x']), text('中间插话'), result('x')];
    expect(repairMessages(msgs)).toEqual(msgs);
  });

  it('isError 的 toolResult 同样算有效应答，不被剥', () => {
    const failed: MessageLike = { ...result('c1'), isError: true };
    const msgs = [user('u1'), calls(['c1']), failed];
    expect(repairMessages(msgs)).toEqual(msgs);
  });
});

describe('forkMessages —— 切片处的完整性', () => {
  it('切口落在工具循环后时不产生孤儿 result', () => {
    const history = [
      ...fullRound(1),
      user('u2'),
      calls(['c2']),
      result('c2'),
      user('u3'),
      text('a3'),
    ];
    const forked = forkMessages(history, forkLastRounds(1));
    expect(resultIdsIn(forked)).toEqual([]);
    expect(forked).toEqual([user('u3'), text('a3')]);
  });

  it('父处于「已发调用未回结果」瞬间被 all 分身，子上下文仍然合法', () => {
    const history = [user('u1'), calls(['inflight'], '正在执行')];
    const forked = forkMessages(history, FORK_ALL);
    expect(callIdsIn(forked)).toEqual([]);
    expect(forked).toEqual([user('u1'), text('正在执行')]);
  });

  it('切片把 call 留在上一轮、result 落在本轮时，孤儿被清掉', () => {
    // 构造：round2 发起调用后模型未收束，result 在 round3 才回来
    const history = [
      ...fullRound(1),
      user('u2'),
      calls(['late']),
      user('u3'),
      result('late'),
      text('a3'),
    ];
    const forked = forkMessages(history, forkLastRounds(1));
    // 最后一轮是 [user(u3), result(late), text(a3)]，late 的 call 不在切片里
    expect(resultIdsIn(forked)).toEqual([]);
    expect(forked).toEqual([user('u3'), text('a3')]);
  });
});

// ── ④ 不变式属性测试 ────────────────────────────────────────

/** 线性同余随机数，固定种子保证失败可复现。 */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 随机生成含并行调用、跨轮调用、残缺尾部的历史。 */
function randomHistory(rng: () => number): MessageLike[] {
  const msgs: MessageLike[] = [];
  let id = 0;
  const roundCount = 1 + Math.floor(rng() * 5);

  for (let r = 0; r < roundCount; r++) {
    msgs.push(user(`u${r}`));
    const loops = Math.floor(rng() * 3);
    for (let l = 0; l < loops; l++) {
      const parallel = 1 + Math.floor(rng() * 3);
      const ids = Array.from({ length: parallel }, () => `c${id++}`);
      msgs.push(calls(ids, rng() < 0.5 ? `思考 ${r}-${l}` : undefined));
      // 有时只回应一部分，制造残缺
      const answered = rng() < 0.25 ? ids.slice(0, Math.max(0, parallel - 1)) : ids;
      msgs.push(...results(answered));
    }
    if (rng() < 0.7) msgs.push(text(`a${r}`));
  }
  return msgs;
}

function assertInvariants(msgs: readonly MessageLike[]) {
  const callIds = new Set(callIdsIn(msgs));
  const resultIds = new Set(resultIdsIn(msgs));

  for (const id of resultIds) {
    expect(callIds.has(id), `孤儿 toolResult: ${id}`).toBe(true);
  }
  for (const id of callIds) {
    expect(resultIds.has(id), `悬空 toolCall: ${id}`).toBe(true);
  }
  for (const m of msgs) {
    expect(m.content.length, '不允许出现空 content 的消息').toBeGreaterThan(0);
  }
}

describe('不变式：任意历史、任意模式，输出都合法', () => {
  it('200 组随机历史 × 全部模式', () => {
    const rng = makeRng(20260912);

    for (let i = 0; i < 200; i++) {
      const history = randomHistory(rng);
      const before = structuredClone(history);
      const modes = [FORK_NONE, FORK_ALL, forkLastRounds(1 + Math.floor(rng() * 6))];

      for (const mode of modes) {
        const forked = forkMessages(history, mode);

        assertInvariants(forked);

        // 父上下文绝不能被改动
        expect(history).toEqual(before);

        // 输出必须是父历史的保序子序列
        const forkedRoles = forked.map((m) => m.role);
        const historyRoles = history.map((m) => m.role);
        let cursor = 0;
        for (const role of forkedRoles) {
          cursor = historyRoles.indexOf(role, cursor);
          expect(cursor, '输出顺序与父历史不一致').toBeGreaterThanOrEqual(0);
          cursor++;
        }
      }
    }
  });

  it('随机历史里确实出现过残缺（否则上面的测试是空跑）', () => {
    const rng = makeRng(20260912);
    let brokenSeen = 0;
    for (let i = 0; i < 200; i++) {
      const h = randomHistory(rng);
      const calls = new Set(callIdsIn(h));
      const res = new Set(resultIdsIn(h));
      if ([...calls].some((c) => !res.has(c))) brokenSeen++;
    }
    expect(brokenSeen, '生成器没造出任何残缺历史，属性测试形同空转').toBeGreaterThan(20);
  });

  it('repair 幂等：修过一次的历史再修不变', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const once = repairMessages(randomHistory(rng));
      expect(repairMessages(once)).toEqual(once);
    }
  });
});

// ── ⑤ parseForkMode ─────────────────────────────────────────

describe('parseForkMode —— 字面量解析', () => {
  it('识别三种基本取值', () => {
    expect(parseForkMode('none')).toEqual(FORK_NONE);
    expect(parseForkMode('all')).toEqual(FORK_ALL);
    expect(parseForkMode('3')).toEqual({ kind: 'lastRounds', rounds: 3 });
  });

  // 默认值是个产品决策而非实现细节：三个产品（TabTin/kalo/tutti）都收敛到
  // 「子 Agent 不继承父上下文」，详见 protocol/agent.ts 的 DEFAULT_FORK_MODE。
  // 这条测试是那个决策的回归护栏 —— 若有人轻率改回 all，这里会红。
  it('缺省与空串默认为 none（纯净）', () => {
    expect(parseForkMode(undefined)).toEqual(FORK_NONE);
    expect(parseForkMode(null)).toEqual(FORK_NONE);
    expect(parseForkMode('')).toEqual(FORK_NONE);
    expect(parseForkMode('   ')).toEqual(FORK_NONE);
  });

  it('大小写与空白容错', () => {
    expect(parseForkMode('NONE')).toEqual(FORK_NONE);
    expect(parseForkMode(' All ')).toEqual(FORK_ALL);
    expect(parseForkMode(' 5 ')).toEqual({ kind: 'lastRounds', rounds: 5 });
  });

  it('非法输入抛错而非静默截断', () => {
    expect(() => parseForkMode('0')).toThrow(RangeError);
    expect(() => parseForkMode('-1')).toThrow(TypeError);
    expect(() => parseForkMode('abc')).toThrow(TypeError);
    // 关键：不能被 parseInt 截断成 1
    expect(() => parseForkMode('1.5')).toThrow(TypeError);
    expect(() => parseForkMode('3abc')).toThrow(TypeError);
  });
});

// ── ⑥ 角色减能 ──────────────────────────────────────────────

describe('intersectTools —— 角色只能减能', () => {
  it('子集正常保留', () => {
    expect(intersectTools(['read', 'edit', 'shell'], ['read'])).toEqual(['read']);
  });

  it('子级越权申请被剔除', () => {
    expect(intersectTools(['read'], ['read', 'shell'])).toEqual(['read']);
  });

  it('父级无限制时子级声明即生效', () => {
    expect(intersectTools(undefined, ['read'])).toEqual(['read']);
  });

  it('子级未声明则继承父级', () => {
    expect(intersectTools(['read', 'edit'], undefined)).toEqual(['read', 'edit']);
    expect(intersectTools(undefined, undefined)).toBeUndefined();
  });

  it('返回新数组，不与父级共享引用', () => {
    const parent = ['read', 'edit'];
    const got = intersectTools(parent, undefined);
    expect(got).not.toBe(parent);
  });
});

/**
 * ContextForker —— 把父 Agent 的上下文切给子 Agent。
 *
 * 这是整个项目最容易出错的一块，原因是 toolCall/toolResult 的**配对约束**：
 * 几乎所有模型 API 都要求 assistant 发出的每个 toolCall 都有对应的 toolResult，
 * 且 toolResult 不能凭空出现。一旦按「消息条数」切片，切口两侧必然出现：
 *
 *   - 孤儿 toolResult：切片开头有结果，但产生它的 toolCall 被切掉了
 *   - 悬空 toolCall：切片结尾的 assistant 发起了调用，但结果被切掉了
 *
 * 模型会直接 400。所以这里的策略是两步：
 *   1. 按 round 边界切（round = 一条 user 消息及其引发的全部后续消息）
 *   2. 对切片结果做修复，兜住 round 内部本身就残缺的情况
 *
 * 第 2 步不是多余的：父 Agent 可能正处在「已发出 toolCall、结果还没回来」
 * 的瞬间就被 fork，此时最后一个 round 天然是残缺的。
 */

import type { ContentBlockLike, MessageLike } from '@axon/protocol';
import { type AgentPath, type ForkMode, isAncestorOf } from '@axon/protocol';

/**
 * 按 round 切分消息历史。
 *
 * round 的定义：以一条 user 消息开头，直到下一条 user 消息之前的所有消息。
 * 中间的 assistant / toolResult 往返（可能很多轮工具循环）都属于同一个 round。
 *
 * 两个边界情况天然被覆盖：
 *  - 历史不以 user 开头（如 fork 出来的子上下文）：开头那段自成 round 0
 *  - 连续多条 user 消息：每条各起一个 round
 */
export function groupIntoRounds(messages: readonly MessageLike[]): MessageLike[][] {
  const rounds: MessageLike[][] = [];
  let current: MessageLike[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      rounds.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) rounds.push(current);

  return rounds;
}

function blocksOf(msg: MessageLike): ContentBlockLike[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

/** 取一条 assistant 消息里所有 toolCall 块的 id。 */
function callIdsOf(msg: MessageLike): string[] {
  return blocksOf(msg)
    .filter((b) => b.type === 'toolCall')
    .map((b) => (b as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * 修复消息序列，使 toolCall/toolResult 严格配对。
 *
 * 两侧的形态是不对称的，这点极易搞错（实测 pi 0.85.1 的 transcript）：
 *   - toolCall  是 assistant 消息 content 里的**块**，标识字段为 `id`
 *   - toolResult 是**独立的一条消息**，标识字段为顶层的 `toolCallId`，
 *     它的 content 里只有普通 text 块
 * 所以「丢孤儿」删的是整条消息，「剥悬空」删的是块。
 *
 * 实现要点：先完整扫描收集两侧 id 集合，再做两步删除。
 * 两步互不干扰 —— 丢弃孤儿 result 不会让任何 call 变悬空（被丢的 result
 * 本就没有对应 call），剥离悬空 call 也不会制造新孤儿（被剥的 call 本就
 * 没有对应 result）。因此无需迭代到不动点。
 */
export function repairMessages(messages: readonly MessageLike[]): MessageLike[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    for (const id of callIdsOf(msg)) callIds.add(id);
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      resultIds.add(msg.toolCallId);
    }
  }

  const repaired: MessageLike[] = [];

  for (const msg of messages) {
    // 第一步：整条丢弃没有对应 toolCall 的 toolResult 消息
    if (msg.role === 'toolResult') {
      if (typeof msg.toolCallId === 'string' && !callIds.has(msg.toolCallId)) continue;
      repaired.push(msg);
      continue;
    }

    // 第二步：剥掉没有对应 toolResult 的 toolCall 块
    const blocks = blocksOf(msg);
    const kept = blocks.filter((block) => {
      if (block.type !== 'toolCall') return true;
      const id = (block as { id?: unknown }).id;
      return typeof id === 'string' ? resultIds.has(id) : true;
    });

    if (kept.length === blocks.length) {
      repaired.push(msg);
      continue;
    }

    // 块被删光 —— 整条消息也没意义了（例如只发起了一个未应答调用的 assistant
    // 消息）。留着会变成空 content，同样被模型拒绝。
    if (kept.length === 0) continue;

    repaired.push({ ...msg, content: kept });
  }

  return repaired;
}

/**
 * 按分身模式切出子 Agent 的初始消息历史。
 *
 * 全程深拷贝：子 Agent 之后会往自己的历史里追加消息，若共享引用，
 * 子的改动会污染父的上下文 —— 这种 bug 在多 Agent 场景下极难定位。
 */
export function forkMessages(
  parentMessages: readonly MessageLike[],
  mode: ForkMode,
): MessageLike[] {
  switch (mode.kind) {
    case 'none':
      return [];

    case 'all': {
      // 仍需 repair：父可能正处于「已发 toolCall 未回结果」的瞬间。
      return repairMessages(structuredClone(parentMessages) as MessageLike[]);
    }

    case 'lastRounds': {
      if (!Number.isInteger(mode.rounds) || mode.rounds <= 0) {
        throw new RangeError(`fork rounds 必须是正整数，收到 ${mode.rounds}`);
      }
      const cloned = structuredClone(parentMessages) as MessageLike[];
      const rounds = groupIntoRounds(cloned);
      const sliced = rounds.slice(-mode.rounds).flat();
      return repairMessages(sliced);
    }
  }
}

/**
 * 工具白名单求交集 —— 角色只能减能，不能越权。
 *
 * 借鉴 codex 的 agent_roles 约束。没有这条，一个被限制为只读的角色
 * 可以在自己的配置里给自己加回 shell，权限模型就形同虚设。
 *
 * parentTools 为 undefined 表示父级无限制（根 Agent），此时子级声明什么就是什么。
 */
export function intersectTools(
  parentTools: readonly string[] | undefined,
  childTools: readonly string[] | undefined,
): string[] | undefined {
  if (childTools === undefined) {
    return parentTools === undefined ? undefined : [...parentTools];
  }
  if (parentTools === undefined) return [...childTools];

  const allowed = new Set(parentTools);
  return childTools.filter((t) => allowed.has(t));
}

/**
 * 校验 wait 目标合法性，防止编排层自己造出死锁。
 *
 * 三类非法：等自己、等自己的祖先（祖先正阻塞在等我）、等不存在的 agent。
 */
export function assertWaitable(
  self: AgentPath,
  target: AgentPath,
  exists: (path: AgentPath) => boolean,
): void {
  if (self === target) {
    throw new Error(`agent ${self} 不能等待自己`);
  }
  if (isAncestorOf(target, self)) {
    throw new Error(`agent ${self} 不能等待其祖先 ${target}，会立即死锁`);
  }
  if (!exists(target)) {
    throw new Error(`等待目标不存在: ${target}`);
  }
}

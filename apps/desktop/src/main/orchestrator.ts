/**
 * M3 编排工具层 —— 六个 AgentTool 的「身体」（M3 文档 §4.1）。
 *
 * 设计要点：
 * - 只依赖 `OrchestrationDriver` 接口：不 import electron、不 import host，
 *   单测用 FakeDriver 驱动，headless 可测。
 * - 双闭包：工具集合 per-spawn 现造（`AgentTool.execute` 签名里没有
 *   「谁在调我」，调用者身份在**创建工具集时** bind 进 driver.selfPath）。
 * - 错误一律 throw：pi 约定 throw 转 error toolResult 回灌给模型，
 *   模型知道失败原因并自行纠偏（types.d.ts 注释：Throw on failure）。
 * - 等边只沿树向下：所有目标必须先过 `assertWaitable`（自己/祖先/不存在
 *   全拦），结构性死锁不可能（M3 §4.3）。
 *
 * 六件套（抄 TabTin 五件套 + spawn，02 §3.3）：
 *   agent           spawn 子 Agent，异步立返——等待是 agent_wait 的事
 *   agent_wait      挂起（父退位让额）等目标全部终态或超时；超时不杀子（决策 #5）
 *   agent_check     只读快照摘要 + 最近一条 assistant 文本预览
 *   agent_message   运行中投递（steer，下一轮生效）；终态 throw 提示改用 resume
 *   agent_resume    终态目标追加任务（fire 语义！结果用 agent_wait 等）
 *   agent_interrupt abort 下游（parked 则出队丢任务）
 *
 * M4 追加第七件：
 *   ledger_adopt    裁决一笔协作产出（仅当前 AdoptionPolicy 的 arbiter 可用）
 *
 * M4 落账：落账点选在这一层而不是 host，是因为 `driver.selfPath` 已经把
 * 「谁发起的协作」绑定好了，from 身份零成本可得。三个只读/控制类工具
 * （wait / check / interrupt）**不落账** —— 它们不是协作动作，落了只会淹没账本。
 */

import {
  isTerminal,
  parseForkMode,
  type Adoption,
  type AgentPath,
  type AgentSnapshot,
  type CollabAction,
  type CollabOrigin,
  type MessageLike,
} from '@axon/protocol';
import {
  Type,
  assertWaitable,
  type AgentTool,
  type AgentToolResult,
} from '@axon/kernel';

// ── OrchestrationDriver ──────────────────────────────────────
//
// host 用 AxonHost 实现它（slice 5 装配），测试用 FakeDriver 实现。
// 刻意收窄：编排工具只需要这些能力，不需要见到 registry / engine /
// 事件流。接口越小，假实现越廉价，工具的行为越容易被单独钉死。

export interface OrchestrationDriver {
  /** 调用者自己。spawn 出的子挂在它名下；所有目标校验都以它为参照。 */
  readonly selfPath: AgentPath;
  /** 立即 spawn 子 Agent 并投喂 task。失败（角色不存在/超深/冻结）throw。 */
  spawnChild(spec: { role: string; task: string; forkMode?: string }): AgentPath;
  /** 跑一轮任务。fire 语义：宿主内部排队/闸门全包，调用方不 await 跑完。 */
  requestRun(path: AgentPath, text: string): Promise<void>;
  /** 中断目标（终态/不存在为幂等 no-op）。 */
  interrupt(path: AgentPath): void;
  /** 快照；不存在返回 null。 */
  snapshot(path: AgentPath): AgentSnapshot | null;
  /** 消息记录（agent_check 的文本预览用）。 */
  messagesOf(path: AgentPath): MessageLike[];
  /** 挂起（退位让额）直到全部目标终态。目标已终态时应立即 resolve。 */
  beginWait(targets: AgentPath[]): Promise<void>;
  /** 摘掉自己的全部 wait 边并恢复 running（超时/被中断路径必调）。 */
  endWait(): void;
  /** 向目标投递指导消息（下一轮生效）；目标在 parked 则排队到下一轮。 */
  steerTo(path: AgentPath, text: string): void;

  /** M4：落一笔协作账。幂等（同 toolCallId 重复调不会出两行）。 */
  recordCollab(spec: {
    action: CollabAction;
    to: AgentPath;
    origin: CollabOrigin;
    contextScope?: string;
  }): void;
  /** M4：裁决一笔协作。资格校验在宿主；不合格则 throw（错误回灌给模型）。 */
  adoptCollab(spec: { id: string; adoption: Adoption; note?: string }): void;
}

// ── 常量与辅助 ────────────────────────────────────────────────

/** 六个编排工具的名字。角色白名单通过引用这些名字来授权（M3 §4.1 矩阵）。 */
export const ORCHESTRATION_TOOL_NAMES = [
  'agent',
  'agent_wait',
  'agent_check',
  'agent_message',
  'agent_resume',
  'agent_interrupt',
  'ledger_adopt',
] as const;

/** agent_wait 默认超时 600s（M3 §4.5）。 */
const DEFAULT_WAIT_TIMEOUT_SEC = 600;

/** agent_check 文本预览上限（§4.1）。 */
const PREVIEW_MAX = 500;

/** 工具返回值：content 给模型读，details 给下游工具/UI 结构化消费。 */
function result(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details };
}

/**
 * 目标校验：必须是调用者的后代且存在。非后代（含自己、祖先、旁支）与
 * 不存在的目标一律 throw —— 这是 wait/check/message/resume/interrupt
 * 共用的第一道闸，也是「等边只沿树向下」的落点（M3 §4.3）。
 */
function requireTarget(driver: OrchestrationDriver, id: string): AgentSnapshot {
  const target = id as AgentPath;
  assertWaitable(driver.selfPath, target, (p) => driver.snapshot(p) !== null);
  return driver.snapshot(target)!;
}

/** 最近一条 assistant 消息的纯文本（不含 toolCall 块），截断到 max。 */
function lastAssistantPreview(
  messages: MessageLike[],
  max = PREVIEW_MAX,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const text = (m.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return undefined;
}

/** 等一个 promise：完成 → 'done'；超时 → 'timeout'；signal 中止 → 'aborted'。 */
function waitWithAbort(
  p: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<'done' | 'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: 'done' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    const onAbort = () => settle('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    void p.then(() => settle('done'));
  });
}

// ── 六个工具 ─────────────────────────────────────────────────

const TASK = Type.Object({
  role: Type.String(),
  task: Type.String(),
  forkMode: Type.Optional(Type.String()),
});

/**
 * agent —— spawn 子 Agent（挂在调用者名下）并投喂 task。
 * 异步立返：resolve 时子 Agent 已注册并（可能）入队，跑没跑完不管。
 */
function agentTool(driver: OrchestrationDriver): AgentTool<typeof TASK> {
  return {
    name: 'agent',
    label: 'spawn 子 Agent',
    description:
      '创建一个子 Agent 并派给它一项任务。子 Agent 挂在你的名下（你的后代）。' +
      '返回的 id 是后续 agent_wait / agent_check / agent_message / ' +
      'agent_resume / agent_interrupt 的目标。创建后立即返回，不等待它跑完——' +
      '要等它出结果请用 agent_wait。',
    parameters: TASK,
    async execute(toolCallId, params) {
      const path = driver.spawnChild({
        role: params.role,
        task: params.task,
        forkMode: params.forkMode,
      });
      // delegate vs fork 就看上下文口径：干净上下文的下属 = 委派；
      // 带着父上下文分出去的 = 分叉（tutti 的 context_scope 正是此维度）。
      // 注意用 parseForkMode 而不是比字符串："" / "NONE" / undefined 都该归 none。
      const resolved = parseForkMode(params.forkMode);
      driver.recordCollab({
        action: resolved.kind === 'none' ? 'delegate' : 'fork',
        to: path,
        origin: { tool: 'agent', toolCallId },
        contextScope: params.forkMode,
      });
      return result(
        `已创建子 Agent ${path}（角色 ${params.role}），用 agent_wait 等它收尾。`,
        { id: path, role: params.role },
      );
    },
  };
}

const WAIT = Type.Object({
  ids: Type.Array(Type.String()),
  timeoutSec: Type.Optional(Type.Number()),
});

/**
 * agent_wait —— 挂起等待目标全部终态（done/failed/interrupted）。
 * 等待期间调用者退位让出并发额度（宿主语义），目标终态后自动恢复。
 * 超时不杀子（决策 #5）：timedOut 目标继续跑，可用 agent_check 追结果。
 * 被中断（用户 interrupt 了调用者）时返回当前状态并摘边。
 */
function agentWaitTool(driver: OrchestrationDriver): AgentTool<typeof WAIT> {
  return {
    name: 'agent_wait',
    label: '等待子 Agent',
    description:
      '挂起并等待这些目标 Agent（你的后代）全部到达终态（done/failed/interrupted），' +
      '或超时。等待期间你让出并发额度，目标完成后自动恢复。' +
      '超时不会杀掉目标（它们在继续跑），超时的条目带 timedOut 标记，' +
      '之后可用 agent_check 追结果。',
    parameters: WAIT,
    async execute(_toolCallId, params, signal) {
      const ids = params.ids as AgentPath[];
      for (const id of ids) requireTarget(driver, id);

      const outcome = await waitWithAbort(
        driver.beginWait(ids),
        (params.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC) * 1000,
        signal,
      );
      // 超时/被中止都要摘边：否则宿主会认为调用者仍在等、永远不退位恢复。
      if (outcome !== 'done') driver.endWait();

      const statuses = ids.map((id) => {
        const snap = driver.snapshot(id)!;
        return {
          id,
          status: snap.status,
          lastError: snap.lastError,
          timedOut: outcome === 'timeout' && !isTerminal(snap.status),
        };
      });
      return result(
        outcome === 'done'
          ? '全部目标已终态。'
          : outcome === 'timeout'
            ? '等待超时：未终态的目标带 timedOut 标记，仍在继续跑。'
            : '等待被中断。',
        { statuses },
      );
    },
  };
}

const CHECK = Type.Object({ id: Type.String() });

/** agent_check —— 只读快照摘要，不改变任何状态。 */
function agentCheckTool(driver: OrchestrationDriver): AgentTool<typeof CHECK> {
  return {
    name: 'agent_check',
    label: '查看 Agent 状态',
    description:
      '只读查看目标 Agent（你的后代）的最新摘要：状态、用量、子 Agent、最近错误，' +
      '以及最近一条回复的文本预览（最多 500 字）。不改变任何状态。',
    parameters: CHECK,
    async execute(_toolCallId, params) {
      const snap = requireTarget(driver, params.id);
      return result(
        `${snap.displayName} 状态: ${snap.status}`,
        {
          id: snap.path,
          status: snap.status,
          usage: snap.usage,
          children: snap.children,
          lastError: snap.lastError,
          preview: lastAssistantPreview(driver.messagesOf(snap.path)),
        },
      );
    },
  };
}

const MESSAGE = Type.Object({ id: Type.String(), text: Type.String() });

/** agent_message —— 向运行中/排队中的目标投递指导消息（下一轮生效）。 */
function agentMessageTool(driver: OrchestrationDriver): AgentTool<typeof MESSAGE> {
  return {
    name: 'agent_message',
    label: '给 Agent 递话',
    description:
      '向目标 Agent（你的后代）投递一条消息：目标在运行中，则本轮结束后注入、' +
      '下一轮首条生效；目标在排队中，则到它下一轮开始时生效。' +
      '目标已终态时不可用——改用 agent_resume 追加任务。',
    parameters: MESSAGE,
    async execute(toolCallId, params) {
      const snap = requireTarget(driver, params.id);
      if (isTerminal(snap.status)) {
        throw new Error(
          `agent ${snap.path} 已终态（${snap.status}），改用 agent_resume 追加任务`,
        );
      }
      driver.steerTo(snap.path, params.text);
      // consult：steer 的 pi 语义是「下一轮生效，不保证被采纳」，
      // 恰好需要 adoption 来裁决「这句指导最后算不算数」。
      driver.recordCollab({
        action: 'consult',
        to: snap.path,
        origin: { tool: 'agent_message', toolCallId },
      });
      return result(`已投递给 ${snap.path}（下一轮生效）。`, {
        id: snap.path,
        status: snap.status,
      });
    },
  };
}

const RESUME = Type.Object({ id: Type.String(), text: Type.String() });

/**
 * agent_resume —— 终态目标追加任务，fire 语义。
 *
 * 为什么**不 await** 任务跑完（这一点很反直觉，写死在这里）：
 * requestRun 在并发额满时会把目标扔进 parked 排队，其 Promise 直到跑完才
 * resolve。若工具 await 它，调用者占着额度等一个没额度的子 —— 共享额度
 * 模型下的结构性死锁（`maxConcurrent=1` 时当场触发）。等结果必须走
 * agent_wait：它会先让调用者退位，把额度放给子，子跑完再唤醒父。
 */
function agentResumeTool(driver: OrchestrationDriver): AgentTool<typeof RESUME> {
  return {
    name: 'agent_resume',
    label: '让 Agent 接着干',
    description:
      '给已终态（done/failed/interrupted）的目标 Agent（你的后代）追加一项' +
      '新任务，让它重新跑起来。立即返回——要等结果请随后调用 agent_wait。' +
      '目标还在运行/排队时不可用。',
    parameters: RESUME,
    async execute(toolCallId, params) {
      const snap = requireTarget(driver, params.id);
      if (!isTerminal(snap.status)) {
        throw new Error(
          `agent ${snap.path} 状态为 ${snap.status}，agent_resume 只对终态目标可用（等结果用 agent_wait）`,
        );
      }
      // 先落账再 fire：否则目标有可能在落账前就跑完进终态，
      // settle 钩子找不到这笔 open 记录，账上就永远挂着一笔未结算。
      driver.recordCollab({
        action: 'handoff',
        to: snap.path,
        origin: { tool: 'agent_resume', toolCallId },
      });
      // fire：失败会落在目标自己的 failed 状态上，父用 agent_check 追。
      void driver.requestRun(snap.path, params.text).catch(() => undefined);
      return result(`已向 ${snap.path} 追加任务。`, { id: snap.path });
    },
  };
}

const INTERRUPT = Type.Object({ id: Type.String() });

/** agent_interrupt —— 中止下游（parked 则出队丢任务；终态幂等）。 */
function agentInterruptTool(driver: OrchestrationDriver): AgentTool<typeof INTERRUPT> {
  return {
    name: 'agent_interrupt',
    label: '中断 Agent',
    description:
      '中断目标 Agent（你的后代）：在跑的马上 abort，在排队中的出队丢任务，' +
      '已终态的为幂等 no-op。目标会进入 interrupted 状态。',
    parameters: INTERRUPT,
    async execute(_toolCallId, params) {
      const snap = requireTarget(driver, params.id);
      driver.interrupt(snap.path);
      const after = driver.snapshot(snap.path)?.status ?? snap.status;
      return result(`${snap.path} 已中断（${after}）。`, { id: snap.path, status: after });
    },
  };
}

const ADOPT = Type.Object({
  recordId: Type.String(),
  adoption: Type.Union([Type.Literal('adopted'), Type.Literal('rejected')]),
  note: Type.Optional(Type.String()),
});

/**
 * ledger_adopt —— 裁决一笔协作产出（M4 决策 D2：AutoAdoption）。
 *
 * 三点写死在这里：
 *  - 参数里**没有裁决者身份** —— 和另六个一样靠 selfPath 双闭包绑定（M3 不变量），
 *    模型传不了「我是谁」，也就冒充不了裁决者。
 *  - 只允许 adopted / rejected：回到 pending 或改 not_applicable 不是裁决，是抹账。
 *  - 工具按 M3 决策 #1（全员全件套）发给所有角色，资格在 **execute 时**由宿主校验。
 *    不按 spawn 时的策略发工具，是因为策略可以在 spawn 之后才改——
 *    那样会得到一个永远改不动的静态授权。
 */
function ledgerAdoptTool(driver: OrchestrationDriver): AgentTool<typeof ADOPT> {
  return {
    name: 'ledger_adopt',
    label: '裁决协作产出',
    description:
      '对协作账本里的一笔记录表态：adopted（采纳）或 rejected（不采纳），' +
      '并用 note 写明理由。只有当前被指定为裁决者时可用；' +
      '你不能裁决自己或自己后代交付的成果。',
    parameters: ADOPT,
    async execute(_toolCallId, params) {
      driver.adoptCollab({
        id: params.recordId,
        adoption: params.adoption as Adoption,
        note: params.note,
      });
      return result(`已对 ${params.recordId} 表态：${params.adoption}。`, {
        id: params.recordId,
        adoption: params.adoption,
      });
    },
  };
}

/** 为一棵树上的某个 Agent 现造全套工具（per-spawn bind selfPath）。 */
export function createOrchestrationTools(driver: OrchestrationDriver) {
  return [
    agentTool(driver),
    agentWaitTool(driver),
    agentCheckTool(driver),
    agentMessageTool(driver),
    agentResumeTool(driver),
    agentInterruptTool(driver),
    ledgerAdoptTool(driver),
  ];
}
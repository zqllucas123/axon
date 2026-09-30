/**
 * preload —— 渲染进程与主进程之间唯一的孔。
 *
 * 只暴露 `platform` 一个常量、`invoke` 与 `subscribe` 两个方法（形状见
 * @axon/protocol 的 `AxonBridge`）。不暴露 ipcRenderer 本体，也不暴露任何
 * Node API —— 否则 contextIsolation 等于白开。
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_COMMAND_CHANNEL,
  ipcEventChannel,
  type AgentPath,
  type AxonBridge,
  type AxonPlatform,
  type CommandMap,
  type EventMap,
  type NotificationEnvelope,
  type ResponseEnvelope,
} from '@axon/protocol';

/**
 * `process.platform` → 协议里的三值联合。
 *
 * 归一（而不是原样透出去）是因为渲染层只对这三种分支过：多出来的值
 * （`freebsd`/`openbsd`/…）如果漏进去，渲染层会拿到一个「哪个分支都不匹配」
 * 的字符串，然后静默地按非 Windows 走 —— 那正是最难查的一类错。
 */
function toAxonPlatform(platform: NodeJS.Platform): AxonPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

let seq = 0;

const bridge: AxonBridge = {
  platform: toAxonPlatform(process.platform),
  async invoke<C extends keyof CommandMap>(
    command: C,
    payload: CommandMap[C]['payload'],
  ): Promise<CommandMap[C]['result']> {
    const id = `axon-${++seq}`;
    const response: ResponseEnvelope<C> = await ipcRenderer.invoke(IPC_COMMAND_CHANNEL, {
      id,
      command,
      payload,
    });
    if (!response.ok) {
      // 把结构化错误还原成异常，让调用方能用常规 try/catch。
      const err = new Error(response.error.message);
      err.name = response.error.code;
      throw err;
    }
    return response.result;
  },

  subscribe<E extends keyof EventMap>(
    event: E,
    handler: (
      payload: EventMap[E],
      meta: { source?: AgentPath; sessionId?: string; at: number },
    ) => void,
  ): () => void {
    const channel = ipcEventChannel(event);
    const listener = (_e: unknown, envelope: NotificationEnvelope<E>) => {
      // source 在 MU-1 起是可选的（账本策略、会话级事件没有单一归属 Agent）。
      handler(envelope.payload, {
        ...(envelope.source !== undefined ? { source: envelope.source } : {}),
        ...(envelope.sessionId !== undefined ? { sessionId: envelope.sessionId } : {}),
        at: envelope.at,
      });
    };
    ipcRenderer.on(channel, listener);
    // 返回退订而不是让调用方自己记 channel 名 —— 少一个出错的地方。
    return () => ipcRenderer.off(channel, listener);
  },
};

contextBridge.exposeInMainWorld('axon', bridge);

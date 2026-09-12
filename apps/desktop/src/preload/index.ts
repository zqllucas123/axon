/**
 * preload —— 渲染进程与主进程之间唯一的孔。
 *
 * 只暴露 `invoke` 与 `subscribe` 两个方法（形状见 @axon/protocol 的 `AxonBridge`）。
 * 不暴露 ipcRenderer 本体，也不暴露任何 Node API ——
 * 否则 contextIsolation 等于白开。
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_COMMAND_CHANNEL,
  ipcEventChannel,
  type AxonBridge,
  type CommandMap,
  type EventMap,
  type NotificationEnvelope,
  type ResponseEnvelope,
} from '@axon/protocol';

let seq = 0;

const bridge: AxonBridge = {
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
    handler: (payload: EventMap[E], meta: { source: string; at: number }) => void,
  ): () => void {
    const channel = ipcEventChannel(event);
    const listener = (_e: unknown, envelope: NotificationEnvelope<E>) => {
      handler(envelope.payload, { source: envelope.source, at: envelope.at });
    };
    ipcRenderer.on(channel, listener);
    // 返回退订而不是让调用方自己记 channel 名 —— 少一个出错的地方。
    return () => ipcRenderer.off(channel, listener);
  },
};

contextBridge.exposeInMainWorld('axon', bridge);

/**
 * 渲染进程的全局类型 —— preload 通过 contextBridge 注入的 window.axon。
 */

import type { AxonBridge } from '@axon/protocol';

declare global {
  interface Window {
    axon: AxonBridge;
  }
}

export {};
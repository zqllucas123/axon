/**
 * keychain.ts —— API key 的加密存取
 *
 * 使用 Electron 内置的 safeStorage（无额外依赖）：
 * - 可用时：加密 → base64 → 写 provider.apiKeyCiphertext；删 provider.apiKey
 * - 不可用时（CI / 非 macOS）：降级明文存 provider.apiKey，打 warn
 *
 * getKey / hasKey 用同步 readFileSync（config.json 很小，主进程启动路径可接受）。
 * setKey 写盘是异步（read → encrypt → writeFile + rename 原子落盘）。
 */

import { safeStorage } from 'electron';

/**
 * safeStorage 在 Vitest/Node 环境下可能是 undefined（electron mock 未初始化）。
 * 所有调用点都必须经过这个函数，不要直接用 safeStorage。
 */
function isEncryptionAvailable(): boolean {
  return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
}
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_PATH } from './model-config.ts';

type RawConfig = Record<string, unknown>;

// ─── 内部 helpers ────────────────────────────────────────────

function readRawSync(configPath = CONFIG_PATH): RawConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;
  } catch {
    return {};
  }
}

async function writeRawAsync(raw: RawConfig, configPath = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const payload = `${JSON.stringify(raw, null, 2)}\n`;
  const tmp = `${configPath}.tmp-keychain-${Date.now()}`;
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, configPath);
}

function getAt(raw: RawConfig, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let cur: unknown = raw;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as RawConfig)[p];
  }
  return cur;
}

function setAt(raw: RawConfig, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let cur = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as RawConfig;
  }
  cur[parts[parts.length - 1]!] = value;
}

function delAt(raw: RawConfig, dotPath: string): void {
  const parts = dotPath.split('.');
  let cur = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== 'object' || cur[p] === null) return;
    cur = cur[p] as RawConfig;
  }
  delete cur[parts[parts.length - 1]!];
}

/** 'provider.apiKey' → 'provider.apiKeyCiphertext' */
function ctPath(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot === -1) return `${key}Ciphertext`;
  return `${key.slice(0, dot + 1)}${key.slice(dot + 1)}Ciphertext`;
}

// ─── 公开 API ─────────────────────────────────────────────────

/**
 * 存储一个 key。
 * safeStorage 可用时写密文 + 删明文；不可用时降级写明文并 warn。
 */
export async function setKey(key: string, plaintext: string, configPath = CONFIG_PATH): Promise<void> {
  const raw = readRawSync(configPath);

  if (!isEncryptionAvailable()) {
    console.warn('[keychain] safeStorage 不可用，apiKey 以明文存储');
    setAt(raw, key, plaintext);
    await writeRawAsync(raw, configPath);
    return;
  }

  const ciphertext = safeStorage.encryptString(plaintext).toString('base64');
  setAt(raw, ctPath(key), ciphertext);
  delAt(raw, key);
  await writeRawAsync(raw, configPath);
}

/**
 * 读取一个 key 的明文；不存在返回 null。
 * 解密结果只存在于主进程内存，不出 keychain。
 */
export function getKey(key: string, configPath = CONFIG_PATH): string | null {
  const raw = readRawSync(configPath);

  if (!isEncryptionAvailable()) {
    const v = getAt(raw, key);
    return typeof v === 'string' ? v : null;
  }

  const ct = getAt(raw, ctPath(key));
  if (typeof ct !== 'string') return null;
  try {
    return safeStorage.decryptString(Buffer.from(ct, 'base64'));
  } catch {
    return null;
  }
}

/** 判断 key 是否已存储（不解密）。 */
export function hasKey(key: string, configPath = CONFIG_PATH): boolean {
  const raw = readRawSync(configPath);

  if (!isEncryptionAvailable()) {
    const v = getAt(raw, key);
    return typeof v === 'string' && v.length > 0;
  }

  const ct = getAt(raw, ctPath(key));
  return typeof ct === 'string' && ct.length > 0;
}

/**
 * ConfigStore 单测 —— 掩码 / patch 白名单 / 未知字段保留 / env 锁定（MU-1 §八）。
 *
 * 用真实临时目录而不是内存 IO：`load()` 走 `loadConfig`（真 fs），
 * 而 patch 的原子写与 0600 权限也只有在真盘上才验得出来 ——
 * 一个测试替身在这里恰好会把「权限位没设」这类事故测没。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from './config-store.ts';

const dirs: string[] = [];
async function tempConfig(initial?: unknown): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'axon-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  if (initial !== undefined) await writeFile(path, JSON.stringify(initial, null, 2));
  return { path, dir };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function store(path: string, env: Record<string, string | undefined> = {}) {
  return new ConfigStore({ configPath: path, roleDir: '/tmp/roles', teamDir: '/tmp/teams', env });
}

const readRaw = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

// ────────────────────────────────────────────────────────────
// 读侧
// ─────────────────────────────────────────────────────────────

describe('ConfigStore · 读侧掩码与降级', () => {
  it('配置文件不存在 ⇒ 空配置 + 降级（不抛）', async () => {
    const { path } = await tempConfig();
    const s = store(path);
    await s.load();
    expect(s.rawConfig()).toEqual({});
    expect(s.snapshot().config).toEqual({});
    expect(s.snapshot().resolution.degraded).toBe(true);
  });

  it('坏 JSON ⇒ 记错误原因，仍能起（降级到 faux）', async () => {
    const { path, dir } = await tempConfig();
    await writeFile(join(dir, 'config.json'), '{ nope');
    const s = store(path);
    await s.load();
    expect(s.snapshot().resolution.degraded).toBe(true);
    expect(s.snapshot().resolution.reason).toContain('config.json');
  });

  it('apiKey 永不回明文：只给 apiKeySet + 掩码', async () => {
    const { path } = await tempConfig({
      provider: { baseUrl: 'https://gw/v1', apiKey: 'sk-1234567890abcd', models: [{ id: 'm' }] },
    });
    const s = store(path);
    await s.load();
    const cfg = s.snapshot().config;
    expect(cfg.provider?.apiKeySet).toBe(true);
    expect(cfg.provider?.apiKeyMasked).toBe('sk-***bcd');
    expect(JSON.stringify(cfg)).not.toContain('sk-1234567890abcd');
    // 主进程内部要拿到明文（建模型源用）
    expect(s.rawConfig().provider?.apiKey).toBe('sk-1234567890abcd');
  });

  it('未配置 apiKey ⇒ apiKeySet=false 且不给掩码字段', async () => {
    const { path } = await tempConfig({ provider: { baseUrl: 'https://gw/v1' } });
    const s = store(path);
    await s.load();
    expect(s.snapshot().config.provider?.apiKeySet).toBe(false);
    expect(s.snapshot().config.provider?.apiKeyMasked).toBeUndefined();
  });

  it('配齐 provider ⇒ 不降级，并报出有效模型', async () => {
    const { path } = await tempConfig({
      provider: { baseUrl: 'https://gw/v1', apiKey: 'sk-abcdefgh', models: [{ id: 'axon-pro' }] },
    });
    const s = store(path);
    await s.load();
    const r = s.snapshot().resolution;
    expect(r.degraded).toBe(false);
    expect(r.effectiveModel).toBe('axon-pro');
  });

  it('paths() 报出三个真相目录', async () => {
    const { path } = await tempConfig();
    const s = store(path);
    expect(s.paths()).toEqual({ config: path, roles: '/tmp/roles', teams: '/tmp/teams' });
  });
});

describe('ConfigStore · 环境变量覆盖', () => {
  it('三种 env 都能识别；密钥类只给掩码', async () => {
    const { path } = await tempConfig({
      provider: { baseUrl: 'https://file/v1', apiKey: 'sk-file-key-000000', models: [{ id: 'm' }] },
    });
    const s = store(path, {
      AXON_BASE_URL: 'https://env/v1',
      AXON_API_KEY: 'sk-env-key-999999',
      AXON_MODEL: 'env-model',
    });
    await s.load();
    const overrides = s.snapshot().envOverrides;
    const byPath = new Map(overrides.map((o) => [o.path, o]));
    expect(byPath.get('provider.baseUrl')?.value).toBe('https://env/v1');
    expect(byPath.get('provider.baseUrl')?.env).toBe('AXON_BASE_URL');
    expect(byPath.get('provider.apiKey')?.value).toBe('sk-***999');
    expect(byPath.get('provider.defaultModel')?.value).toBe('env-model');
  });

  it('空串不算覆盖（否则「设了空变量」会静默清掉配置）', async () => {
    const { path } = await tempConfig({ provider: { apiKey: 'sk-x' } });
    const s = store(path, { AXON_BASE_URL: '' });
    await s.load();
    expect(s.snapshot().envOverrides.map((o) => o.path)).toEqual([]);
  });

  it('AXON_PROVIDER=faux 让解析降级（冒烟与本地开发的逃生门）', async () => {
    const { path } = await tempConfig({
      provider: { baseUrl: 'https://gw/v1', apiKey: 'sk-abcdefgh', models: [{ id: 'm' }] },
    });
    const s = store(path, { AXON_PROVIDER: 'faux' });
    await s.load();
    expect(s.snapshot().resolution.degraded).toBe(true);
    expect(s.snapshot().resolution.reason).toContain('faux');
  });
});

// ────────────────────────────────────────────────────────────
// 写侧
// ─────────────────────────────────────────────────────────────

describe('ConfigStore · patch 校验', () => {
  it('合法 patch 落盘并反映到快照；文件权限 0600', async () => {
    const { path } = await tempConfig({ maxConcurrent: 4 });
    const s = store(path);
    await s.load();
    const res = await s.patch({ maxConcurrent: 8, defaultExecutor: 'team', budgetUsd: 2.5 });

    expect(res.accepted).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.config.config.maxConcurrent).toBe(8);
    expect(res.config.config.defaultExecutor).toBe('team');
    expect((await readRaw(path)).maxConcurrent).toBe(8);

    const mode = (await stat(path)).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('未知字段整批拒（拼错的键不能被静默吞掉）', async () => {
    const { path } = await tempConfig({ maxConcurrent: 4 });
    const s = store(path);
    await s.load();
    const res = await s.patch({ maxConcurrent: 8, nopeField: 1 } as never);

    expect(res.accepted).toBe(false);
    expect(res.errors[0]?.code).toBe('unknown-field');
    // 一个字节都没写：部分成功会让用户以为改好了
    expect((await readRaw(path)).maxConcurrent).toBe(4);
  });

  it('越界 / 类型错拒整批，并给出可读原因', async () => {
    const { path } = await tempConfig();
    const s = store(path);
    await s.load();
    const range = await s.patch({ maxDepth: 99 });
    expect(range.accepted).toBe(false);
    expect(range.errors[0]?.code).toBe('out-of-range');
    expect(range.errors[0]?.message).toContain('99');

    const type = await s.patch({ maxConcurrent: '6' as never });
    expect(type.accepted).toBe(false);
    expect(type.errors[0]?.code).toBe('invalid-type');
  });

  it('枚举字段只接受白名单取值；字符串不能为空串', async () => {
    const { path } = await tempConfig();
    const s = store(path);
    await s.load();
    expect((await s.patch({ defaultApproval: 'sometimes' })).errors[0]?.code).toBe('invalid-value');
    expect((await s.patch({ provider: undefined, 'provider.name': '' } as never)).errors[0]?.code)
      .toBe('invalid-value');
  });

  it('provider.models 必须是数组且每项有 id；headers 的值必须是字符串', async () => {
    const { path } = await tempConfig();
    const s = store(path);
    await s.load();
    expect((await s.patch({ 'provider.models': { id: 'm' } })).errors[0]?.code).toBe('invalid-type');
    expect((await s.patch({ 'provider.models': [{ id: 'ok' }, {}] })).errors[0]?.message).toContain(
      'models[1]',
    );
    expect((await s.patch({ 'provider.models': [{ id: 'ok' }] })).accepted).toBe(true);
    expect((await s.patch({ 'provider.headers': { a: 1 } })).errors[0]?.code).toBe('invalid-value');
  });

  it('defaultModel 必须在该清单里（否则启动时静默降级到 faux）', async () => {
    const { path } = await tempConfig({ provider: { models: [{ id: 'a' }, { id: 'b' }] } });
    const s = store(path);
    await s.load();
    const bad = await s.patch({ 'provider.defaultModel': 'c' });
    expect(bad.accepted).toBe(false);
    expect(bad.errors[0]?.message).toContain('a, b');

    expect((await s.patch({ 'provider.defaultModel': 'b' })).accepted).toBe(true);
  });

  it('null = 清除该字段（设置界面「清空 key」的唯一手段）', async () => {
    const { path } = await tempConfig({ provider: { apiKey: 'sk-abcdefgh' }, budgetUsd: 3 });
    const s = store(path);
    await s.load();
    const res = await s.patch({ 'provider.apiKey': null, budgetUsd: null });
    expect(res.accepted).toBe(true);
    const raw = await readRaw(path);
    expect(raw.provider.apiKey).toBeUndefined();
    expect(raw.budgetUsd).toBeUndefined();
  });

  it('未知字段（用户自己写的 / 未来版本的）原样保留', async () => {
    const { path } = await tempConfig({ maxConcurrent: 4, myOwnField: { note: '别删我' } });
    const s = store(path);
    await s.load();
    await s.patch({ maxConcurrent: 6 });
    const raw = await readRaw(path);
    expect(raw.myOwnField).toEqual({ note: '别删我' });
    expect(raw.maxConcurrent).toBe(6);
  });

  it('被 env 锁定的字段单独报 issue，其余照常落盘', async () => {
    const { path } = await tempConfig({ maxConcurrent: 4 });
    const s = store(path, { AXON_MODEL: 'env-model' });
    await s.load();
    const res = await s.patch({ 'provider.defaultModel': 'file-model', maxConcurrent: 9 });

    expect(res.accepted).toBe(true); // env-locked 不算 blocking
    expect(res.errors.map((e) => e.code)).toEqual(['env-locked']);
    expect(res.errors[0]?.message).toContain('AXON_MODEL');
    const raw = await readRaw(path);
    expect(raw.maxConcurrent).toBe(9);
    expect(raw.provider?.defaultModel).toBeUndefined(); // 没写进去
  });

  it('普通 patch 不碰 provider（保留原样）', async () => {
    const { path } = await tempConfig({ provider: { apiKey: 'sk-abcdefgh', models: [{ id: 'm' }] } });
    const s = store(path);
    await s.load();
    await s.patch({ maxConcurrent: 2 });
    const raw = await readRaw(path);
    expect(raw.provider.apiKey).toBe('sk-abcdefgh');
  });

  it('写盘失败 ⇒ accepted=false + io_error（不谎报成功）', async () => {
    const { path } = await tempConfig({ maxConcurrent: 1 });
    const s = new ConfigStore({
      configPath: path,
      roleDir: '/tmp/roles',
      teamDir: '/tmp/teams',
      env: {},
      io: {
        readFile: async () => '',
        writeFile: async () => Promise.reject(new Error('磁盘满了')),
        rename: async () => undefined,
        mkdir: async () => undefined,
        chmod: async () => undefined,
      },
    });
    await s.load();
    const res = await s.patch({ maxConcurrent: 2 });
    expect(res.accepted).toBe(false);
    expect(res.errors[0]?.code).toBe('io_error');
    expect(res.errors[0]?.message).toContain('磁盘满了');
    expect(res.config.config.maxConcurrent).toBe(1); // 快照还是旧值
  });

  it('patch 里的 undefined 跳过（表单未改的字段不该被写）', async () => {
    const { path } = await tempConfig({ maxConcurrent: 4 });
    const s = store(path);
    await s.load();
    const res = await s.patch({ maxConcurrent: undefined, budgetUsd: 1 });
    expect(res.accepted).toBe(true);
    const raw = await readRaw(path);
    expect(raw.maxConcurrent).toBe(4);
    expect(raw.budgetUsd).toBe(1);
  });
});
/**
 * model-config 单测 —— 覆盖「配置 + env → 用哪个模型」的全部分叉。
 *
 * 这一层为什么值得测：它是唯一决定「真花钱 vs 不花钱」的判断。
 * 判错方向的两种代价不对称 —— 该用 faux 时用了真模型是账单，
 * 该用真模型时静默降级成 faux 是「测了半天全是假的」。所以两个方向都钉住。
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, maskKey, resolveModelChoice, type AxonConfig } from './model-config.ts';

const gateway: AxonConfig = {
  provider: {
    id: 'kotei',
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'secret-key-123',
    defaultModel: 'qwen3-max',
    models: [{ id: 'qwen3-max' }, { id: 'deepseek-r1', reasoning: true }],
  },
};

describe('resolveModelChoice', () => {
  it('配置齐全时选真网关', () => {
    const choice = resolveModelChoice(gateway, {});
    expect(choice.kind).toBe('openai-compat');
    if (choice.kind !== 'openai-compat') return;
    expect(choice.baseUrl).toBe('https://gw.example.com/v1');
    expect(choice.defaultModel).toBe('qwen3-max');
    expect(choice.providerId).toBe('kotei');
  });

  it('空配置降级 faux，且说明原因', () => {
    const choice = resolveModelChoice({}, {});
    expect(choice.kind).toBe('faux');
    if (choice.kind !== 'faux') return;
    expect(choice.reason).toContain('provider.baseUrl');
  });

  it('缺 apiKey 降级 faux —— 不拿半份配置去发请求', () => {
    const choice = resolveModelChoice({ provider: { baseUrl: 'https://x/v1', models: [{ id: 'm' }] } }, {});
    expect(choice.kind).toBe('faux');
  });

  it('配了网关但 models 为空也降级（否则 pick 会抛在启动路径上）', () => {
    const choice = resolveModelChoice(
      { provider: { baseUrl: 'https://x/v1', apiKey: 'k', models: [] } },
      {},
    );
    expect(choice.kind).toBe('faux');
    if (choice.kind !== 'faux') return;
    expect(choice.reason).toContain('models');
  });

  it('AXON_PROVIDER=faux 是逃生门：配置再全也走假模型', () => {
    const choice = resolveModelChoice(gateway, { AXON_PROVIDER: 'faux' });
    expect(choice.kind).toBe('faux');
    if (choice.kind !== 'faux') return;
    expect(choice.reason).toContain('AXON_PROVIDER');
  });

  it('AXON_MODEL 切到清单内的模型', () => {
    const choice = resolveModelChoice(gateway, { AXON_MODEL: 'deepseek-r1' });
    expect(choice.kind).toBe('openai-compat');
    if (choice.kind !== 'openai-compat') return;
    expect(choice.defaultModel).toBe('deepseek-r1');
    // 清单里已有的条目不该被复制一份，元数据（reasoning）要保住
    expect(choice.models.filter((m) => m.id === 'deepseek-r1')).toHaveLength(1);
    expect(choice.models.find((m) => m.id === 'deepseek-r1')?.reasoning).toBe(true);
  });

  it('AXON_MODEL 指定清单外的模型时临时加进清单（网关常有未登记模型）', () => {
    const choice = resolveModelChoice(gateway, { AXON_MODEL: 'kimi-k2' });
    expect(choice.kind).toBe('openai-compat');
    if (choice.kind !== 'openai-compat') return;
    expect(choice.defaultModel).toBe('kimi-k2');
    expect(choice.models[0]?.id).toBe('kimi-k2');
  });

  it('AXON_BASE_URL / AXON_API_KEY 覆盖配置文件', () => {
    const choice = resolveModelChoice(gateway, {
      AXON_BASE_URL: 'https://other/v1',
      AXON_API_KEY: 'other-key',
    });
    expect(choice.kind).toBe('openai-compat');
    if (choice.kind !== 'openai-compat') return;
    expect(choice.baseUrl).toBe('https://other/v1');
    expect(choice.apiKey).toBe('other-key');
  });

  it('配置文件里 defaultModel 写错（不在清单）降级而非崩溃', () => {
    const choice = resolveModelChoice(
      { provider: { baseUrl: 'https://x/v1', apiKey: 'k', models: [{ id: 'a' }], defaultModel: 'b' } },
      {},
    );
    expect(choice.kind).toBe('faux');
    if (choice.kind !== 'faux') return;
    expect(choice.reason).toContain('defaultModel');
  });
});

describe('loadConfig', () => {
  it('文件不存在 → 空配置且不报错（新克隆的仓库要能直接跑）', async () => {
    const { config, error } = await loadConfig(join(tmpdir(), 'axon-does-not-exist-xyz.json'));
    expect(config).toEqual({});
    expect(error).toBeUndefined();
  });

  it('坏 JSON → 返回错误但不抛（启动不该被一个手滑的逗号挡住）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axon-cfg-'));
    const path = join(dir, 'config.json');
    await writeFile(path, '{ "provider": { ', 'utf8');
    const { config, error } = await loadConfig(path);
    expect(config).toEqual({});
    expect(error).toContain('失败');
  });

  it('正常读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axon-cfg-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(gateway), 'utf8');
    await chmod(path, 0o600);
    const { config } = await loadConfig(path);
    expect(config.provider?.apiKey).toBe('secret-key-123');
  });
});

describe('maskKey', () => {
  it('长 key 只露首尾', () => {
    expect(maskKey('yOXtanFlnZw83oa9')).toBe('yOX***oa9');
  });

  it('短 key 全遮 —— 露首尾等于露了大半', () => {
    expect(maskKey('abc123')).toBe('***');
  });
});

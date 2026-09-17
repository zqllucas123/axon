/**
 * 关于 pane —— 版本、文件位置、存储实况与危险区（UX 03 §3.5）。
 *
 * ── 与原型最大的一处出入：「会话与账本」整块重写 ──
 * 原型写的是「当前全在内存，关闭应用即丢失」。那是 M4 的实况，**M5 之后已经不对了**：
 * 会话按 JSONL 落盘、按需懒加载，账本随会话持久化。照抄原型等于在设置页里放一句
 * 假话，用户会据此做「关窗前先复制走」这种没必要的动作。所以这块改用
 * `storage.status` 的真实数据渲染（根目录 / 会话数 / 已加载数 / issue 清单）。
 *
 * 删掉的原型元素：
 * - 「检查更新」：没有更新通道（没有 autoUpdater、没有发布服务），按钮点了只能骗人。
 * - 「开源许可证」：没有许可证清单页面，也没有生成它的构建步骤。
 * - 版本号旁的「复制」按钮不做成 toast，文本本身可选中即可。
 */

import { useState, type ReactElement } from 'react';
import type { StorageIssueKind } from '@axon/protocol';
import { useSettings } from '../SettingsStore.tsx';
import { DangerAction, PathRow, SettingsRow } from '../fields.tsx';

/** 版本三元组：与 package.json 的 dependencies 对齐（AGENTS.md §5「版本锁定」）。 */
const VERSIONS: ReadonlyArray<[string, string]> = [
  ['Axon', '0.1.0'],
  ['pi-agent-core', '0.85.1'],
  ['Electron', '33.2.1'],
  ['esbuild', '0.24.2'],
];

const ISSUE_LABEL: Record<StorageIssueKind, string> = {
  'corrupt-line': '坏行（已跳过）',
  'partial-line': '半截行（写入被打断）',
  'missing-header': '缺文件头',
  'version-too-new': '版本比本程序新',
  'path-mismatch': '路径与内容不一致',
  'unreadable-dir': '目录读不了',
  'orphan-dir': '孤儿目录',
  'write-failed': '写入失败',
};

export function AboutPane(): ReactElement {
  const { config, storage, refreshStorage, reset, openPath } = useSettings();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = (): void => {
    setRefreshing(true);
    void refreshStorage().finally(() => setRefreshing(false));
  };

  return (
    <section className="st-pane" data-pane="about">
      <h1 className="st-h1">关于</h1>
      <p className="st-lede">版本、数据在哪、以及一个会让你失去设置的按钮。</p>

      <div className="st-sec">版本</div>
      <div className="grp">
        <SettingsRow
          title="Axon"
          desc="内核与运行时版本是锁定的：升级前要先跑内核契约测试（engine.contract.test.ts），否则 pi 的行为变化会直接漏到编排层。"
          smoke="set-versions"
        >
          <span className="path">
            {VERSIONS.map(([n, v]) => `${n} ${v}`).join(' · ')}
          </span>
        </SettingsRow>
      </div>

      <div className="st-sec">文件位置</div>
      <div className="grp">
        <PathRow
          title="配置文件"
          desc="所有设置都写在这一个文件里，权限 0600。API Key 目前也明文存在这里（钥匙串在 M6）。"
          path={config?.paths.config ?? '（读取中）'}
          action={{ label: '在访达中显示', onClick: () => void openPath('config') }}
          smoke="set-path-config"
        />
        <PathRow
          title="角色目录"
          desc="你的角色就是这个目录里的文件，可以直接用编辑器改、也可以进版本库；改完热重载。内置角色不在这里（编进程序），同名时你的覆盖内置。"
          path={config?.paths.roles ?? '（读取中）'}
          action={{ label: '在访达中打开', onClick: () => void openPath('roles') }}
          smoke="set-path-roles"
        />
        <PathRow
          title="团队目录"
          desc="编队（固定组合）的存放处。删掉某个团队不会影响已经跑起来的会话，因为会话在创建时就把成员快照落下来了。"
          path={config?.paths.teams ?? '（读取中）'}
          action={{ label: '在访达中打开', onClick: () => void openPath('teams') }}
          smoke="set-path-teams"
        />
        <PathRow
          title="会话目录"
          desc="一个会话一个子目录，消息按 JSONL 追加。整个目录可以直接拷走或删除；删掉之后下次启动就是干净的新家。"
          path={storage?.root ?? '（读取中）'}
          action={{ label: '在访达中打开', onClick: () => void openPath('sessions') }}
          smoke="set-path-sessions"
        />
      </div>

      <div className="st-sec">会话与账本</div>
      <div className="grp">
        <SettingsRow
          title="落盘实况"
          desc="会话与账本都已经落盘，关掉应用不会丢。启动时只读每个会话的头部元数据，消息在你点开它的那一刻才真正读进内存 —— 所以「已加载」通常远小于「总数」，这是正常的。"
          smoke="set-storage"
        >
          <span className="path">
            {storage
              ? `${storage.sessionCount} 个会话 · 已加载 ${storage.loadedCount}`
              : '读取中…'}
          </span>
          <button
            type="button"
            className="btn sm ghost"
            disabled={refreshing}
            data-smoke="set-storage-refresh"
            onClick={onRefresh}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </SettingsRow>

        <SettingsRow
          title="存储问题"
          desc="坏文件不阻断启动：能读的照常读，读不了的跳过并记在这里。最常见的是 partial-line（上次退出时正好写到一半），它只影响那一条消息。"
          col={storage !== null && storage.issues.length > 0}
          top={storage !== null && storage.issues.length > 0}
          smoke="set-storage-issues"
        >
          {storage === null ? (
            <span className="d">读取中…</span>
          ) : storage.issues.length === 0 ? (
            <span className="tag ok">没有问题</span>
          ) : (
            <ul className="issue-list">
              {storage.issues.map((it, i) => (
                <li key={`${it.path}-${i}`}>
                  <span className="tag err">{ISSUE_LABEL[it.kind]}</span>
                  <code>{it.path}</code>
                  <span className="d">{it.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      </div>

      <div className="st-sec">危险区</div>
      <div className="grp danger-zone">
        <SettingsRow
          title="重置所有设置"
          desc="把 config.json 恢复到出厂缺省（含网关地址与 API Key）。只重置这一个文件：你的角色目录、团队与会话记录都不动；文件里我们不认识的键也原样保留。被 AXON_* 环境变量覆盖的项重置后仍然被覆盖。"
          smoke="set-reset"
        >
          <DangerAction
            label="重置所有设置"
            confirmText="config.json 会被清回缺省，这一步不能撤销。"
            onConfirm={() => void reset()}
            smoke="set-reset"
          />
        </SettingsRow>
      </div>
    </section>
  );
}

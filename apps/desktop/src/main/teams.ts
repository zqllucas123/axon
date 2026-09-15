/**
 * 内置团队 —— S3 团队卡片与 S0「选一个团队」的三张卡（`docs/ux/mockups/s3-teams.html`）。
 *
 * 与内置角色（roles.ts）同一套纪律：这里是 TS 常量，结构直接可落盘成
 * `~/.axon/teams/<name>.json`，用户手写一个 json 就是一个新团队。
 *
 * 三条设计意图写进注释，免得后来者「顺手改宽」：
 *
 * 1. **成员名是给人看的**（主控 / 架构师 / 后端实现 …），路径段用的是角色名
 *    （`/sX/developer-1`）—— 界面显示相对路径时不会把中文糊进内部 id。
 * 2. **主控用 `lead` 类型**，不是 Axon5：权限沿树求交，lead 的白名单是整队的
 *    能力上限（理由见 roles.ts 的 LEAD_ROLE 注释）。
 * 3. **团队预算是「更严者」的一档**（UX 02 §6 拍板：团队线与全局线取更严），
 *    这里的 soft/hard 直接抄自原型的卡片文案（$1.50 / $0.80 / 只读）。
 */

import type { TeamDefinition } from '@axon/protocol';

/** 只读白名单 —— 评审小队的成员覆写用它把「全员禁止写盘」落成硬约束。 */
const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls'];

export const BUILTIN_TEAMS: TeamDefinition[] = [
  {
    name: '全栈小队',
    description: '主控 + 架构师 + 后端实现 + 测试工程师。跨层改动的默认编队。',
    members: [
      { name: '主控', role: 'lead', lead: true, description: '拆解目标、分派成员、汇总交付' },
      { name: '架构师', role: 'architect', description: '接口契约与模块边界；只写设计文档' },
      { name: '后端实现', role: 'developer', description: '按契约落地实现，自测后再交' },
      { name: '测试工程师', role: 'tester', description: '补边界与异常路径，报告缺陷' },
    ],
    formation: 'star',
    // 4 个成员但只放 3 个同时跑：主控在等结果时退位，额度留给真正干活的。
    maxConcurrent: 3,
    budget: { softUsd: 1.0, hardUsd: 1.5 },
    defaultForkMode: 'none',
  },
  {
    name: '测试双人',
    description: '实现 + 测试成对推进，只补测不改架构。',
    members: [
      { name: '主控', role: 'lead', lead: true, description: '分工与收口，不写实现' },
      { name: '实现', role: 'developer', description: '小步改动，每步可回退' },
      { name: '测试', role: 'tester', description: '对抗性验证：假设实现有问题' },
    ],
    formation: 'star',
    maxConcurrent: 2,
    budget: { softUsd: 0.5, hardUsd: 0.8 },
    defaultForkMode: 'none',
  },
  {
    name: '评审小队',
    description: '只读团队：读码、评审、出文档，全员禁止写盘。',
    members: [
      { name: '主控', role: 'lead', lead: true, description: '组织评审、汇总结论' },
      {
        name: '架构评审',
        role: 'architect',
        description: '看边界与契约，不看风格',
        // 覆写只能减：把 write 摘掉，评审者就不能顺手改代码了。
        overrides: { tools: READ_ONLY_TOOLS },
      },
      {
        name: '测试视角',
        role: 'tester',
        description: '从用例反推缺口，不跑破坏性命令',
        overrides: { tools: READ_ONLY_TOOLS },
      },
    ],
    formation: 'star',
    maxConcurrent: 2,
    budget: { softUsd: 0.3, hardUsd: 0.5 },
    defaultForkMode: 'none',
  },
];
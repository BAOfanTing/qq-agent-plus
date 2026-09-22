import { readFileSync } from 'node:fs';

export function normalizeBehaviorProfile(value) {
  const profile = value ?? 'legacy';
  if (!['legacy', 'grounded'].includes(profile)) throw new Error('Invalid persona behavior profile');
  return profile;
}

// 人设模板库：**角色卡正文的唯一来源是 roles/ 目录**，一张卡一个 markdown 文件，
// 这里只做登记（id → 文件 / 显示名 / 语气档位），不再把正文内联进代码。
//
//   roles/xiaojingyu.md              默认人设：原版 qq-bridge 的"小鲸鱼"角色卡。
//                                    已把其中旧架构专属指令（[SILENT]、qq_* MCP 工具名、
//                                    唤醒配置、空格分条等）适配为本程序的机制
//                                    （安静结束、send_message 数组分条、原生工具名），
//                                    人格与示例原样保留。
//   roles/duzui-sunyou.md            损友（毒舌吐槽），legacy 档：短句接梗、只损能开玩笑的事。
//   roles/wenrou-peiliao.md          温柔陪聊（知心），grounded 档：会听、不诊断、不承诺陪伴。
//   roles/jishu-zhai.md              技术宅（自建服务），grounded 档：先问关键信息、留出不确定。
//   roles/maoniang.md                猫娘（二次元），legacy 档：萌点是点缀，不擦边不病娇。
//
// 新增卡时的约定：正文只写在 roles/ 下，用真实工具名，别引用旧架构专属指令；
// test/personas.test.mjs 会检查"roles/ 下的每个文件都已登记"。
//
// 用相对模块 URL 读取，不依赖启动工作目录；部署时必须带上 roles/（完整同步会包含）。
const readRole = (file) => readFileSync(new URL(`../roles/${file}`, import.meta.url), 'utf8').trim();

export const PERSONAS = {
  xiaojingyu: {
    name: '小鲸鱼（默认）',
    behaviorProfile: 'legacy',
    text: readRole('xiaojingyu.md')
  },
  duzui_sunyou: {
    name: '损友（毒舌吐槽）',
    behaviorProfile: 'legacy',
    text: readRole('duzui-sunyou.md')
  },
  wenrou_peiliao: {
    name: '温柔陪聊（知心）',
    behaviorProfile: 'grounded',
    text: readRole('wenrou-peiliao.md')
  },
  jishu_zhai: {
    name: '技术宅（自建服务）',
    behaviorProfile: 'grounded',
    text: readRole('jishu-zhai.md')
  },
  maoniang: {
    name: '猫娘（二次元）',
    behaviorProfile: 'legacy',
    text: readRole('maoniang.md')
  }
};

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
//   roles/xiaojingyu-game-client.md  小鲸鱼（游戏客户端开发者）版本，grounded 档。
//
// 用相对模块 URL 读取，不依赖启动工作目录；部署时必须带上 roles/（完整同步会包含）。
const readRole = (file) => readFileSync(new URL(`../roles/${file}`, import.meta.url), 'utf8').trim();

export const PERSONAS = {
  xiaojingyu: {
    name: '小鲸鱼（默认）',
    behaviorProfile: 'legacy',
    text: readRole('xiaojingyu.md')
  },
  xiaojingyu_game_client: {
    name: '小鲸鱼（游戏客户端开发者）',
    behaviorProfile: 'grounded',
    text: readRole('xiaojingyu-game-client.md')
  }
};

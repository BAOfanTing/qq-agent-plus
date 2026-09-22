# 文档索引

按"你要做什么"分组；每篇一句话说明。角色卡正文不在 docs 下，而是 `roles/`（一张卡一个 markdown）。

## 上手与部署

| 文档 | 说明 |
| --- | --- |
| [LINUX.md](LINUX.md) | Linux 全栈部署与运维手册：隔离边界、依赖、安装、控制台、数据与备份、OneBot 连不上怎么查 |
| [BAOTA.md](BAOTA.md) | 宝塔 / aaPanel 面板部署：面板与 systemd 的分工、非 root 服务用户、端口与反向代理、常见报错 |
| [OPS.md](OPS.md) | `src/ops.js` 运维入口（体检 / 扫描 / 备份 / 部署 / 看门狗 / 隧道）的环境变量与示例 |
| [CONFIG-EXAMPLES.md](CONFIG-EXAMPLES.md) | 常用配置片段：思考模式、兜底模型、视觉、主动发言、表情包、节奏 |
| [AUTO_UPDATE.md](AUTO_UPDATE.md) | Release 驱动的自动更新：判定口径、两条下载通道（git / API+源码包）、失败策略与状态字段 |

## 功能说明

| 文档 | 说明 |
| --- | --- |
| [CONVERSATION_MODES.md](CONVERSATION_MODES.md) | 对话引擎三模式（legacy / threaded / lifecycle）的差异与选择 |
| [DAILY_MOMENTS.md](DAILY_MOMENTS.md) | 每日说说：生成、发布、去重与静默时段 |
| [QZONE_INTERACTIONS.md](QZONE_INTERACTIONS.md) | 好友动态与评论回复的巡检节奏、退避与跳过原因 |
| [model-prices.md](model-prices.md) | 价格体系：模型 id 归一化与别名、渠道价、账户口径三选一、实付/估算/未定价 |
| [STABLE_FEATURES.md](STABLE_FEATURES.md) | 哪些功能已从"实验"转为默认开启，以及转正的判定标准 |
| [EXPERIMENTAL_FEATURE_STANDARD.md](EXPERIMENTAL_FEATURE_STANDARD.md) | 实验功能的开发规范：开关、默认值、降级与转正流程 |
| [ASSET_OBSERVABILITY.md](ASSET_OBSERVABILITY.md) | AI 资产观测（表情/黑话等）的统计口径与控制台入口 |

## 开发与维护

| 文档 | 说明 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构总览：模块划分、消息流、存储与外部依赖 |
| [CHANGES.md](CHANGES.md) | 本分支相对上游的改动清单，每条附"失败模式 → 现在的做法" |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | 当前已知但未修的问题（以及历史上的基线失败） |
| [GAME_CLIENT_PERSONA.md](GAME_CLIENT_PERSONA.md) | 游戏客户端开发者人设的接入方式与两张内置角色卡的位置 |
| [../AGENTS.md](../AGENTS.md) | 给 AI 协作者的约定：代码风格、验证方式、提交要求 |

## 调研与方向稿

[`research/`](research/) 下是**当时**的调研与设计草稿，不是现行规范（结论可能已经过时，
现状以代码与上面几篇为准）：

- [WECHAT_BOT_FEASIBILITY.md](research/WECHAT_BOT_FEASIBILITY.md) —— 微信端可行性调研
- [CONTEXT_BUDGET_RESEARCH.md](research/CONTEXT_BUDGET_RESEARCH.md) —— 上下文预算的三个概念与实测
- [INCIDENT_HANDLING_RESEARCH.md](research/INCIDENT_HANDLING_RESEARCH.md) —— 异常处理与降级策略的调研
- [FRIEND_TRIGGER_PILOT_RESEARCH.md](research/FRIEND_TRIGGER_PILOT_RESEARCH.md) —— 主动加好友触发条件的调研
- [SNOWLUMA_FRIEND_API_RESEARCH.md](research/SNOWLUMA_FRIEND_API_RESEARCH.md) —— 协议端好友接口调研
- [GAME_CLIENT_PERSONA_DIRECTION.md](research/GAME_CLIENT_PERSONA_DIRECTION.md) —— 游戏客户端人设的方向稿
- [THREADED_PILOT.md](research/THREADED_PILOT.md) —— 线程化对话的早期方案
- [MULTIMODAL_CONTEXT_PILOT.md](research/MULTIMODAL_CONTEXT_PILOT.md) —— 多模态上下文连续性的早期方案

## 角色卡与其它

- 角色卡正文：[`roles/`](../roles)，一张卡一个 markdown（内置默认小鲸鱼、游戏客户端开发者、
  损友、温柔陪聊、技术宅、猫娘；新增卡要在 `src/personas.js` 登记，`test/personas.test.mjs` 会查）
- 远程价格表（随版本发布）：[`prices.json`](../prices.json)
- 运行数据与凭据：`data/`（**不入库**，分享前用 `node scripts/sanitize-release.mjs` 生成干净副本）

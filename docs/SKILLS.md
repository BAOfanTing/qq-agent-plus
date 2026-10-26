# 技能包（Skill Pack）

技能包是**只读的工作方法**，不是插件。

- 插件：可以执行代码、提供工具、访问网络/存储/媒体，受能力白名单与审批约束；
- 技能：只有 Markdown 流程和工具白名单，宿主不执行其中的代码，也不能借它拿到新权限。

## 目录与格式

```text
skills/<id>/
  skill.json
  SKILL.md
```

用户技能放在 `data/skills/<id>/`。同名 id 保留先加载的内置版本，不会让用户目录静默覆盖官方技能。

```json
{
  "id": "chat-summary",
  "name": "群聊总结",
  "version": "1.0.0",
  "description": "把最近一段群聊整理成几条结论。",
  "allowedTools": ["get_recent_messages", "send_message"],
  "triggers": ["总结一下", "帮我回顾"]
}
```

- `id`：小写字母/数字/连字符，2–64 位；
- `allowedTools`：最多 40 个宿主工具名；`finish`、`skill_list`、`skill_use` 始终允许；
  插件工具用限定名（如 `bilibili__read`）。meta 挂载下宿主会按 `plugin_call` 的 `args.tool` 二次校验，
  写了限定名不会顺带放开同一插件的其他工具；
- `triggers`：只用于控制台展示/人工选择，不会自动触发；
- `SKILL.md`：≤64KB，只写流程、边界与输出格式。

## 启用与选择

控制台顶部「技能」页：

- 总开关默认关；关闭时不加载技能目录、不注册 `skill_list` / `skill_use`；
- 可以全局启用，也可以按群/私聊覆盖；
- 「重新扫描技能目录」会重新读取 `skills/` 与 `data/skills/`；
- 模型看到【可用技能】后会先调 `skill_list`，再调 `skill_use` 选中一个。

`skill_use` 返回该技能的流程，并把本轮工具收窄到 `allowedTools`。之后调用未允许的工具会被宿主拒绝，
但不会触发 finish 屏障；模型可以按流程继续或正常结束。

## 安全边界

- 不能执行 JS、读文件、拿 secrets、改配置；
- 不能新增工具，只能收窄；
- 不能改变安全规则、管理员权限或发送队列；
- 不自动触发。群友说“进入 xx 技能”不会绕过启用状态，也不能让模型使用未启用的技能；
- 技能正文仍然按第三方内容对待：工具白名单是硬边界，流程文本只影响做事方法。

## 内置示例

| id | 名称 | 允许工具 | 用途 |
| --- | --- | --- | --- |
| `chat-summary` | 群聊总结 | `get_recent_messages`、`send_message` | 结论 / 分歧 / 待办 |
| `video-digest` | 视频读懂 | `bilibili__search`、`bilibili__video`、`bilibili__read`、`web_fetch`、`send_message` | 优先用 B 站插件读元数据/字幕/评论；非 B 站链接退回 `web_fetch` |
| `comment-analysis` | 评论分析 | 同上 | 用 B 站插件拿评论样本，非 B 站页面才 `web_fetch` |

## 限制

- 技能只能“建议模型怎么做”，不能保证模型每一步都照做；
- 技能不会自动触发，需要模型选择或用户明确要求；
- 技能不执行代码，复杂计算/二进制处理仍然应该做成插件或宿主工具。

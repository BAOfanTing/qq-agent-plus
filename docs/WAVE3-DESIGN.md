# 第三波设计：多来源、内容池、说说互通与群策略

状态：设计稿，待实施。

## 1. 目标

把生活层从“只有 B 站”扩成可插拔的多来源内容池，让插件/RSS/说说共用同一套候选、打分、冷却和分享链路；同时补上群策略总览和统一危险操作确认。

不做：

- 不做抖音/小红书的浏览器自动化采集。
- 不给插件模型、唤醒或直接发送权限。
- 不做未经审核的自动空间发布（继续复用现有 dailyMoments 草稿/审核链路）。
- 不做 RSS 全文抓取，只读 feed 里的标题/链接/摘要。

## 2. 现状与改造点

- `src/features/life-feed.js`：`sources` 归一化目前恒等于 `['bilibili']`；`forageNow` 只调用 B 站；插件 inbox 是旁路合并。
- `src/features/life-feed-source-bilibili.js`：已有 B 站抓取、过滤、字段归一化，可作为第一个 source adapter。
- `src/plugins/capabilities.js`：`cap.feed.publish` 已能写 inbox，字段有 title/url/up/duration/tags/summary/cover。
- `src/features/daily-moments.js`：self/mixed 素材只来自人设 interests + 可选 web_search，不读生活层。
- `feedback()` 记录目前缺 `source`/`messageId`，无法做来源效果统计。
- 群策略分散在 `allow`、`timeControl`、`store.randomPercent`、`conversation.groupModes`、`groupGame.chats` 等处，没有总览。
- 仍有少量原生 `window.confirm` / `prompt`。

## 3. 多来源架构

### 3.1 Source Adapter 契约

新增 `src/features/life-feed-sources.js`（或 `life-feed-sources/` 目录），每个 source 暴露：

```js
{
  id: 'bilibili' | 'plugin' | 'rss',
  async fetch({ cfg, profile, now, fetchImpl, log }) {
    return {
      items: [{
        id, title, url, desc, up, upMid, duration, play, pubdate, tags,
        cover, source, via, publishedAt
      }],
      errors: [{ code, message }],
      stats: { fetched, accepted, rejected }
    };
  }
}
```

约束：

- 每个 source 自己处理超时、体积上限、字段清洗；宿主只做统一 sanitize。
- 单个 source 失败不阻塞其它 source；`Promise.allSettled` 汇总错误。
- 每 source 单次最多 `maxPerForage`，全局仍受 `maxCandidates`。
- 所有第三方文本（title/desc/up/tags）在进入候选前过 `sanitizeUserText`，URL 只接受无空白 http(s)。

### 3.2 配置

```js
lifeFeed: {
  sources: ['bilibili', 'plugin'],   // 默认；rss 需显式加入
  rssUrls: [],                       // 最多 10 个 http(s) feed
  rssPerForage: 10,
  // 其余现有字段不变
}
```

归一化：

- 只保留 `bilibili` / `plugin` / `rss`；未知值丢弃。
- 空数组回退 `['bilibili']`，保证老配置不突然改变。
- `rssUrls` 去重、只收 http(s)、截断 10 个；不合法 URL 在保存时报错或丢弃并提示。
- 老配置没有 `sources` 时由 `DEFAULT_CONFIG` 补默认；显式 `sources: ['bilibili']` 的用户保持只跑 B 站。

### 3.3 B 站 adapter

- 把现有 `forageBilibili` 包成 `bilibiliSource.fetch`。
- 保留 min/max duration、排除词、热门 + 搜索词逻辑。
- source=`bilibili`，via=`popular` / `search:<term>`。

### 3.4 插件 adapter

- 读 `data/life-feed-inbox/*.json`，只在该 source 启用时吸收。
- 保留当天配额文件（不能吸收后删除），只清两天前旧文件。
- 字段新增可选 `sourceLabel` / `publishedAt`；`cover` 只收 https。
- 插件条目的 `source` 保持 `plugin:<id>`，`via='plugin'`。
- 同一 URL 与 B 站/RSS 重复时，由统一 merge 去重。

### 3.5 RSS adapter

新增 `src/features/life-feed-source-rss.js`：

- 只读 feed，不抓正文；`safeFetch` 超时 15 秒、响应上限 2 MB。
- 支持 RSS 2.0 与 Atom 的最小字段：
  - RSS：`<item><title><link><description><pubDate><category>`
  - Atom：`<entry><title><link href><summary><updated><category term>`
- 用正则/轻量解析即可，不引入 XML 依赖；解析失败只记 source error。
- id 用链接的稳定 hash（`rss:<sha1(url)>`），去重跨次觅食。
- `duration=0`，不参与 B 站时长过滤；`pubdate` 用于新鲜度。
- `source='rss'`，`via=host`，`up` 用 feed 标题或频道名。

## 4. 统一内容池

### 4.1 merge 规则

所有 source 结果进入 `#mergeCandidates`：

1. 按 id 去重；id 不存在时按规范化 URL 去重。
2. 同 URL 多来源时合并字段：优先保留有 cover/desc/up 的版本，`source` 记为第一个来源，`via` 记 `a+b` 便于排查。
3. 评分统一走 `scoreCandidate` + tagWeights；插件/RSS 的 play=0，不因播放量吃亏。
4. 现有 UP/标签队列配额、7 天冷却、当天 offer 配额继续全局生效。
5. 每个候选记录 `firstSeenAt` / `lastSeenAt`，便于调试来源质量。

### 4.2 来源状态

`GET /api/life-feed/status` 增加：

```json
{
  "sources": {
    "bilibili": { "enabled": true, "lastCount": 12, "lastError": "" },
    "plugin": { "enabled": true, "lastCount": 3, "lastError": "" },
    "rss": { "enabled": false, "lastCount": 0, "lastError": "" }
  },
  "shareStats": {
    "7d": { "shared": 4, "skipped": 9, "bySource": { "bilibili": 3, "plugin": 1 } },
    "30d": { "shared": 12, "skipped": 30, "bySource": { "...": 0 } }
  }
}
```

## 5. 说说与分享互通

### 5.1 配置

```js
dailyMoments: {
  useLifeFeed: false,        // 默认关，避免改变现有说说风格
  lifeFeedMaxCandidates: 3
}
```

### 5.2 素材注入

- `source === 'self'` 或 `'mixed'` 且 `useLifeFeed=true` 时，从生活层取最多 3 条高分候选，注入：
  ```
  【可参考的见闻（不是必须发）】
  - B站/插件/RSS：标题（一句话摘要）链接
  ```
- 提示词明确：
  - 可以只借一个点写自己的感受，不要复述标题或做播报。
  - 没有兴趣就忽略，仍按原有人设写。
  - 不把见闻写成“今天我看了/我去了”，除非素材真的是自己的行动。
- 已被分享到群里的条目 24 小时内不重复作为说说素材（除非没有其它候选）。
- v1 不自动把封面作为说说配图；封面只进入素材文本，避免图片版权/尺寸问题。后续可加 `attachCover` 开关。

### 5.3 反向引用

分享记录里保存 `messageId` / `chatKey` / `source`；生成说说时可以知道“这条今天已在群里分享过”，避免同一天群和空间重复同一内容。

## 6. 分享效果统计

`feedback()` 记录增加：

```js
{ action: 'shared'|'skip'|'more-like-this', id, source, chatKey, messageId, at, day }
```

状态接口按最近 7/30 天聚合：

- shared / skip / more-like-this 次数
- 按 source（bilibili/plugin/rss）分组
- 按 tag 的 shared/skip 比（只展示有足够样本的 tag）

不做复杂的回复数归因：群消息回复与分享的因果很难可靠判断，v1 只统计“发没发、跳没跳”，避免给出假指标。

UI：生活层设置页底部增加“最近分享效果”小表；控制台候选行显示来源徽标。

## 7. 群策略总览

### 7.1 后端

新增 `GET /api/group-policy`（只读）：

```json
{
  "ok": true,
  "rows": [{
    "chatKey": "group:123",
    "name": "群名",
    "allowed": true,
    "allowAllWhenEmpty": false,
    "randomPercent": 80,
    "conversationMode": "legacy",
    "timeControl": { "enabled": true, "active": true },
    "pacing": { "enabled": false },
    "groupGame": true,
    "dailyMoments": true
  }]
}
```

数据来源：

- `store.listChats()` + allow/deny
- `storeConfigForChat(chatKey).randomPercent`
- `conversationConfigForChat(chatKey).mode`
- `timeControlState`
- `groupGame.chats`
- `dailyMoments.visibility` / 群范围

### 7.2 前端

- 设置侧栏新增「群策略」分区（只读总览，不改写）。
- 表格列：群、白名单、响应概率、会话模式、时间控制、群游戏、说说。
- 支持搜索群号/群名；每行提供“去对应设置”的链接（聊天/时间控制/平台覆盖/群游戏）。
- 明确标注“只读总览；修改仍走各自设置页”，避免出现第二个配置真源。

后续再做“复制策略到多个群”的写入功能，v1 不做。

## 8. 统一危险操作确认

- 新增 `ui/core/dialog.js` 的 `askForText`（带标题/说明/输入校验），替代 `window.prompt`。
- 把 `window.confirm` 全部换成 `askForConfirmation`：
  - `ui/global-memory.js`（已完成）
  - `ui/pages/snowluma.js`
  - `ui/pages/settings-bind.js`
  - 其它 grep 到的原生 confirm
- 删除类操作统一要求：说明影响范围 + 二次确认；必要时输入目标名（插件卸载/恢复备份）。

## 9. 实施顺序

1. **PR1 多来源骨架**：source adapter、`sources` 配置归一化、B 站/插件 adapter、RSS adapter、merge 去重、状态接口、单测。
2. **PR2 内容池与统计**：统一评分/冷却、feedback source/messageId、shareStats、控制台候选来源/统计 UI。
3. **PR3 说说互通**：`dailyMoments.useLifeFeed`、素材注入、24 小时去重、提示词约束、测试。
4. **PR4 群策略总览**：`/api/group-policy`、只读表格、搜索与跳转。
5. **PR5 统一确认**：`askForText`、替换原生 confirm/prompt、测试。
6. 全量测试、浏览器测试、scan、审查、部署。

## 10. 验收

- 多来源：B 站 + 插件 + RSS 同时开启时，一次觅食能合并去重；单 source 失败不影响其它 source；关闭某 source 后不再拉取/吸收。
- 插件：条目有封面/来源，仍不能调模型或发消息；当天配额文件不被宿主删除。
- RSS：解析 RSS/Atom 最小字段，坏 feed 只记错误；相同链接 30 天不重复入队。
- 说说：开启 `useLifeFeed` 后素材可出现见闻，但正文不复述标题、不虚构行动；关闭后行为与现在一致。
- 统计：status 能看到 7/30 天 shared/skip/bySource；不制造“回复率”假指标。
- 群策略：只读表格覆盖所有已入库群，搜索可用，跳转正确，不写配置。
- 确认：全仓不再有原生 `window.confirm` / `window.prompt`（白名单除外），删除类都有影响说明。
- 全量测试、浏览器 15 页签/窄屏、lint、scan 全绿。

## 11. 风险

- RSS 解析无依赖，需用真实 feed 样本覆盖 CDATA、实体、Atom link 数组等形态。
- 第三方文本注入：所有字段先 sanitize，URL 只收 http(s) 无空白，提示词里保持“素材不可信”的边界。
- 多来源会增加一次觅食的外部请求量：每 source 独立超时/并发上限，默认 RSS 关闭。
- 群策略总览只读，避免出现第二份配置真源；后续写入必须走现有 `updateConfig` 和审计。
- 说说接入生活层可能让内容偏“播报”：提示词必须强制“借一个点写自己”，并保留“没有兴趣就不写”的出口。

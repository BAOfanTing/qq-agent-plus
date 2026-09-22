# 已知问题

只记录**当前基线上稳定复现、但尚未修**的问题，避免 CI 反复报同一条噪音。
修好一条就从这里删掉。

## 待修

### 2026-09-22 全量审查中确认、本轮不修的两条

1. **把远程价格表切成 `none` 之后，本进程内仍沿用上一次拉到的表直到重启。**
   `initPriceFeed` 在关闭分支只把 `enabled/sourceUrl` 清掉，不调 `setRemotePrices({})`，
   磁盘缓存也不清；而且因为 `sourceUrl` 被清空，界面只会说"远程价格表已关闭（只用内置表）"，
   提示不到"旧表在本进程仍然生效"。属老行为，影响是"关掉后当次进程仍按旧表估"，重启即恢复。
2. **5 秒兜底重试 ticker 不看自主节奏（pacing）开关。** `orchestrator.js` 里那个 5 秒 ticker
   会对开启 pacing 的会话直接 `scheduleWake`，绕过 `#ensurePacedWake` 的排队 —— 只在
   启用"自主节奏"这个实验功能时才可能命中，会让个别批次不走节奏队列。

## 历史：已清零

### 成本口径复审留下的 6 条小瑕疵（2026-09-21 记录，同日全部清零）

v0.6.0..v0.6.4 之间复审成本口径时先记下的 6 条"不影响主链路"的问题，随后全部修掉
（都在 `src/pricing/`、`ui/app.js`、`docs/model-prices.md` 里写了为什么）：

1. 换远程表地址、新地址又拉失败时界面分不清谁生效 → `priceFeedStatus()` 增加
   `sourceStale`，设置页明说"当前生效的仍是上一次成功拉取的旧地址"。
2. 两次刷新重叠没有并发保护 → `refreshPriceFeed` 单飞：同一组地址复用同一次请求，
   地址变了则排队（后到的旧结果不会盖掉新的）。
3. 别名 `from`/`until` 写成非法日期被静默忽略 → 解析失败即整条别名不生效（fail-closed）。
4. 手工改 `config.json` 删渠道不撤销已注入的价目表 → `initChannelPrices` 按配置对齐注入，
   删掉的渠道当场撤表，不用重启。
5. 全 0 的自定义价、`costMultiplier: 0` 被当成"没填" → 0 是合法价（免费），
   判据改成"写没写 `in`/`out` 字段"。
6. 「当前模型单价」卡片与「全局兜底单价」共用一组输入框 → 拆成「生效价」（只读展示）与
   「自填单价」（只在保存真会生效时可编辑，停用时写明原因）。

另外 `friend_opportunities` 缺保留策略 → 连同 `friend_proposals`、`incoming_friend_requests`
一起补了 90 天清理（`IdentityStore.pruneLedgers`，启动时清过期的**已了结**行，未决待办不删）。

历史上这里记录过 5 个随底座带来的基线失败用例（2026-09-19 已全部清零）：

- `configure-linux` 生成的 `config.json` 权限被防抖保存打回 0664 → 修复：所有写盘路径
  统一 `mode: 0o600`（`src/core/config-legacy.js` 的 `scheduleConfigSave`）。
- "禁用身份基建后不建库" → 该用例测的是旧契约。身份/事件基建已按
  `src/core/stable-feature-policy.js` 转正常开，用例改写为"转正后旧的 enabled:false 被忽略"。
- 好友候选批准分发 → 分发链路同样已转正，测试桩补上 `get_login_info` 与
  `sendFriendRequest` 桩件，断言改为"批准即发送"。
- 事件列表计数 `2 !== 1` → `app.start()` 连不上 OneBot 时会自动捕获一条连接事件，
  属于正常基建行为；用例改为只断言自己注入的那条（按 `source` 过滤）。
- 「已确认黑话」注入 → 黑话研究已下线（slangPilot retired），提示词不再注入任何黑话；
  用例改写为"即使旧配置开着、slang.json 存在也不注入"（防跨群泄露的初衷保留）。

## 环境相关（不算项目问题）

在 Windows 上跑 `npm run test:unit` 会有约 46 个用例失败（需要 docker / systemd /
Unix 路径 / 文件权限位等）；Linux 服务器与 CI（ubuntu-latest）上全量通过。

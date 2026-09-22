# 已知问题

本文档仅记录**当前基线上稳定复现、尚未修复**的问题，以避免 CI 重复报告同一问题。
问题修复后即从本文档删除。

## 待修问题

### 2026-09-22 全量审查确认、本轮不修的两项问题

1. **远程价格表切换为 `none` 后，本进程内仍沿用上一次拉取的表直到重启。**
   `initPriceFeed` 在关闭分支仅清除 `enabled/sourceUrl`，不调用 `setRemotePrices({})`，
   磁盘缓存也不清理。由于 `sourceUrl` 已被清空，界面只显示“远程价格表已关闭（只用内置表）”，
   不会提示“旧表在本进程仍然生效”。该问题属既有行为，影响范围为关闭后当次进程仍按旧表估算，重启即恢复。
2. **5 秒兜底重试 ticker 不检查自主节奏（pacing）开关。** `orchestrator.js` 中的 5 秒 ticker
   会对启用 pacing 的会话直接调用 `scheduleWake`，绕过 `#ensurePacedWake` 的排队。
   该问题仅在启用“自主节奏”实验功能时可能触发，会导致个别批次不经过节奏队列。

## 历史问题（已全部修复）

### 成本口径复审记录的 6 项问题（2026-09-21 记录，同日全部修复）

v0.6.0..v0.6.4 之间复审成本口径时记录的 6 项“不影响主链路”的问题，随后已全部修复，
修复原因均写入 `src/pricing/`、`ui/app.js`、`docs/model-prices.md`：

1. 更换远程表地址且新地址拉取失败时，界面无法区分实际生效的地址 → `priceFeedStatus()` 增加
   `sourceStale`，设置页明确提示“当前生效的仍是上一次成功拉取的旧地址”。
2. 两次刷新重叠时没有并发保护 → `refreshPriceFeed` 采用单飞：同一组地址复用同一次请求，
   地址变化时排队，后到的旧结果不会覆盖新结果。
3. 别名 `from`/`until` 写成非法日期时被静默忽略 → 解析失败即整条别名不生效（fail-closed）。
4. 手工修改 `config.json` 删除渠道不撤销已注入的价目表 → `initChannelPrices` 按配置对齐注入，
   删除的渠道即时撤表，无需重启。
5. 全 0 的自定义价与 `costMultiplier: 0` 被当作未填写 → 0 是合法价格（免费），
   判据改为是否写入 `in`/`out` 字段。
6. 「当前模型单价」卡片与「全局兜底单价」共用一组输入框 → 拆分为「生效价」（只读展示）与
   「自填单价」（仅在保存确实生效时可编辑，停用时说明原因）。

另有 `friend_opportunities` 缺少保留策略，已连同 `friend_proposals`、`incoming_friend_requests`
一起补充 90 天清理（`IdentityStore.pruneLedgers`，启动时清理过期的**已了结**行，未决待办不删）。

本文档历史上还记录过 5 个随底座引入的基线失败用例（2026-09-19 已全部修复）：

- `configure-linux` 生成的 `config.json` 权限被防抖保存回退为 0664 → 修复：所有写盘路径
  统一 `mode: 0o600`（`src/core/config-legacy.js` 的 `scheduleConfigSave`）。
- 「禁用身份基建后不建库」：该用例验证的是旧契约。身份与事件基建已按
  `src/core/stable-feature-policy.js` 转为默认开启，用例改写为「转正后旧的 enabled:false 被忽略」。
- 「好友候选批准分发」：分发链路同样已转为默认开启，测试桩补充 `get_login_info` 与
  `sendFriendRequest` 桩件，断言改为「批准即发送」。
- 事件列表计数 `2 !== 1`：`app.start()` 无法连接 OneBot 时会自动捕获一条连接事件，
  属于正常基建行为；用例改为仅断言自身注入的那条（按 `source` 过滤）。
- 「已确认黑话」注入：黑话研究已下线（slangPilot retired），提示词不再注入任何黑话；
  用例改写为「即使旧配置开启、slang.json 存在也不注入」（防跨群泄露的原始目标保留）。

## 环境相关（不属于项目问题）

在 Windows 上执行 `npm run test:unit` 会有约 46 个用例失败（涉及 docker、systemd、
Unix 路径与文件权限位等）；在 Linux 服务器与 CI（ubuntu-latest）上全量通过。

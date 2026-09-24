# 已知问题

本文档仅记录**当前基线上稳定复现、尚未修复**的问题，以避免 CI 重复报告同一问题。
问题修复后即从本文档删除。

## 待修问题

### 2026-09-22 全量审查确认、本轮不修的问题

**5 秒兜底重试 ticker 不检查自主节奏（pacing）开关。** `orchestrator.js` 的 5 秒 ticker
会对启用 pacing 的会话直接调用 `scheduleWake`，绕过 `#ensurePacedWake` 的排队。
仅在启用「自主节奏」实验功能时可能触发，会导致个别批次不经过节奏队列。

（同批记录的「远程价格表切成 `none` 后本进程仍沿用旧表」已于 2026-09-23 修复：
`initPriceFeed` 的关闭分支现在会 `setRemotePrices({})` 当场回落到内置表，
磁盘缓存仍按设计保留，重新启用时先顶上。）

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

`test/usage-e2e.mjs` 起的真服务用的是配置里的控制台端口（`app.start()` 不收参数，
文件里那个 40995 不起作用），所以机器上已经跑着机器人时它会以 `EADDRINUSE` 退出 ——
只有在本机没有实例占用该端口时才能跑。它不在更新器的部署前测试集里
（那一集只跑 `test/*.test.mjs`），因此不影响「立即更新」。

## 外部依赖缺口：SnowLuma 不支持"主动发起好友申请"（2026-09-25 确认）

主动好友候选的**应用层管线完全正常**（候选生成 → 审批 → 派发 → 记账已端到端验证），
但派发环节的 `friendlist.addFriend` JCE 报文被服务端秒回笼统拒绝
（`businessCode=1`「添加失败，请稍后再试」），对陌生人、已好友、机器人自己三种目标
表现完全一致——请求没有到达好友逻辑。

### 实验记录（详见 Issue #10）

- **A/B 同连接对照**：旧结构（[5] 带手工字节长度）27ms 秒拒；移除长度字段的
  实验结构 15 秒无响应（`retcode=100`）。
- **self-add 实验**：连"添加自己"这类必然秒回语义化错误的请求，两种结构都未触发
  好友逻辑——实验性结构同样无效，该候选修复已回退。
- **开源调研**：NapCat/LLOneBot/Lagrange 均只实现入站申请处理
  （`set_friend_add_request`），无"发起申请"的公开报文实现可对照。
- **foxlesbiao 的内核发现**：GUI 客户端发起申请走的是 NTQQ 内核
  `reqToAddFriends`，而 SnowLuma 的 action 目录中没有此能力。

### 结论与当前状态

**根因是协议端能力缺口，不是本仓库的包结构错误。** `friendlist.addFriend`
这一旧服务在 NTQQ 会话下不可用，正确命令字 `reqToAddFriends` 需要
SnowLuma 上游支持，或拿到内核报文对照后经 `send_packet` 直发（transport 已验证可用）。

- 生产配置：`identityPilot.friendProposal.activeDispatchEnabled=false`——提案照常
  生成与审批，批准后保留为 `approved_manual`（待手动执行），不再白烧 30 天冷却。
- **重新派发**：`failed`/`held_unknown` 提案新增管理动作（控制台"重新派发"按钮，
  `POST /api/identity-pilot/friend-proposals/{id}/redispatch`，需 `confirm`）——
  协议端支持落地后可立即重试存量提案，不必等冷却重新提名。
- 恢复条件：SnowLuma 上游加入好友申请能力（或拿到 `reqToAddFriends` 报文对照）
  → 适配 `src/identity/friend-request-protocol.js` → 打开开关 → 用重新派发验证。

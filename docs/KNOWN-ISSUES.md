# 已知问题

只记录**当前基线上稳定复现、但尚未修**的问题，避免 CI 反复报同一条噪音。
修好一条就从这里删掉。

## 当前没有待修的已知问题

历史上这里记录过 5 个随底座带来的基线失败用例（2026-09-19 已全部清零）：

- `configure-linux` 生成的 `config.json` 权限被防抖保存打回 0664 → 修复：所有写盘路径
  统一 `mode: 0o600`（`src/config-legacy.js` 的 `scheduleConfigSave`）。
- "禁用身份基建后不建库" → 该用例测的是旧契约。身份/事件基建已按
  `src/stable-feature-policy.js` 转正常开，用例改写为"转正后旧的 enabled:false 被忽略"。
- 好友候选批准分发 → 分发链路同样已转正，测试桩补上 `get_login_info` 与
  `sendFriendRequest` 桩件，断言改为"批准即发送"。
- 事件列表计数 `2 !== 1` → `app.start()` 连不上 OneBot 时会自动捕获一条连接事件，
  属于正常基建行为；用例改为只断言自己注入的那条（按 `source` 过滤）。
- 「已确认黑话」注入 → 黑话研究已下线（slangPilot retired），提示词不再注入任何黑话；
  用例改写为"即使旧配置开着、slang.json 存在也不注入"（防跨群泄露的初衷保留）。

## 环境相关（不算项目问题）

在 Windows 上跑 `npm run test:unit` 会有约 50 个用例失败（需要 docker / systemd /
Unix 路径 / 文件权限位等）；Linux 服务器与 CI（ubuntu-latest）上全量通过。

<div align="center">

<img src="docs/assets/mark.svg" alt="QQ Agent Plus" width="104" height="104">

# QQ Agent Plus

**面向 Linux 服务器的 QQ 群聊 Agent · 会分条说话、会发表情包、记得住人、自带运维命令**

[![CI](https://github.com/sakurawwwxh/qq-agent-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/sakurawwwxh/qq-agent-plus/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/sakurawwwxh/qq-agent-plus?color=e8b400&label=stars&logo=github)](https://github.com/sakurawwwxh/qq-agent-plus/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/sakurawwwxh/qq-agent-plus?logo=git&logoColor=white)](https://github.com/sakurawwwxh/qq-agent-plus/commits/main)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-Linux-0b5fff?logo=linux&logoColor=white)](docs/LINUX.md)
[![OneBot](https://img.shields.io/badge/protocol-OneBot%20v11-12b7f5)](https://github.com/botuniverse/onebot-11)
[![LLM](https://img.shields.io/badge/LLM-OpenAI%20%E5%85%BC%E5%AE%B9-6b4fbb)](#-特性)

**简体中文** ｜ [English](README.en.md)

<img src="docs/assets/console-demo.png" alt="控制台：消息存档与会话管理" width="880">

</div>

面向 Linux 服务器的 QQ 群聊 Agent：直接连接外部 OneBot v11 服务，每次触发使用独立的
OpenAI Chat Completions 会话，不依赖 DSH、MCP、Electron 或 Windows 运行环境。

## ✨ 特性

下面这些改动都来自真实群聊里踩过的坑，每条的失败模式与效果写在[改动清单](docs/CHANGES.md)里：

- **对话行为**：一轮里分条发言、看图先定性再回话、表情包清单常驻系统提示、收尾自检；
- **发送链路**：网络级发送重试、QQ 系统表情、消息 id 归一化、内联工具调用兜底解析；
- **贴纸系统**：自动收藏与 QQ 收藏优先、查找兜底、同步护栏；
- **主动发言**：多个活跃时段、间隔护栏、跳过原因日志、follow-up 提醒、重启补齐漏消息；
- **模型接入**：按用途控制思考模式、服务商审核拦截重试、兜底模型切换。

配置项示例见 [配置示例](docs/CONFIG-EXAMPLES.md)；运维命令统一收在 [src/ops.js](src/ops.js)，
用法见 [运维工具](docs/OPS.md)；本地回归测试在 [test/local/](test/local/README.md)。
衍生关系与版权说明见 [NOTICE](NOTICE.md)。

## 🖼 演示

运维命令都是程序自带（`src/ops.js`），只读命令不会碰业务数据：

```text
$ node src/ops.js audit
===== 1. 服务与定时器 =====
  [正常] qq-agent-linux.service  active
  [正常] qq-agent-linux-update.timer  enabled
===== 3. 源码语法（全部 js） =====
  [正常] 所有 js 文件语法通过（75 个）
===== 4. 未定义调用扫描 =====
  [正常] 可疑未定义调用点: 0
===== 8. 运行态 =====
  [正常] OneBot: connected=true …
===== 自检结论 =====
  全部通过（0 项异常）
（节选：实际共 11 段，含配置 / 数据文件 / 价格缺口 / 最近日志 / 主机资源等）

$ node src/ops.js watch-send --minutes=5
基线：outbox 最新 rowid=17，待处理消息 0 条
      最近一条人类消息：今晚还打不打
SEND_OK：机器人通过工具层成功回话 ｜ group:123456789 ｜ run=3f2c… ｜ state=sent ｜ 打啊
      人类上一条：今晚还打不打
```

群聊里的一轮（示意；真实聊天记录不会公开）——接住对方的话之后，
如果还有自己的半句就分条接着说，合适的场合直接用表情：

```text
群友： 今晚还打不打
机器人：打啊
机器人：我吃完饭了 缓十分钟就来
机器人：[表情包：别墨迹]
```


## 🧱 架构

```text
OneBot WebSocket
  -> 按会话串行入库
  -> SQLite/WAL 消息状态机
  -> 默认随机 8-12 秒、最长 20 秒有界聚合
  -> legacy / threaded / lifecycle 路由
  -> 可选持久化线程与检查点
  -> 一次性 Agent 会话
  -> 会话绑定工具
  -> OneBot HTTP
```

消息只在处理成功后确认。模型或进程失败时，未发送批次自动重试；
发送结果无法确认时进入 `held`，必须人工核对，避免重复发言。

## 🚀 全栈一键部署

全新 Linux 机器推荐运行交互式安装器。它会询问部署目录和端口，自动安装
Docker（需要 sudo 确认）、下载 SnowLuma、配置 OneBot、安装 QQ Agent，并生成和
同步全部服务凭据。SnowLuma 已经包含 OneBot，不需要再安装 NapCat 或 Lagrange。

```bash
git clone https://github.com/sakurawwwxh/qq-agent-plus.git
cd qq-agent-plus
bash deploy-all.sh
```

默认目录为 `/mnt/data/qq-agent`，默认对外端口为：

- `3210`：QQ Agent 控制台；
- `5099`：SnowLuma WebUI；
- `6081`：QQ 登录使用的 noVNC。

OneBot HTTP `3000` 和 WebSocket `3001` 默认只绑定
`127.0.0.1`，不会暴露到局域网。安装器不会要求填写本机 IP，而是在完成后自动
检测并打印访问地址。所有生成的凭据保存在
`/mnt/data/qq-agent/deployment-access.txt`，权限为 `0600`。
脚本不会擅自修改 UFW、firewalld 或云安全组；需要跨主机访问时，应只向可信
局域网或 VPN 放行上述三个用户入口，不要把 noVNC 或 OneBot 暴露到公网。

首次安装会同时询问模型 Base URL、API Key、模型名和 QQ 白名单。基础设施启动后，
打开脚本给出的 noVNC 地址并扫码登录 QQ，再回到终端按 Enter；脚本会验证 OneBot
登录并询问是否激活。确认旧机器人已停止或排除相同群聊后，也可手动执行：

```bash
/mnt/data/qq-agent/app/manage.sh activate --confirm-exclusive
```

无人值守安装可使用：

```bash
bash deploy-all.sh --yes --root-dir /mnt/data/qq-agent \
  --agent-port 3210 --snowluma-port 5099 --novnc-port 6081 \
  --model-base-url https://api.deepseek.com \
  --model-api-key "$DEEPSEEK_API_KEY" --model deepseek-chat \
  --allow-groups 123456789
```

无人值守模式必须提供模型配置，或者显式增加 `--skip-model-config`，部署后再从控制台
填写。白名单可以留空，但机器人在配置允许的会话前不会响应。

仅本脚本管理且配置一致的安装允许重跑。开始写入前会核对 Agent 配置与部署记录、
systemd 服务目录、SnowLuma 容器的 Compose 归属/数据卷，以及端口占用。发现已有
非受管安装、残留不完整状态或后台修改过的凭据时，会报错退出，不覆盖配置或重启服务；
`--yes` 和 `--rotate-credentials` 都不能绕过这一保护。

可先进行只读检查（不创建目录、下载依赖或修改服务）：

```bash
bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
```

旧 Bridge/SnowLuma 生产环境应使用 `deploy.sh` 更新 Agent，保留实际数据目录、
监听地址和 OneBot 配置；不要删除已有数据或伪造 `.env` 来绕过检查。全栈检查还需要
`realpath`、`ss`（iproute2）；已有 Docker 但无法读取容器时会安全退出。

受管安装重跑会保留 SnowLuma 数据、QQ 登录态和现有凭据。如需同步轮换 Agent、
OneBot、SnowLuma WebUI 与 noVNC 凭据，增加 `--rotate-credentials`；启用
SnowLuma 2FA 后还需提供 `--snowluma-totp`。完整参数见：

```bash
bash deploy-all.sh --help
```

## 📦 仅部署 QQ Agent

要求：

- Linux + systemd user service
- `curl`、`tar`、`sha256sum`、`rsync`（缺少 Node.js 时自动安装已校验的 Node 22）
- 已运行的 OneBot v11 HTTP 和正向 WebSocket 服务
- OpenAI Chat Completions 兼容模型

面板部署（宝塔 / aaPanel）见[宝塔面板部署](docs/BAOTA.md)：宝塔只当面板用，进程仍由 systemd
用户服务托管，不要在面板里用 Node 项目或 PM2 启动。

```bash
git clone https://github.com/sakurawwwxh/qq-agent-plus.git
cd qq-agent-plus

bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 127.0.0.1 \
  --port 3210
```

`deploy.sh` 不安装 SnowLuma，适合已有 OneBot 服务或只更新 Agent。该脚本会：

- 校验参数、源码和 Node.js `node:sqlite` 能力
- 安装生产依赖
- 自动检测或安装 Node.js 22 运行时
- 初始化独立数据目录和控制台 Token
- 注册并启用 `qq-agent-linux.service`
- 配置进程异常自动重启
- 检查端口冲突和 systemd unit
- 首次安装以 `observe` 模式启动，更新时保留已有运行模式
- 更新前自动创建代码快照，失败时恢复旧代码、配置和服务
- 排除 `.git`、`.dbg`、运行数据、凭据和本地调试记录

查看全部参数：

```bash
bash deploy.sh --help
```

如果已有外部备份流程，可以显式跳过代码快照：

```bash
bash deploy.sh --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data --host 127.0.0.1 --port 3210 \
  --no-backup
```

首次从旧 Bridge 迁移连接配置时可附加：

```bash
  --import-bridge /path/to/old/config.json \
  --credential-file /path/to/credentials.env
```

该操作只复制配置，不修改旧目录或数据。

更新已有安装：

```bash
git pull --ff-only
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 127.0.0.1 \
  --port 3210
```

更新不会重置现有配置或运行模式。默认在
`DATA_DIR/deploy-backups/` 创建部署前代码快照；任何安装、配置、systemd
校验或健康检查失败都会自动恢复旧代码、配置和服务。

部署脚本还会安装独立的 GitHub 更新 service/timer。自动更新默认关闭，可在
“控制 -> 更新部署”配置管理员后恢复。提示与部署都以**已发布的 Release** 为准
（草稿、预发布和 `main` 上的日常提交都不算），目标就是该 tag 的提交：先执行单元测试，
再复用 `deploy.sh` 部署；当前部署已包含最新 Release 时不会回退，比较不出方向时不动手；
失败会回滚、停止自动更新并私聊管理员。
详见[自动更新部署](docs/AUTO_UPDATE.md)。

## 🛠 运维

```bash
bash manage.sh status
bash manage.sh logs
bash manage.sh health
bash manage.sh token
bash manage.sh restart
bash manage.sh observe
bash manage.sh activate --confirm-exclusive
bash manage.sh update-status
bash manage.sh update-now --confirm
bash manage.sh backup /path/to/new-backup-dir
```

`manage.sh` 之外的运维工具（只读体检、数据备份、发送/登录监控、进程看门狗、
表情名导出、非交互部署、SSH 隧道）统一由 `src/ops.js` 提供，只用 Node 内置模块：

```bash
node src/ops.js help                     # 全部子命令
node src/ops.js audit                    # 服务 + 代码 + 数据体检（只读）
node src/ops.js audit-host               # 主机体检（只读）
node src/ops.js scan                     # 未定义调用扫描
node src/ops.js backup --confirm         # 停/起服务 + 打包数据目录，只留最近 4 份
node src/ops.js install-timers --print   # 查看两个 systemd user 定时器
node src/ops.js console --open           # 建 SSH 隧道并打开控制台
```

每个子命令都支持 `--help`；环境变量、常用示例与远程执行说明见
[运维工具文档](docs/OPS.md)。

### OneBot 显示「未连接」怎么查

控制台只判断"连上/没连上"，真正的原因在 `/api/status` 的 `onebot.error` 里，跑一次体检就能看到：

```bash
node src/ops.js audit --dir=/mnt/data/qq-agent     # 看 "OneBot: connected=false error=…" 那一行
journalctl --user -u qq-agent-linux -n 80 | grep -i onebot
```

> `ops.js` 直连协议端时默认用 `3390` 端口；如果你没改过端口（安装脚本默认 `3000`），
> 加一个 `QQ_AGENT_ONEBOT_HTTP_PORT=3000` 再看，否则那一行会误报不可达。

按 error 里的内容对症：

- `ECONNREFUSED` —— 协议端没在这个端口监听。先看容器在不在：
  `docker ps -a | grep snowluma`、`docker logs --tail 50 qq-agent-snowluma`。
- `401` / `403` —— 令牌不一致：协议端 `onebot.json` 里的 `accessToken` 必须和
  控制台「设置 → OneBot」的 WS 令牌一致（HTTP 令牌留空则沿用 WS）。
- `ENOTFOUND` —— 地址解析不了，WS 地址写错了（默认 `ws://127.0.0.1:3001`）。
- `ETIMEDOUT` —— 连不到那台机器（地址或防火墙）。
- `404` / `Unexpected server response` —— 端口填错，对方不是 WebSocket 协议端
  （HTTP 端口 `3000` 不能当 WS 用）。

三个最容易踩的坑：

- **改完地址或令牌必须重启才生效**：连接只在服务启动时建立一次，控制台里保存配置
  不会重连，执行 `bash manage.sh restart`。
- 协议端必须是**正向 WebSocket 服务端**：本项目只做正向 WS 客户端，不提供反向 WS 服务端。
- 状态圆点：绿＝已连接，黄＝连上过又断了（会自己退避重连，不用重启），灰＝从未连上。

QQ 没登录不算"未连接"：那种情况 WS 是通的，只是取不到登录信息，用
`node src/ops.js watch-login` 盯登录即可。

> **本机看控制台不用碰公网端口**：控制台只监听服务器的 `127.0.0.1:3210`。
> Windows 用户直接双击仓库里的 [`console-tunnel.bat`](console-tunnel.bat)——首次输入一次
> `user@host` 并记住，它会自动从服务器读取控制台令牌、建好 SSH 隧道并免登录打开浏览器
> （同时转发 5099 SnowLuma WebUI 与 6081 QQ 扫码登录）。macOS / Linux 或有 Node 的机器
> 用上面的 `node src/ops.js console --open`，效果相同。

控制台默认端口为 `3210`。Token 可在
`设置 -> 系统 -> 控制台安全` 中轮换。

顶层“控制”页是统一运维入口，集中提供 QQ Agent、DSH、Bridge、SnowLuma 和
QQ 远程桌面的入口与在线状态，并可跳转到模型、搜索、OneBot 和控制台 Token
设置。该页还可手动更新、暂停或恢复自动更新。SnowLuma 登录密钥可在该页直接修改，
密钥仅随单次请求发送，不写入 QQ
Agent 配置或前端存储。旧的 `3110` 门户不再映射。

启用前必须确保旧机器人未处理相同会话，否则会产生双回复。

## 💾 数据

数据默认位于部署参数指定的 `data` 目录：

- `config.json`：配置和凭据，权限 `0600`
- `messages.sqlite`：消息、租约和出站状态
- `sessions/`：每次 Agent 运行记录
- `memory/`：群友长期印象和跨 Session 会话交接状态
- `identity-pilot.sqlite`：实验性统一 QQ 身份索引（仅启用实验开关后创建）
- `slang-pilot.sqlite`：黑话发现、研究任务和两级审批审计（仅启用后创建）
- `daily-moments.json`：每日群聊总结、说说决策与发布结果
- `qzone-interactions.json`：好友动态未读队列、评论回复和外部写入状态
- `console-access.txt`：控制台地址和 Token，权限 `0600`

“设置 -> 实验功能”只管理实验能力的运行开关与固化状态，不承载业务数据或高级
参数。固化后对应功能会取得独立顶层入口；关闭运行开关不会撤销入口或删除历史数据。
“旧印象”页按 QQ 号聚合白名单会话里的身份、别名、消息统计、好友状态及已有会话
印象，并开放受限的 `person_memory_lookup` 查询工具。“好友管理”页维护主动候选、
收到的好友请求、审批参数及状态。管理员批准主动候选后，系统通过 SnowLuma
`send_packet` 调用已验证的 QQ 好友协议；仅业务响应明确成功才标记已提交，超时、
断线或响应无法解析会进入“发送结果未知”且禁止自动重试。收到 `friend_add` 事件
后才闭环为“已成为好友”。收到的好友请求同样需要管理员审批，同意后调用标准
`set_friend_add_request` 并自动加入私聊白名单。
实现边界见[已转正的稳定特性](docs/STABLE_FEATURES.md)。

“观测”页展示并管理表情包、黑话与黑话研究数据。人物和旧印象由固化后的独立页面
管理，不再混放在通用观测入口。手动上传的表情保存在数据目录；QQ 收藏表情的删除
只会从 AI 资产库隐藏，不会改动 QQ 客户端收藏。表情图片通过控制台鉴权的同源代理
加载，临时 QQ 图片 URL 不会返回给浏览器。
详细口径见[资产观测](docs/ASSET_OBSERVABILITY.md)。

自动黑话研究流水线**已退休**（`slangPilotEnabled()` 恒为 false，无法再启用）：
提示词不再注入任何黑话，历史配置里的开关不会再生效。见
[已转正的稳定特性](docs/STABLE_FEATURES.md)。

每次 Agent 运行仍有独立的审计记录。`lifecycle` 模式会按 `threadId`
持久化 provider transcript（包括工具轨迹和供应商返回的
`reasoning_content`），并在下一批消息中按原顺序续接；结构化 handoff
作为生命周期滚动后的压缩状态继续保留。控制台可检查注入历史、最新完整模型
输入以及逐轮 Token/缓存命中。
生命周期默认在上次请求输入达到 32000 Token 时换代；单次 Agent 运行累计预算
为 160000 Token，追加工具轮会在请求前预估预算并安全收尾。

“设置 -> 聊天设置”可分别配置未思考等待的最短值与最长值。每次自动唤醒会在
范围内重新随机，默认 `8000–12000ms`；连续消息仍由 `maxBatchWaitMs=20000`
限制从首条待处理消息起的最长聚合时间。生命周期的等待批次会立即归入当前
`threadId`，控制台不会先显示独立窗口再合并；新 Session 也不会抢占正在查看的
详情。生命周期批次栏支持横向滚动，切换批次时保留详情和批次栏位置。

“设置 -> 聊天设置”里的响应概率滑条决定机器人对普通消息的回话比例：**滑条上的数字就是
概率**。`0%` 只回被 @、被点名或命中关键词的消息，`100%` 任何消息都回；被 @、被点名或
命中关键词的批次一定回，不看概率。概率按批独立抽签、不累计配额，也不是“每 100 条回
几条”的额度。可以统一设置，也可以关掉统一开关后给每个群单独拖：没单独设置过的群聊和
所有私聊跟随统一滑条。旧版四段式档位（0-10 仅艾特、10-20 加关键词、20-90 概率、
90-100 全响应）会在首次读盘时换算一次：0-20 变成 `0%`，20-90 按比例线性映射，
90 以上变成 `100%`。新语义里没有“只回 @、不回关键词”这一档，所以旧的 0-10 换算后
也会响应关键词。

“设置 -> 人设 -> 选择人设”里有多张内置角色卡（默认小鲸鱼、游戏客户端开发者，另有损友、
温柔陪聊、技术宅、猫娘），选中只填入草稿，点“保存人设修改”才生效。交流策略可选“原版群友”
或“自然可靠”，角色正文和管理员附加规则都能改，也可以基于当前草稿“＋ 添加人设”建自定义
副本。角色卡正文的单一来源是 [`roles/`](roles) 目录，一张卡一个 markdown 文件。

顶部状态与用量页均按每次模型调用返回的 `usage`、实际模型和调用时刻计价。
“今日”以及按天统计固定使用 `Asia/Shanghai` 自然日，不受服务器系统时区影响。

“设置 -> 每日动态”可启用每日群聊总结。任务按上海时间运行，读取当天活跃群的
消息、长期记忆和会话交接；模型可以联网研究、查看近期群图或收藏图，最终自行
决定发布或跳过。发布通过 SnowLuma `send_qzone_msg` 完成，并按日期记录幂等状态，
服务重启不会自动重复发布结果不明的说说。

每日动态使用专门的说说提示词，完整读取设置中的角色卡和管理员附加规则，
不再附加普通群聊的工具流程。提示词与设计说明见
[动态提示词](docs/DAILY_MOMENTS.md)。`生成新草稿` 不发布；检查正文后可点击
`发布这份草稿`，直接发送同一份内容，不再次消耗模型 Token。
中断的生成可重新执行；非法模型参数会触发纠错，纠错失败显示“生成失败”。
“发布结果待核对”只能核对空间记录，不能盲目重发。

“设置 -> 动态互动”可按可配置间隔阅览好友动态、决定点赞或评论，并检查自己
动态及已评论动态中的新回复。未阅览内容按最新优先统一提交给模型，超出模型
上下文窗口的旧条目继续保持未读。首次启用默认只建立基线，不突然互动历史内容。
设计、状态与幂等规则见[动态互动](docs/QZONE_INTERACTIONS.md)。

存档页的“主动唤醒”是管理员显式运行：有未读消息时直接处理当前批次（不看响应概率）；
没有未读消息时读取该模式配置的最近存档，让模型自行决定是否
发言。该操作仍受运行模式、暂停、白名单、时间控制、并发上限和 `held` 状态保护。

## ⏰ 时间控制

“设置 -> 时间控制”默认关闭。关闭时忽略全部时间规则，不改变现有唤醒、提示词、
模型请求或消息处理策略。开启后统一使用上海时间，全局规则默认为 DS 低峰：
工作日 `00:00–09:00`、`12:00–14:00`、`18:00–24:00`，周末全天。
每个群聊及私聊均可覆盖为继承全局、DS 低峰、自定义星期/时段或全天活跃。
自定义允许跨午夜，例如周五 `22:00–02:00` 延续至周六凌晨；
`00:00–24:00` 为全天，自定义空时间表表示始终非活跃。

非活跃期消息与拍一拍仅归档，不触发 AI，不积压自动补回复；进入活跃期后新消息
按原模式处理，已归档消息仍可作为历史上下文。模型请求、工具轮、重试、记忆整理
及发送均受时间门控。每日动态与控制台模型测试遵循全局时间表，每日汇总还会排除
当前非活跃的会话；被时间限制挡住的定时动态推迟至活跃窗口。

规则修改即时生效。在途请求跨入非活跃期会被中止，后续请求与发信被拦截；
供应商对已经收到的请求仍可能计费，无法承诺撤销这部分 Token。
发送结果不明确的 `held` 记录不会因时间切换而被丢弃或自动重发。

聊天、密钥、Token 和运行数据均被 Git 忽略。

## ✅ 验证

```bash
npm ci --omit=dev --ignore-scripts
npm run test:unit     # 单元测试
npm run test:local    # 本地回归（自动用临时数据目录，不碰生产数据）
node src/ops.js scan --strict
npm audit --omit=dev
bash -n deploy.sh manage.sh
```

CI（GitHub Actions）在每次推送和 PR 上跑：语法检查、未定义调用扫描（严格模式）、
单元测试与本地回归。当前基线上有两条已确认、暂不修的小问题（都不影响主链路），
历史记录见[已知问题](docs/KNOWN-ISSUES.md)。

详细说明见 [Linux 运维手册](docs/LINUX.md)；全部文档见 [文档索引](docs/README.md)。
试验性三模式对话引擎见
[Conversation Modes](docs/CONVERSATION_MODES.md)；早期参与者续接方案见
[Threaded Conversation Pilot](docs/research/THREADED_PILOT.md)。

## 📄 许可

本项目使用 MIT 许可（见 [LICENSE](LICENSE)）；衍生关系与第三方版权见 [NOTICE](NOTICE.md)。
OneBot 协议端是独立软件，遵循其自身许可。

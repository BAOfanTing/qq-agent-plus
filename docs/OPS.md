# 运维工具（src/ops.js）

项目的运维入口只有 `src/ops.js` 一个文件，使用 Node 内置模块（`child_process` /
`fs` / `path` / `os` / `node:sqlite` 等），**不引入任何新依赖**，也不需要 python3。
原来的 `ops/` 目录（shell / python 脚本与 systemd 示例单元）已全部移植进来并删除。

约定：

- 所有路径与凭据只从**环境变量**读取，脚本里不含任何真实地址、令牌或账号；
- token / 口令只用于本地请求，`audit` 对 `config.json` 里的密钥只报「有 / 无」，绝不打印；
- 只读子命令（`audit` / `audit-host` / `scan` / `watch-*` 及 `--print` 模式）不写业务数据；
- 破坏性操作（`backup` / `deploy` / `guard` 真实执行 / `install-timers` 写盘）必须显式
  `--confirm`，预演用 `--dry-run` 或 `--print`；
- 外部命令（`systemctl` / `docker` / `journalctl` / `ss` / `tar` / `openssl` 等）缺失时，
  对应段落打印「跳过」并继续，不会中断整体体检；在 Windows/macOS 上只读体检可以正常跑完。

```bash
node src/ops.js help          # 全部子命令
node src/ops.js <子命令> --help
npm run ops -- <子命令>
```

## 子命令一览

| 子命令 | 对应原脚本 | 干什么 | 什么时候用 |
| --- | --- | --- | --- |
| `audit` | `ops/audit-server.sh` | 服务 + 代码 + 数据体检：systemd user 服务/定时器、启动补丁链可执行性、全量 js 语法、未定义调用扫描、关键补丁标记、config.json 关键项（密钥只报有/无）、sqlite 完整性、控制台/OneBot 运行态、最近日志、主机资源 | 部署后验收；出问题先跑一遍定位 |
| `audit-host` | `ops/audit-host.sh` | 主机只读体检：失败单元、内存/磁盘/journald、Docker 容器与重启次数、监听端口、SSH 安全、防火墙、定时任务、可升级包、TLS 证书到期、备份现状 | 接手一台机器、例行巡检 |
| `backup` | `ops/backup-qq-agent-data.sh` | 停服务几秒 → tar.gz 打包数据目录 → 起服务 → 只留最近 N 份；任何失败路径都会把服务拉起来 | 每周定时（配 `.timer`）；大改动前手动跑 |
| `scan` | `ops/scan-undefined-calls.py` + `ops/check-undefined-calls.sh` | 把注释/字符串/正则/模板串抹白后，找「调用了但本文件既没定义也没 import」的函数名；只记录、不阻断（退出码恒为 0） | 改完 `src/*.js` 后；也可挂在服务 `ExecStartPost` |
| `watch-send` | `ops/watch-send.py` | 盯 outbox 表的 rowid 水位线：基线之后新增 failed 行报 SEND_FAIL，新增成功行报 SEND_OK，也检查是否又出现未定义函数事故 | 修完发送链路后的线上验证 |
| `watch-login` | `ops/watch-login.py` | 每 15 秒轮询协议端 HTTP 端口，直到 QQ 登录成功，然后打印登录信息 / 控制台状态 / 最近日志 | 重启协议端容器或掉线重登后确认恢复 |
| `guard` | `ops/guard-process-explosion.sh` | 用户进程数超过阈值时清理失控的 bash/grep/tr/sh/sleep 进程树并记录现场（仅 Linux） | 配 `process-guard.timer` 每 10 分钟跑 |
| `face-names` | `ops/export-face-names.sh` | 合并 SnowLuma 目录 / QQ 客户端配置 / 手工补充表，导出 `data/face-names.json` | QQ 加了新表情、表情名对不上时 |
| `deploy` | `ops/deploy_qq_agent.sh` | 非交互部署：设好模型凭据后调用源码目录的 `deploy-all.sh -y` | 新机器初始化、CI / 远程 SSH 里部署 |
| `console` | `ops/qq-console.bat` | 用系统 `ssh` 建立控制台 / WebUI / 远程桌面三个端口的隧道，就绪后提示或打开控制台（Windows/macOS/Linux 通用） | 日常打开控制台 |
| `install-timers` | `ops/systemd/` | 生成并安装两个 systemd user 定时器：备份（每周日 04:10）、进程看门狗（每 10 分钟） | 安装定时任务 |

## 常用示例

```bash
# 体检（先主机层，再服务层）
node src/ops.js audit-host
QQ_AGENT_CONSOLE_TOKEN=xxx node src/ops.js audit

# 本地跑体检时指定仓库自身（默认看 /data/qq-agent/app）
node src/ops.js audit --app=. --data=./data

# 未定义调用扫描：默认带项目已知误报忽略表；传空 --ignore= 可看原始结果
node src/ops.js scan
node src/ops.js scan --ignore=
node src/ops.js scan --log="$HOME/qq-agent-undefined-calls.log"   # 有可疑调用时追加记录

# 备份（先预演，再执行；N 默认取 QQ_AGENT_KEEP=4）
node src/ops.js backup --dry-run
node src/ops.js backup --confirm --keep=4

# 备份出机（可选，强烈建议）：把备份包再推一份到 rclone 远端（如腾讯云 COS）
# 一次性配置：装 rclone → rclone config 建远端 → 写 ~/qq-agent/tools/offsite.conf：
#   RCLONE_REMOTE="my-cos:qq-agent-backups"
# 安装定时器（每周日 05:10，紧跟本地 04:10 备份；未配置时脚本安静跳过）：
#   cp scripts/systemd/qq-agent-backup-offsite.* ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now qq-agent-backup-offsite.timer
# 手动跑一次 / 看日志：
~/qq-agent/app/scripts/backup-offsite.sh
tail ~/qq-agent/backups/offsite.log

# 线上验证
node src/ops.js watch-send --minutes=240
node src/ops.js watch-login --timeout=25

# 进程看门狗
node src/ops.js guard --dry-run
node src/ops.js guard --confirm --threshold=800

# 表情名导出（容器在跑时直接导出；也可以给本地文件副本）
node src/ops.js face-names
node src/ops.js face-names --print
node src/ops.js face-names --catalog=/path/sys-face-catalog.json --qq-config=/path/face_config.json

# 非交互部署
QQ_AGENT_MODEL_API_KEY=... QQ_AGENT_MODEL_BASE_URL=... QQ_AGENT_MODEL=... \
  node src/ops.js deploy --dir="$HOME/qq-agent-src" --confirm

# 控制台隧道
SSHHOST=user@your-server node src/ops.js console --open
node src/ops.js console --print        # 只打印 ssh 命令

# 定时器
node src/ops.js install-timers --print
node src/ops.js install-timers --confirm
```

## 环境变量

所有带默认值的路径都可以覆盖；默认值对应「部署根目录 `/data/qq-agent`」的标准布局。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_AGENT_DIR` | `/data/qq-agent` | 部署根目录 |
| `QQ_AGENT_APP_DIR` | `$QQ_AGENT_DIR/app` | 应用目录（`src/`、`ui/`、自带 `.runtime/node`） |
| `QQ_AGENT_DATA_DIR` | `$QQ_AGENT_DIR/data` | 数据目录（config.json、sqlite、sessions） |
| `QQ_AGENT_BACKUP_DIR` | `$HOME/qq-agent/backups` | 备份输出目录 |
| `QQ_AGENT_SERVICE` | `qq-agent-linux.service` | systemd user 服务名 |
| `QQ_AGENT_KEEP` | `4` | `backup` 保留份数（也可用 `--keep=N`） |
| `QQ_AGENT_USER` | 当前登录用户 | 进程/定时任务检查的目标用户 |
| `QQ_AGENT_NODE` | 自动找 `$APP_DIR/.runtime/node-*/bin/node` | 跑 `--check` 用的 node |
| `QQ_AGENT_LOG` | `$HOME/qq-agent-undefined-calls.log` | 启动自检报告文件（`scan --log=` 可显式覆盖） |
| `QQ_AGENT_CONSOLE_PORT` | `3210` | 控制台端口 |
| `QQ_AGENT_ONEBOT_HTTP_PORT` | `3390` | 协议端 HTTP 端口 |
| `QQ_AGENT_CONSOLE_TOKEN` | 无（未设置则回退到 `config.json` 的 `server.token`；都没有则跳过相关检查） | 控制台 API token |
| `QQ_AGENT_ONEBOT_TOKEN` | 无（未设置则回退到 `config.json` 的 OneBot 令牌） | 协议端 access token |
| `QQ_AGENT_UPDATE_TIMER` | `qq-agent-linux-update.timer` | 自动更新定时器名（`audit` 只读检查） |
| `QQ_AGENT_GUARD_TIMER` | `process-guard.timer` | 进程看门狗定时器名 |
| `QQ_AGENT_OVERRIDE_CONF` | `~/.config/systemd/user/<service>.d/override.conf` | 启动补丁链检查用的 override 文件 |
| `QQ_AGENT_HOST_UPDATE_PATTERN` | `hermes\|unattended\|update` | 主机级更新定时器过滤正则 |
| `QQ_AGENT_GUARD_USER` | `QQ_AGENT_USER` | 看门狗盯的系统用户 |
| `QQ_AGENT_PROC_LIMIT` | `800` | 看门狗阈值（也可用 `--threshold=N`） |
| `QQ_AGENT_GUARD_LOG` | `$HOME/process-explosion.log` | 看门狗现场记录文件 |
| `QQ_AGENT_SNOWLUMA_CONTAINER` | `qq-agent-snowluma` | 协议端容器名（`face-names` 用） |
| `QQ_AGENT_WEBUI_PORT` | `5099` | SnowLuma WebUI 端口（`console` 隧道） |
| `QQ_AGENT_VNC_PORT` | `6081` | QQ 远程桌面 / 扫码端口（`console` 隧道） |
| `QQ_AGENT_SYSTEMD_DIR` | `~/.config/systemd/user` | `install-timers` 写入目录 |
| `QQ_AGENT_SRC_DIR` | `$HOME/qq-agent-src` | `deploy` 的源码 checkout 目录（也可用 `--dir=`） |
| `QQ_AGENT_ROOT_DIR` | `QQ_AGENT_DIR` | `deploy` 的部署根目录（也可用 `--root-dir=`） |
| `QQ_AGENT_MODEL_API_KEY` / `QQ_AGENT_MODEL_KEY_FILE` | 无（必填其一） | 模型凭据（文件优先级低于环境变量） |
| `QQ_AGENT_MODEL_BASE_URL` / `QQ_AGENT_MODEL` | 无（必填） | 模型网关地址 / 模型名 |
| `SNOWLUMA_IMAGE` | `motricseven7/snowluma:v1.14.15` | 协议端镜像（`deploy`） |
| `QQ_AGENT_ONEBOT_WS_PORT` | `3391` | 协议端 WebSocket 端口（`deploy`） |
| `SSHHOST` / `QQ_AGENT_SSH` | **必填**（缺失直接报错退出） | 服务器地址；两种写法都支持：`SSHHOST=host` 或 `SSHHOST=user@host` / `QQ_AGENT_SSH=user@host` |
| `SSHUSER` | `ubuntu` | SSH 登录用户 |
| `SSHPORT` | `22` | SSH 端口 |

安全约定：token / 口令只从环境变量或部署生成的配置文件读取，不要写进脚本或提交到仓库。

## 退出码

| 子命令 | 退出码 |
| --- | --- |
| `scan` | 恒为 0（只记录、不阻断） |
| `watch-send` | 0 = 工具层成功发出消息；1 = 发送失败 / 又出现未定义函数；2 = 超时 |
| `watch-login` | 0 = 已登录；1 = 超时或缺少令牌 |
| `backup` / `deploy` / `install-timers` | 0 = 成功；1 = 参数/执行失败（缺少 `--confirm` 也返回 1） |
| `audit` / `audit-host` / `guard` | 恒为 0（问题只体现在 NG / [注意] 行数） |

## 定时任务

`install-timers` 生成两个 unit，`--print` 只打印内容，`--confirm` 才写入
`~/.config/systemd/user/` 并执行 `systemctl --user daemon-reload && enable --now`：

- `qq-agent-backup.timer`：`OnCalendar=Sun *-*-* 04:10:00`、`Persistent=true`，
  调用 `node src/ops.js backup --confirm`；
- `process-guard.timer`：`OnBootSec=3min`、`OnUnitActiveSec=10min`，
  调用 `node src/ops.js guard --confirm`。

生成的 ExecStart 使用当前 node 与 `src/ops.js` 的绝对路径；换机器/换部署目录后重新
`install-timers --confirm` 即可，也可以直接改 unit 里的路径。

## 远程执行

仓库不再携带开发机私有的 ssh/paramiko 文件传输与执行脚本（原 `ops/sshcmd.py`、
`ops/sshrun.py`、`ops/sshupload.py`、`ops/sshget.py`）。**远程执行请直接用 `ssh` /
`scp`**，例如：

```bash
ssh user@host 'cd /data/qq-agent/app && node src/ops.js audit'
scp user@host:/data/qq-agent/data/messages.sqlite ./messages.sqlite
```

本项目只额外提供一个 `console` 子命令做端口隧道（控制台 / WebUI / 远程桌面），
方便日常打开控制台。

## 从旧 ops/ 迁移

- 命令对应关系见上面的子命令一览表；所有默认路径与变量名保持不变；
- 已知差异：
  - `watch-send` / `watch-login` 改为在本机（或你 ssh 上去的那台机器）直接运行，
    不再内置 SSH 客户端；轮询间隔分别增加 `--interval` 选项便于调试；
  - `backup` 在缺少 `systemctl` 的环境（如 Windows）只跳过停/起服务，仍会打包；
  - `scan` 默认带项目已知误报忽略表（等价于原 `check-undefined-calls.sh`），
    `--ignore=` 可关闭；`--log=文件` 等价于原启动自检的日志行为；
  - `audit` 的第 4 节会打印每个文件的未定义调用明细，并在结论里重复计数。

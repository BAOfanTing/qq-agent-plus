# 运维工具（ops）

本目录收录本项目在真实 Linux 部署里用到的运维脚本。所有脚本都已参数化：
服务器地址、部署路径、账号、token 一律从**环境变量**读取，脚本里不含任何真实地址或凭据。

## 工具一览

| 工具 | 干什么 | 什么时候用 | 依赖 |
| --- | --- | --- | --- |
| `audit-host.sh` | 主机层面只读体检：失败单元、内存/磁盘/journald、Docker 容器重启、监听端口、SSH 安全、防火墙、定时任务、TLS 证书、备份状况 | 接手一台机器、例行巡检 | bash、coreutils；docker/sshd/certbot 缺失时对应段落自动降级 |
| `audit-server.sh` | 服务 + 代码 + 数据体检：systemd user 服务/定时器、启动补丁链脚本可执行性、全量 js 语法、未定义调用扫描、关键补丁标记、配置项、sqlite 完整性、运行态 API、最近日志 | 部署完成后验收、出问题先跑一遍定位 | bash、python3、curl；`--check` 用部署自带的 node；需 systemd user 服务 |
| `backup-qq-agent-data.sh` | 停服务几秒 → 打包数据目录 → 重启 → 只留最近 KEEP 份 | 每周定时（配 `.timer`）；大改动前手动跑 | bash、`systemctl --user`、tar |
| `check-undefined-calls.sh` | 启动自检：扫描"调用了但没定义/没 import"的函数名，只记日志、不阻断启动 | 挂到服务的 `ExecStartPost`，或改完代码手动跑 | bash、python3 |
| `scan-undefined-calls.py` | 上面那个自检的实际扫描器；也支持 `--ignore=` 已知误报 | 本地/服务器上改完 `src/*.js` 后 | python3（无第三方依赖） |
| `sshcmd.py` | 通过 SSH 执行一条命令（不走 SFTP，sftp 子系统坏掉时也能用），支持 `--sudo`、多行/heredoc | 临时排查、跑一条命令 | python3 + paramiko |
| `sshrun.py` | 把脚本上传到 `/tmp` 再执行，彻底避免引号/换行转义问题；支持 `--file`、`--sudo`、stdin | 跑多行脚本、把本地脚本原样搬过去 | python3 + paramiko |
| `sshupload.py` | SFTP 上传文件（文本自动 CRLF 归一化，二进制原样），支持 `--chmod` 与多组 local/remote | 传补丁、配置、tar.gz/图片/sqlite | python3 + paramiko |
| `sshget.py` | SFTP 下载文件到本地 | 取日志、sqlite、备份回本地分析 | python3 + paramiko |
| `watch-login.py` | 每 15 秒轮询协议端 HTTP 端口，等到 QQ 登录成功就打印登录信息/控制台状态/最近日志 | 重启协议端容器或掉线重登后确认恢复 | python3 + paramiko；服务器上有 curl |
| `watch-send.py` | 盯 outbox（用 rowid 水位线），确认真实回话确实通过工具层发出、且没再出现未定义函数事故 | 修完发送链路后的线上验证 | python3 + paramiko |
| `qq-console.bat` | Windows 侧一键建 SSH 隧道（控制台/WebUI/远程桌面三个端口）并自动打开控制台，带 token 时免登录 | 日常打开控制台 | Windows + OpenSSH 客户端；可选 curl（没有则固定等 8 秒） |
| `export-face-names.sh` | 合并 SnowLuma 目录 / QQ 客户端配置 / 手工补充表，导出 `face-names.json` | QQ 加了新表情、表情名对不上时 | bash、docker、python3；协议端容器在跑 |
| `deploy_qq_agent.sh` | 非交互部署：设好模型凭据后直接跑 `deploy-all.sh -y` | 新机器初始化、CI/远程 SSH 里部署 | bash、docker、已 clone 的 deploy-all.sh |
| `guard-process-explosion.sh` | 用户进程数超过阈值时杀掉失控的 bash/grep 树并记录现场 | 配 `process-guard.timer` 每 10 分钟跑 | bash、python3 |
| `systemd/` | 两个 systemd user 单元示例：`qq-agent-backup.service/.timer`（每周日 04:10 备份）、`process-guard.service/.timer`（每 10 分钟看门狗） | 安装定时任务 | systemd（user 实例） |

## 环境变量约定

所有带默认值的路径都可以覆盖；默认值对应"部署根目录 /data/qq-agent"的标准布局。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_AGENT_DIR` | `/data/qq-agent` | 部署根目录 |
| `QQ_AGENT_APP_DIR` | `$QQ_AGENT_DIR/app` | 应用目录（`src/`、`ui/`、自带 `.runtime/node`） |
| `QQ_AGENT_DATA_DIR` | `$QQ_AGENT_DIR/data` | 数据目录（config.json、sqlite、sessions） |
| `QQ_AGENT_BACKUP_DIR` | `$HOME/qq-agent-backups` | 备份输出目录 |
| `QQ_AGENT_SERVICE` | `qq-agent-linux.service` | systemd user 服务名 |
| `QQ_AGENT_USER` | 当前登录用户 | 进程/定时任务检查的目标用户 |
| `QQ_AGENT_LOG` | `$HOME/qq-agent-undefined-calls.log` | 启动自检报告文件 |
| `QQ_AGENT_NODE` | 自动找 `$APP_DIR/.runtime/node-*/bin/node` | 运行应用的 node |
| `QQ_AGENT_CONSOLE_PORT` | `3210` | 控制台端口 |
| `QQ_AGENT_ONEBOT_HTTP_PORT` | `3390` | 协议端 HTTP 端口 |
| `QQ_AGENT_CONSOLE_TOKEN` | 无（未设置则跳过相关检查） | 控制台 API token |
| `QQ_AGENT_ONEBOT_TOKEN` | 无（未设置则跳过相关检查） | 协议端 access token |
| `SSHHOST` | **必填**（缺失直接报错退出） | 服务器地址，例如 `SSHHOST=1.2.3.4` |
| `SSHUSER` / `SSHPASS` / `SSHPORT` | `ubuntu` / 无（必填） / `22` | SSH 登录信息 |

安全约定：token/口令只从环境变量或配置文件读取，不要写进脚本或提交到仓库。

## 快速开始

```bash
# 1) 体检（先确认主机层没问题，再看服务层）
bash ops/audit-host.sh
QQ_AGENT_CONSOLE_TOKEN=xxx QQ_AGENT_ONEBOT_TOKEN=yyy bash ops/audit-server.sh

# 2) 远程执行（SSH 相关工具都要求显式给 SSHHOST）
SSHHOST=1.2.3.4 SSHPASS=... python ops/sshrun.py --file ops/audit-server.sh

# 3) 安装定时任务（路径按实际部署位置改过再启）
cp ops/systemd/*.service ops/systemd/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qq-agent-backup.timer process-guard.timer
```

## 依赖安装（SSH 工具）

```bash
python3 -m pip install paramiko
```

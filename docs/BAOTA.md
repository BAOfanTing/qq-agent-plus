# 宝塔面板部署

宝塔（含 aaPanel）不改变部署方式：底层仍是同一套 systemd 与包管理器，`deploy.sh` /
`deploy-all.sh` 原样可用。差异全在**宝塔默认以 root 操作、并希望由面板托管进程**这套习惯上。
本文只讲这些差异；通用步骤、数据与备份说明见 [LINUX.md](LINUX.md)。

## 结论：宝塔只当面板，进程仍交给 systemd

三件不要做的事：

1. **不要**用宝塔的「Node 项目」/ PM2 启动本项目；
2. **不要**在宝塔「计划任务」里再建更新任务；
3. **不要**以 root 部署。

原因在于项目注册的是 **systemd 用户服务**（`scripts/install-service.mjs` 写
`~/.config/systemd/user/qq-agent-linux.service`，`WantedBy=default.target`），运维入口
`manage.sh` 硬编码 `systemctl --user` / `journalctl --user`（`scripts/manage.mjs:11,31`），
自动更新是配套的 user timer。改用 PM2 会绕过：部署前代码快照与失败回滚、健康检查、
unit 里的 `Restart=on-failure` 与 `NoNewPrivileges`、以及 Release 驱动的自动更新。
另外 `deploy-all.sh:379` 明确拒绝 root，`docs/LINUX.md:121` 也要求以服务用户身份部署。

## 差异速查

| 项目的假设 | 宝塔的默认 | 处理 |
| --- | --- | --- |
| 以非 root 服务用户部署 | 全程 root | 建 `qqagent` 用户，SSH 进去跑脚本 |
| `systemctl --user` 可用 | 网页终端常不是登录会话 | 改用 SSH；或见文末「直接用 root」 |
| 依赖 `rsync`（硬检查）、`xz`（解压 Node） | 精简模板常缺 | 先 `apt install` |
| 脚本不动防火墙，只绑定 `127.0.0.1` | 面板「安全」页管 ufw/iptables | 默认走 SSH 隧道，一个端口都不用放 |
| 根目录默认 `/mnt/data/qq-agent` | 该路径常不存在 | 用 `--root-dir` 改，优先选 `.bat` 认得的路径 |
| 缺 Node 时脚本自己下载并校验 22.23.2 | 面板 Node 管理器版本可能偏低 | 不要用面板的 Node 管理器 |

## 一、前置检查

```bash
systemctl --user show-environment >/dev/null 2>&1 \
  && echo "systemd 用户服务：可用" \
  || echo "systemd 用户服务：不可用（别在宝塔网页终端跑，改用 SSH 登录）"

for c in rsync curl tar xz sha256sum; do
  command -v "$c" >/dev/null && echo "OK  $c" || echo "缺  $c"
done
```

`deploy.sh:73-75` 在动手之前就要求 `systemctl`、`systemctl --user` 和 `rsync` 三者可用；
`sleep` 之类不算，`rsync` 缺失会直接退出，**脚本不会替你安装系统包**。全栈安装额外需要
`realpath` 和 `ss`（iproute2）。

端口方面，默认 `3210` 控制台、`5099` SnowLuma WebUI、`6081` noVNC，OneBot `3000`/`3001`
只绑定 `127.0.0.1`。确认这四个（除 localhost 那两个外）没有被宝塔的其它服务占用——
面板自身默认 `8888`，网站 `80/443`，MySQL `3306`，一般不会冲突。

## 二、建服务用户并开启 linger（root 执行一次）

```bash
# Debian / Ubuntu
adduser --disabled-password --gecos "" qqagent
# CentOS / Rocky / AlmaLinux
useradd -m -s /bin/bash qqagent

mkdir -p /mnt/data/qq-agent
chown -R qqagent:qqagent /mnt/data/qq-agent
loginctl enable-linger qqagent
```

linger 是"开机免登录也能常驻"的前提。预先在这里开好还有个好处：`deploy.sh:312-313`
只在 linger 未开启时才尝试 `sudo loginctl enable-linger`，提前开好就完全不需要 `sudo`。

父目录也要在这里建：`deploy.sh` 会自己 `mkdir -p` 安装目录和数据目录，但 `/mnt` 归 root，
以 `qqagent` 身份跑时连 `data` 这一级都建不出来（`docs/LINUX.md:121` 说的"先以合适的属主
创建父目录"就是这个意思）。

把 `console-tunnel.bat` 用的那把 SSH 公钥也装给 `qqagent`（`~qqagent/.ssh/authorized_keys`），
隧道要用它登录。

## 三、装系统依赖

```bash
apt update && apt install -y rsync curl tar xz-utils
```

`xz-utils` 不是可选项：脚本下载的 Node 压缩包是 `.tar.xz`，用 `tar -xJf` 解压，缺 `xz`
会在这里失败。

## 四、部署 QQ Agent（以 qqagent 身份）

```bash
su - qqagent          # 或 ssh qqagent@你的服务器
git clone https://github.com/sakurawwwxh/qq-agent-plus.git ~/qq-agent-plus
cd ~/qq-agent-plus

bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir    /mnt/data/qq-agent/data \
  --host 127.0.0.1 --port 3210
```

几个要点：

- **目录**：`/mnt/data/qq-agent` 与 `/data/qq-agent` 是 `console-tunnel.bat:46` 会去读令牌的两个
  路径，优先选它们；机器上这两个挂载点都不存在时再换别的绝对路径（如 `/opt/qq-agent`）。
  路径不能有空格、`%` 或引号，SQLite 必须放在本机盘，不能用 NFS/SMB。别放进 `/www/wwwroot`，
  那是宝塔的站点目录，会被网站备份/防篡改逻辑一起扫到。
- **`--host 127.0.0.1` 保持默认**：控制台不对外，访问走下一节的隧道。用同机 nginx 反代时
  目标也是 `127.0.0.1`，同样不用对外开放。
- **Node 不用你装**：找不到合格的 Node 时脚本会下载并校验 `22.23.2` 到 `INSTALL_DIR/.runtime`。
  要求是 ≥22.13 且 `node:sqlite` 可用（`package.json` 的 `engines`）。
- 首次安装以 `observe` 模式启动，机器人不会发言；确认后再激活。
- 服务器连不上 GitHub 时，把 Release 源码包上传解压，在解压出的目录里执行同一条 `deploy.sh`。
  自动更新依赖 GitHub，不通时会保留现状并在控制台说明原因。

## 五、访问控制台：宝塔下其实一个端口都不用开

与裸机一致，仓库推荐的入口是 SSH 隧道（[AGENTS.md](../AGENTS.md) 的口径：不要求服务器开放
任何公网端口）：

- **Windows**：仓库根目录 `console-tunnel.bat`，双击后输入 `qqagent@你的IP`；
  或命令行 `console-tunnel.bat qqagent@你的IP`（写进 `.console-tunnel.cfg`，下次直接双击）。
- **macOS / Linux / 本机有 Node**：`SSHHOST=qqagent@你的IP node src/ops.js console --open`。
- **手工**：

  ```bash
  ssh -L 3210:127.0.0.1:3210 -L 5099:127.0.0.1:5099 -L 6081:127.0.0.1:6081 qqagent@你的IP
  ```

  然后访问 `http://127.0.0.1:3210`。扫码登录 QQ 走 `6081`，**不要**把 noVNC 暴露到公网。

**换过目录的坑**：`console-tunnel.bat:46` 只在
`/mnt/data/qq-agent/data/console-access.txt` 和 `/data/qq-agent/data/console-access.txt`
两处找令牌。装到别的路径时隧道照样能用，但不会免登录，手动取令牌即可：

```bash
cat /你的根目录/data/console-access.txt      # 看 Token 那一行
bash /你的根目录/app/manage.sh token         # 等价
```

或在客户端设 `QQ_AGENT_CONSOLE_TOKEN=<令牌>`。另外 `.bat` 用密钥登录（`BatchMode=yes`），
读取令牌的账号要能读 `data/`（权限 `0600`，属 `qqagent`），所以隧道账号用 `qqagent`
或 root 最省事。

### 想用域名 / HTTPS：宝塔反向代理

在「网站 → 反代」把目标设为 `http://127.0.0.1:3210`，**并把缓存关掉**。控制台的事件流是
SSE（`src/console/app.js:1127`，前端 `ui/app.js:1383` 的 `EventSource`），宝塔生成的 nginx
配置默认开启 `proxy_buffering`，会让页面看着像卡住。在反代配置里补上：

```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

登录 cookie 带 `HttpOnly; SameSite=Strict`、没有 `Secure` 标志（`src/console/app.js:985`），
所以 HTTP 反代也能正常登录，上 HTTPS 也不受影响。首次访问用
`https://你的域名/?token=<令牌>` 即免登录，之后浏览器记住 30 天。反代一旦对公网开放，
控制台令牌就是唯一凭据，务必只给自己用。

## 六、全栈（SnowLuma / OneBot / Docker）

`deploy-all.sh` 拒绝 root，所以要按下面的顺序：

1. 先在宝塔「Docker」管理器里装好 Docker 与 Compose v2，省得脚本再用 apt 装第二套；
2. `usermod -aG docker qqagent`，然后**重新登录** `qqagent`（组变更要新会话才生效）；
3. 只读探一遍（非交互、不改任何东西）：

   ```bash
   bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
   ```

4. 正式安装（需要 TTY，SSH 或宝塔网页终端都行，但必须是 `qqagent` 身份）：

   ```bash
   bash deploy-all.sh --root-dir /mnt/data/qq-agent \
     --agent-port 3210 --snowluma-port 5099 --novnc-port 6081 \
     --model-base-url https://api.deepseek.com \
     --model-api-key "$DEEPSEEK_API_KEY" --model deepseek-chat \
     --allow-groups 123456789
   ```

5. 走 `6081` 隧道打开 noVNC 扫码登录 QQ，回到终端按 Enter，再按提示激活：

   ```bash
   /mnt/data/qq-agent/app/manage.sh activate --confirm-exclusive
   ```

`--yes` 无人值守模式必须显式给模型参数（或 `--skip-model-config`）；白名单留空等于默认不
响应任何会话。用宝塔 Docker 管理器装的 Docker 能被复用，SnowLuma 容器也会出现在面板的
容器列表里，但**不要**用面板改它的端口或挂载——下次 `deploy-all.sh` 的归属校验会因此报错
退出（见 [LINUX.md](LINUX.md) 的 Existing Environment Protection）。

## 七、运维与自动更新

```bash
cd /mnt/data/qq-agent/app
bash manage.sh status        # 或 logs / health / token / restart / observe
bash manage.sh backup /path/to/backup-dir
```

这些都走 `systemctl --user`（`scripts/manage.mjs:11,31`），**必须在 `qqagent` 的登录会话里执行**。
在 root 下直接跑，它查的是 root 自己的 user manager，会报"服务不存在"——而服务其实正常运行，
这点很容易误判。

自动更新用项目自带的 GitHub Release timer（控制台「控制 → 更新部署」配置管理员后可开启），
**不要**在宝塔「计划任务」里再建一遍。宝塔「文件」管理器以 root 读取 `data/` 没有问题，
但不要用面板改动这些文件的属主，否则服务用户可能读不到自己的数据。

## 八、常见报错对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Failed to connect to bus` / 提到 `XDG_RUNTIME_DIR` | 在非登录会话（宝塔网页终端）里调用了 `systemctl --user` | 改用 SSH 登录；或文末的 root 方案 |
| `deploy.sh` 刚开始就退出、几乎没输出 | `deploy.sh:73-75` 的 `systemctl --user` / `rsync` 检查未通过 | 装 `rsync`，并换成 SSH 登录会话 |
| `Run as the service user, not root` | `deploy-all.sh:379` | `su - qqagent` 后重跑 |
| 解压 Node 失败、提示 `xz` | 缺 `xz-utils` | `apt install -y xz-utils` |
| 控制台打开正常但数据不刷新 | 反代缓冲了 SSE | 反代配置加 `proxy_buffering off;` |
| 机器人不回复 | 仍在 `observe` 模式，或白名单为空 | `manage.sh activate --confirm-exclusive`，并在控制台配置白名单 |
| `manage.sh` 说服务不存在，但进程在跑 | 用 root 执行，查的是 root 的 user manager | 换成 `qqagent` 身份执行 |
| 隧道通了但要手动登录 | 换过安装目录，`.bat` 找不到令牌 | 手动取令牌，或设 `QQ_AGENT_CONSOLE_TOKEN` |
| 全栈安装中途退出并提示已有非受管安装 | 目录里有不属于本安装器的数据或容器 | 不要删数据或伪造元数据绕过；按提示用 `deploy.sh` 更新或先人工确认残留状态 |

## 九、备选：直接用 root 部署（不推荐）

有些机器上确实没有第二个可用账号，此时：

```bash
apt install -y rsync curl tar xz-utils
loginctl enable-linger root
export XDG_RUNTIME_DIR=/run/user/0          # 每次新开 shell 都要设，否则 manage.sh 找不到服务

cd /root/qq-agent-plus
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir    /mnt/data/qq-agent/data \
  --host 127.0.0.1 --port 3210
```

代价：机器人以 root 身份常驻（unit 里的 `NoNewPrivileges`、`UMask=0077` 仍在，但进程身份是
root）；而且 `deploy-all.sh` 依然拒绝 root，所以**全栈模式没有这个选项**，只能以非 root
用户安装。能用独立服务用户时，请用前面第四节的写法。

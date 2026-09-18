#!/bin/bash
# 云主机全面自检（只读：不改配置、不停服务、不写业务数据）。
#
# 用途：接手一台跑了本项目的 Linux 主机时，先跑一遍，确认系统层面没有坑
#       （失败单元、磁盘/日志膨胀、容器重启、防火墙、证书、备份等）。
# 用法：
#   bash ops/audit-host.sh
#   QQ_AGENT_DIR=/mnt/data/qq-agent QQ_AGENT_USER=ubuntu bash ops/audit-host.sh
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_DIR       部署根目录（/data/qq-agent）
#   QQ_AGENT_DATA_DIR  数据目录（$QQ_AGENT_DIR/data）
#   QQ_AGENT_USER      运行本项目的系统用户（当前登录用户），用于进程/定时任务检查
set -u
APP_DIR="${QQ_AGENT_DIR:-/data/qq-agent}"
DATA_DIR="${QQ_AGENT_DATA_DIR:-$APP_DIR/data}"
APP_USER="${QQ_AGENT_USER:-$(id -un)}"
warn=0
ok()  { echo "  [正常] $1"; }
bad() { echo "  [注意] $1"; warn=$((warn+1)); }
info() { echo "  [信息] $1"; }

echo "════════ A. 系统基础 ════════"
info "内核 $(uname -r) ｜ $(grep PRETTY_NAME /etc/os-release | cut -d'"' -f2)"
info "开机于 $(uptime -s 2>/dev/null)，已运行 $(uptime -p | sed 's/up //')"
timedatectl 2>/dev/null | grep -E 'Time zone|synchronized' | sed 's/^/  /'
echo "  重启需求: $( [ -f /var/run/reboot-required ] && echo '需要重启（有内核/安全更新生效前）' || echo '无' )"

echo "════════ B. systemd 失败单元 ════════"
f=$(systemctl --failed --no-pager --no-legend 2>/dev/null | wc -l)
echo "  系统级失败单元: $f $( [ "$f" != 0 ] && systemctl --failed --no-pager --no-legend | head -5 )"
[ "$f" = 0 ] && ok "没有失败的系统服务"

echo "════════ C. 资源 ════════"
free -m | awk '/^Mem:/{printf "  内存 %dM/%dM（可用 %dM）\n", $3, $2, $7} /^Swap:/{printf "  交换 %dM/%dM\n", $3, $2}'
echo "  负载 $(uptime | sed 's/.*load average/load/')"
ps -eo rss,comm --sort=-rss 2>/dev/null | awk 'NR<=6 && $1>0 {printf "  内存Top: %-22s %dM\n", $2, $1/1024}'

echo "════════ D. 磁盘卫生 ════════"
df -h / | awk 'NR==2{printf "  根盘 %s 已用 %s (%s，剩 %s)\n", $2, $3, $5, $4}'
echo "  journald 日志占用: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[GM]')"
echo "  /var/log 大小: $(du -sh /var/log 2>/dev/null | cut -f1)  /var/cache/apt: $(du -sh /var/cache/apt 2>/dev/null | cut -f1)"
echo "  docker 总占用:"; docker system df 2>/dev/null | sed 's/^/    /'
echo "  已安装内核: $(dpkg -l 2>/dev/null | grep -c 'linux-image-[0-9]') 个"
big=$(du -sh /var/log/* 2>/dev/null | sort -rh | head -3 | tr '\n' ' ')
echo "  /var/log 大头: $big"

echo "════════ E. Docker 容器 ════════"
docker ps -a --format '{{.Names}}|{{.Status}}' | while IFS='|' read -r n s; do
  case "$s" in Up*) echo "  [正常] $n ($s)";; *) echo "  [注意] $n ($s)";; esac
done
for c in $(docker ps --format '{{.Names}}'); do
  rc=$(docker inspect -f '{{.RestartCount}} {{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null)
  echo "    $c: 重启${rc%% *}次 / 策略${rc#* }"
done

echo "════════ F. 监听端口（本机视角）════════"
ss -lntp 2>/dev/null | awk 'NR>1 {print "  "$4"  <-  "$6}' | grep -vE '127.0.0.1|\[::1\]' | sort -u | head -20
echo "  （以上为对 0.0.0.0/[::] 监听的端口；仅 127.0.0.1 的已略）"

echo "════════ G. SSH 与登录安全 ════════"
sshd -T 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin|port) ' | sed 's/^/  /' \
  || echo "  （读 sshd 生效配置需要 root，本次略过）"
echo "  今天失败的 SSH 认证次数: $(grep -c 'Failed password\|Invalid user' /var/log/auth.log 2>/dev/null || echo n/a)"
last -n 5 -w 2>/dev/null | head -6 | sed 's/^/  /'
echo "  可登录的用户: $(grep -E 'bash|sh$' /etc/passwd | cut -d: -f1 | tr '\n' ' ')"
echo "  $APP_USER 的 sudo 组成员: $(groups "$APP_USER" 2>/dev/null | sed 's/.*: //')"
echo "  fail2ban: $(command -v fail2ban-client >/dev/null && fail2ban-client status 2>/dev/null | head -2 || echo '未安装')"

echo "════════ H. 防火墙 ════════"
echo "  ufw: $(ufw status 2>/dev/null | head -1)"
iptables -S 2>/dev/null | head -5 | sed 's/^/  /'

echo "════════ I. 定时任务 ════════"
echo "  root crontab: $(( $(crontab -l -u root 2>/dev/null | grep -c '^[^#]') )) 条"
echo "  $APP_USER crontab: $(( $(crontab -l 2>/dev/null | grep -c '^[^#]') )) 条"
echo "  系统 timer: $(systemctl list-timers --no-pager --no-legend 2>/dev/null | awk '{print $NF}' | tr '\n' ' ')"

echo "════════ J. 系统更新 ════════"
echo "  可升级包: $(apt list --upgradable 2>/dev/null | grep -c upgradable) 个（安全更新用 apt 注意评估）"
echo "  unattended-upgrades: $(systemctl is-active unattended-upgrades 2>/dev/null || echo 未启用)"

echo "════════ K. TLS 证书 ════════"
if command -v certbot >/dev/null 2>&1; then certbot certificates 2>/dev/null | grep -E 'Certificate Name|Expiry' | sed 's/^/  /'; fi
for c in /etc/letsencrypt/live/*/fullchain.pem; do
  [ -f "$c" ] || continue
  d=$(openssl x509 -enddate -noout -in "$c" 2>/dev/null | cut -d= -f2)
  echo "  $(dirname $c | xargs basename): 到期 $d"
done

echo "════════ L. 备份状况 ════════"
echo "  $DATA_DIR 下的 .bak* 现场备份: $(ls "$DATA_DIR"/*.bak* 2>/dev/null | wc -l) 个（补丁过程的现场备份，不是定时备份）"
echo "  有无定时备份任务: $(grep -rE 'backup|rsync|tar' /etc/cron* /var/spool/cron 2>/dev/null | grep -cv '^#' || echo 0) 条"

echo
echo "════════ 结论 ════════"
echo "  需要注意的事项: $warn 项（见上面 [注意] 行）"

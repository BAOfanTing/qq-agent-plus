#!/usr/bin/env bash
# 把本机的 qq-agent 数据备份包推送到异地（rclone 远端，如腾讯云 COS）。
#
# 为什么需要它：qq-agent-backup.timer 的备份包只躺在同一块盘上，
# 盘坏 = 本地备份一起没。本脚本把 ~/qq-agent/backups/ 下的包再推一份到远端。
#
# 一次性配置（详见 docs/OPS.md 的"备份出机"一节）：
#   1. 安装 rclone 并配置一个远端：rclone config（腾讯云 COS 选 s3 兼容模板）
#   2. 写配置文件 ~/qq-agent/tools/offsite.conf：
#        RCLONE_REMOTE="my-cos:qq-agent-backups"
#   3. 安装定时器（每周日 05:10，紧跟本地 04:10 备份之后）：
#        mkdir -p ~/.config/systemd/user
#        cp scripts/systemd/qq-agent-backup-offsite.* ~/.config/systemd/user/
#        systemctl --user daemon-reload
#        systemctl --user enable --now qq-agent-backup-offsite.timer
#
# 未配置时（没有 offsite.conf 或远端不可用）本脚本写一行日志后安静退出，
# 不算故障——这样定时器可以先装上，凭证到位后自动生效。
set -u

BACKUP_DIR="${QQ_AGENT_BACKUP_DIR:-$HOME/qq-agent/backups}"
CONF="${QQ_AGENT_OFFSITE_CONF:-$HOME/qq-agent/tools/offsite.conf}"
LOG="$BACKUP_DIR/offsite.log"
KEEP_REMOTE="${QQ_AGENT_OFFSITE_KEEP:-8}"

mkdir -p "$BACKUP_DIR"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "跳过：rclone 未安装（安装并配置 offsite.conf 后自动生效）"
  exit 0
fi
if [ ! -f "$CONF" ]; then
  log "跳过：未找到 $CONF（备份出机尚未配置）"
  exit 0
fi
# shellcheck disable=SC1090
. "$CONF"
if [ -z "${RCLONE_REMOTE:-}" ]; then
  log "跳过：$CONF 里没有 RCLONE_REMOTE"
  exit 0
fi
if ! rclone lsd "${RCLONE_REMOTE%%:*}:" >/dev/null 2>&1; then
  log "跳过：远端 $RCLONE_REMOTE 不可达（检查 rclone 配置/网络）"
  exit 0
fi

shopt -s nullglob
files=("$BACKUP_DIR"/qq-agent-data-*.tar.gz)
if [ ${#files[@]} -eq 0 ]; then
  log "跳过：$BACKUP_DIR 下没有备份包"
  exit 0
fi

# 只推本地存在、远端还没有（或体积不同）的包
pushed=0
for f in "${files[@]}"; do
  name=$(basename "$f")
  local_size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  remote_size=$(rclone lsl "$RCLONE_REMOTE" 2>/dev/null | awk -v n="$name" '$4==n {print $1}' | head -1)
  if [ "${remote_size:-0}" = "$local_size" ] && [ "$local_size" != "0" ]; then
    continue
  fi
  if rclone copy "$f" "$RCLONE_REMOTE" --transfers 2 --checkers 4 >/dev/null 2>&1; then
    log "已上传 $name ($local_size 字节) → $RCLONE_REMOTE"
    pushed=$((pushed + 1))
  else
    log "上传失败 $name（网络或凭证问题，下次再试）"
  fi
done
[ "$pushed" -eq 0 ] && log "远端已是最新（检查了 ${#files[@]} 个包）"

# 远端只留最近 KEEP_REMOTE 份，按修改时间从新到旧
rclone lsl "$RCLONE_REMOTE" 2>/dev/null | sort -k2,3r | awk -v keep="$KEEP_REMOTE" 'NR>keep {print $4}' |
while IFS= read -r old; do
  [ -n "$old" ] || continue
  if rclone deletefile "$RCLONE_REMOTE/$old" >/dev/null 2>&1; then
    log "远端已清理旧备份 $old（保留最近 $KEEP_REMOTE 份）"
  fi
done
exit 0

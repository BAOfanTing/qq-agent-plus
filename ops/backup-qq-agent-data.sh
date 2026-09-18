#!/bin/bash
# 每周备份数据目录（机器人全部状态：配置 / 会话 / 表情库 / 记忆 / sqlite）。
#
# 用途：定时（或手动）把 DATA_DIR 打包留档。做法：停 app 几秒（QQ 客户端容器不受影响，
#       恢复后补课机制会接上漏掉的消息）→ tar.gz → 重启 → 只留最近 KEEP 份。
# 用法：
#   bash ops/backup-qq-agent-data.sh
#   QQ_AGENT_DIR=/mnt/data/qq-agent QQ_AGENT_BACKUP_DIR=/mnt/backup bash ops/backup-qq-agent-data.sh
# 定时：配合 ops/systemd/qq-agent-backup.service + .timer（示例为每周日 04:10）。
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_DIR        部署根目录（/data/qq-agent）
#   QQ_AGENT_DATA_DIR   数据目录（$QQ_AGENT_DIR/data）
#   QQ_AGENT_BACKUP_DIR 备份输出目录（$HOME/qq-agent-backups）
#   QQ_AGENT_SERVICE    systemd user 服务名（qq-agent-linux.service）
#   QQ_AGENT_KEEP       保留份数（4）
set -eu
DATA_DIR="${QQ_AGENT_DATA_DIR:-${QQ_AGENT_DIR:-/data/qq-agent}/data}"
DEST="${QQ_AGENT_BACKUP_DIR:-$HOME/qq-agent-backups}"
SERVICE="${QQ_AGENT_SERVICE:-qq-agent-linux.service}"
KEEP="${QQ_AGENT_KEEP:-4}"

mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/qq-agent-data-$STAMP.tar.gz"

echo "  源大小: $(du -sh "$DATA_DIR" | cut -f1)"
systemctl --user stop "$SERVICE"
sleep 2
# 无论 tar 成败都要把服务拉起来——备份失败可以下次再试，机器人停着才是事故。
tar_status=ok
tar czf "$OUT" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" || tar_status=failed
systemctl --user start "$SERVICE"
sleep 3
echo "  服务: $(systemctl --user is-active "$SERVICE")"
if [ "$tar_status" != ok ]; then
  echo "  !! tar 失败，本次备份作废（服务已恢复）"; rm -f "$OUT"; exit 1
fi
ls -1t "$DEST"/qq-agent-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "  备份完成: $(ls -lh "$OUT" | awk '{print $5, $9}')"
ls -1t "$DEST"/qq-agent-data-*.tar.gz | head -"$KEEP" | sed 's/^/    /'

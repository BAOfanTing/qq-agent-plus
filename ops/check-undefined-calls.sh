#!/bin/bash
# 启动自检：扫描 src/*.js 里"调用了、但本文件既没定义也没 import"的函数名。
#
# 用途：node --check 只查语法，查不出这类错；它在运行时报 ReferenceError，
#       而工具调用里的报错会被当成"发送失败"吞掉——normalizeMid 缺定义那次就是这样：
#       机器人整整一夜一个字都发不出去，表现像"静默 / 掉线"。
# 原则：只记录、永远 exit 0，绝不阻断服务启动；没发现问题时一句话都不写日志。
#
# 用法：
#   bash ops/check-undefined-calls.sh                      # 作为服务 ExecStartPost 一步
#   QQ_AGENT_DIR=/mnt/data/qq-agent bash ops/check-undefined-calls.sh
#   QQ_AGENT_LOG=/var/log/qq-agent-undefined.log bash ops/check-undefined-calls.sh
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_DIR   部署根目录（/data/qq-agent）
#   QQ_AGENT_SRC   源码目录（$QQ_AGENT_DIR/app/src）
#   QQ_AGENT_LOG   报告追加到的日志文件（$HOME/qq-agent-undefined-calls.log）
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${QQ_AGENT_DIR:-/data/qq-agent}"
SRC="${QQ_AGENT_SRC:-$APP_DIR/app/src}"
LOG="${QQ_AGENT_LOG:-$HOME/qq-agent-undefined-calls.log}"
SCAN="$SCRIPT_DIR/scan-undefined-calls.py"
# 已知误报（解构参数 / 动态 import / 全局对象），逐个确认过才会列在这里
IGNORE=Agent,Proxy,resolve,reject,task,fn,send,sleep,operation,isRetryable,random,resolveAtName,resolveReply,normalizeBehaviorProfile,getConfigFn,allowSource,fetchFn

report="$(python3 "$SCAN" "$SRC" --ignore="$IGNORE" 2>&1)"
count="$(printf '%s\n' "$report" | tail -n 1 | sed 's/.*: *//')"

if [ "$count" != "0" ]; then
  {
    echo "[$(date '+%F %T')] 启动自检发现可疑未定义调用（$count 处）"
    printf '%s\n' "$report" | grep -v '^$'
  } >> "$LOG"
  echo "自检：发现可疑未定义调用 $count 处，已记录到 $LOG"
fi
exit 0

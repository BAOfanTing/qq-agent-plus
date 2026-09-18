#!/bin/bash
# 非交互式一键部署（适合 CI / 远程 SSH 里跑 deploy-all.sh）。
#
# 用途：把「取源码 → 设模型凭据 → 跑 deploy-all.sh」这段固定流程写成非交互脚本，
#       部署目录、端口、协议端镜像全部参数化，不把任何凭据写进文件。
# 用法：
#   QQ_AGENT_SRC_DIR=~/qq-agent-src \
#   QQ_AGENT_MODEL_API_KEY=sk-xxx \
#   QQ_AGENT_MODEL_BASE_URL=https://your-gateway.example.com/v1 \
#   QQ_AGENT_MODEL=your-model \
#   bash ops/deploy_qq_agent.sh
#
# 凭据也可从文件读：QQ_AGENT_MODEL_KEY_FILE=/path/to/key（优先级低于环境变量）。
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_SRC_DIR        源码 checkout 目录（$HOME/qq-agent-src），需已含 deploy-all.sh
#   QQ_AGENT_ROOT_DIR       部署根目录（/data/qq-agent）
#   QQ_AGENT_MODEL_API_KEY  模型 API Key（必填，或改用 QQ_AGENT_MODEL_KEY_FILE）
#   QQ_AGENT_MODEL_KEY_FILE 存放 API Key 的文件（可选）
#   QQ_AGENT_MODEL_BASE_URL 模型网关地址（必填）
#   QQ_AGENT_MODEL          模型名（必填）
#   SNOWLUMA_IMAGE          协议端镜像（motricseven7/snowluma:v1.14.15）
#   QQ_AGENT_ONEBOT_HTTP_PORT / QQ_AGENT_ONEBOT_WS_PORT  协议端端口（3390 / 3391）
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export LANG="${LANG:-C.UTF-8}"

SRC="${QQ_AGENT_SRC_DIR:-$HOME/qq-agent-src}"
ROOT_DIR="${QQ_AGENT_ROOT_DIR:-/data/qq-agent}"
IMAGE="${SNOWLUMA_IMAGE:-motricseven7/snowluma:v1.14.15}"
OB_HTTP_PORT="${QQ_AGENT_ONEBOT_HTTP_PORT:-3390}"
OB_WS_PORT="${QQ_AGENT_ONEBOT_WS_PORT:-3391}"

KEY=""
if [ -n "${QQ_AGENT_MODEL_API_KEY:-}" ]; then
  KEY="$QQ_AGENT_MODEL_API_KEY"
elif [ -n "${QQ_AGENT_MODEL_KEY_FILE:-}" ]; then
  KEY="$(tr -d '\r\n' < "$QQ_AGENT_MODEL_KEY_FILE")"
else
  echo "缺少模型凭据：请设置 QQ_AGENT_MODEL_API_KEY（或 QQ_AGENT_MODEL_KEY_FILE）" >&2
  exit 1
fi
if [ -z "${QQ_AGENT_MODEL_BASE_URL:-}" ] || [ -z "${QQ_AGENT_MODEL:-}" ]; then
  echo "缺少 QQ_AGENT_MODEL_BASE_URL / QQ_AGENT_MODEL" >&2
  exit 1
fi

export QQ_AGENT_MODEL_API_KEY="$KEY"
export QQ_AGENT_MODEL_BASE_URL
export QQ_AGENT_MODEL

echo "当前用户: $(id -un)  分组含 docker: $(id -nG | grep -qw docker && echo yes || echo no)"
echo "可用内存: $(free -m | awk '/^Mem:/{print $7" MB"}')   磁盘可用: $(df -h / | awk 'NR==2{print $4}')"
echo

cd "$SRC"
bash deploy-all.sh -y \
  --root-dir "$ROOT_DIR" \
  --onebot-http-port "$OB_HTTP_PORT" \
  --onebot-ws-port "$OB_WS_PORT" \
  --image "$IMAGE"

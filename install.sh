#!/usr/bin/env bash
# 一键安装入口（"小白版"）：把能默认的都默认掉，全程零提问。
#
# 它只是 deploy-all.sh 的一层薄封装：
#   1) 用大白话做前置检查（别 root 跑、脚本要和整仓在一起）；
#   2) 以 --yes 调 deploy-all.sh（端口/目录/凭据全走默认，Docker 缺失时自动装）；
#   3) 模型配置默认跳过（留到网页控制台里配：有服务预设和连通性测试，比命令行好填）——
#      要现在就配就传 --model-base-url / --model-api-key / --model，或设同名环境变量；
#   4) 装完打印"接下来三步"（控制台一键登录链接、扫码登录入口、白名单），外加最常见的
#      排障提示。以前这些都要人去看文档，小白看不到就来报问题（2026-10-12）。
#
# 进阶用法照旧：交互式用 deploy-all.sh；本脚本接受并透传它的一切参数（--image-mirror、
# --root-dir、--image…），--help 也会转到 deploy-all.sh 的帮助。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_ALL="$SCRIPT_DIR/deploy-all.sh"

info() { printf '%s\n' "$*"; }
die() { printf '\n[一键安装] %s\n' "$*" >&2; exit 1; }

# ── 前置检查：全部给出"下一步怎么做"，别只报错 ──────────────────────────────
case "${BASH_VERSINFO[0]:-0}" in
  0|1|2|3) die "需要 bash 4 以上（当前 ${BASH_VERSION:-unknown}）。请用 bash install.sh 运行。" ;;
esac

if [[ "$(id -u)" == "0" ]]; then
  die '请不要用 root 运行：装出来的服务挂在当前用户名下，root 装完普通账号用不了。
  用你的普通账号（比如 ubuntu、debian）重新登录后再跑一次：
      bash install.sh
  （脚本只在装 Docker、开 linger 时按需用 sudo，届时可能让你输一次密码。）'
fi

if [[ ! -f "$DEPLOY_ALL" ]]; then
  die "找不到同目录的 deploy-all.sh：$DEPLOY_ALL
  这个脚本要和整个项目放在一起跑，单独一个文件不行。克隆完整仓库后重试：
      git clone https://github.com/sakurawwwxh/qq-agent-plus.git
      cd qq-agent-plus
      bash install.sh"
fi

# ── 模型配置：显式给了就不跳过，否则留到控制台里配 ──────────────────────────
MODEL_REQUESTED=false
if [[ -n "${QQ_AGENT_MODEL_BASE_URL:-}${QQ_AGENT_MODEL_API_KEY:-}${QQ_AGENT_MODEL:-}" ]]; then
  MODEL_REQUESTED=true
fi
for arg in "$@"; do
  case "$arg" in
    --model-base-url|--model-api-key|--model) MODEL_REQUESTED=true ;;
  esac
done

ARGS=(--yes)
[[ "$MODEL_REQUESTED" == true ]] || ARGS+=(--skip-model-config)

info '== QQ Agent 一键安装 =='
info '接下来全自动完成：装 Docker → 拉协议端镜像 → 部署 QQ Agent → 生成凭据。'
info '全程不问问题；模型 Key 和群号装完在网页控制台里填（结束时会打印入口）。'
info ''

# 透传用户参数；放在内置 flag 之后，后出现的同名参数会覆盖前面的（与 deploy-all.sh 的解析顺序一致）。
# 输出同时落一份日志：失败时给出日志路径，成功时从日志里抠出凭据文件位置（不重复推导默认值）。
LOG_FILE="${TMPDIR:-/tmp}/qq-install-$(date +%Y%m%d-%H%M%S).log"
set +e
bash "$DEPLOY_ALL" "${ARGS[@]}" "$@" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}
set -e
if [[ "$status" -ne 0 ]]; then
  printf '\n[一键安装] 安装没有完成（退出码 %s），上面最后几行通常就是原因。\n' "$status" >&2
  printf '完整日志：%s\n' "$LOG_FILE" >&2
  printf '按提示处理好后重跑同一条命令即可（已装好的部分不会被重复安装）。\n' >&2
  exit "$status"
fi

# ── 装完的"接下来三步"：从凭据文件里取真实地址，别让新人去翻文档 ────────────
ACCESS_FILE="$(sed -n 's/^Credentials: *//p' "$LOG_FILE" 2>/dev/null | tail -n 1 || true)"
rm -f "$LOG_FILE"
if [[ -z "$ACCESS_FILE" || ! -f "$ACCESS_FILE" ]]; then
  ACCESS_FILE="${QQ_AGENT_STACK_DIR:-/mnt/data/qq-agent}/deployment-access.txt"
fi
read_field() {
  # 文件不存在/读不了时**安静地**给空串：清单会退回通用文案，不能因为读凭据失败就报错退出
  #（set -e + pipefail 下，裸 sed 失败会把整个脚本带走）。分隔符用 | ——键名里有斜杠
  #（"QQ login/noVNC"），用默认的 / 会把 s/// 表达式拆坏、静默匹配不到。
  { sed -n "s|^$1: *||p" "$ACCESS_FILE" 2>/dev/null || true; } | tail -n 1
}
CONSOLE_URL="$(read_field 'Agent console')"
CONSOLE_TOKEN="$(read_field 'Agent token')"
VNC_URL="$(read_field 'QQ login/noVNC')"
VNC_PASSWORD="$(read_field 'noVNC password')"
MODE="$(read_field 'Mode')"
ROOT_GUESS="$(dirname "$ACCESS_FILE")"

printf '\n============================================================\n'
printf '安装完成。接下来三步（都在浏览器里做）：\n\n'
if [[ -n "$CONSOLE_URL" ]]; then
  printf '① 打开控制台（链接已带登录令牌，点开即进）：\n     %s/?token=%s\n' "$CONSOLE_URL" "$CONSOLE_TOKEN"
  printf '   在「设置 → 模型 API」里选服务、填 Key、保存，点「测试连通性」通过即可。\n\n'
else
  printf '① 打开控制台，在「设置 → 模型 API」里填好模型（地址、Key、模型名）。\n'
  printf '   控制台地址与令牌见凭据文件：%s\n\n' "$ACCESS_FILE"
fi
if [[ -n "$VNC_URL" ]]; then
  printf '② 登录 QQ：打开 %s（密码：%s）→ 按页面提示扫码登录。\n' "$VNC_URL" "$VNC_PASSWORD"
else
  printf '② 扫码登录 QQ（登录入口与控制台在同一份凭据文件里）。\n'
fi
printf '   登录后回控制台首页，看到「OneBot 已连接」就对了。\n\n'
printf '③ 把要用它的群加进白名单：控制台「设置 → 聊天白名单」填群号并保存。\n'
if [[ "$MODE" == "observe" ]]; then
  printf '   （机器人默认「观察」模式只看不说话；确认没问题后在控制台首页把运行模式切到「启用」。）\n'
fi
printf '\n打不开上面的地址？云服务器需要在安全组放行这几个端口（TCP）：\n'
printf '   3210 控制台 / 5099 协议端后台 / 6081 扫码登录\n'
printf '   全套凭据也在：%s\n' "$ACCESS_FILE"
printf '\n出问题先看日志：\n   bash %s/app/manage.sh logs\n' "$ROOT_GUESS"
printf '============================================================\n'

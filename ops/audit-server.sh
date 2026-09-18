#!/bin/bash
# 服务器 + QQ Agent 全面自检（只读：不改配置、不重启服务、不写业务数据）。
#
# 用途：部署后或排查故障时的一次性体检，覆盖 11 个面：服务/定时器、启动补丁链、
#       源码语法、未定义调用扫描、关键补丁标记、配置、数据文件、运行态 API、
#       最近日志、主机资源、主机级更新定时器。
# 用法：
#   bash ops/audit-server.sh
#   QQ_AGENT_DIR=/mnt/data/qq-agent QQ_AGENT_CONSOLE_TOKEN=xxx bash ops/audit-server.sh
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_DIR            部署根目录（/data/qq-agent）
#   QQ_AGENT_DATA_DIR       数据目录（$QQ_AGENT_DIR/data）
#   QQ_AGENT_NODE           运行本项目的 node（$QQ_AGENT_DIR/app/.runtime/node-*/bin/node）
#   QQ_AGENT_SERVICE        systemd user 服务名（qq-agent-linux.service）
#   QQ_AGENT_UPDATE_TIMER   自动更新定时器名（qq-agent-linux-update.timer）
#   QQ_AGENT_GUARD_TIMER    进程看门狗定时器名（process-guard.timer）
#   QQ_AGENT_OVERRIDE_CONF  服务 override.conf 路径（~/.config/systemd/user/<service>.d/override.conf）
#   QQ_AGENT_CONSOLE_PORT   控制台端口（3210）
#   QQ_AGENT_ONEBOT_HTTP_PORT  协议端 HTTP 端口（3390）
#   QQ_AGENT_CONSOLE_TOKEN  控制台 API token，未设置则跳过运行态接口检查
#   QQ_AGENT_ONEBOT_TOKEN   协议端 access token，未设置则跳过 OneBot 直连检查
#
# 注意：token 一律从环境变量读，不要写进本文件。
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${QQ_AGENT_DIR:-/data/qq-agent}"
DATA_DIR="${QQ_AGENT_DATA_DIR:-$APP_DIR/data}"
APP="${QQ_AGENT_APP_DIR:-$APP_DIR/app}"
NODE="${QQ_AGENT_NODE:-$(ls -d "$APP"/.runtime/node-*/bin/node 2>/dev/null | head -1)}"
SERVICE="${QQ_AGENT_SERVICE:-qq-agent-linux.service}"
UPDATE_TIMER="${QQ_AGENT_UPDATE_TIMER:-qq-agent-linux-update.timer}"
GUARD_TIMER="${QQ_AGENT_GUARD_TIMER:-process-guard.timer}"
CONF="${QQ_AGENT_OVERRIDE_CONF:-$HOME/.config/systemd/user/${SERVICE}.d/override.conf}"
CONSOLE_PORT="${QQ_AGENT_CONSOLE_PORT:-3210}"
ONEBOT_PORT="${QQ_AGENT_ONEBOT_HTTP_PORT:-3390}"
TOK="${QQ_AGENT_CONSOLE_TOKEN:-}"
OB="${QQ_AGENT_ONEBOT_TOKEN:-}"
APP_USER="${QQ_AGENT_USER:-$(id -un)}"
ng=0
ok()  { echo "  OK  $1"; }
bad() { echo "  NG  $1"; ng=$((ng+1)); }

echo "===== 1. 服务与定时器 ====="
echo "  qq-agent 状态: $(systemctl --user is-active "$SERVICE") / 开机自启: $(systemctl --user is-enabled "$SERVICE" 2>&1)"
echo "  重启次数: $(systemctl --user show "$SERVICE" -p NRestarts --value)  启动时间: $(systemctl --user show "$SERVICE" -p ActiveEnterTimestamp --value)"
echo "  更新定时器（应为 disabled）: $(systemctl --user is-enabled "$UPDATE_TIMER" 2>&1)"
echo "  进程看门狗（应为 enabled）: $(systemctl --user is-enabled "$GUARD_TIMER" 2>&1)"
systemctl --user list-timers --all --no-pager 2>/dev/null | sed -n '1,6p' | sed 's/^/  /'

echo "===== 2. 启动补丁链完整性 ====="
n_scripts=$(grep -c '^ExecStartPost=' "$CONF" 2>/dev/null || echo 0)
miss=0
while read -r s; do
  [ -x "$s" ] || { echo "  NG  不可执行/缺失: $s"; miss=$((miss+1)); }
done < <(grep '^ExecStartPost=' "$CONF" 2>/dev/null | sed 's/^ExecStartPost=//')
echo "  注册脚本数: $n_scripts，不可用: $miss"
[ "$miss" = 0 ] && ok "补丁链引用的脚本都存在且可执行" || bad "有 $miss 个脚本不可用"

echo "===== 3. 源码语法（全部 js） ====="
badf=0
for f in "$APP"/src/*.js "$APP"/ui/*.js "$APP"/src/**/*.js; do
  [ -f "$f" ] || continue
  [ -n "$NODE" ] || { echo "  NG  找不到 node（设 QQ_AGENT_NODE）"; badf=$((badf+1)); break; }
  "$NODE" --check "$f" >/dev/null 2>&1 || { echo "  NG  语法错误: $f"; badf=$((badf+1)); }
done
[ "$badf" = 0 ] && ok "所有 js 文件语法通过（$(ls "$APP"/src/*.js 2>/dev/null | wc -l) 个 src + ui）" || bad "语法错误文件数: $badf"

echo "===== 4. 未定义调用扫描 ====="
scan=""
if [ -f "$SCRIPT_DIR/scan-undefined-calls.py" ]; then
  scan=$(python3 "$SCRIPT_DIR/scan-undefined-calls.py" "$APP/src" --ignore=Agent,Proxy,resolve,reject,task,fn,send,sleep,operation,isRetryable,random,resolveAtName,resolveReply,normalizeBehaviorProfile,getConfigFn,allowSource,fetchFn 2>&1)
else
  echo "  （未找到 $SCRIPT_DIR/scan-undefined-calls.py，跳过）"
fi

echo "===== 5. 关键补丁标记 ====="
check_marker() { # 名称 期望最少次数 文件 正则
  local name="$1" want="$2" file="$3" pat="$4" n
  n=$(grep -cE "$pat" "$file" 2>/dev/null || echo 0)
  if [ "$n" -ge "$want" ]; then ok "$name（$n）"; else bad "$name 期望≥$want 实际 $n（$file）"; fi
}
check_marker "normalizeMid 定义"        1 "$APP/src/tools-core.js" '^function normalizeMid\(value\)'
check_marker "normalizeMid 调用点"      3 "$APP/src/tools-core.js" 'replyToMessageId: normalizeMid\(args'
check_marker "store.findByMid 归一化"   1 "$APP/src/store.js"      'normalizeMid\(mid\)'
n_inline=$(grep -lE "import \{ resolveToolCalls \}" "$APP"/src/*.js 2>/dev/null | wc -l)
[ "$n_inline" -ge 5 ] && ok "内联工具兜底接入（$n_inline 个文件）" || bad "内联工具兜底接入 期望≥5 个文件，实际 $n_inline"
check_marker "贴纸同步防清空守卫"       1 "$APP/src/stickers.js"   'if \(!fetchedIds\.size\) return out'
check_marker "主动间隔守卫"             1 "$APP/src/orchestrator.js" 'minGapMs'
check_marker "主动判定落盘"             1 "$APP/src/orchestrator.js" 'writeProactiveLastAttempt\(nowTick\)'
check_marker "多窗口工具函数"           1 "$APP/src/orchestrator.js" 'function proactiveWindowState'
check_marker "补话安排"                 1 "$APP/src/orchestrator.js" 'maybeScheduleFollowUp\(chatKey'
check_marker "重连补课"                 2 "$APP/src/app.js"          'catchUpMissedMessages|scheduleCatchUp'
check_marker "空间互动失败退避"         2 "$APP/src/qzone-interactions.js" 'failStreak|backoff'
check_marker "发送网络级重试"           1 "$APP/src/sender.js"       'isTransient|transient'
check_marker "QQ表情标签"               1 "$APP/src/onebot.js"       'QQ表情'
check_marker "看图先读情绪"             1 "$APP/src/prompt.js"       '看图先读情绪'
check_marker "表情编号≠stickerId 提醒"  1 "$APP/src/prompt.js"       '别拿这个编号去 get_sticker_image'
check_marker "发言唯一通道提示"         1 "$APP/src/prompt.js"       '发言的唯一通道'
check_marker "收尾自检段"               2 "$APP/src/prompt.js"       '沉默就是零输出|每次结束前必读'
check_marker "多气泡鼓励"               1 "$APP/src/prompt.js"       '别把一轮压成一句点评'
check_marker "一轮说完"                 1 "$APP/src/prompt.js"       '有想法就一轮里说完'
check_marker "贴纸选图提示"             1 "$APP/src/stickers.js"     '选图很简单'
check_marker "审核拦截重试"             1 "$APP/src/llm.js"         '审核拦截整次请求'
check_marker "兜底模型接入"             1 "$APP/src/llm.js"         '改用兜底模型'
check_marker "人设·别当评委"            1 "$DATA_DIR/config.json"   '聊天是双向的，别当评委'
check_marker "闲聊带自己"               1 "$APP/src/prompt.js"       '把自己的那半句补上'
check_marker "表情清单常驻"             1 "$APP/src/prompt.js"       '表情清单常驻系统提示'

echo "===== 6. 配置 ====="
DATA="$DATA_DIR" python3 - <<'PY'
import json, os
base = os.environ['DATA']
d = json.load(open(os.path.join(base, 'config.json'), encoding='utf-8'))
p = d['proactive']
print('  主动开话题: enabled=%s 概率=%s 间隔=%.1f~%.1fh 窗口=%s 冷场=%d分钟' % (
    p['enabled'], p['probability'], p['checkIntervalMinMs']/3.6e6, p['checkIntervalMaxMs']/3.6e6,
    [(w['start'], w['end']) for w in p['activeHours']['windows']], p['idleThresholdMs']//60000))
print('  思考开关: %s' % json.dumps(d['api'].get('thinking'), ensure_ascii=False))
print('  自动更新: %s' % d['autoUpdate']['enabled'])
print('  时间控制: %s' % d['timeControl']['enabled'])
print('  节奏(pacing): %s' % d['pacing']['enabled'])
print('  空间互动: %s' % d['qzoneInteractions']['enabled'])
print('  说说/每日总结: %s' % d['dailyMoments']['enabled'])
print('  表情包: enabled=%s 积极度=%s 自动收藏=%s' % (d['sticker'].get('enabled'), d['sticker'].get('encourage'), d['sticker'].get('autoCollect')))
print('  模型: %s @ %s' % (d['api'].get('model'), d['api'].get('baseUrl')))
fb = d['api'].get('fallback') or {}
print('  兜底模型: %s' % (('%s @ %s' % (fb.get('model'), fb.get('baseUrl'))) if fb.get('model') and fb.get('enabled') is not False else '（未配置/已停用）'))
print('  白名单群/私聊: %s / %s' % (len(d.get('allow', {}).get('groups', []) or []), len(d.get('allow', {}).get('private', []) or [])))
PY
DATA="$DATA_DIR" python3 -c "import json,os;[json.load(open(os.path.join(os.environ['DATA'],f),encoding='utf-8')) for f in ['config.json']]" && ok "config.json 是合法 JSON"

echo "===== 7. 数据文件 ====="
DATA="$DATA_DIR" python3 - <<'PY'
import json, os, sqlite3
data = os.environ['DATA']
try:
    s = json.load(open(os.path.join(data, 'stickers.json'), encoding='utf-8'))
    items = s if isinstance(s, list) else s.get('items') or s.get('stickers') or []
    ids = [i.get('id') for i in items]
    print('  表情库: %d 条，重复 id: %d，有备注: %d' % (len(items), len(ids)-len(set(ids)), sum(1 for i in items if i.get('localNote'))))
except Exception as e:
    print('  !! stickers.json 读取失败:', e)
for f in ['messages.sqlite', 'incident-pilot.sqlite', 'identity-pilot.sqlite', 'relationship-pilot.sqlite']:
    p = os.path.join(data, f)
    if not os.path.exists(p):
        print('  （缺 %s）' % f); continue
    try:
        db = sqlite3.connect('file:%s?mode=ro' % p, uri=True)
        r = db.execute('pragma integrity_check').fetchone()[0]
        print('  %-26s integrity=%s' % (f, r))
    except Exception as e:
        print('  !! %s 打开失败: %s' % (f, e))
sess = os.path.join(data, 'sessions')
n = len(os.listdir(sess)) if os.path.isdir(sess) else 0
print('  会话文件: %d 个' % n)
PY

echo "===== 8. 运行态 ====="
if [ -n "$TOK" ]; then
  st=$(curl -s -m 6 "http://127.0.0.1:$CONSOLE_PORT/api/status?token=$TOK")
  echo "$st" | python3 -c "
import json,sys
d=json.load(sys.stdin)
o=d['onebot']; r=d['orchestrator']
print('  OneBot: connected=%s error=%r self=%s' % (o['connected'], o.get('error'), o.get('self',{}).get('userId')))
print('  编排器: paused=%s mode=%s 运行中=%s 并发上限=%s' % (r['paused'], r['mode'], r['running'], r['maxConcurrentRuns']))
print('  今日用量: %s tokens / %s 次运行' % (d['usage']['totalTokens'], d['usage']['runs']))
i=d['incidentPilot']['counts']
print('  告警: open=%s resolved=%s pendingNotify=%s' % (i['open'], i['resolved'], d['incidentPilot']['pendingNotifications']))
"
else
  echo "  （未设置 QQ_AGENT_CONSOLE_TOKEN，跳过控制台状态接口）"
fi
if [ -n "$OB" ]; then
  echo "  OneBot 直连: $(curl -s -m 6 -H "Authorization: Bearer $OB" http://127.0.0.1:$ONEBOT_PORT/get_status)"
else
  echo "  （未设置 QQ_AGENT_ONEBOT_TOKEN，跳过 OneBot 直连检查）"
fi
DATA="$DATA_DIR" python3 - <<'PY'
import os, sqlite3
db = sqlite3.connect('file:%s/messages.sqlite?mode=ro' % os.environ['DATA'], uri=True)
print('  待处理消息: %d 条' % db.execute("select count(*) from messages where state='pending'").fetchone()[0])
print('  未完成 run: %d 个' % db.execute("select count(*) from runs where state not in ('acked','failed')").fetchone()[0])
PY

echo "===== 9. 最近日志（6 小时，剔除 SQLite 实验性警告） ====="
journalctl --user -u "$SERVICE" --since '6 hours ago' --no-pager 2>/dev/null | grep -vE 'ExperimentalWarning|trace-warnings' | grep -iE 'error|fail|异常|失败|refus|crash' | tail -8 | sed 's/^/  /'
echo "  （以上是含 error/fail 的行，空=没有）"

echo "===== 10. 主机资源与容器 ====="
echo "  内存: $(free -m | awk '/^Mem:/{printf "总 %dM 用 %dM 可用 %dM", $2,$3,$7}')  交换: $(free -m | awk '/^Swap:/{printf "%dM/%dM", $3,$2}')"
echo "  磁盘 /: $(df -h / | awk 'NR==2{printf "%s 已用 %s (%s)", $2,$3,$5}')  数据盘: $(df -h "$DATA_DIR" | awk 'NR==2{printf "%s 已用 %s (%s)", $2,$3,$5}')"
echo "  负载: $(uptime | sed 's/.*load average/load/')"
echo "  $APP_USER 进程数: $(ps -u "$APP_USER" -o pid= | wc -l)"
docker ps --format '  {{.Names}} | {{.Status}} | {{.Ports}}' 2>/dev/null | sed 's/0.0.0.0:\([0-9]*\)->/0.0.0.0:\1->/g' | head -12
echo "  端口绑定（控制台 $CONSOLE_PORT 可能是唯一对外端口，其余应在 127.0.0.1）:"
ss -lntp 2>/dev/null | grep -E ":($CONSOLE_PORT|$ONEBOT_PORT|3391|5099|6081|5900)\b" | awk '{print "    "$4"  "$6}' | sort -u

echo "===== 11. 主机级自动更新定时器（可选） ====="
HOST_UPDATE_PATTERN="${QQ_AGENT_HOST_UPDATE_PATTERN:-hermes|unattended|update}"
systemctl list-timers --all --no-pager 2>/dev/null | grep -iE "$HOST_UPDATE_PATTERN" | sed 's/^/  /' || echo "  （未找到）"

echo
echo "===== 自检结论 ====="
[ "$ng" = 0 ] && echo "  全部通过（0 项异常）" || echo "  有 $ng 项异常，见上面 NG 行"
echo "  未定义调用扫描: $(printf '%s\n' "$scan" | tail -1)"

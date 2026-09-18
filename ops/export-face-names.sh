#!/bin/bash
# 重新导出 QQ 系统表情对照表（QQ/客户端加了新表情时重跑）。
#
# 用途：把三个来源合并成 data/face-names.json（onebot.js 的表情名补丁读它，改完要重启服务）：
#   1) SnowLuma 抓的目录 /app/data/data/sys-face-catalog.json（容器内路径）
#   2) QQ 客户端自带的 face_config.json（容器内路径，客户端版本更旧）
#   3) 手工补充文件 $QQ_AGENT_DATA_DIR/face-names-extra.json（两边都没有的新表情写这里，可覆盖）
# 用法：
#   bash ops/export-face-names.sh
#   QQ_AGENT_DATA_DIR=/mnt/data/qq-agent/data bash ops/export-face-names.sh
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_DATA_DIR            数据目录（${QQ_AGENT_DIR:-/data/qq-agent}/data）
#   QQ_AGENT_SNOWLUMA_CONTAINER  协议端容器名（qq-agent-snowluma）
set -u

DATA_DIR="${QQ_AGENT_DATA_DIR:-${QQ_AGENT_DIR:-/data/qq-agent}/data}"
CONTAINER="${QQ_AGENT_SNOWLUMA_CONTAINER:-qq-agent-snowluma}"
OUT="$DATA_DIR/face-names.json"

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
docker cp "$CONTAINER":/app/data/data/sys-face-catalog.json "$TMPD/sys-face.json" >/dev/null 2>&1 || {
  echo "导出失败：容器 $CONTAINER 未运行或文件不存在"; exit 1; }
docker cp "$CONTAINER":/app/.config/QQ/global/nt_data/Emoji/emoji-resource/face_config.json "$TMPD/qq-face.json" >/dev/null 2>&1 || true

TMPD="$TMPD" DATA_DIR="$DATA_DIR" OUT="$OUT" python3 - <<'PY'
import json, time, os

merged, src = {}, {}
data_dir = os.environ['DATA_DIR']
out = os.environ['OUT']

# 1) SnowLuma 目录
try:
    d = json.load(open(os.environ['TMPD'] + '/sys-face.json', encoding='utf-8'))
    for p in (d.get('packs') or []):
        for e in (p.get('emojis') or []):
            sid = str(e.get('qSid') or '').strip()
            name = str(e.get('qDes') or '').strip().lstrip('/')
            if sid and name:
                merged[sid] = name; src[sid] = 'catalog'
except Exception as e:
    print('目录读取失败:', e)

# 2) QQ 自带配置
try:
    d = json.load(open(os.environ['TMPD'] + '/qq-face.json', encoding='utf-8'))
    n = 0
    for e in (d.get('sysface') or []):
        sid = str(e.get('QSid') or '').strip()
        name = str(e.get('QDes') or '').strip().lstrip('/')
        if sid and name and sid not in merged:
            merged[sid] = name; src[sid] = 'qq'; n += 1
    print('QQ 配置新增 %d 条' % n)
except Exception as e:
    print('QQ 配置读取失败:', e)

# 3) 手工补充（优先级最高，可覆盖）
extra_path = os.path.join(data_dir, 'face-names-extra.json')
try:
    ex = json.load(open(extra_path, encoding='utf-8'))
    n = 0
    for sid, name in (ex.get('bySid') or {}).items():
        sid = str(sid).strip(); name = str(name).strip()
        if sid and name and merged.get(sid) != name:
            merged[sid] = name; src[sid] = 'manual'; n += 1
    print('手工补充应用 %d 条' % n)
except FileNotFoundError:
    print('（暂无手工补充表 %s）' % extra_path)
except Exception as e:
    print('手工补充表读取失败:', e)

json.dump({'bySid': merged, 'source': 'catalog+qq+manual', 'exportedAt': time.time()},
          open(out, 'w', encoding='utf-8'), ensure_ascii=False)
nums = sorted(int(k) for k in merged if k.isdigit())
print('已导出 %d 条 -> %s（编号范围 %s ~ %s）' % (len(merged), out, nums[0] if nums else '-', nums[-1] if nums else '-'))
PY

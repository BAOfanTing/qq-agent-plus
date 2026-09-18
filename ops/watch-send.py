#!/usr/bin/env python
"""盯住"修复后的发送链路"是否真的在线上生效。

用途：修完发送链路后的线上验证——只轮询、只读远端数据库，不改任何东西；
      退出码可直接被脚本判断（0 成功 / 1 失败 / 2 超时）。

背景：曾出现 tools-core.js 的 normalizeMid 缺定义导致 send_message 全挂的事故。
      单元测试过了，但还需要一次真实回话来收尾。

为什么盯 outbox：outbox 是工具层发送（send_message / send_sticker / send_face）唯一会写
字的地方；OneBot 直发（系统通知、人工自检消息）不会写这里。用 rowid 做水位线，
只认"基线之后新增的行"——早先两版分别栽在"消息表里自己发的自检消息"和"用 UUID 当水位线"
上，都误报过 SEND_OK。

用法：
  SSHHOST=1.2.3.4 SSHPASS=... python ops/watch-send.py [分钟数，默认 240]
退出码：0 = 工具层成功发出消息；1 = 发送失败 / 又出现未定义函数；2 = 超时。
环境变量：
  SSHHOST              必填，服务器地址（不设则直接报错退出）
  SSHUSER / SSHPASS    登录用户（默认 ubuntu）/ 登录密码（必填）
  QQ_AGENT_DATA_DIR    远端数据目录（默认 /data/qq-agent/data）
"""
import json
import os
import sys
import time

import paramiko

HOST = os.environ.get("SSHHOST")
USER = os.environ.get("SSHUSER", "ubuntu")
PASSWORD = os.environ.get("SSHPASS")
if not HOST:
    sys.exit("SSHHOST not set（请显式指定服务器地址，例如 SSHHOST=1.2.3.4）")
if not PASSWORD:
    sys.exit("SSHPASS not set")

MINUTES = int(sys.argv[1]) if len(sys.argv) > 1 else 240
DATA_DIR = os.environ.get("QQ_AGENT_DATA_DIR", "/data/qq-agent/data")
if any(c in DATA_DIR for c in "\"'\n\\"):
    sys.exit("QQ_AGENT_DATA_DIR 含引号/反斜杠等不安全字符")

REMOTE = r'''
python3 - <<'PY'
import sqlite3, json, os
DATA = __DATA_DIR__
out = {}
try:
    db = sqlite3.connect('file:%s/messages.sqlite?mode=ro' % DATA, uri=True)
    out['max_rowid'] = db.execute('select coalesce(max(rowid), 0) from outbox').fetchone()[0]
    rows = []
    for rid, run, chat, state, payload, err in db.execute(
            'select rowid, run_id, chat_key, state, payload, error from outbox order by rowid desc limit 6'):
        try:
            text = json.loads(payload).get('text', '') if payload else ''
        except Exception:
            text = (payload or '')[:60]
        rows.append({'rid': rid, 'run': run, 'chat': chat, 'state': state,
                     'text': str(text)[:80], 'error': err})
    out['rows'] = rows
    row = db.execute('select ts, text from messages where self=0 order by ts desc limit 1').fetchone()
    if row:
        out['last_human'] = {'ts': row[0], 'text': (row[1] or '')[:80]}
    out['pending'] = db.execute("select count(*) from messages where state='pending'").fetchone()[0]
except Exception as e:
    out['error'] = str(e)
try:
    idb = sqlite3.connect('file:%s/incident-pilot.sqlite?mode=ro' % DATA, uri=True)
    cols = [c[1] for c in idb.execute('pragma table_info(incidents)')]
    col = 'message' if 'message' in cols else ('msg' if 'msg' in cols else cols[0])
    rows = list(idb.execute('select %s, last_at from incidents where %s like "%%is not defined%%" order by last_at desc limit 2' % (col, col)))
    out['defined_incidents'] = [{'msg': (r[0] or '')[:90], 'at': r[1]} for r in rows]
except Exception as e:
    out['incident_error'] = str(e)
print(json.dumps(out, ensure_ascii=False))
PY
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=22, username=USER, password=PASSWORD,
               timeout=25, banner_timeout=25, auth_timeout=25,
               look_for_keys=False, allow_agent=False)
client.get_transport().set_keepalive(20)

remote_cmd = REMOTE.replace("__DATA_DIR__", repr(DATA_DIR))


def run(cmd, timeout=30):
    _in, out, _err = client.exec_command(cmd, timeout=timeout)
    return out.read().decode("utf-8", "replace").strip()


def stamp(ms):
    return time.strftime("%H:%M:%S", time.localtime(ms / 1000))


base = None
for attempt in range(3):
    try:
        base = json.loads(run(remote_cmd).splitlines()[-1])
        break
    except Exception as e:
        print("  （基线第 %d 次查询失败：%s，10 秒后重试）" % (attempt + 1, e))
        time.sleep(10)
if base is None:
    client.close()
    sys.exit("基线查询连续 3 次失败，脚本退出")
base_rid = base.get("max_rowid", 0)
base_incident_at = max([i.get("at", 0) for i in base.get("defined_incidents", [])] or [0])
print("基线：outbox 最新 rowid=%s，待处理消息 %s 条" % (base_rid, base.get("pending")))
print("      最近一条人类消息：%s" % (base.get("last_human") or {}).get("text", "-"))

deadline = time.time() + MINUTES * 60
while time.time() < deadline:
    time.sleep(30)
    try:
        info = json.loads(run(remote_cmd).splitlines()[-1])
    except Exception as e:
        print("  （本轮查询失败，跳过：%s）" % e)
        continue

    for inc in info.get("defined_incidents", []):
        if inc.get("at", 0) > base_incident_at:
            print("SEND_FAIL：又出现未定义函数事故 → %s（%s）" % (inc.get("msg"), stamp(inc["at"])))
            client.close()
            sys.exit(1)

    new = [r for r in info.get("rows", []) if r.get("rid", 0) > base_rid]
    for row in reversed(new):  # 按时间正序看
        if row.get("state") == "failed":
            print("SEND_FAIL：工具层发送失败 ｜ %s ｜ %s ｜ %s ｜ %s"
                  % (row.get("chat"), row.get("run"), row.get("text"), row.get("error")))
            client.close()
            sys.exit(1)
        if str(row.get("run")) in ("mix-test", "manual-face-test"):
            continue  # 控制台手工测试留下的行，不算
        print("SEND_OK：机器人通过工具层成功回话 ｜ %s ｜ run=%s ｜ state=%s ｜ %s"
              % (row.get("chat"), row.get("run"), row.get("state"), row.get("text")))
        print("      人类上一条：%s" % (info.get("last_human") or {}).get("text", "-"))
        client.close()
        sys.exit(0)

print("TIMEOUT：%d 分钟内没有通过工具层发过消息（没人跟它说话也属正常）" % MINUTES)
client.close()
sys.exit(2)

#!/usr/bin/env python
"""等待 QQ 客户端（SnowLuma 容器内）完成登录。

用途：重启容器 / 掉线重登后，用一条 SSH 连接每 15 秒轮询一次协议端 HTTP 端口；
      端口一旦应答（说明 QQ 已登录、hook 把 OneBot 服务拉起来了），打印登录信息、
      控制台状态和最近日志，一次确认恢复完成。
用法：
  SSHHOST=1.2.3.4 SSHPASS=... QQ_AGENT_ONEBOT_TOKEN=... python ops/watch-login.py [分钟数，默认 25]
退出码：0 = 已登录（打印 LOGIN_OK）；1 = 超时。
环境变量：
  SSHHOST                必填，服务器地址（不设则直接报错退出）
  SSHUSER / SSHPASS      登录用户（默认 ubuntu）/ 登录密码（必填）
  QQ_AGENT_ONEBOT_TOKEN  必填，协议端 access token
  QQ_AGENT_CONSOLE_TOKEN 可选，控制台 token（设了才打印控制台状态）
  QQ_AGENT_ONEBOT_HTTP_PORT / QQ_AGENT_CONSOLE_PORT / QQ_AGENT_SERVICE  见下默认值
"""
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

MINUTES = int(sys.argv[1]) if len(sys.argv) > 1 else 25
OB_PORT = os.environ.get("QQ_AGENT_ONEBOT_HTTP_PORT", "3390")
CONSOLE_PORT = os.environ.get("QQ_AGENT_CONSOLE_PORT", "3210")
SERVICE = os.environ.get("QQ_AGENT_SERVICE", "qq-agent-linux.service")
OB_TOKEN = os.environ.get("QQ_AGENT_ONEBOT_TOKEN")
CONSOLE_TOKEN = os.environ.get("QQ_AGENT_CONSOLE_TOKEN")
if not OB_TOKEN:
    sys.exit("QQ_AGENT_ONEBOT_TOKEN not set")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=22, username=USER, password=PASSWORD,
               timeout=25, banner_timeout=25, auth_timeout=25,
               look_for_keys=False, allow_agent=False)
client.get_transport().set_keepalive(20)


def run(cmd, timeout=25):
    _in, out, _err = client.exec_command(cmd, timeout=timeout)
    return out.read().decode("utf-8", "replace")


def onebot_up():
    return run("curl -s -m 4 -H 'Authorization: Bearer %s' http://127.0.0.1:%s/get_status" % (OB_TOKEN, OB_PORT))


deadline = time.time() + MINUTES * 60
tries = 0
while time.time() < deadline:
    tries += 1
    body = onebot_up()
    if "online" in body:
        print("LOGIN_OK（第 %d 次探测，约 %d 秒）" % (tries, tries * 15))
        print("get_status: " + body.strip()[:200])
        print("get_login_info: " + run(
            "curl -s -m 5 -H 'Authorization: Bearer %s' http://127.0.0.1:%s/get_login_info" % (OB_TOKEN, OB_PORT)).strip()[:300])
        if CONSOLE_TOKEN:
            print("console: " + run(
                "curl -s -m 5 'http://127.0.0.1:%s/api/status?token=%s'" % (CONSOLE_PORT, CONSOLE_TOKEN)).strip()[:400])
        print("--- journal ---")
        print(run("journalctl --user -u %s -n 12 --no-pager | tail -12" % SERVICE))
        client.close()
        sys.exit(0)
    time.sleep(15)

print("LOGIN_TIMEOUT（%d 分钟内没等到登录，二维码可能已过期）" % MINUTES)
client.close()
sys.exit(1)

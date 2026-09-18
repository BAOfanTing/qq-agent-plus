#!/usr/bin/env python
"""通过 SSH 从远端下载文件到本地（密码登录，SFTP）。

用途：把服务器上的日志 / sqlite / 备份 / 配置取回本地分析。
用法：
  SSHHOST=1.2.3.4 SSHPASS=... python ops/sshget.py /tmp/audit.log ./audit.log
  SSHHOST=... SSHPASS=... python ops/sshget.py /data/qq-agent/data/config.json ./config.json
环境变量：
  SSHHOST  必填，服务器地址（不设则直接报错退出）
  SSHUSER  登录用户（默认 ubuntu）
  SSHPASS  必填，登录密码
  SSHPORT  SSH 端口（默认 22）
"""
import os
import sys

import paramiko

HOST = os.environ.get("SSHHOST")
USER = os.environ.get("SSHUSER", "ubuntu")
PASSWORD = os.environ.get("SSHPASS")
PORT = int(os.environ.get("SSHPORT", "22"))

if not HOST:
    sys.exit("SSHHOST not set（请显式指定服务器地址，例如 SSHHOST=1.2.3.4）")
if not PASSWORD:
    sys.exit("SSHPASS not set")
pairs = sys.argv[1:]
if not pairs or len(pairs) % 2:
    sys.exit("用法: sshget.py <remote> <local> [<remote> <local> ...]")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
               timeout=25, banner_timeout=25, auth_timeout=25,
               look_for_keys=False, allow_agent=False)
sftp = client.open_sftp()
try:
    for i in range(0, len(pairs), 2):
        remote, local = pairs[i], pairs[i + 1]
        os.makedirs(os.path.dirname(os.path.abspath(local)), exist_ok=True)
        sftp.get(remote, local)
        print("  %s → %s (%d bytes)" % (remote, local, os.path.getsize(local)))
finally:
    sftp.close()
    client.close()

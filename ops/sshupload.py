#!/usr/bin/env python
"""通过 SSH 上传本地文件到远端（密码登录，SFTP）。

用途：把补丁脚本 / 配置 / 二进制（tar.gz、图片、sqlite）搬到服务器。
      文本文件自动归一化 CRLF；二进制（含 NUL 字节）原样上传。
用法：
  SSHHOST=1.2.3.4 SSHPASS=... python ops/sshupload.py local.sh /tmp/remote.sh
  SSHHOST=... SSHPASS=... python ops/sshupload.py --chmod 755 ops/audit-server.sh /tmp/audit.sh
  SSHHOST=... SSHPASS=... python ops/sshupload.py a.sh /tmp/a.sh b.tar.gz /tmp/b.tar.gz
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

args = sys.argv[1:]
mode = None
if args and args[0] == "--chmod":
    mode = int(args[1], 8)
    args = args[2:]
if len(args) % 2 != 0:
    sys.exit("need pairs: local remote [local remote ...]")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    HOST,
    port=PORT,
    username=USER,
    password=PASSWORD,
    timeout=25,
    banner_timeout=25,
    auth_timeout=25,
    look_for_keys=False,
    allow_agent=False,
)
sftp = client.open_sftp()
for i in range(0, len(args), 2):
    local, remote = args[i], args[i + 1]
    with open(local, "rb") as fh:
        data = fh.read()
    # CRLF 归一化只对文本文件做；二进制（tar.gz/图片/sqlite）里有 NUL 字节，
    # 盲替换会把文件改坏——传二进制时必须原样上传。
    if b"\x00" not in data[:8192]:
        data = data.replace(b"\r\n", b"\n")
    with sftp.open(remote, "wb") as fh:
        fh.write(data)
    if mode is not None:
        sftp.chmod(remote, mode)
    print("uploaded %s -> %s (%d bytes)" % (local, remote, len(data)))
sftp.close()
client.close()

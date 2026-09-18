#!/usr/bin/env python
"""通过 SSH 在远端执行一段 shell 脚本（密码登录）。

用途：把本地脚本原样搬到远端跑，彻底绕开 shell 引号/换行转义问题。
      脚本先经 SFTP 上传到 /tmp，再用 bash 执行，执行完删除。
用法：
  SSHHOST=1.2.3.4 SSHPASS=... python ops/sshrun.py "systemctl --user restart qq-agent-linux"
  SSHHOST=... SSHPASS=... python ops/sshrun.py --file ops/audit-server.sh
  SSHHOST=... SSHPASS=... python ops/sshrun.py --sudo --file local/fix.sh   # 以 root 跑
  cat local.sh | SSHHOST=... SSHPASS=... python ops/sshrun.py              # 从 stdin 读
环境变量：
  SSHHOST          必填，服务器地址（不设则直接报错退出）
  SSHUSER          登录用户（默认 ubuntu）
  SSHPASS          必填，登录密码
  SSHPORT          SSH 端口（默认 22）
  SSHREMOTE_SCRIPT 远端临时脚本路径（默认 /tmp/_sshrun.<本机 PID>.sh，避免并发互踩）
"""
import os
import sys

import paramiko

HOST = os.environ.get("SSHHOST")
USER = os.environ.get("SSHUSER", "ubuntu")
PASSWORD = os.environ.get("SSHPASS")
PORT = int(os.environ.get("SSHPORT", "22"))
# 默认路径带本机 PID，避免两次并发执行互相覆盖（仍可用 SSHREMOTE_SCRIPT 固定）
REMOTE_PATH = os.environ.get("SSHREMOTE_SCRIPT", "/tmp/_sshrun.%d.sh" % os.getpid())

if not HOST:
    sys.exit("SSHHOST not set（请显式指定服务器地址，例如 SSHHOST=1.2.3.4）")
if not PASSWORD:
    sys.exit("SSHPASS not set")

args = sys.argv[1:]
use_sudo = False
local_file = None
if args and args[0] == "--sudo":
    use_sudo = True
    args = args[1:]
if args and args[0] == "--file":
    local_file = args[1]
    args = args[2:]

if local_file:
    with open(local_file, "rb") as fh:
        script = fh.read().decode("utf-8")
elif args:
    script = " ".join(args)
else:
    script = sys.stdin.read()

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
with sftp.open(REMOTE_PATH, "w") as fh:
    # local files may carry CRLF; a stray \r breaks JSON arguments and heredocs
    fh.write(script.replace("\r\n", "\n"))
sftp.chmod(REMOTE_PATH, 0o700)
sftp.close()

if use_sudo:
    cmd = "sudo -S -p '' bash %s; rc=$?; rm -f %s; exit $rc" % (REMOTE_PATH, REMOTE_PATH)
else:
    cmd = "bash %s; rc=$?; rm -f %s; exit $rc" % (REMOTE_PATH, REMOTE_PATH)

stdin, stdout, stderr = client.exec_command(cmd, timeout=3600, get_pty=False)
if use_sudo:
    stdin.write(PASSWORD + "\n")
    stdin.flush()
# 写完就关 stdin：脚本若尝试读 stdin 会拿到 EOF 而不是永远挂住
stdin.channel.shutdown_write()
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
rc = stdout.channel.recv_exit_status()
sys.stdout.write(out)
if err.strip():
    sys.stderr.write("\n--- stderr ---\n" + err)
print("\n[exit %d]" % rc)
client.close()

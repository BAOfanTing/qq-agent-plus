#!/usr/bin/env python
"""通过 SSH 执行一条 shell 命令（不用 SFTP，适合 sftp 子系统起不来的机器）。

用途：给运维脚本 / 手工排查提供最小可用的远程执行入口，密码从环境变量读，
      不落盘；多行命令与 heredoc 安全（整段交给 bash -s 的 stdin）。
用法：
  SSHHOST=1.2.3.4 SSHPASS=... python ops/sshcmd.py "systemctl --user status qq-agent-linux"
  SSHHOST=1.2.3.4 SSHPASS=... python ops/sshcmd.py --sudo "cat /etc/systemd/system/x.service"
  SSHHOST=... SSHPASS=... python ops/sshcmd.py "$(cat local.sh)"     # 多行/heredoc 均可
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

use_sudo = "--sudo" in sys.argv[1:]
cmd = " ".join(a for a in sys.argv[1:] if a != "--sudo")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
               timeout=25, banner_timeout=25, auth_timeout=25,
               look_for_keys=False, allow_agent=False)
if use_sudo:
    # 密码占 stdin 第一行，其余 stdin 作为脚本交给 bash -s —— 多行/heredoc 都安全。
    # （早期实现用 repr() 转义拼进 bash -lc "..."，命令里带引号/换行时会被打碎。）
    stdin, stdout, stderr = client.exec_command("sudo -S -p '' bash -s", timeout=300, get_pty=False)
    stdin.write(PASSWORD + "\n" + cmd + "\n")
    stdin.flush()
    stdin.channel.shutdown_write()
else:
    stdin, stdout, stderr = client.exec_command(cmd, timeout=300, get_pty=False)
sys.stdout.write(stdout.read().decode("utf-8", "replace"))
err = stderr.read().decode("utf-8", "replace")
if err.strip():
    sys.stderr.write("\n--- stderr ---\n" + err)
print("\n[exit %d]" % stdout.channel.recv_exit_status())
client.close()

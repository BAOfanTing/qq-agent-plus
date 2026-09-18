#!/bin/bash
# 看门狗：某个用户进程数异常增长（典型是脚本失控递归）时，杀掉失控进程树并记录现场。
#
# 用途：配合 ops/systemd/process-guard.timer 每 10 分钟跑一次。正常情况该用户只有
#       几十个进程，默认阈值 800（可用 QQ_AGENT_PROC_LIMIT 调整），只在真的失控时动手。
#       起因是一次补丁脚本里带了"注册自己/幂等复查自己"的代码，无限递归堆出上千进程，
#       把用户进程上限顶满，连 SSH 都 fork 不出来。
# 用法：
#   bash ops/guard-process-explosion.sh
#   QQ_AGENT_GUARD_USER=ubuntu QQ_AGENT_PROC_LIMIT=800 bash ops/guard-process-explosion.sh
#
# 可配置（环境变量，默认值见括号）：
#   QQ_AGENT_GUARD_USER  要盯的系统用户（当前用户）
#   QQ_AGENT_PROC_LIMIT  进程数阈值，超过才动手（800）
#   QQ_AGENT_GUARD_LOG   记录文件（$HOME/process-explosion.log）
set -u
LIMIT="${QQ_AGENT_PROC_LIMIT:-800}"
TARGET_USER="${QQ_AGENT_GUARD_USER:-$(id -un)}"
LOG="${QQ_AGENT_GUARD_LOG:-$HOME/process-explosion.log}"

u=$(ps -e -o user= | grep -c "^${TARGET_USER}$")
[ "$u" -lt "$LIMIT" ] && exit 0
TARGET_USER="$TARGET_USER" python3 - <<'PY' >> "$LOG" 2>&1
import os, glob, signal, collections, datetime, pwd
target = os.environ.get('TARGET_USER', '')
try:
    target_uid = str(pwd.getpwnam(target).pw_uid)
except KeyError:
    target_uid = ''

def rf(p):
    try: return open(p, 'rb').read().decode('utf-8', 'replace')
    except Exception: return ''
def cmd(pid): return rf('/proc/%s/cmdline' % pid).replace('\x00', ' ').strip()
def comm(pid): return rf('/proc/%s/comm' % pid).strip()
def uid(pid):
    for line in rf('/proc/%s/status' % pid).splitlines():
        if line.startswith('Uid:'): return line.split()[1]
    return ''
procs = {}
for d in glob.glob('/proc/[0-9]*'):
    pid = os.path.basename(d)
    if uid(pid) == target_uid:
        procs[pid] = (comm(pid), cmd(pid))
counts = collections.Counter(c for c, _ in procs.values())
print('=== %s 触发：%s 进程数 %d ===' % (datetime.datetime.now().strftime('%F %T'), target, len(procs)))
print('  各程序计数:', dict(counts.most_common(8)))
# 只杀明显失控的：bash/grep/tr 数量远超正常
killed = 0
for pid, (c, cl) in procs.items():
    if c in ('bash', 'grep', 'tr', 'sh', 'sleep') and (counts[c] > 200 or len(procs) > 3000):
        try:
            os.kill(int(pid), signal.SIGKILL); killed += 1
        except Exception:
            pass
print('  已杀:', killed)
PY

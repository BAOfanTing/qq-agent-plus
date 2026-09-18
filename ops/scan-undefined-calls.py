"""扫描 src/*.js：找出「调用了但本文件既没定义也没 import」的函数名。

用途：这类"调用点有、定义没有"的错 node --check 查不出来，只在运行时抛
ReferenceError（历史上 tools-core.js 调用 normalizeMid 却没定义，导致 send_message
全部失败、机器人一个字都发不出去），所以单独做一次静态扫描，配合启动自检脚本
(check-undefined-calls.sh) 在服务启动时跑一遍。

实现要点：手写一个轻量扫描器把注释/字符串/正则/模板串替换成空白（保留换行以便算行号）。
其中正则字面量按"前一个有效字符不是值"的通用启发式识别——否则 `/['\"]/` 这类正则里的
引号会让字符串扫描跑飞，把后面的真实代码整段吞掉（第一版就是这么误报一堆的）。

用法：python3 scan-undefined-calls.py <app 的 src 目录> [--ignore=名字1,名字2]
退出码恒为 0（只报告、不阻断）；最后一行固定是「可疑未定义调用点: N」。
"""
import glob
import os
import re
import sys

GLOBALS = set('''console Math JSON Object Array String Number Boolean Date Promise Set Map WeakMap WeakSet Buffer
process setTimeout clearTimeout setInterval clearInterval setImmediate queueMicrotask requestAnimationFrame
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent fetch URL URLSearchParams
structuredClone BigInt RegExp Error TypeError RangeError SyntaxError Symbol AbortController AbortSignal
TextEncoder TextDecoder atob btoa globalThis performance crypto require module exports
if for while switch catch return typeof function await new delete void in of do else try throw case instanceof
yield super this null true false async static get set import export default class const let var new'''.split())

# 正则字面量判定：'/' 前面这个字符意味着"这里不可能是除号"
REGEX_PRECEDERS = set('(,=:[!&|?{};+-*%<>~^') | {'\n', ''}


def blank(src: str) -> str:
    """把注释/字符串/模板/正则替换成空白，保留换行。"""
    out = []
    i, n = 0, len(src)
    last = ''  # 上一个有效字符（用于判断 '/' 是除号还是正则）

    def emit(chunk):
        out.append(chunk)
        for ch in reversed(chunk):
            if not ch.isspace():
                return ch
        return None

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '/' and nxt == '*':
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append('\n' * src.count('\n', i, j))
            i = j
            continue
        if c == '/' and last in REGEX_PRECEDERS:
            j = i + 1
            in_class = False
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                elif src[j] == '/' and not in_class:
                    j += 1
                    break
                elif src[j] == '\n':
                    break
                j += 1
            out.append(' ' * (j - i))
            last = '/'
            i = j
            continue
        if c in '"\'`':
            q = c
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == q:
                    j += 1
                    break
                if q == '`' and src[j] == '$' and j + 1 < n and src[j + 1] == '{':
                    depth = 1
                    j += 2
                    while j < n and depth:
                        if src[j] == '{':
                            depth += 1
                        elif src[j] == '}':
                            depth -= 1
                        j += 1
                    continue
                j += 1
            # 保留引号本身：否则 import ... from '...' 的引号也会被抹掉，
            # 后面按 from '...' 抓 import 的正则全部落空（第一版就栽在这）。
            if j - i >= 2:
                out.append(src[i] + ' ' * (j - i - 2) + src[j - 1])
            else:
                out.append(' ' * (j - i))
            last = q
            i = j
            continue
        out.append(c)
        if not c.isspace():
            last = c
        i += 1
    return ''.join(out)


def declared_names(src: str):
    names = set()
    for m in re.finditer(r'\b(?:function|class)\s+([A-Za-z_$][\w$]*)', src):
        names.add(m.group(1))
    for m in re.finditer(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)', src):
        names.add(m.group(1))
    for m in re.finditer(r'^\s*(?:static\s+|async\s+|get\s+|set\s+|#)*([A-Za-z_$][\w$]*)\s*\(', src, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'\bimport\s+([\s\S]*?)\s+from\s*[\'"]', src):
        for name in re.findall(r'[A-Za-z_$][\w$]*', m.group(1)):
            names.add(name)
    for m in re.finditer(r'^\s*import\s+([A-Za-z_$][\w$]*)\s+from', src, re.M):
        names.add(m.group(1))
    return names


def main(src_dir: str, ignore=None) -> int:
    ignore = set(ignore or ())
    total = 0
    for path in sorted(glob.glob(os.path.join(src_dir, '*.js'))):
        src = blank(open(path, encoding='utf-8').read())
        declared = declared_names(src)
        missing = {}
        for m in re.finditer(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(', src):
            name = m.group(1)
            if name in declared or name in GLOBALS or name in ignore:
                continue
            line = src.count('\n', 0, m.start()) + 1
            missing.setdefault(name, line)
        if missing:
            total += len(missing)
            items = sorted(missing.items(), key=lambda kv: kv[1])
            print(os.path.basename(path), '→', ', '.join('%s(第%d行)' % (k, v) for k, v in items))
    print()
    print('可疑未定义调用点:', total)
    return 0


if __name__ == '__main__':
    args = sys.argv[1:]
    ignores = []
    src_dir = '.'
    for a in args:
        if a.startswith('--ignore='):
            ignores = [x for x in a.split('=', 1)[1].split(',') if x]
        else:
            src_dir = a
    raise SystemExit(main(src_dir, ignores))
